# convert-milk.cjs — MilkDrop → Butterchurn Preset Converter

Converts MilkDrop `.milk` preset files into the Butterchurn JSON format used by this visualizer.

## Prerequisites

The script resolves its dependencies from two local converter repos that must be present with `node_modules` installed:

```
tmp/milkdrop-preset-converter/          # npm install done
tmp/milkdrop-preset-converter-node/     # npm install done (used for milkdrop-preset-utils v0.2.1)
```

Key npm packages used (resolved from the above, not installed globally):

| Package | Version | Purpose |
|---------|---------|---------|
| `milkdrop-preset-utils` | 0.2.1 (from `-node`) | Parses `.milk` files (`splitPreset`), prepares shaders |
| `hlslparser-js` | 0.1.1 (from browser converter) | Pure-JS HLSL → GLSL shader conversion |
| `lodash` | (from browser converter) | Utility functions |

### System binaries

| Binary | Installed via | Purpose |
|--------|--------------|---------|
| `glslangValidator` | `brew install glslang` | Validates GLSL ES 3.0, catches type errors |
| `spirv-cross` | `brew install spirv-cross` | SPIR-V → GLSL cross-compilation |

### Node.js built-ins

| Module | Purpose |
|--------|---------|
| `fs` | File read/write |
| `path` | Path joining |
| `child_process` | Spawning `glslangValidator` / `spirv-cross` |

## Usage

### Convert a single preset

```bash
node scripts/convert-milk.cjs path/to/preset.milk > output.json
```

Reads the `.milk` file, converts it, and writes the Butterchurn JSON to stdout.

### Convert from stdin

```bash
cat preset.milk | node scripts/convert-milk.cjs > output.json
```

### Batch-convert a directory

```bash
node scripts/convert-milk.cjs --batch <inputDir> <outputDir>
```

Converts all `.milk` files in `<inputDir>` and writes corresponding `.json` files to `<outputDir>` (created automatically if it doesn't exist). Progress and errors are printed to stderr.

Example:

```bash
node scripts/convert-milk.cjs --batch src/milkdrop-presets public/butterchurn-presets/test10
```

### Compare against a reference

```bash
node scripts/convert-milk.cjs --compare <milkFile> <referenceJson>
```

Converts the `.milk` file and compares every field against an existing reference JSON. Prints per-field match results to stdout. Useful for validating the converter against known-good conversions.

Example:

```bash
node scripts/convert-milk.cjs --compare \
  tmp/butterchurn-presets/presets/milkdrop/11.milk \
  tmp/butterchurn-presets/presets/converted/11.json
```

Output:

```
BaseVals match: true
Init EEL match: true
Frame EEL match: true
Pixel EEL match: true
Shape 0 bv match: true
Shape 0 init match: true
Shape 0 frame match: true
...
Warp match: false
Comp match: false
Warp len: 2893 vs 450
Comp len: 2849 vs 1121
```

## Output Format

The output JSON has this structure:

```jsonc
{
  "version": 201,                   // MilkDrop preset version
  "baseVals": { ... },              // Numeric parameters (decay, zoom, rot, etc.)
  "shapes": [                       // 4 custom shapes (always 4 slots)
    {
      "baseVals": { ... },          // Shape parameters (enabled, sides, x, y, rad, etc.)
      "init_eqs_eel": "...",        // Per-shape init equations (raw EEL code)
      "frame_eqs_eel": "..."        // Per-shape per-frame equations (raw EEL code)
    },
    // ... shapes 1–3
  ],
  "waves": [                        // 4 custom waves (always 4 slots)
    {
      "baseVals": { ... },          // Wave parameters (enabled, samples, scaling, etc.)
      "init_eqs_eel": "...",        // Per-wave init equations (raw EEL code)
      "frame_eqs_eel": "...",       // Per-wave per-frame equations (raw EEL code)
      "point_eqs_eel": "..."        // Per-wave per-point equations (raw EEL code)
    },
    // ... waves 1–3
  ],
  "init_eqs_eel": "...",            // Global init equations (raw EEL code)
  "frame_eqs_eel": "...",           // Global per-frame equations (raw EEL code)
  "pixel_eqs_eel": "...",           // Global per-vertex/pixel equations (raw EEL code)
  "warp": "...",                    // Warp shader (GLSL fragment shader source)
  "comp": "..."                     // Composite shader (GLSL fragment shader source)
}
```

## Conversion Pipeline

```
.milk file
  │
  ├─ splitPreset()          → parses INI-like .milk into structured parts
  │                            (baseVals, shapes, waves, EEL strings, HLSL shaders)
  │
  ├─ EEL strings            → passed through as-is (CRLF normalized to LF)
  │                            top-level EEL is trimmed; shape/wave EEL is not
  │
  └─ HLSL shaders           → prepareShader() wraps raw HLSL in full program
                               with MilkDrop uniforms and macros
                             → convertHLSLShader() converts HLSL → GLSL (pure JS)
                             → processUnOptimizedShader() post-processes the output
```

## Shader Conversion Notes

This script uses `hlslparser-js` (pure JavaScript / WebAssembly) for HLSL → GLSL conversion. This produces functionally correct but **unoptimized** GLSL — the output includes helper functions like `matrix_row0()`, `m_scalar_swizzle20()`, etc.

The reference presets in `tmp/butterchurn-presets/presets/converted/` were created with `milkdrop-shader-converter`, a native C++ Node addon (hlsl2glslfork + glsl-optimizer) that produces compact, optimized GLSL. That native addon does not currently work on Apple Silicon (hangs indefinitely).

Both GLSL variants are functionally equivalent and work correctly in Butterchurn. The unoptimized shaders are slightly larger but have no visual difference at runtime.

## Comparison with the "full" Format

The `tmp/butterchurn-presets/presets/full/` directory contains a superset format with additional fields:

| Field | In "converted" | In "full" | Description |
|-------|:-:|:-:|-------------|
| `*_eel` | ✓ | ✓ | Raw EEL equation code |
| `*_str` | ✗ | ✓ | EEL compiled to JavaScript (via milkdrop-eel-parser) |
| `warp` / `comp` | ✓ | ✓ | GLSL shader source |
| `warp_hlsl` / `comp_hlsl` | ✗ | ✓ | Original HLSL shader source |

The "converted" format (which this script produces) is the minimal runtime format that Butterchurn needs. The `*_str` and `*_hlsl` fields are only needed for debugging or re-conversion.


# Classify milk files
Example
```
node scripts/classify-milk.cjs --batch src/presets/milkdrop --csv
```


# Find broken visualizers

## Static scanner
```
# Scan all presets under public/butterchurn-presets/
node scripts/scan-broken-presets.mjs

# Scan a specific group
node scripts/scan-broken-presets.mjs public/butterchurn-presets/cream-of-the-crop

# Write JSON report
node scripts/scan-broken-presets.mjs --output tmp/broken-report.json

# TSV output (file<tab>error), one row per broken field — pipe-friendly
node scripts/scan-broken-presets.mjs --tsv
node scripts/scan-broken-presets.mjs --tsv public/butterchurn-presets/cream-of-the-crop > tmp/broken.tsv

# Move broken files into a broken/ subdir with _broken_ prefix
node scripts/scan-broken-presets.mjs --move
node scripts/scan-broken-presets.mjs --move public/butterchurn-presets/cream-of-the-crop
```

Files already inside a `broken/` subdirectory (or named with a `_broken_` prefix) are skipped by the scanner and never moved again.

The WebGL warnings (GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough) cannot be caught this way — those are a runtime rendering bug inside Butterchurn that requires actual GPU execution.

