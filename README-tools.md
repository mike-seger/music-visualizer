# Developer Tools

Scripts in the `scripts/` directory that support preset management and analysis.

---

## hash-presets.mjs

Computes the same stable SHA-256 content hash the app uses to key captured
previews, for one or more preset JSON files.  The hash is the first 12 hex
characters of the SHA-256 digest of the raw file text (UTF-8) — identical to
the in-browser `_sha256short()` function in `src/js/preview/PreviewBatch.js`.

### Usage

```
node scripts/hash-presets.mjs [options] <path>
```

`<path>` is either a single `.json` file or a directory.  When a directory is
given, only its **top-level** `.json` files are included (no recursion).

### Options

| Flag | Default | Description |
|---|---|---|
| `--format json` | ✓ | Output a JSON array |
| `--format tsv` | | Output tab-separated values with a header row |
| `--out <file>` | stdout | Write output to `<file>` instead of stdout |
| `--help` | | Show usage message |

### Output columns

| Column | Description |
|---|---|
| `hash12` | First 12 hex chars of SHA-256 — the key used by the app |
| `hashfull` | Full 64-char hex SHA-256 digest |
| `file` | Basename of the JSON file (e.g. `martin - witchcraft.json`) |

### Examples

```bash
# Hash every preset in a group directory — JSON output to stdout
node scripts/hash-presets.mjs public/butterchurn-presets/top

# Same, as TSV written to a file
node scripts/hash-presets.mjs public/butterchurn-presets/top \
  --format tsv --out /tmp/top-hashes.tsv

# Hash a single file
node scripts/hash-presets.mjs "public/butterchurn-presets/top/martin - witchcraft reloaded.json"

# Hash all presets in the cream-of-the-crop group, TSV to stdout
node scripts/hash-presets.mjs public/butterchurn-presets/cream-of-the-crop \
  --format tsv
```

### Sample JSON output

```json
[
  {
    "hash12": "5910993c73cf",
    "hashfull": "5910993c73cf04ef83c0679c9fc3005203662bb0084f3863bd26005314a21649",
    "file": "Martin - QBikal - Surface Turbulence.json"
  },
  ...
]
```

### Sample TSV output

```
hash12	hashfull	file
5910993c73cf	5910993c73cf04ef83c0679c9fc3005203662bb0084f3863bd26005314a21649	Martin - QBikal - Surface Turbulence.json
f760d5102b07	f760d5102b072f54505e3ff092f805e2a9c0dc05d5948b4b8f94b420a3eb9a87	martin - Thinking about you.json
```

### Notes

- The hash is **content-based**: if the file bytes change, the hash changes.
  Renaming a file does not affect its hash.
- `index.json` and other non-preset JSON files in a directory are included by
  the script since it does no filtering by content — pipe through `grep -v` or
  use a single-file invocation to exclude them if needed.
- The hash is guaranteed to match the key stored in `previews/index.js` for any
  preset that has already been captured by the app.

---

## `detect-glsl-version.cjs`

Shared CJS module that analyses a GLSL shader source string and returns whether
it requires **WebGL1** (GLSL ES 1.00) or **WebGL2** (GLSL ES 3.00).

Used by:
- `scripts/list-webgl1-shaders.cjs` (CLI)
- `src/js/visualizers/ShadertoyMultipassVisualizer.js` (runtime, inline copy)

### API

```js
const { detectGLSLVersion } = require('./detect-glsl-version.cjs')

const { version, reason } = detectGLSLVersion(glslSource)
// version: 1 | 2
// reason:  human-readable string explaining the decision
```

### Detection signals

The function checks signals in priority order:

| Priority | Condition | Decision |
|----------|-----------|----------|
| 1 | `//@WebGL1` on first line | WebGL1 (explicit override) |
| 2 | `//@WebGL2` on first line | WebGL2 (explicit override) |
| 3 | `gl_FragColor`, `texture2D()`, `varying`, `attribute`, comma for-loop vars | WebGL1 |
| 4 | `fwidth()`, `dFdx()`, `dFdy()`, `textureLod()`, `#version 300 es`, `layout()` | WebGL2 |
| 5 | _(none of the above)_ | WebGL1 (default) |

WebGL1 is the default because any shader that genuinely requires WebGL2 will have
at least one detectable signal (`fwidth`, `dFdx`, `dFdy`, `textureLod`, `layout`,
`#version 300 es`). "No signals" means neutral GLSL that compiles correctly on
either path, and WebGL2 contexts fully support GLSL ES 1.00 via backward compatibility.

---

## `list-webgl1-shaders.cjs`

CLI tool that scans all `.glsl` files in a `presets-src/` directory and reports
which ones auto-detect as WebGL1 vs WebGL2, together with the reason for each
decision. Useful for auditing which shaders will use the more capable WebGL2
path (and thus require a WebGL2-capable device/browser).

### Usage

```bash
# Default directory: public/shadertoy-presets/default/presets-src
node scripts/list-webgl1-shaders.cjs

# Custom directory
node scripts/list-webgl1-shaders.cjs path/to/presets-src
```

### Example output

```
GLSL version scan: /…/public/shadertoy-presets/default/presets-src
────────────────────────────────────────────────────────────────────────
Total shaders scanned: 55
  WebGL1 (GLSL ES 1.00): 53
  WebGL2 (GLSL ES 3.00): 2

WebGL1 shaders (53):
  glowmarcher-1.glsl                      detected WebGL1 signal: comma-declared for-loop variables
  audio-cube-ii.glsl                      no signals detected, defaulting to WebGL1
  …

WebGL2 shaders (2):
  neonstyle.glsl                          detected WebGL2 signal: fwidth() (built-in in GLSL ES 3.00)
  voronoi-distances.glsl                  detected WebGL2 signal: textureLod() (built-in in GLSL ES 3.00)
```

### Notes

- Exit code `0` even when WebGL1 shaders are found; `1` only on missing directory.
- Explicit `//@WebGL1` or `//@WebGL2` overrides on the **first line** of a shader
  always win over any auto-detected signals.
- The runtime visualizer logs the same decision to the browser console on every
  shader load: `[GLSL] <name> → <reason>`.

---

## `import-shadertoy.cjs`

Converts a Shadertoy export (`.zip` or `.json`) into this project's GLSL preset
format, writes it to `presets-src/`, and automatically runs `mkmeta.sh` so the
preset is immediately available in the app.

### Getting the export file

On any Shadertoy shader page click **Export** (bottom of the editor panel). This
downloads a `.zip` containing a `readme.txt` and a `<shaderid>.json` with all
pass code and metadata.

Alternatively, pass the raw JSON from the
[Shadertoy API](https://www.shadertoy.com/api).

### Usage

```bash
# From a ZIP export (auto-detects the JSON inside)
node scripts/import-shadertoy.cjs "tmp/iq - Snail.zip"

# From a raw JSON file
node scripts/import-shadertoy.cjs shadertoy-export.json

# Override the output filename slug
node scripts/import-shadertoy.cjs "Snail.zip" --name my-snail

# Write to a different presets-src directory
node scripts/import-shadertoy.cjs shader.zip --out-dir path/to/presets-src

# Skip mkmeta.sh (e.g. when importing multiple shaders in a batch)
node scripts/import-shadertoy.cjs shader.zip --no-meta
```

### Output format

| Shader type | Output |
|-------------|--------|
| Single Image pass | Flat GLSL (no section markers) |
| Multi-pass (buffers) | `// # Common`, `// # Buffer A/B/C/D`, `// # Image` sections |

### Texture channels

Shadertoy serves its media library with auth cookies, so direct download is not
possible. Instead, the importer writes a browser-console snippet to
`public/shadertoy-media/<zip-name>.js`.

**Workflow:**

1. Open the shader's page on [shadertoy.com](https://www.shadertoy.com) while
   logged in.
2. Open the browser DevTools console.
3. Paste the contents of the generated `.js` file into the console and press
   Enter. Each file will download via the browser (one at a time, with a
   0.6 s delay between them).
4. Move the downloaded files into `public/shadertoy-media/`.

```
// Download Shadertoy media for: Snail
// Paste into the browser console on https://www.shadertoy.com (logged in)
// Place the downloaded files into: public/shadertoy-media/

;(async () => {
  const files = [
    { ch: 1, url: '/media/a/ad56fba9….png', name: 'ad56fba9….png' },
    …
  ]
  for (const f of files) {
    const blob = await fetch(f.url).then(r => r.blob())
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: f.name })
    a.click()
    …
  }
})()
```

Once the files are in place, the visualizer's runtime reads the
`// @iChannel<n>: /shadertoy-media/<filename>` comments that were embedded in
the `.glsl` file and loads the images automatically via `THREE.TextureLoader`.



