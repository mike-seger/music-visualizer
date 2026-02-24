#!/usr/bin/env bash
# ── all-presets.sh ────────────────────────────────────────────────────────────
# Run mkmeta.sh for every preset group in both butterchurn-presets/ and
# shadertoy-presets/.  Generates preset-groups.json in each top-level dir.
#
# Group names are discovered from the keys of public/presets.json.
# Within each top-level dir, every immediate subdirectory that contains a
# presets-src/ folder is treated as a group.
#
# Usage:  ./scripts/all-presets.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC="$ROOT/public"
MKMETA="$SCRIPT_DIR/mkmeta.sh"

chmod +x "$MKMETA"

# ── Discover top-level preset categories from presets.json ──────────────────
# Keys of the JSON object are directory names under public/
categories=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for k in d:
    print(k)
" "$PUBLIC/presets.json")

for category in $categories; do
    cat_dir="$PUBLIC/$category"
    if [[ ! -d "$cat_dir" ]]; then
        echo "⚠  Category '$category' not found at $cat_dir — skipping." >&2
        continue
    fi

    echo "━━━ $category ━━━" >&2

    # Find all group subdirectories (those with presets-src/)
    groups=()
    while IFS= read -r d; do
        [[ -z "$d" ]] && continue
        groups+=("$(basename "$d")")
    done < <(find "$cat_dir" -maxdepth 1 -mindepth 1 -type d | sort)

    # Run mkmeta.sh for each group that has presets-src/
    active_groups=()
    for g in "${groups[@]}"; do
        group_dir="$cat_dir/$g"
        if [[ -d "$group_dir/presets-src" ]]; then
            "$MKMETA" "$group_dir"
            active_groups+=("$g")
        else
            echo "  ⚠  $g: no presets-src/ — skipping mkmeta." >&2
        fi
    done

    # Generate preset-groups.json
    groups_json="$cat_dir/preset-groups.json"
    python3 -c "
import json, sys
groups = sys.argv[1:]
json.dump(sorted(groups), sys.stdout, indent=2)
print()
" "${active_groups[@]}" > "$groups_json"

    echo "  ✓  $category/preset-groups.json: ${#active_groups[@]} group(s)." >&2
done

echo "━━━ Done ━━━" >&2
