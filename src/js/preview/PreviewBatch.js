import { zipSync } from 'fflate'

/**
 * PreviewBatch – captures image previews of every preset in the current group
 * and bundles them into a ZIP download.
 *
 * Each captured preview is keyed by a stable SHA-256 content hash (first 12
 * hex chars, 48 bits) of the preset's JSON file.  This means:
 *   • Re-running capture for the same preset collection is a no-op for
 *     presets already in the store.
 *   • The same preset appearing in multiple groups gets a single entry.
 *
 * Store is module-level so it persists across re-captures within the same
 * page session and clears naturally on page reload.
 * Images are stored in group sub-folders: "<group>/<preset>.<ext>"
 */

/**
 * @typedef {{ filename: string, blob: Blob, presetName: string, group: string, jsonPath: string }} PreviewEntry
 * @type {Map<string, PreviewEntry>}  key = 12-char SHA-256 hex prefix
 */
const _store = new Map()

/** Revocable object URLs for the live preview panel */
const _previewUrls = new Map() // hash → object URL

export default class PreviewBatch {
  constructor() {
    this._running = false
    this._cancelled = false
  }

  isRunning() { return this._running }
  cancel() { if (this._running) this._cancelled = true }
  getCount() { return _store.size }

  /** Revoke all preview blob URLs (call when the panel popup closes). */
  closePreview() {
    for (const url of _previewUrls.values()) URL.revokeObjectURL(url)
    _previewUrls.clear()
  }

  /**
   * Start a batch capture run.
   *
   * @param {Object} opts
   * @param {string[]}          opts.list           Full preset list for the current group
   * @param {number}            opts.startIndex     Index of the currently active preset
   * @param {string}            opts.group          Group name (used as sub-folder in ZIP)
   * @param {(name: string) => Promise<void>} opts.switchTo  Async preset-switch callback
   * @param {() => HTMLCanvasElement|null}    opts.getCanvas Canvas getter (called after switch)
   * @param {(group: string, name: string) => string} [opts.getPresetUrl]
   *   Returns the fetch URL for a preset's JSON.  Defaults to the standard
   *   `butterchurn-presets/<group>/<name>.json` relative URL.
   * @param {number}            [opts.settleDelay=300]  ms to wait after switching
   * @param {'dynamic'|'fixed'} [opts.resolution='fixed']
   * @param {number}            [opts.width=160]
   * @param {number}            [opts.height=160]
   * @param {'PNG'|'JPG'}       [opts.format='PNG']
   * @param {(text: string) => void} [opts.onStatus]  Status string callback
   */
  async startCapture({
    list,
    startIndex,
    group,
    switchTo,
    getCanvas,
    getPresetUrl,
    settleDelay = 300,
    resolution = 'fixed',
    width = 160,
    height = 160,
    format = 'PNG',
    onStatus,
  } = {}) {
    if (this._running) return
    if (!list || list.length === 0) return

    this._running = true
    this._cancelled = false

    const total = list.length
    const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const ext = format === 'JPG' ? 'jpg' : 'png'
    const quality = format === 'JPG' ? 0.92 : undefined
    const groupFolder = _sanitize(group)

    const urlFor = getPresetUrl ??
      ((g, n) => `butterchurn-presets/${encodeURIComponent(g)}/${encodeURIComponent(n)}.json`)

    // ── Load pre-built previews for this group (if any) ──
    // Maps presetName → { hash, imageUrl, imgExt }
    const prebuilt = await _loadPreviewIndex(group)
    onStatus?.(`Starting capture (0 / ${total}${prebuilt.size ? `, ${prebuilt.size} pre-built` : ''})…`)

    let captured = 0
    let skipped = 0
    let fromDisk = 0

    for (let i = 0; i < total; i++) {
      if (this._cancelled) break

      const idx = (startIndex + i) % total
      const name = list[idx]

      if (!name) continue  // skip empty/falsy entries in the list

      // ── Fetch preset JSON and compute stable hash ──
      let hash = null
      try {
        const resp = await fetch(urlFor(group, name))
        if (resp.ok) hash = await _sha256short(await resp.text())
      } catch { /* network failure — fall through */ }

      // Already in store — nothing to do
      if (hash !== null && _store.has(hash)) {
        skipped++
        onStatus?.(`Loading ${fromDisk + captured} / ${total} (${skipped} skipped)`)
        continue
      }

      // ── Pre-built image available for this exact hash? ──
      if (hash !== null) {
        const pb = prebuilt.get(hash)
        if (pb) {
          try {
            const imgResp = await fetch(pb.imageUrl)
            if (imgResp.ok) {
              const blob = await imgResp.blob()
              const filename = `${groupFolder}/${_sanitize(name)}.${pb.imgExt}`
              const jsonPath = `${group}/${name}.json`
              _store.set(hash, { filename, blob, presetName: name, group, jsonPath })
              fromDisk++
              onStatus?.(`Loading ${fromDisk + captured} / ${total}`)
              continue
            }
          } catch { /* image fetch failed — fall through to canvas capture */ }
        }
      }

      // No pre-built image — fall through to live canvas capture
      if (hash === null) {
        console.warn(`[PreviewBatch] skipping "${name}" — could not fetch / hash preset JSON`)
        continue
      }

      // Switch to preset
      try {
        await switchTo(name)
      } catch (err) {
        console.warn(`[PreviewBatch] switchTo failed for "${name}":`, err)
        continue
      }

      // Settle: allow the preset a few rendered frames
      await _sleep(settleDelay)

      if (this._cancelled) break

      // Capture inside the next RAF callback so the WebGL backbuffer is intact
      const canvas = getCanvas()
      if (!canvas) {
        console.warn('[PreviewBatch] No canvas available for', name)
        continue
      }

      let blob
      if (resolution === 'fixed') {
        blob = await _captureFixedInRAF(canvas, width, height, mimeType, quality)
      } else {
        blob = await _captureInRAF(canvas, mimeType, quality)
      }

      if (blob) {
        const filename = `${groupFolder}/${_sanitize(name)}.${ext}`
        const jsonPath = `${group}/${name}.json`
        _store.set(hash, { filename, blob, presetName: name, group, jsonPath })
        captured++
      }

      onStatus?.(`Capturing ${captured} / ${total}`)
    }

    this._running = false

    if (this._cancelled) {
      onStatus?.(`Cancelled — ${fromDisk + captured} loaded${skipped ? `, ${skipped} skipped` : ''}${ fromDisk ? ` (${fromDisk} pre-built)` : ''}. Press Z to ZIP.`)
    } else {
      onStatus?.(`Done — ${fromDisk + captured} loaded${skipped ? `, ${skipped} skipped` : ''}${ fromDisk ? ` (${fromDisk} pre-built, ${captured} new)` : ''}. Press Z to ZIP.`)
    }
  }

  /**
   * Zip all captured previews and trigger a browser download.
   * ZIP contains: image files, index.js (defining `previewMeta` as a Map), index.html viewer.
   *
   * @param {string} groupName  Used only in the downloaded ZIP filename
   */
  async downloadZip(groupName) {
    // Only ZIP entries for the currently active group
    const groupEntries = [..._store.entries()].filter(([, e]) => e.group === groupName)
    if (groupEntries.length === 0) {
      console.warn('[PreviewBatch] Nothing to ZIP for group', groupName, '— capture previews first (X key).')
      return false
    }

    const dt = new Date().toISOString()
      .replace('T', '_').replace(/[:.]/g, '-').slice(0, 19)
    const zipName = `previews-${_sanitize(groupName)}-${dt}.zip`

    const files = {}

    // Image files (keyed by relative path within ZIP)
    for (const [, { filename, blob }] of groupEntries) {
      files[filename] = new Uint8Array(await blob.arrayBuffer())
    }

    // index.js — defines previewMeta Map, loaded by index.html via <script src>
    // Map<hash, jsonPath>  (filename derived: replace .json → .<ext>)
    const ext = groupEntries[0][1].filename.match(/\.(png|jpg)$/i)?.[1] ?? 'png'
    const mapEntries = groupEntries
      .sort(([, a], [, b]) => a.filename.localeCompare(b.filename))
      .map(([hash, { jsonPath }]) =>
        `  [${JSON.stringify(hash)}, ${JSON.stringify(jsonPath)}]`
      )
    files['index.js'] = _enc(
      `const previewExt = ${JSON.stringify(ext)};\nconst previewMeta = new Map([\n${mapEntries.join(',\n')}\n]);\n`
    )

    // index.html — static viewer
    files['index.html'] = _enc(_buildIndexHtml())

    const zipped = zipSync(files)
    const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = zipName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return true
  }

  /**
   * Build the items array the preview panel needs.
   * Creates (or refreshes) blob URLs for every stored image.
   * Returns null if there are no entries for the given group.
   *
   * @param {string} group  Only items whose group matches are returned
   * @returns {Array|null}
   */
  openPreview(group) {
    // Revoke stale URLs first (always, so we don't leak)
    for (const url of _previewUrls.values()) URL.revokeObjectURL(url)
    _previewUrls.clear()

    const items = []
    for (const [hash, entry] of _store) {
      if (entry.group !== group) continue
      const blobUrl = URL.createObjectURL(entry.blob)
      _previewUrls.set(hash, blobUrl)
      items.push({
        hash,
        blobUrl,
        presetName: entry.presetName,
        group: entry.group,
        jsonPath: entry.jsonPath,
      })
    }
    return items.length > 0 ? items : null
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function _sanitize(str) {
  return String(str ?? '').replace(/[/\\:*?"<>|]/g, '_').trim()
}

function _enc(str) {
  return new TextEncoder().encode(str)
}

/**
 * Fetch and parse the pre-built previews index for a group.
 *
 * The file at `butterchurn-presets/<group>/previews/index.js` is a plain JS
 * file that defines `previewMeta` (Map<hash, jsonPath>) and `previewExt`.
 * We execute it with `new Function` to extract those values.
 *
* Returns a Map<hash, { imageUrl, imgExt }> so the capture loop can look up
 * pre-built images by the preset JSON's SHA-256 hash instead of by filename.
 */
async function _loadPreviewIndex(group) {
  const url = `butterchurn-presets/${encodeURIComponent(group)}/previews/index.js`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return new Map()
    const code = await resp.text()
    // Execute the script to extract its exported values
    // eslint-disable-next-line no-new-func
    const { previewMeta, previewExt: ext } = new Function(`${code}\nreturn { previewMeta, previewExt }`)() 
    if (!(previewMeta instanceof Map) || !ext) return new Map()

    const base = `butterchurn-presets/${encodeURIComponent(group)}/previews/`
    const result = new Map()  // hash → { imageUrl, imgExt }
    for (const [hash, jsonPath] of previewMeta) {
      if (!hash || hash.startsWith('nohash')) continue
      // Reconstruct the on-disk filename using the same _sanitize() logic the
      // capture loop uses when saving images.  The raw jsonPath may contain ':'
      // and other chars that _sanitize replaces with '_', so we must not
      // URL-encode the original path directly — that would produce %3A instead
      // of the underscore that's actually in the filename.
      const slash = jsonPath.lastIndexOf('/')
      const dir = slash >= 0 ? jsonPath.slice(0, slash) : ''
      const fileBase = jsonPath.slice(slash + 1).replace(/\.json$/i, '')
      const sanitizedFile = _sanitize(fileBase) + '.' + ext
      const relPath = dir ? `${dir}/${sanitizedFile}` : sanitizedFile
      const imageUrl = base + relPath.split('/').map(encodeURIComponent).join('/')
      result.set(hash, { imageUrl, imgExt: ext })
    }
    console.log(`[PreviewBatch] pre-built index for "${group}": ${result.size} entries`)
    return result
  } catch (err) {
    console.warn('[PreviewBatch] could not load preview index:', err)
    return new Map()
  }
}

/**
 * SHA-256 of `text`, returned as the first 12 hex chars (48 bits).
 * Uses the built-in Web Crypto API (no dependencies).
 */
async function _sha256short(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/**
 * Read the canvas inside the next requestAnimationFrame tick.
 * WebGL backbuffers are cleared after compositing, so we must read inside RAF.
 */
function _captureInRAF(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      try { canvas.toBlob(resolve, mimeType, quality) }
      catch (err) { console.warn('[PreviewBatch] toBlob failed:', err); resolve(null) }
    })
  })
}

function _captureFixedInRAF(canvas, w, h, mimeType, quality) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const off = document.createElement('canvas')
      off.width = w; off.height = h
      const ctx = off.getContext('2d')
      if (!ctx) { resolve(null); return }
      try { ctx.drawImage(canvas, 0, 0, w, h); off.toBlob(resolve, mimeType, quality) }
      catch (err) { console.warn('[PreviewBatch] fixed capture failed (tainted canvas?):', err); resolve(null) }
    })
  })
}

// ─── ZIP viewer ───────────────────────────────────────────────────────────────

function _buildIndexHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Previews</title>
<script src="index.js"><\/script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #111; color: #ccc;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 12px;
  padding: 52px 10px 40px;
}
#toolbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(17,17,17,.92); backdrop-filter: blur(6px);
  border-bottom: 1px solid #2a2a2a;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; gap: 8px;
}
#title { color: #888; }
#copy-btn {
  background: #222; border: 1px solid #444; color: #ddd;
  padding: 5px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
}
#copy-btn:hover { background: #2e2e2e; }
#copy-btn .count { color: #fa4; }
.group-section { margin-bottom: 20px; }
.group-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
}
.group-label { color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
.group-count { color: #555; font-size: 11px; }
.group-line { flex: 1; height: 1px; background: #2a2a2a; }
.grid { display: flex; flex-wrap: wrap; gap: 3px; }
.tile {
  position: relative; width: var(--tile-w, 160px); height: var(--tile-h, 160px);
  cursor: pointer; flex-shrink: 0; border-radius: 2px; overflow: hidden;
  background: #111; outline: 2px solid transparent; outline-offset: 0;
}
.tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tile:hover { outline-color: #48c; }
.tile.selected { outline-color: #fa4; }
.tile-cb {
  position: absolute; bottom: 5px; right: 5px;
  width: 15px; height: 15px; cursor: pointer; accent-color: #fa4;
  opacity: 0; transition: opacity 0.1s;
}
.tile:hover .tile-cb { opacity: 0.5; }
.tile.selected .tile-cb { opacity: 0.8; }
#overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.88);
  justify-content: center; align-items: center; cursor: pointer;
}
#overlay.open { display: flex; }
#overlay-img { max-width: 94vw; max-height: 94vh; object-fit: contain; border-radius: 3px; cursor: default; }
#overlay-label {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,.75); color: #eee; padding: 4px 12px;
  border-radius: 3px; font-size: 12px; pointer-events: none;
}
</style>
</head>
<body>
<div id="toolbar">
  <span id="title">Previews</span>
  <button id="copy-btn">Copy selected (<span class="count" id="copy-count">0</span>)</button>
</div>
<div id="root"></div>
<div id="overlay">
  <img id="overlay-img" src="" alt="">
  <div id="overlay-label"></div>
</div>
<script>
(function () {
  // previewMeta is injected by index.js (Map<hash, jsonPath>)
  // filename is derived: jsonPath.replace(/\.json$/i, '.' + previewExt)
  const root = document.getElementById('root')
  const overlay = document.getElementById('overlay')
  const overlayImg = document.getElementById('overlay-img')
  const overlayLabel = document.getElementById('overlay-label')
  const copyBtn = document.getElementById('copy-btn')
  const copyCountEl = document.getElementById('copy-count')
  const titleEl = document.getElementById('title')

  const entries = [...previewMeta.entries()].map(([hash, jsonPath]) => {
    const filename = jsonPath.replace(/\.json$/i, '.' + previewExt)
    const slash = jsonPath.indexOf('/')
    const group = slash > -1 ? jsonPath.slice(0, slash) : ''
    const name  = jsonPath.slice(slash + 1).replace(/\.json$/i, '')
    return { hash, filename, jsonPath, group, name }
  })
  titleEl.textContent = entries.length + ' previews'

  // Size tiles to match first image's aspect ratio (max 160px per side)
  if (entries.length > 0) {
    const probe = new Image()
    probe.onload = function () {
      const scale = Math.min(160 / probe.naturalWidth, 160 / probe.naturalHeight)
      document.documentElement.style.setProperty('--tile-w', Math.round(probe.naturalWidth  * scale) + 'px')
      document.documentElement.style.setProperty('--tile-h', Math.round(probe.naturalHeight * scale) + 'px')
    }
    probe.src = entries[0].filename
  }

  const groups = new Map()
  for (const e of entries) {
    if (!groups.has(e.group)) groups.set(e.group, [])
    groups.get(e.group).push(e)
  }

  const selected = new Set()
  function updateCount() { copyCountEl.textContent = selected.size }

  for (const [group, items] of groups) {
    const section = document.createElement('div')
    section.className = 'group-section'
    const hdr = document.createElement('div')
    hdr.className = 'group-header'
    hdr.innerHTML =
      '<span class="group-label">' + esc(group || '(root)') + '</span>' +
      '<span class="group-line"></span>' +
      '<span class="group-count">' + items.length + '</span>'
    section.appendChild(hdr)

    const grid = document.createElement('div')
    grid.className = 'grid'
    for (const { filename, jsonPath, name } of items) {
      const tile = document.createElement('div')
      tile.className = 'tile'; tile.title = name
      const img = document.createElement('img')
      img.src = filename; img.alt = name; img.loading = 'lazy'
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.className = 'tile-cb'
      cb.addEventListener('change', (e) => {
        e.stopPropagation()
        if (cb.checked) { selected.add(jsonPath); tile.classList.add('selected') }
        else            { selected.delete(jsonPath); tile.classList.remove('selected') }
        updateCount()
      })
      cb.addEventListener('click', (e) => e.stopPropagation())
      tile.addEventListener('click', () => {
        overlayImg.src = filename; overlayLabel.textContent = name
        overlay.classList.add('open')
      })
      tile.appendChild(img); tile.appendChild(cb); grid.appendChild(tile)
    }
    section.appendChild(grid); root.appendChild(section)
  }

  overlay.addEventListener('click', (e) => { if (e.target !== overlayImg) overlay.classList.remove('open') })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('open') })

  copyBtn.addEventListener('click', () => {
    const json = JSON.stringify([...selected].sort(), null, 2)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).catch(() => fallback(json))
    } else { fallback(json) }
  })
  function fallback(text) {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  }
})()
</script>
</body>
</html>`
}
