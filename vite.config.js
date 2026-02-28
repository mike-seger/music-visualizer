import { defineConfig } from 'vite'
import glslify from 'rollup-plugin-glslify'
import * as path from 'path'
import { readdirSync, symlinkSync, existsSync, lstatSync, readlinkSync, mkdirSync } from 'fs'

export default defineConfig({
  root: '',
  base: '/visualizer/',
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
  build: {
    outDir: 'dist',
    cssCodeSplit: true,
    // Speed: don't wipe dist/ on every build — compiled JS/CSS chunks are
    // content-hashed so stale ones are harmless, and this lets us skip
    // re-copying the 1.6 GB public/butterchurn-presets tree each time.
    // Run  cp -r public/* dist/  once after a fresh clone to seed dist/.
    emptyOutDir: false,
    copyPublicDir: false,
    // milkdrop-presets (~645 kB) and three.js (~477 kB) are the largest chunks.
    // Both are lazy-loaded or cache-stable; suppress the default 500 kB warning.
    chunkSizeWarningLimit: 700,
    // Speed: skip per-chunk gzip calculation (only affects the size column in output).
    reportCompressedSize: false,
    // Speed: target modern browsers to avoid unnecessary JS downleveling.
    target: 'esnext',
    // Speed: esbuild minifier is ~10× faster than terser.
    minify: 'esbuild',
    rollupOptions: {
      input: {
        visualizer:            './index.html',
        bridge:                './bridge.html',
        'bridge-example':      './bridge-example.html',
        'panels/index':        './panels/index.html',
        'panels/viz-controls': './panels/viz-controls.html',
        'panels/preview':      './panels/preview.html',
        'panels/editor':       './panels/editor.html',
      },
      output: {
        manualChunks(id) {
          if (!id) return

          // Split out large in-repo assets (GLSL + visualizers) to keep the app
          // entry chunk smaller. (These are still loaded up-front for now, but
          // will be separate cached chunks.)
          const normalized = id.replace(/\\/g, '/')
          if (normalized.includes('/src/shaders/')) return 'shaders'

          // Keep entities + visualizers together to avoid circular chunk
          // dependencies (visualizers <-> entities).
          if (normalized.includes('/src/js/visualizers/') || normalized.includes('/src/js/entities/')) {
            return 'visuals'
          }

          if (!id.includes('node_modules')) return

          // Keep large deps in their own chunks so the app chunk stays smaller
          // and caches better when app code changes.
          if (id.includes('/three/')) return 'three'
          if (id.includes('/dat.gui/')) return 'datgui'
          if (id.includes('/gsap/')) return 'gsap'
          if (id.includes('/web-audio-beat-detector/')) return 'beat-detector'
          if (id.includes('/butterchurn-presets/')) return 'milkdrop-presets'
          if (id.includes('/butterchurn/')) return 'milkdrop-engine'
          if (id.includes('/@codemirror/') || id.includes('/codemirror/')) return 'codemirror'

          return 'vendor'
        },
      },
    },
  },
  server: {
    host: true,
  },
  resolve: {
    dedupe: ['three'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    glslify(),
    // Instead of copying the 1.6 GB public/ tree on every build, create
    // relative symlinks dist/<name> → ../public/<name> once and leave them.
    // To force a real copy for deployment: rm dist/<name> && cp -r public/<name> dist/<name>
    {
      name: 'symlink-public',
      closeBundle() {
        const outDir = path.resolve(__dirname, 'dist')
        const publicDir = path.resolve(__dirname, 'public')
        mkdirSync(outDir, { recursive: true })
        for (const entry of readdirSync(publicDir)) {
          const dest = path.join(outDir, entry)
          if (existsSync(dest)) {
            // Already there (symlink or real copy) — leave it.
            continue
          }
          // Relative target: from dist/<entry> back up to public/<entry>
          const target = path.join('..', 'public', entry)
          symlinkSync(target, dest)
        }
      },
    },
  ],
})
