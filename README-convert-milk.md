# convert-milk.cjs — MilkDrop → Butterchurn Preset Converter

Converts MilkDrop `.milk` preset files into the Butterchurn JSON format used by this visualizer.

### Node.js built-ins

| Module | Purpose |
|--------|---------|
| `fs` | File read/write |
| `path` | Path joining |

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
