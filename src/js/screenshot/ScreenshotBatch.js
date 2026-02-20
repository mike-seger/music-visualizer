import { zipSync } from 'fflate'

/**
 * ScreenshotBatch – captures PNGs/JPGs of every preset in the current group
 * and bundles them into a ZIP download.
 *
 * Store is module-level so it naturally clears on each page load.
 * Files are stored under a group sub-folder: "<group>/<preset>.<ext>"
 * Rebuilding the ZIP always adds index.json + index.html.
 *
 * Switching presets calls the caller-supplied callbacks to avoid circular
 * imports with App.js.
 */

/** @type {Map<string, Blob>} "group/filename.ext" → Blob */
const _store = new Map()

/** @type {Map<string, {jsonPath: string, presetName: string, group: string}>}
 *  store key → original preset metadata */
const _meta = new Map()

/** Revocable object URLs for the live preview window */
const _previewUrls = new Map() // store key → object URL
let _previewWindow = null

export default class ScreenshotBatch {
  constructor() {
    this._running = false
    this._cancelled = false
  }

  isRunning() { return this._running }
  cancel() { if (this._running) this._cancelled = true }
  getCount() { return _store.size }

  /** Close preview popup if open. */
  closePreview() {
    try { if (_previewWindow && !_previewWindow.closed) _previewWindow.close() } catch { /* */ }
    _previewWindow = null
    for (const url of _previewUrls.values()) URL.revokeObjectURL(url)
    _previewUrls.clear()
  }

  /**
   * Start a batch capture run.
   *
   * @param {Object} opts
   * @param {string[]}          opts.list         Full preset list for the current group
   * @param {number}            opts.startIndex   Index of the currently active preset
   * @param {string}            opts.group        Group name (used as sub-folder name in ZIP)
   * @param {(name: string) => Promise<void>} opts.switchTo  Async preset-switch callback
   * @param {() => HTMLCanvasElement|null}    opts.getCanvas Canvas getter (called after each switch)
   * @param {number}            [opts.settleDelay=300]  ms to wait after switching before capture
   * @param {'dynamic'|'fixed'} [opts.resolution='dynamic']
   * @param {number}            [opts.width=640]
   * @param {number}            [opts.height=360]
   * @param {'PNG'|'JPG'}       [opts.format='PNG']
   * @param {(text: string) => void} [opts.onStatus]  Status string callback
   */
  async startCapture({
    list,
    startIndex,
    group,
    switchTo,
    getCanvas,
    settleDelay = 300,
    resolution = 'dynamic',
    width = 640,
    height = 360,
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

    onStatus?.(`Starting capture (0 / ${total})…`)

    let captured = 0
    for (let i = 0; i < total; i++) {
      if (this._cancelled) break

      const idx = (startIndex + i) % total
      const name = list[idx]

      // Switch preset
      try {
        await switchTo(name)
      } catch (err) {
        console.warn(`[ScreenshotBatch] switchTo failed for "${name}":`, err)
        continue
      }

      // Settle: wait the configured delay so the preset renders a few frames
      await _sleep(settleDelay)

      if (this._cancelled) break

      // Capture INSIDE the next RAF callback so the WebGL backbuffer hasn't been
      // cleared yet by the browser's compositing step.
      const canvas = getCanvas()
      if (!canvas) {
        console.warn('[ScreenshotBatch] No canvas available for', name)
        continue
      }

      let blob
      if (resolution === 'fixed') {
        blob = await _captureFixedInRAF(canvas, width, height, mimeType, quality)
      } else {
        blob = await _captureInRAF(canvas, mimeType, quality)
      }

      if (blob) {
        // Store as "<group>/<preset>.<ext>", preserving original case
        const filename = `${groupFolder}/${_sanitize(name)}.${ext}`
        _store.set(filename, blob)
        // Record original metadata so preview and ZIP can emit real JSON paths
        _meta.set(filename, {
          presetName: name,
          group,
          jsonPath: `${group}/${name}.json`,
        })
        captured++
      }

      onStatus?.(`Capturing ${captured} / ${total}`)
    }

    this._running = false

    if (this._cancelled) {
      onStatus?.(`Cancelled — ${captured} captured. Press Z to download.`)
    } else {
      onStatus?.(`Done — ${captured} captured. Press Z to download.`)
    }
  }

  /**
   * Zip all captured screenshots (organised by group sub-folder) and trigger
   * a browser download.  Always includes index.json + index.html.
   * @param {string} groupName  Used in the ZIP filename only
   */
  async downloadZip(groupName) {
    if (_store.size === 0) {
      console.warn('[ScreenshotBatch] Nothing to download — capture first (X key).')
      return false
    }

    const dt = new Date().toISOString()
      .replace('T', '_')
      .replace(/[:.]/g, '-')
      .slice(0, 19)
    const zipName = `screenshots-${_sanitize(groupName)}-${dt}.zip`

    const files = {}

    // Screenshot images
    for (const [path, blob] of _store) {
      const buf = await blob.arrayBuffer()
      files[path] = new Uint8Array(buf)
    }

    // index.json — sorted array of original JSON preset paths (for external use)
    const allPaths = [..._store.keys()].sort()
    const allJsonPaths = allPaths.map((k) => _meta.get(k)?.jsonPath ?? k)
    files['index.json'] = _enc(JSON.stringify(allJsonPaths, null, 2))

    // index.js — data file loaded by index.html via <script src>
    // Two arrays: image file paths and corresponding original JSON paths
    files['index.js'] = _enc(
      `const PATHS = ${JSON.stringify(allPaths)};\n` +
      `const JSON_PATHS = ${JSON.stringify(allJsonPaths)};`
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
   * Open preview.html in a popup and return { popup, items } for the caller
   * to complete the postMessage handshake (preview.html sends 'preview-ready',
   * the caller responds with 'preview-data').
   *
   * @returns {{ popup: Window, items: Array }|null}
   */
  openPreview() {
    if (_store.size === 0) return null

    // Close any existing preview window first
    this.closePreview()

    // Build blob URLs and serialisable items array
    const items = []
    for (const [path, blob] of _store) {
      const blobUrl = URL.createObjectURL(blob)
      _previewUrls.set(path, blobUrl)
      const m = _meta.get(path) ?? {}
      items.push({
        blobUrl,
        presetName: m.presetName ?? path,
        group: m.group ?? '',
        jsonPath: m.jsonPath ?? path,
      })
    }

    const previewUrl = new URL('preview.html', location.href).href
    const w = Math.min(1400, screen.availWidth - 20)
    const h = Math.min(900, screen.availHeight - 40)
    const left = Math.round((screen.availWidth - w) / 2)
    const top  = Math.round((screen.availHeight - h) / 2)

    const popup = window.open(
      previewUrl,
      '_blank',
      `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`
    )
    if (!popup) {
      for (const u of _previewUrls.values()) URL.revokeObjectURL(u)
      _previewUrls.clear()
      return null
    }

    _previewWindow = popup

    // Revoke blob URLs when the popup is closed
    const poll = setInterval(() => {
      if (!_previewWindow || _previewWindow.closed) {
        clearInterval(poll)
        for (const u of _previewUrls.values()) URL.revokeObjectURL(u)
        _previewUrls.clear()
        if (_previewWindow === popup) _previewWindow = null
      }
    }, 1000)

    return { popup, items }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
 * Capture canvas.toBlob() INSIDE the next requestAnimationFrame callback.
 * This is required for WebGL canvases: the backbuffer is cleared by the browser
 * *after* compositing, so we must read it while still inside a RAF tick.
 */
function _captureInRAF(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      try {
        canvas.toBlob(resolve, mimeType, quality)
      } catch (err) {
        console.warn('[ScreenshotBatch] toBlob failed:', err)
        resolve(null)
      }
    })
  })
}

function _captureFixedInRAF(canvas, w, h, mimeType, quality) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const offscreen = document.createElement('canvas')
      offscreen.width = w
      offscreen.height = h
      const ctx = offscreen.getContext('2d')
      if (!ctx) { resolve(null); return }
      try {
        ctx.drawImage(canvas, 0, 0, w, h)
        offscreen.toBlob(resolve, mimeType, quality)
      } catch (err) {
        console.warn('[ScreenshotBatch] fixed capture failed (tainted canvas?):', err)
        resolve(null)
      }
    })
  })
}

// ─── index.html generator ─────────────────────────────────────────────────────

function _buildIndexHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshots</title>
<script src="index.js"><\/script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #111; color: #ccc;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 12px;
  padding: 52px 10px 40px;
}

/* ── Floating toolbar ── */
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
  white-space: nowrap;
}
#copy-btn:hover { background: #2e2e2e; }
#copy-btn .count { color: #fa4; }

/* ── Group sections ── */
.group-section { margin-bottom: 20px; }

.group-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.group-label {
  white-space: nowrap; color: #999;
  font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
}
.group-count { color: #555; font-size: 11px; }
.group-line { flex: 1; height: 1px; background: #2a2a2a; }

/* ── Grid ── */
.grid { display: flex; flex-wrap: wrap; gap: 3px; }

/* ── Tile ── */
.tile {
  position: relative; width: 80px; height: 45px;
  cursor: pointer; flex-shrink: 0; border-radius: 2px; overflow: hidden;
  outline: 2px solid transparent; outline-offset: 0;
}
.tile img {
  width: 80px; height: 45px; object-fit: cover;
  display: block; background: #1c1c1c;
}
.tile:hover { outline-color: #48c; }
.tile.selected { outline-color: #fa4; }

.tile-cb {
  position: absolute; bottom: 3px; right: 3px;
  width: 14px; height: 14px;
  cursor: pointer; accent-color: #fa4;
  opacity: .7;
}
.tile:hover .tile-cb,
.tile.selected .tile-cb { opacity: 1; }

/* ── Overlay ── */
#overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.88);
  justify-content: center; align-items: center;
  cursor: pointer;
}
#overlay.open { display: flex; }
#overlay-img {
  max-width: 94vw; max-height: 94vh;
  object-fit: contain; border-radius: 3px;
  cursor: default;
}
#overlay-label {
  position: absolute; bottom: 12px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,.75); color: #eee;
  padding: 4px 12px; border-radius: 3px;
  font-size: 12px; white-space: nowrap; pointer-events: none;
}
</style>
</head>
<body>

<div id="toolbar">
  <span id="title">Screenshots</span>
  <button id="copy-btn">Copy selected (<span class="count" id="copy-count">0</span>)</button>
</div>

<div id="root"></div>

<div id="overlay">
  <img id="overlay-img" src="" alt="">
  <div id="overlay-label"></div>
</div>

<script>
(function () {
  // PATHS is defined by index.js loaded in <head>
  const root = document.getElementById('root')
  const overlay = document.getElementById('overlay')
  const overlayImg = document.getElementById('overlay-img')
  const overlayLabel = document.getElementById('overlay-label')
  const copyBtn = document.getElementById('copy-btn')
  const copyCountEl = document.getElementById('copy-count')
  const titleEl = document.getElementById('title')

  // ── PATHS and JSON_PATHS are defined in index.js, loaded via <script src> in <head> ──
  const paths = PATHS
  // JSON_PATHS[i] is the original JSON preset path for paths[i]
  // e.g. "cream-of-the-crop/My Cool Preset.json"
  const jsonPaths = typeof JSON_PATHS !== 'undefined' ? JSON_PATHS : paths

  titleEl.textContent = paths.length + ' screenshots'

  // ── Group by folder ──
  const groups = new Map()
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]
    const jp = jsonPaths[i]
    const slash = p.indexOf('/')
    const group = slash > -1 ? p.slice(0, slash) : ''
    const name  = slash > -1 ? p.slice(slash + 1) : p
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({ path: p, jsonPath: jp, name })
  }

  // ── Selection state ──
  const selected = new Set()
  function updateCount() {
    copyCountEl.textContent = selected.size
  }

  // ── Render groups ──
  for (const [group, items] of groups) {
    const section = document.createElement('div')
    section.className = 'group-section'

    // Header
    const hdr = document.createElement('div')
    hdr.className = 'group-header'
    hdr.innerHTML =
      '<span class="group-label">' + esc(group || '(root)') + '</span>' +
      '<span class="group-line"></span>' +
      '<span class="group-count">' + items.length + '</span>'
    section.appendChild(hdr)

    // Grid
    const grid = document.createElement('div')
    grid.className = 'grid'

    for (const { path, jsonPath, name } of items) {
      const tile = document.createElement('div')
      tile.className = 'tile'
      tile.title = name.replace(/\\.(png|jpg)$/i, '')

      const img = document.createElement('img')
      img.src = path
      img.alt = tile.title
      img.loading = 'lazy'

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'tile-cb'

      cb.addEventListener('change', (e) => {
        e.stopPropagation()
        if (cb.checked) { selected.add(jsonPath); tile.classList.add('selected') }
        else            { selected.delete(jsonPath); tile.classList.remove('selected') }
        updateCount()
      })
      cb.addEventListener('click', (e) => e.stopPropagation())

      tile.addEventListener('click', () => {
        overlayImg.src = path
        overlayLabel.textContent = tile.title
        overlay.classList.add('open')
      })

      tile.appendChild(img)
      tile.appendChild(cb)
      grid.appendChild(tile)
    }

    section.appendChild(grid)
    root.appendChild(section)
  }

  // ── Overlay ──
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlayImg) overlay.classList.remove('open')
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.classList.remove('open')
  })

  // ── Copy selected ──
  copyBtn.addEventListener('click', () => {
    const arr = [...selected].sort()
    const json = JSON.stringify(arr, null, 2)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).catch(() => _fallbackCopy(json))
    } else {
      _fallbackCopy(json)
    }
  })

  function _fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
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

// eslint-disable-next-line no-unused-vars
function _buildPreviewHtml(urlMap, meta, presetList) {
  // Build the data needed inline (no external scripts required)
  const paths = [...urlMap.keys()].sort()

  // Build JSON-safe data arrays for inline embedding
  const pathsForEmbed = JSON.stringify(paths)
  const blobUrlsForEmbed = JSON.stringify(paths.map((p) => urlMap.get(p) ?? ''))
  const jsonPathsForEmbed = JSON.stringify(paths.map((p) => meta.get(p)?.jsonPath ?? p))
  const presetListForEmbed = JSON.stringify(presetList)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshot Preview</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #111; color: #ccc;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 12px;
  padding: 52px 10px 40px;
}
/* ── Floating toolbar ── */
#toolbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(17,17,17,.92); backdrop-filter: blur(6px);
  border-bottom: 1px solid #2a2a2a;
  display: flex; align-items: center; flex-wrap: wrap;
  padding: 8px 12px; gap: 8px;
}
#title { color: #888; flex-shrink: 0; }

/* Preset switcher */
#switcher-wrap {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
}
#switcher-label { color: #666; flex-shrink: 0; font-size: 11px; }
#preset-select {
  flex: 1; min-width: 0; max-width: 340px;
  background: #1e1e1e; border: 1px solid #444; color: #ddd;
  padding: 4px 6px; border-radius: 4px; font-size: 11px;
}
#switch-btn {
  background: #2a3a2a; border: 1px solid #4a6a4a; color: #ada;
  padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
  flex-shrink: 0; white-space: nowrap;
}
#switch-btn:hover { background: #3a4a3a; }
#switch-status { color: #666; font-size: 11px; flex-shrink: 0; }

/* Copy button */
#copy-btn {
  background: #222; border: 1px solid #444; color: #ddd;
  padding: 5px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; margin-left: auto;
}
#copy-btn:hover { background: #2e2e2e; }
#copy-btn .count { color: #fa4; }

/* ── Group sections ── */
.group-section { margin-bottom: 20px; }
.group-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.group-label {
  white-space: nowrap; color: #999;
  font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
}
.group-count { color: #555; font-size: 11px; }
.group-line { flex: 1; height: 1px; background: #2a2a2a; }

/* ── Grid ── */
.grid { display: flex; flex-wrap: wrap; gap: 3px; }

/* ── Tile ── */
.tile {
  position: relative; width: 80px; height: 45px;
  cursor: pointer; flex-shrink: 0; border-radius: 2px; overflow: hidden;
  outline: 2px solid transparent; outline-offset: 0;
}
.tile img {
  width: 80px; height: 45px; object-fit: cover;
  display: block; background: #1c1c1c;
}
.tile:hover { outline-color: #48c; }
.tile.selected { outline-color: #fa4; }
.tile-cb {
  position: absolute; bottom: 3px; right: 3px;
  width: 14px; height: 14px;
  cursor: pointer; accent-color: #fa4;
  opacity: .7;
}
.tile:hover .tile-cb,
.tile.selected .tile-cb { opacity: 1; }

/* Switch-to badge on hover */
.tile-switch {
  display: none;
  position: absolute; top: 3px; left: 3px;
  background: rgba(0,160,80,.8); color: #fff;
  font-size: 9px; padding: 2px 4px; border-radius: 2px;
  cursor: pointer; pointer-events: auto;
  line-height: 1.2;
}
.tile:hover .tile-switch { display: block; }

/* ── Overlay ── */
#overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.88);
  justify-content: center; align-items: center;
  cursor: pointer;
}
#overlay.open { display: flex; }
#overlay-img {
  max-width: 94vw; max-height: 94vh;
  object-fit: contain; border-radius: 3px;
  cursor: default;
}
#overlay-label {
  position: absolute; bottom: 12px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,.75); color: #eee;
  padding: 4px 12px; border-radius: 3px;
  font-size: 12px; white-space: nowrap; pointer-events: none;
}
</style>
</head>
<body>
<div id="toolbar">
  <span id="title">Preview</span>
  <div id="switcher-wrap">
    <span id="switcher-label">Switch to:</span>
    <select id="preset-select"></select>
    <button id="switch-btn">Switch</button>
    <span id="switch-status"></span>
  </div>
  <button id="copy-btn">Copy selected (<span class="count" id="copy-count">0</span>)</button>
</div>
<div id="root"></div>
<div id="overlay">
  <img id="overlay-img" src="" alt="">
  <div id="overlay-label"></div>
</div>
<script>
(function () {
  const PATHS      = ${pathsForEmbed}
  const BLOB_URLS  = ${blobUrlsForEmbed}
  const JSON_PATHS = ${jsonPathsForEmbed}
  const PRESET_LIST = ${presetListForEmbed}

  const CHANNEL_NAME = 'visualizer-controls'
  let ch
  try { ch = new BroadcastChannel(CHANNEL_NAME) } catch { ch = null }

  function switchVisualizerTo(name) {
    if (!ch) { statusEl.textContent = 'BroadcastChannel unavailable'; return }
    ch.postMessage({ type: 'select-visualizer', name })
    statusEl.textContent = '↩ ' + name.slice(0, 40)
    setTimeout(() => { statusEl.textContent = '' }, 3000)
  }

  const root       = document.getElementById('root')
  const overlay    = document.getElementById('overlay')
  const overlayImg = document.getElementById('overlay-img')
  const overlayLbl = document.getElementById('overlay-label')
  const copyBtn    = document.getElementById('copy-btn')
  const copyCountEl= document.getElementById('copy-count')
  const titleEl    = document.getElementById('title')
  const selectEl   = document.getElementById('preset-select')
  const switchBtn  = document.getElementById('switch-btn')
  const statusEl   = document.getElementById('switch-status')

  // ── Populate preset switcher ──
  PRESET_LIST.forEach(function(name) {
    var opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    selectEl.appendChild(opt)
  })
  switchBtn.addEventListener('click', function() {
    if (selectEl.value) switchVisualizerTo(selectEl.value)
  })

  titleEl.textContent = PATHS.length + ' screenshots'

  // ── Group by folder ──
  const groups = new Map()
  for (let i = 0; i < PATHS.length; i++) {
    const p  = PATHS[i]
    const bu = BLOB_URLS[i]
    const jp = JSON_PATHS[i]
    const slash = p.indexOf('/')
    const group = slash > -1 ? p.slice(0, slash) : ''
    const name  = slash > -1 ? p.slice(slash + 1) : p
    // Extract preset name (no extension) from jsonPath for display
    const slashJ = jp.lastIndexOf('/')
    const presetName = jp.slice(slashJ + 1).replace(/\\.json$/i, '')
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({ path: p, blobUrl: bu, jsonPath: jp, name, presetName })
  }

  // ── Selection state (tracks jsonPaths) ──
  const selected = new Set()
  function updateCount() { copyCountEl.textContent = selected.size }

  // ── Render groups ──
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

    for (const { blobUrl, jsonPath, name, presetName } of items) {
      const tile = document.createElement('div')
      tile.className = 'tile'
      tile.title = presetName

      const img = document.createElement('img')
      img.src = blobUrl
      img.alt = presetName
      img.loading = 'lazy'

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'tile-cb'

      // "Switch" badge — sends BroadcastChannel to main app
      const swBadge = document.createElement('span')
      swBadge.className = 'tile-switch'
      swBadge.textContent = '▶ switch'
      swBadge.addEventListener('click', function(e) {
        e.stopPropagation()
        switchVisualizerTo(presetName)
      })

      cb.addEventListener('change', function(e) {
        e.stopPropagation()
        if (cb.checked) { selected.add(jsonPath); tile.classList.add('selected') }
        else            { selected.delete(jsonPath); tile.classList.remove('selected') }
        updateCount()
      })
      cb.addEventListener('click', function(e) { e.stopPropagation() })

      tile.addEventListener('click', function() {
        overlayImg.src = blobUrl
        overlayLbl.textContent = presetName
        overlay.classList.add('open')
      })

      tile.appendChild(img)
      tile.appendChild(swBadge)
      tile.appendChild(cb)
      grid.appendChild(tile)
    }

    section.appendChild(grid)
    root.appendChild(section)
  }

  // ── Overlay ──
  overlay.addEventListener('click', function(e) {
    if (e.target !== overlayImg) overlay.classList.remove('open')
  })
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') overlay.classList.remove('open')
  })

  // ── Copy selected (copies original JSON paths) ──
  copyBtn.addEventListener('click', function() {
    const arr = [...selected].sort()
    const json = JSON.stringify(arr, null, 2)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).catch(function() { _fallbackCopy(json) })
    } else {
      _fallbackCopy(json)
    }
  })

  function _fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
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
