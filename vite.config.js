import { defineConfig } from 'vite'
import glslify from 'rollup-plugin-glslify'
import * as path from 'path'
import { readdirSync, symlinkSync, existsSync, lstatSync, readlinkSync, mkdirSync, statSync, createReadStream } from 'fs'

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
    // ── Dev-only: serve /player/ from the local polaris-player-2 checkout ──
    // In production the server serves both /visualizer/ and /player/ directly.
    // Audio source URLs like  ../player/video/…  resolve to /player/… which
    // Vite doesn't know about, causing 404s in dev mode.
    {
      name: 'serve-player',
      apply: 'serve',
      configureServer(server) {
        const playerRoot = path.resolve(__dirname, '../polaris-player-2/parent/player')
        const MIME = {
          '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
          '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml', '.gif': 'image/gif',
          '.json': 'application/json', '.html': 'text/html',
          '.css': 'text/css', '.js': 'application/javascript',
        }
        server.middlewares.use((req, res, next) => {
          if (!req.url.startsWith('/player/')) { next(); return }
          let relPath
          try { relPath = decodeURIComponent(req.url.slice('/player/'.length).split('?')[0]) }
          catch { next(); return }
          const filePath = path.join(playerRoot, relPath)
          // Security: reject path traversal
          if (!filePath.startsWith(playerRoot + path.sep)) { res.writeHead(403); res.end(); return }
          let stat
          try { stat = statSync(filePath) } catch { next(); return }
          if (!stat.isFile()) { next(); return }
          const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
          const cors = {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges',
          }
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors); res.end(); return
          }
          const range = req.headers.range
          if (range) {
            const fileSize = stat.size
            const [s, e] = range.replace(/bytes=/, '').split('-')
            const start = parseInt(s, 10)
            const end   = e ? parseInt(e, 10) : fileSize - 1
            res.writeHead(206, {
              ...cors,
              'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges':  'bytes',
              'Content-Length': end - start + 1,
              'Content-Type':   contentType,
            })
            createReadStream(filePath, { start, end }).on('error', () => res.end()).pipe(res)
          } else {
            res.writeHead(200, {
              ...cors,
              'Content-Length': stat.size,
              'Content-Type':   contentType,
              'Accept-Ranges':  'bytes',
            })
            createReadStream(filePath).on('error', () => res.end()).pipe(res)
          }
        })
      },
    },
    // ── Dev-only: fix %3A (colon) in custom-webgl-previews paths ──
    // Vite's static file server (sirv) uses decodeURI() which intentionally
    // does *not* decode %3A → : (colon is a reserved URI char).  The previews
    // folder contains a subdirectory named "synthetic:Custom WebGL" (with a
    // literal colon), so sirv can't find it and falls back to serving index.html
    // with Content-Type: text/html.  The fetch() in loadCustomWebGLPreviews()
    // sees status 200, creates a blob from the HTML body, and the <img> shows
    // as broken because the blob isn't a valid image.
    //
    // We scope this ONLY to /visualizer/custom-webgl-previews/ to avoid
    // touching Vite's internal /@id/virtual%3Asomething module URLs, which
    // must stay percent-encoded for Vite's own module router to work.
    {
      name: 'decode-static-paths',
      apply: 'serve',
      configureServer(server) {
        const PREFIX = '/visualizer/custom-webgl-previews/'
        server.middlewares.use((req, res, next) => {
          if (typeof req.url === 'string' && req.url.startsWith(PREFIX) && req.url.includes('%')) {
            try { req.url = decodeURIComponent(req.url) } catch { /* leave unchanged */ }
          }
          next()
        })
      },
    },
  ],
})
