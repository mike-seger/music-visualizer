# Music Visualizer

A browser-based, audio-reactive music visualizer built with Three.js, WebGL, and Butterchurn (MilkDrop). It supports multiple visual modes, real-time audio analysis, beat detection, and can run standalone or embedded inside another player via iframe.

## Features

- **40+ Three.js entity visualizers** — particles, waveforms, spectrums, spirals, fluid, fireworks, voronoi, and more
- **50+ Shadertoy / custom GLSL shaders** — raymarching, fractals, plasma, audio-reactive GLSL ported from Shadertoy
- **Butterchurn / MilkDrop presets** — thousands of classic MilkDrop presets rendered via WebGL; lazy-loaded to keep initial bundle small
- **Real-time audio analysis** — FFT spectrum, beat detection via `web-audio-beat-detector`, BPM tracking
- **Spectrum filter system** — per-visualizer filter presets for frequency shaping
- **lil-gui controls** — in-browser GUI for switching modes, adjusting parameters, and customizing shaders
- **Time sync** — optional WebSocket-based sync server to coordinate playback across clients/tabs
- **Polaris Player bridge** — embeddable via iframe with a `postMessage` protocol for external player control
- **Vite build** — chunked output with manual chunk splitting for Three.js, GSAP, beat-detector, MilkDrop engine, and presets

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Development server

```bash
npm run dev
```

Opens at `http://localhost:5173/visualizer/` (or the address printed by Vite).

### Build

```bash
npm run build
```

Output goes to `dist/`. The build includes two entry points:

| Entry | File | Purpose |
|-------|------|---------|
| Main visualizer | `index.html` | Standalone player with full controls |
| Controls panel | `viz-controls.html` | Detachable controls UI |

### Preview build

```bash
npm run preview
```

## Usage

Open `index.html` (dev or built). The app will:

1. Ask for audio input (file, microphone, or URL).
2. Start analysing audio in real time.
3. Render the selected visualizer.

Use the **lil-gui panel** (top-right) to:

- Switch between visualizer groups: *Custom WebGL*, *Shadertoy*, *All Butterchurn*, and named preset groups
- Pick a specific visualizer or preset
- Adjust audio sensitivity, BPM, spectrum filters, and shader parameters

## Project Structure

```
src/
  js/
    App.js                  # Main application class
    visualizers/
      entityRegistry.js     # Auto-discovers Three.js entity visualizers
      shaderRegistry.js     # Auto-discovers GLSL/Shadertoy visualizers
      milkdropRegistry.js   # Lazy-loads Butterchurn presets
      ButterchurnVisualizer.js
      ShadertoyMultipassVisualizer.js
    entities/               # ~40 Three.js visualizer modules
    managers/               # AudioManager, BPMManager
    sync-client/            # WebSocket sync client (SyncClient.mjs)
    shaderCustomization.js  # Per-shader uniform config loader
    spectrumFilters.js      # Spectrum filter presets
  shaders/                  # ~50 GLSL shaders
  scss/                     # Styles
public/
  butterchurn-presets/      # Extra Butterchurn preset JSON files
  spectrum-filters/         # JSON spectrum filter definitions
  milkdrop-presets.json     # Preset index
scripts/                    # Dev/build utility scripts
timeserver/                 # Optional time-sync server
```

## Visualizer Modes

### Three.js Entity Visualizers

Self-contained modules in `src/js/entities/`. Each directory exports a class as `default` and a `meta` object with `name` and optional `order`. Examples: `audio-particles`, `circular-spectrum`, `fireworks`, `fluid`, `synthwave`, `oscilloscope`.

### GLSL / Shadertoy Shaders

`.glsl` files in `src/shaders/` are auto-discovered and wrapped in a `ShadertoyMultipassVisualizer`. Optional JSON config files in `src/shaders-config/` can inject custom uniforms and GUI controls per shader.

### Butterchurn (MilkDrop)

Uses the [`butterchurn`](https://github.com/jberg/butterchurn) library. Presets are grouped and lazy-loaded (~800 kB) on first selection. Additional presets can be added to `public/butterchurn-presets/`.

To convert `.milk` files to Butterchurn JSON format, see [README-convert-milk.md](README-convert-milk.md).

## Polaris Player Integration

`bridge.html` embeds the visualizer as an iframe component controlled by a parent window via `postMessage`. See [README-bridge.md](README-bridge.md) for the full communication protocol.

Quick test in the browser console:

```js
__polarisVisualizer.enable()
```

## Time Sync Server

An optional zero-dependency Node.js server that broadcasts a shared clock via SSE, used to synchronise playback across multiple clients or tabs.

```bash
cd timeserver
node server.js          # default port 4000
PORT=5000 node server.js
```

Admin panel: `http://localhost:4000/`

See [timeserver/README.md](timeserver/README.md) for the full API and client examples. For standalone `SyncClient` usage see [README-SyncClient.md](README-SyncClient.md).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run presets` | Regenerate `milkdrop-presets.json` index and deduplicate presets |
| `npm run build` | Production build |
| `npm run lint:glsl` | Validate GLSL shaders with `glslangValidator` |
| `scripts/convert-milk.cjs` | Convert `.milk` → Butterchurn JSON (see README-convert-milk.md) |
| `scripts/gen-spectrum-index.mjs` | Regenerate spectrum filter index |
| `scripts/classify-milk.cjs` | Classify / tag MilkDrop presets |

## Dependencies

| Package | Purpose |
|---------|---------|
| [`three`](https://threejs.org/) | 3D rendering |
| [`butterchurn`](https://github.com/jberg/butterchurn) | MilkDrop / Butterchurn renderer |
| [`butterchurn-presets`](https://github.com/jberg/butterchurn-presets) | Bundled preset library |
| [`gsap`](https://greensock.com/gsap/) | Animations |
| [`lil-gui`](https://lil-gui.georgealways.com/) | Debug/control GUI |
| [`web-audio-beat-detector`](https://github.com/chrisguttandin/web-audio-beat-detector) | BPM / beat detection |

## License

MIT — see [LICENSE](LICENSE).
