# synthesize-presets.mjs

Generate new butterchurn presets by combining structural components from
multiple source presets.  Each output preset is assembled from 2–N
randomly-chosen inputs; blendable components can be interpolated rather
than copied wholesale.

## Usage

```
node scripts/synthesize-presets.mjs [options] <group-dir> <input...>
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--minIn <n>` | Minimum number of input presets to combine per output | `2` |
| `--maxIn <n>` | Maximum number of input presets to combine per output | `2` |
| `--nOut <n>` | Number of output presets to generate | `100` |
| `--components <list>` | Comma-delimited list of components to blend (see below) | all four |

### Arguments

| Argument | Description |
|----------|-------------|
| `group-dir` | Preset group directory (created if needed).  Presets are written to `<group-dir>/presets-src/NNNN.json`, following the same directory structure as existing groups.  Input sources are symlinked alongside as `NNNN-A.json`, `NNNN-B.json`, etc. |
| `input...` | One or more input sources — either a **directory** containing `*.json` preset files, or **individual** `.json` file paths.  At least one input is required. |

## Components

Four components support blending.  Pass any subset to `--components`:

| Name | Blend behaviour | No-blend behaviour |
|------|----------------|--------------------|
| `BaseVals` | Lerp numeric parameters across sources | Copy from one source |
| `InitEQs` | Merge variable declarations from all sources | Copy from one source |
| `Shapes` | Lerp shape `baseVals` between two sources (code eqs kept from first) | Copy whole shapes from one source |
| `Waves` | Lerp wave `baseVals` between two sources (code eqs kept from first) | Copy whole waves from one source |

The remaining components — `frame_eqs_str`, `pixel_eqs_str`, `warp`,
`comp` — are always taken from one randomly-chosen source because they
are code/shader text that cannot be meaningfully interpolated.

## Output

- **Preset files** — numbered `0001.json` … `NNNN.json` in
  `<group-dir>/presets-src/`, following the standard group directory
  layout.
- **Source symlinks** — each input preset used is symlinked alongside the
  output as `NNNN-A.json`, `NNNN-B.json`, etc. in the same
  `presets-src/` directory, so they appear in the UI for side-by-side
  comparison.  Relative symlinks keep the group directory relocatable.
- **Report** — `<group-dir>-synthesis-report.tsv` placed alongside the
  group directory (not inside it, so `mkmeta.sh` won't pick it up).
  Format: `output_hash<TAB>src_hash1,src_hash2[,src_hash3,…]`

## Examples

### Synthesize 100 presets from sel2, combining 2–3 sources

```bash
node scripts/synthesize-presets.mjs \
  --minIn 2 --maxIn 3 --nOut 100 \
  public/butterchurn-presets/sel2-2026-03-01 \
  public/butterchurn-presets/sel2/presets-src
```

### Synthesize 50 presets blending only BaseVals and Shapes

```bash
node scripts/synthesize-presets.mjs \
  --nOut 50 --components BaseVals,Shapes \
  public/butterchurn-presets/my-group \
  public/butterchurn-presets/sel2/presets-src
```

### Use hash-named preset files from `presets/` as input

```bash
node scripts/synthesize-presets.mjs \
  public/butterchurn-presets/new-group \
  public/butterchurn-presets/sel2/presets
```

### Combine presets from multiple groups

```bash
node scripts/synthesize-presets.mjs \
  --minIn 2 --maxIn 4 --nOut 200 \
  public/butterchurn-presets/combined \
  public/butterchurn-presets/sel2/presets-src \
  public/butterchurn-presets/sel1/presets-src
```

### Use individual files as inputs

```bash
node scripts/synthesize-presets.mjs \
  out/presets-src \
  presets/abc123.json presets/def456.json presets/ghi789.json
```

## Post-processing

After generating presets, run the build pipeline to create hash-named
copies and metadata:

```bash
scripts/all-presets.sh
```

Or for a single group:

```bash
scripts/mkmeta.sh public/butterchurn-presets/<group-name>
```


## Key observations:

- Base Vals are always lerped (blended numerically) between sources with a random bias
- Init EQs are always merged (union of variable declarations)
- Frame/Pixel EQs use a fallback pattern (take from one source, fall back to another if empty — never blended)
- Warp/Comp shaders are also fallback (never blended)
- Shapes/Waves are either cloned from one source or concatenated from multiple (enabled shapes from A + B, then padded/truncated to 4)