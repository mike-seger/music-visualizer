#!/usr/bin/env bash
# ── mkmeta.sh ─────────────────────────────────────────────────────────────────
# Generate meta.json and ID-named preset copies for a preset group directory.
#
# Usage:  mkmeta.sh <group-dir>
#
# Input layout:
#   <group-dir>/presets-src/   ← original preset files (human-readable names)
#   <group-dir>/previews/      ← (optional) existing preview images
#
# Output:
#   <group-dir>/meta.json      ← { imageExt, srcMap: { id: filename, … } }
#   <group-dir>/presets/<id>.ext  ← ID-named copies of presets-src/*
#
# Optimisations:
#   • Skips when meta.json is up-to-date and presets/ has the right count.
#   • Only copies files that are missing or outdated in presets/.
#   • Removes orphan ID copies from presets/.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

group_dir="${1:-}"

if [[ -z "$group_dir" || ! -d "$group_dir" ]]; then
    echo "Usage: $0 <group-directory>" >&2
    exit 1
fi

src_dir="$group_dir/presets-src"
if [[ ! -d "$src_dir" ]]; then
    echo "  ⚠  $group_dir: no presets-src/ — skipping." >&2
    exit 0
fi

# Delegate all logic to Python for robustness with special-char filenames
exec python3 - "$group_dir" <<'PYEOF'
import hashlib, json, os, shutil, sys

group_dir = sys.argv[1]
src_dir   = os.path.join(group_dir, 'presets-src')
dst_dir   = os.path.join(group_dir, 'presets')
meta_file = os.path.join(group_dir, 'meta.json')
prev_dir  = os.path.join(group_dir, 'previews')

# ── Collect source files ────────────────────────────────────────────────────
src_files = sorted([
    f for f in os.listdir(src_dir)
    if not f.startswith('.') and os.path.isfile(os.path.join(src_dir, f))
])

if not src_files:
    print(f'  ⚠  {group_dir}: presets-src/ is empty — skipping.', file=sys.stderr)
    sys.exit(0)

# ── Detect preview image extension ──────────────────────────────────────────
image_ext = 'png'
if os.path.isdir(prev_dir):
    for pf in os.listdir(prev_dir):
        if not pf.startswith('.') and os.path.isfile(os.path.join(prev_dir, pf)):
            image_ext = pf.rsplit('.', 1)[-1] if '.' in pf else 'png'
            break

# ── Check if meta.json needs regeneration ───────────────────────────────────
needs_regen = True
old_meta = {}
old_src_map = {}

if os.path.isfile(meta_file):
    try:
        with open(meta_file) as f:
            old_meta = json.load(f)
        old_src_map = old_meta.get('srcMap', {})
    except:
        pass

    if len(old_src_map) == len(src_files):
        meta_mtime = os.path.getmtime(meta_file)
        any_newer = any(
            os.path.getmtime(os.path.join(src_dir, f)) > meta_mtime
            for f in src_files
        )
        if not any_newer:
            needs_regen = False

# ── Compute hashes (only if regenerating) ───────────────────────────────────
if needs_regen:
    src_map = {}  # id → filename
    for fname in src_files:
        path = os.path.join(src_dir, fname)
        h = hashlib.sha256(open(path, 'rb').read()).hexdigest()[:20]
        src_map[h] = fname

    # Write meta.json
    meta = {
        'imageExt': image_ext,
        'srcMap': dict(sorted(src_map.items(), key=lambda x: x[1].lower()))
    }
    with open(meta_file, 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'  ✓  {group_dir}: meta.json written ({len(src_map)} entries, imageExt={image_ext}).', file=sys.stderr)
else:
    meta = old_meta
    src_map = old_src_map
    print(f'  ✓  {group_dir}: meta.json up to date ({len(src_map)} entries).', file=sys.stderr)

# ── Write meta.js (for file:// access without fetch) ────────────────────────
meta_js_file = os.path.join(group_dir, 'meta.js')
needs_meta_js = (
    not os.path.isfile(meta_js_file) or
    os.path.getmtime(meta_js_file) < os.path.getmtime(meta_file)
)
if needs_meta_js:
    import json as _json  # already imported, alias for clarity
    with open(meta_js_file, 'w') as f:
        f.write('window.__META__ = ')
        _json.dump(meta, f, ensure_ascii=False)
        f.write(';\n')
    print(f'  ✓  {group_dir}: meta.js written.', file=sys.stderr)

# ── Sync ID-named copies in presets/ ────────────────────────────────────────
os.makedirs(dst_dir, exist_ok=True)

# Build set of expected destination files
expected_dst = {}  # dst_basename → src_path
for hid, fname in src_map.items():
    ext = fname.rsplit('.', 1)[-1] if '.' in fname else 'json'
    expected_dst[f'{hid}.{ext}'] = os.path.join(src_dir, fname)

# Copy missing or outdated files
copied = 0
for dst_base, src_path in expected_dst.items():
    dst_path = os.path.join(dst_dir, dst_base)
    if not os.path.isfile(src_path):
        continue
    if os.path.isfile(dst_path) and os.path.getmtime(dst_path) >= os.path.getmtime(src_path):
        continue
    shutil.copy2(src_path, dst_path)
    copied += 1

if copied > 0:
    print(f'  ✓  {group_dir}: {copied} preset(s) copied to presets/.', file=sys.stderr)

# Remove orphans from presets/
orphans = 0
if os.path.isdir(dst_dir):
    for df in os.listdir(dst_dir):
        if df.startswith('.'):
            continue
        if df not in expected_dst:
            os.remove(os.path.join(dst_dir, df))
            orphans += 1
    if orphans > 0:
        print(f'  🗑  {group_dir}: removed {orphans} orphan(s) from presets/.', file=sys.stderr)
PYEOF
