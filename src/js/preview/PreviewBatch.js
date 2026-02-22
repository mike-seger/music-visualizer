import { zipSync } from 'fflate'
import butterchurn from 'butterchurn'

/** Reads the overridden butterchurn base path from localStorage (same key as App). */
const _getBcPresetsBase = () => {
  try { return localStorage.getItem('visualizer.bcPresetsBase')?.trim() || 'butterchurn-presets' }
  catch { return 'butterchurn-presets' }
}

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
if (typeof window !== 'undefined') window._previewStore = _store

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

  /**
   * Synchronous reverse-lookup: find the stored hash for a (group, presetName) pair.
   * Returns null if that preset hasn't been captured yet this session.
   */
  findHash(group, presetName) {
    for (const [hash, entry] of _store) {
      if (entry.group === group && entry.presetName === presetName) return hash
    }
    return null
  }

  /**
   * Store a live-captured blob for a preset, replacing any existing entry.
   * Used by the "Snapshot → Current" button to inject a live-canvas image
   * without running a full batch capture.
   *
   * @param {string}      group       Group name
   * @param {string}      presetName  Preset name
   * @param {string|null} hash        SHA hash (null → synthetic key)
   * @param {Blob}        blob        The image blob
   * @returns {{ hash: string, blobUrl: string }}
   */
  storeEntry(group, presetName, hash, blob) {
    const key = hash ?? `snapshot:${group}/${presetName}`
    // Inherit filename / jsonPath from the existing store entry so the ZIP
    // export uses the correct subdirectory (previews/) and file stem casing.
    const existing = hash ? _store.get(hash) : null
    const jsonPath = existing?.jsonPath || presetName
    const filename = existing?.filename || `previews/${_sanitize(presetName)}.png`
    // Revoke any existing URL for this key
    if (_previewUrls.has(key)) {
      URL.revokeObjectURL(_previewUrls.get(key))
      _previewUrls.delete(key)
    }
    const blobUrl = URL.createObjectURL(blob)
    _store.set(key, { filename, blob, presetName, group, jsonPath })
    _previewUrls.set(key, blobUrl)
    return { hash: key, blobUrl }
  }

  /** Revoke all preview blob URLs (call when the panel popup closes). */
  closePreview() {
    for (const url of _previewUrls.values()) URL.revokeObjectURL(url)
    _previewUrls.clear()
  }

  /**
   * Load pre-built preview images for the Shadertoy group from the static
   * `shaders-previews/` directory.  Reads `shaders-previews/settings.json`
   * to discover the image extension, then fetches each image in parallel.
   *
   * Clears any existing store entries for `group` before loading.
   *
   * @param {string}          group       Group name (e.g. 'Shadertoy')
   * @param {string[]}        list        Ordered preset display names
   * @param {Map<string,string>} shaderMeta  displayName → file stem (e.g. 'audio-eclipse')
   * @param {object}          [opts]
   * @param {Function}        [opts.onStatus]
   * @param {Function}        [opts.onCaptured]
   * @returns {Promise<{ loaded: number, missing: string[] }>}
   */
  async loadShaderPreviews(group, list, shaderMeta, { onStatus, onCaptured } = {}) {
    // Clear existing store entries for this group
    for (const [hash, entry] of _store) {
      if (entry.group === group) {
        _store.delete(hash)
        if (_previewUrls.has(hash)) {
          URL.revokeObjectURL(_previewUrls.get(hash))
          _previewUrls.delete(hash)
        }
      }
    }

    // Read image extension from settings.json
    let imgExt = 'png'
    try {
      const resp = await fetch('shaders-previews/settings.json')
      if (resp.ok) {
        const cfg = await resp.json()
        if (typeof cfg['image-type'] === 'string') imgExt = cfg['image-type'].toLowerCase()
      }
    } catch { /* use default png */ }

    const missing = []
    const toFetch = []
    for (const name of list) {
      if (!name) continue
      const stem = shaderMeta.get(name)
      if (!stem) { missing.push(name); continue }
      toFetch.push({ name, stem })
    }

    let loaded = 0
    const CONCURRENCY = 16
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async ({ name, stem }) => {
        const imageUrl = `shaders-previews/${encodeURIComponent(stem)}.${imgExt}`
        const hash = `prebuilt:${_sanitize(group)}/${_sanitize(name)}`
        try {
          const resp = await fetch(imageUrl)
          if (resp.ok) {
            const blob = await resp.blob()
            const filename = `shaders-previews/${stem}.${imgExt}`
            _store.set(hash, { filename, blob, presetName: name, group, jsonPath: stem })
            const blobUrl = URL.createObjectURL(blob)
            _previewUrls.set(hash, blobUrl)
            onCaptured?.({ name, hash, blobUrl, group, jsonPath: stem })
            loaded++
          } else {
            missing.push(name)
          }
        } catch {
          missing.push(name)
        }
      }))
      onStatus?.(`Loading ${loaded} / ${toFetch.length} shader previews…`)
    }

    onStatus?.(`Loaded ${loaded} pre-built${missing.length ? `, ${missing.length} need capture` : ''}. ${
      missing.length ? 'Capturing remaining…' : 'Press Z to ZIP.'
    }`)
    return { loaded, missing }
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
    getFileStem,
    settleDelay = 300,
    resolution = 'fixed',
    width = 160,
    height = 160,
    format = 'PNG',
    skipClear = false,
    onStatus,
    onCaptured,
  } = {}) {
    if (this._running) return
    if (!list || list.length === 0) return

    this._running = true
    this._cancelled = false

    // Clear previous results for this group so re-pressing X always re-captures.
    // skipClear is set when loadShaderPreviews() has already pre-populated the store.
    if (!skipClear) {
      for (const [hash, entry] of _store) {
        if (entry.group === group) _store.delete(hash)
      }
    }

    const total = list.length
    const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const ext = format === 'JPG' ? 'jpg' : 'png'
    const quality = format === 'JPG' ? 0.92 : undefined
    const groupFolder = _sanitize(group)

    const urlFor = getPresetUrl ??
      ((g, n) => `${_getBcPresetsBase()}/${encodeURIComponent(g)}/presets/${encodeURIComponent(n)}.json`)

    // ── Load pre-built previews for this group (if any) ──
    // Returns { byHash: Map<hash,{imageUrl,imgExt}>, byName: Map<presetName,hash> }
    const prebuilt = await _loadPreviewIndex(group)
    onStatus?.(`Starting…`)

    let captured = 0
    let skipped = 0
    let fromDisk = 0

    // Phase 1 -- load pre-built images in parallel, no JSON fetches needed.
    // The index maps presetName -> hash directly, so we skip the expensive
    // per-preset JSON fetch entirely.  Images are fetched CONCURRENCY at a
    // time so we don't open thousands of connections at once.
    const CONCURRENCY = 64

    if (prebuilt.byName.size > 0) {
      const prebuiltWork = []
      for (let i = 0; i < total; i++) {
        const name = list[i]
        if (!name) continue
        const hash = prebuilt.byName.get(name)
        if (!hash) continue
        if (_store.has(hash) && _store.get(hash).group === group) { skipped++; continue }
        prebuiltWork.push({ name, hash })
      }

      onStatus?.(`Loading 0 / ${prebuiltWork.length} pre-built previews…`)

      for (let i = 0; i < prebuiltWork.length && !this._cancelled; i += CONCURRENCY) {
        const batch = prebuiltWork.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(async ({ name, hash }) => {
          const pb = prebuilt.byHash.get(hash)
          if (!pb) return
          try {
            const imgResp = await fetch(pb.imageUrl)
            if (imgResp.ok) {
              const blob = await imgResp.blob()
              const fileStem = getFileStem ? getFileStem(name) : name
              const filename = `previews/${_sanitize(fileStem)}.${pb.imgExt}`
              const jsonPath = fileStem
              _store.set(hash, { filename, blob, presetName: name, group, jsonPath })
              fromDisk++
            }
          } catch { /* image unavailable -- will fall through to canvas capture */ }
        }))
        onStatus?.(`Loading ${fromDisk} / ${prebuiltWork.length} pre-built…`)
      }
    }

    // Phase 2 -- sequential canvas capture for everything not yet in store.
    // Covers (a) presets absent from the index, (b) prebuilt images that
    // failed to fetch.  Starts from startIndex so the current preset is captured first.
    const toCapture = []
    for (let i = 0; i < total; i++) {
      const idx = (startIndex + i) % total
      const name = list[idx]
      if (!name) continue
      const knownHash = prebuilt.byName.get(name)
      if (knownHash && _store.has(knownHash) && _store.get(knownHash).group === group) continue
      toCapture.push(name)
    }

    for (const name of toCapture) {
      if (this._cancelled) break

      let hash = prebuilt.byName.get(name) ?? null
      if (!hash) {
        try {
          let resp = await fetch(urlFor(group, name))
          if (!resp.ok && !getPresetUrl) {
            // Fallback: try old top-level location
            resp = await fetch(`${_getBcPresetsBase()}/${encodeURIComponent(group)}/${encodeURIComponent(name)}.json`)
          }
          if (resp.ok) hash = await _sha256short(await resp.text())
        } catch { /* network failure */ }
      }

      if (hash !== null && _store.has(hash) && _store.get(hash).group === group) { skipped++; continue }

      if (hash === null) {
        // No JSON available (e.g. Shadertoy / Custom WebGL shaders); use a
        // stable synthetic key so the preset still gets captured.
        hash = `synthetic:${_sanitize(group)}/${_sanitize(name)}`
      }

      try {
        await switchTo(name)
      } catch (err) {
        console.warn(`[PreviewBatch] switchTo failed for "${name}":`, err)
        continue
      }

      await _sleep(settleDelay)
      if (this._cancelled) break

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
        const fileStem = getFileStem ? getFileStem(name) : name
        const filename = `previews/${_sanitize(fileStem)}.${ext}`
        const jsonPath = fileStem
        _store.set(hash, { filename, blob, presetName: name, group, jsonPath })
        const blobUrl = URL.createObjectURL(blob)
        _previewUrls.set(hash, blobUrl)
        onCaptured?.({ name, hash, blobUrl, group, jsonPath })
        captured++
      }

      onStatus?.(`Capturing ${captured} / ${toCapture.length}`)
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
  async downloadZip(groupName, filterHashes = null) {
    // Only ZIP entries for the currently active group; optionally restricted to selected hashes
    const groupEntries = [..._store.entries()].filter(([hash, e]) =>
      e.group === groupName && (!filterHashes || filterHashes.has(hash))
    )
    if (groupEntries.length === 0) {
      console.warn('[PreviewBatch] Nothing to ZIP for group', groupName, '— capture previews first (X key).')
      return false
    }

    const dt = new Date().toISOString()
      .replace('T', '_').replace(/[:.]/g, '-').slice(0, 19)
    const selSuffix = filterHashes ? `-${filterHashes.size}sel` : ''
    const zipName = `previews-${_sanitize(groupName)}${selSuffix}-${dt}.zip`

    const files = {}

    // Image files — at previews/<sanitized>.<ext> within the ZIP
    for (const [, { filename, blob }] of groupEntries) {
      files[filename] = new Uint8Array(await blob.arrayBuffer())
    }

    // index.js — defines previewMeta Map (hash → presetName), at the group root
    const ext = groupEntries[0][1].filename.match(/\.(png|jpg)$/i)?.[1] ?? 'png'
    const mapEntries = groupEntries
      .sort(([, a], [, b]) => a.presetName.localeCompare(b.presetName))
      .map(([hash, { jsonPath }]) =>
        `  [${JSON.stringify(hash)}, ${JSON.stringify(jsonPath)}]`
      )
    files['index.js'] = _enc(
      `const previewExt = ${JSON.stringify(ext)};\nconst previewMeta = new Map([\n${mapEntries.join(',\n')}\n]);\n`
    )

    // presets/<sanitized>.json — the raw preset JSON for each captured preview
    await Promise.all(groupEntries.map(async ([, entry]) => {
      if (entry.filename.startsWith('shaders-previews/')) return  // no JSON for GLSL shaders
      const g = encodeURIComponent(entry.group)
      const n = encodeURIComponent(entry.jsonPath)
      let resp = await fetch(`${_getBcPresetsBase()}/${g}/presets/${n}.json`).catch(() => null)
      if (!resp?.ok) resp = await fetch(`${_getBcPresetsBase()}/${g}/${n}.json`).catch(() => null)
      if (resp?.ok) files[`presets/${entry.jsonPath}.json`] = new Uint8Array(await resp.arrayBuffer())
    }))

    // For shader groups, include shaders-previews/settings.json in the ZIP as-is
    if (groupEntries.some(([, e]) => e.filename.startsWith('shaders-previews/'))) {
      try {
        const resp = await fetch('shaders-previews/settings.json')
        if (resp.ok) files['shaders-previews/settings.json'] = new Uint8Array(await resp.arrayBuffer())
      } catch { /* ignore */ }
    }

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
   * Load pre-built preview images for a group without any canvas capture.
   * Fetches `butterchurn-presets/<group>/previews/index.js` to discover
   * which presets have pre-built images, then fetches those images in
   * parallel (64 at a time) and stores them in `_store`.
   *
   * Returns the set of preset names that are NOT covered by pre-built images
   * (i.e. they would require canvas capture).
   *
   * @param {string}   group
   * @param {string[]} list          Ordered preset names for the group
   * @param {object}   [opts]
   * @param {(name: string) => string} [opts.getFileStem]  Name → file stem
   * @param {(text: string) => void}  [opts.onStatus]
   * @returns {Promise<{ missingNames: string[] }>}
   */
  async loadPrebuilt(group, list, { getFileStem, onStatus } = {}) {
    const prebuilt = await _loadPreviewIndex(group)

    if (prebuilt.byName.size === 0) {
      // No pre-built index — everything would need canvas capture
      return { missingNames: list.filter(Boolean) }
    }

    const CONCURRENCY = 64
    const toFetch = []
    for (const name of list) {
      if (!name) continue
      const hash = prebuilt.byName.get(name)
      if (!hash) continue
      if (_store.has(hash) && _store.get(hash).group === group) continue
      toFetch.push({ name, hash })
    }

    let loaded = 0
    for (let i = 0; i < toFetch.length && !this._cancelled; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async ({ name, hash }) => {
        const pb = prebuilt.byHash.get(hash)
        if (!pb) return
        try {
          const resp = await fetch(pb.imageUrl)
          if (resp.ok) {
            const blob = await resp.blob()
            const fileStem = getFileStem ? getFileStem(name) : name
            _store.set(hash, {
              filename: `previews/${_sanitize(fileStem)}.${pb.imgExt}`,
              blob,
              presetName: name,
              group,
              jsonPath: fileStem,
            })
            loaded++
          }
        } catch { /* unavailable */ }
      }))
      onStatus?.(`Loading previews… ${loaded} / ${toFetch.length}`)
    }

    // Names with no pre-built image (need canvas capture)
    const missingNames = list.filter((name) => {
      if (!name) return false
      const hash = prebuilt.byName.get(name)
      if (!hash) return true  // not in index at all
      return !(_store.has(hash) && _store.get(hash).group === group)
    })

    return { missingNames }
  }

  /**
   * Capture preview thumbnails for all presets in `group` using a fully
   * independent offscreen Butterchurn instance driven by `audioUrl`.
   *
   * Phase 1 — loads any pre-built on-disk images (same parallel fetch as
   *            `startCapture`).
   * Phase 2 — canvas-captures anything still missing using an offscreen
   *            <canvas> + its own AudioContext + the provided audio clip.
   *            The main visualizer is never interrupted.
   *
   * @param {Object} opts
   * @param {string[]}  opts.list
   * @param {string}    opts.group
   * @param {string}    opts.audioUrl          URL of the audio clip to drive the viz
   * @param {Function}  [opts.getPresetUrl]
   * @param {Function}  [opts.getFileStem]
   * @param {number}    [opts.settleDelay=300]  ms of rendered frames before capture
   * @param {'fixed'|'dynamic'} [opts.resolution='fixed']
   * @param {number}    [opts.width=160]
   * @param {number}    [opts.height=90]
   * @param {'PNG'|'JPG'} [opts.format='PNG']
   * @param {Function}  [opts.onStatus]
   */
  async startOffscreenCapture({
    list,
    group,
    audioUrl,
    getPresetUrl,
    getFileStem,
    settleDelay = 300,
    settleDelayMax = null,   // if > settleDelay, use random ms per preset in [settleDelay, settleDelayMax]
    forceCapture = false,    // re-capture even if already in _store
    resolution = 'fixed',
    width = 160,
    height = 90,
    format = 'PNG',
    onStatus,
    onCaptured,
  } = {}) {
    if (this._running) return
    if (!list || list.length === 0) return

    this._running = true
    this._cancelled = false

    const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const ext      = format === 'JPG' ? 'jpg' : 'png'
    const quality  = format === 'JPG' ? 0.92 : undefined
    const tw = width
    const th = height

    const urlFor = getPresetUrl ??
      ((g, n) => `${_getBcPresetsBase()}/${encodeURIComponent(g)}/presets/${encodeURIComponent(n)}.json`)

    // ── Phase 1: load pre-built images ────────────────────────────────────────
    const prebuilt = await _loadPreviewIndex(group)
    const CONCURRENCY = 64

    if (prebuilt.byName.size > 0) {
      const toFetch = []
      for (const name of list) {
        if (!name) continue
        const hash = prebuilt.byName.get(name)
        if (!hash) continue
        if (_store.has(hash) && _store.get(hash).group === group) continue
        toFetch.push({ name, hash })
      }

      let loaded = 0
      for (let i = 0; i < toFetch.length && !this._cancelled; i += CONCURRENCY) {
        const batch = toFetch.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(async ({ name, hash }) => {
          const pb = prebuilt.byHash.get(hash)
          if (!pb) return
          try {
            const resp = await fetch(pb.imageUrl)
            if (resp.ok) {
              const blob = await resp.blob()
              const stem = getFileStem ? getFileStem(name) : name
              _store.set(hash, {
                filename: `previews/${_sanitize(stem)}.${pb.imgExt}`,
                blob, presetName: name, group, jsonPath: stem,
              })
              loaded++
            }
          } catch { /* unavailable */ }
        }))
        onStatus?.(`Loading ${loaded} / ${toFetch.length} pre-built…`)
      }
    }

    // ── Phase 2: offscreen butterchurn for remaining (or forced) presets ──────
    const toCapture = list.filter((name) => {
      if (!name) return false
      if (forceCapture) return true  // always re-capture when forcing regen
      const hash = prebuilt.byName.get(name)
      if (hash && _store.has(hash) && _store.get(hash).group === group) return false
      return true
    })

    if (toCapture.length === 0 || this._cancelled) {
      this._running = false
      const total = list.length - toCapture.length
      onStatus?.(this._cancelled
        ? `Cancelled — ${total} loaded. Press Z to ZIP.`
        : `Done — all ${total} pre-built. Press Z to ZIP.`)
      return
    }

    // Set up isolated audio context + butterchurn instance
    let audioCtx  = null
    let audioEl   = null
    let viz       = null
    let offCanvas = null

    try {
      audioCtx = new AudioContext()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024

      if (audioUrl) {
        // Use AudioBufferSourceNode with loop=true for true gapless looping.
        // HTMLMediaElement always has a small gap at the loop point;
        // BufferSource is sample-accurate and has none.
        try {
          const resp = await fetch(audioUrl)
          const arrayBuf = await resp.arrayBuffer()
          const audioBuf = await audioCtx.decodeAudioData(arrayBuf)
          audioEl = audioCtx.createBufferSource()
          audioEl.buffer = audioBuf
          audioEl.loop = true
          audioEl.connect(analyser)
          // intentionally NOT connecting analyser to destination — audio
          // feeds butterchurn only, nothing goes to the speakers
          await audioCtx.resume()
          audioEl.start(0)
        } catch (audioErr) {
          console.warn('[PreviewBatch] audio load failed, capturing silent:', audioErr?.message ?? audioErr)
          await audioCtx.resume()
        }
      }

      // Canvas must be in the document for butterchurn's 2D copy step to work
      offCanvas = document.createElement('canvas')
      offCanvas.width  = tw
      offCanvas.height = th
      offCanvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none'
      document.body.appendChild(offCanvas)

      viz = butterchurn.createVisualizer(audioCtx, offCanvas, {
        width: tw, height: th, pixelRatio: 1, textureRatio: 1,
      })
      viz.connectAudio(analyser)
    } catch (err) {
      console.error('[PreviewBatch] offscreen setup failed:', err)
      onStatus?.('Offscreen setup failed: ' + (err?.message ?? err))
      this._running = false
      if (offCanvas) offCanvas.remove()
      try { audioEl?.stop(); if (audioCtx) await audioCtx.close() } catch { /* */ }
      return
    }

    let captured = 0
    onStatus?.(`Capturing ${toCapture.length} previews…`)

    for (const name of toCapture) {
      if (this._cancelled) break

      let presetJson = null
      let hash = prebuilt.byName.get(name) ?? null

      try {
        const resp = await fetch(urlFor(group, name))
        if (resp.ok) {
          const text = await resp.text()
          presetJson = JSON.parse(text)
          if (!hash) hash = await _sha256short(text)
        }
      } catch { /* network failure */ }

      if (!presetJson || !hash) {
        console.warn(`[PreviewBatch] skip (no data) "${name}"`)
        continue
      }
      if (!forceCapture && _store.has(hash) && _store.get(hash).group === group) continue

      // Per-preset settle: random between settleDelay and settleDelayMax when regen
      const thisSettle = (settleDelayMax != null && settleDelayMax > settleDelay)
        ? settleDelay + Math.random() * (settleDelayMax - settleDelay)
        : settleDelay

      let blob = null
      try {
        viz.loadPreset(presetJson, 0)

        // Render for thisSettle ms so the preset's initial animation plays out
        const t0 = performance.now()
        while (performance.now() - t0 < thisSettle) {
          if (this._cancelled) break
          viz.render()
          await _sleep(16)
        }
        if (this._cancelled) break

        viz.render() // final render before capturing

        blob = await new Promise((res) => {
          try { offCanvas.toBlob(res, mimeType, quality) }
          catch (e) { console.warn('[PreviewBatch] toBlob failed:', e); res(null) }
        })
      } catch (err) {
        console.warn(`[PreviewBatch] skip (render error) "${name}":`, err?.message ?? err)
      }

      if (blob) {
        const stem = getFileStem ? getFileStem(name) : name
        _store.set(hash, {
          filename: `previews/${_sanitize(stem)}.${ext}`,
          blob, presetName: name, group, jsonPath: stem,
        })
        // Create blob URL and fire progressive callback immediately
        const blobUrl = URL.createObjectURL(blob)
        _previewUrls.set(hash, blobUrl)
        onCaptured?.({ name, hash, blobUrl, group, jsonPath: stem })
        captured++
      }

      if (captured % 5 === 0 || captured === toCapture.length) {
        onStatus?.(`Capturing ${captured} / ${toCapture.length}…`)
      }
    }

    // ── Teardown ──────────────────────────────────────────────────────────────
    offCanvas.remove()
    try {
      if (audioEl) audioEl.stop()
      await audioCtx.close()
    } catch { /* ignore */ }

    this._running = false
    const total = list.length - toCapture.length + captured
    onStatus?.(this._cancelled
      ? `Cancelled — ${captured} captured, ${total - captured} pre-built. Press Z to ZIP.`
      : `Done — ${captured} captured, ${total - captured} pre-built. Press Z to ZIP.`)
  }

  /**
   * Capture preview images for a Shadertoy group using an independent offscreen
   * WebGL1 canvas — no interruption of the live visualizer.
   *
   * For each shader: fetch the GLSL source, inject a standard preamble, compile
   * it in a throw-away WebGL program, render `settleDelay` ms worth of frames,
   * then capture.  Shaders that fail to compile or render are skipped silently.
   *
   * @param {Object}      opts
   * @param {string[]}    opts.list           Preset display names to capture
   * @param {string}      opts.group          Group name (used as store key)
   * @param {Map}         opts.shaderMeta     name → filename (e.g. 'audio-eclipse.glsl')
   * @param {string}      opts.presetBase     Base URL, e.g. '/shadertoy-presets/default'
   * @param {number}      [opts.settleDelay]  ms to render before capture (default 500)
   * @param {'fixed'|'dynamic'} [opts.resolution]
   * @param {number}      [opts.width=160]
   * @param {number}      [opts.height=90]
   * @param {'PNG'|'JPG'} [opts.format='PNG']
   * @param {boolean}     [opts.forceCapture] Re-capture even if already stored
   * @param {Function}    [opts.onStatus]
   * @param {Function}    [opts.onCaptured]
   */
  async startOffscreenShaderCapture({
    list,
    group,
    shaderMeta,
    presetBase,
    settleDelay = 500,
    resolution = 'fixed',
    width = 160,
    height = 90,
    format = 'PNG',
    forceCapture = false,
    onStatus,
    onCaptured,
  } = {}) {
    if (this._running) return
    if (!list || list.length === 0) return

    this._running = true
    this._cancelled = false

    // Clear existing store entries for this group unless we're just forcing
    // specific presets (regen path keeps previously loaded previews)
    if (!forceCapture) {
      for (const [hash, entry] of _store) {
        if (entry.group === group && !hash.startsWith('prebuilt:')) _store.delete(hash)
      }
    }

    const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const ext      = format === 'JPG' ? 'jpg' : 'png'
    const quality  = format === 'JPG' ? 0.92 : undefined

    // Create an independent offscreen canvas with its own WebGL context
    const offCanvas = document.createElement('canvas')
    offCanvas.width  = width
    offCanvas.height = height
    offCanvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none'
    document.body.appendChild(offCanvas)

    const gl = offCanvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false })
           || offCanvas.getContext('experimental-webgl', { preserveDrawingBuffer: true })

    if (!gl) {
      console.warn('[PreviewBatch] WebGL not available for offscreen shader capture')
      offCanvas.remove()
      this._running = false
      onStatus?.('WebGL unavailable — cannot capture shader previews offscreen.')
      return
    }

    // Shared black 1×1 texture bound to all iChannel slots
    const blackTex = _makeBlackTex1x1(gl)

    // Shared fullscreen-quad VBOs
    const posBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,-1,0, 1,1,0, -1,1,0]), gl.STATIC_DRAW)
    const uvBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]), gl.STATIC_DRAW)

    let captured = 0
    onStatus?.(`Preparing offscreen shader capture (${list.length})…`)

    for (const name of list) {
      if (this._cancelled) break

      const file = shaderMeta?.get(name)
      if (!file) continue

      const hash = `prebuilt:${_sanitize(group)}/${_sanitize(name)}`
      if (!forceCapture && _store.has(hash) && _store.get(hash).group === group) continue

      let source = ''
      try {
        const resp = await fetch(`${presetBase}/presets/${encodeURIComponent(file)}`)
        if (resp.ok) source = await resp.text()
      } catch { /* skip */ }
      if (!source) { console.warn(`[PreviewBatch] skip (no source) "${name}"`); continue }

      // Build fragment source with preamble + compat transforms
      const fragSrc = _buildPreviewFragment(source)

      let program = null
      try { program = _compilePreviewProgram(gl, fragSrc) }
      catch (err) {
        console.warn(`[PreviewBatch] shader compile skipped "${name}":`, String(err.message).split('\n')[0])
        continue
      }

      let blob = null
      try {
        gl.viewport(0, 0, width, height)
        gl.useProgram(program)

        // Render frames for settleDelay ms so the animation reaches a good frame
        const t0 = performance.now()
        while (performance.now() - t0 < settleDelay) {
          if (this._cancelled) break
          _drawPreviewFrame(gl, program, posBuf, uvBuf, blackTex, width, height, (performance.now() - t0) / 1000 + 1.5)
          await _sleep(16)
        }
        if (!this._cancelled) {
          _drawPreviewFrame(gl, program, posBuf, uvBuf, blackTex, width, height, settleDelay / 1000 + 1.5)
        }

        blob = await new Promise((res) => {
          try { offCanvas.toBlob(res, mimeType, quality) }
          catch (e) { console.warn('[PreviewBatch] toBlob failed:', e); res(null) }
        })
      } catch (err) {
        console.warn(`[PreviewBatch] render failed "${name}":`, err?.message ?? err)
      } finally {
        gl.deleteProgram(program)
      }

      if (blob) {
        const stem = file.replace(/\.glsl$/i, '')
        _store.set(hash, {
          filename: `shaders-previews/${stem}.${ext}`,
          blob, presetName: name, group, jsonPath: stem,
        })
        const blobUrl = URL.createObjectURL(blob)
        _previewUrls.set(hash, blobUrl)
        onCaptured?.({ name, hash, blobUrl, group, jsonPath: stem })
        captured++
      }

      if (captured % 5 === 0 || captured === list.length) {
        onStatus?.(`Capturing ${captured}… (${list.length - captured} remaining)`)
      }
    }

    // Cleanup
    gl.deleteTexture(blackTex)
    gl.deleteBuffer(posBuf)
    gl.deleteBuffer(uvBuf)
    offCanvas.remove()

    this._running = false
    onStatus?.(this._cancelled
      ? `Cancelled — ${captured} captured. Press Z to ZIP.`
      : `Done — ${captured} captured. Press Z to ZIP.`)
  }

  /**
   * Build the items array the preview panel needs.
   * Creates (or refreshes) blob URLs for every stored image.
   * Returns null if there are no entries for the given group.
   *
   * @param {string} group  Only items whose group matches are returned
   * @returns {Array|null}
   */
  openPreview(group, orderedNames) {
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
    if (items.length === 0) return null

    // Sort to match the preset list order (same order as the controls List dropdown)
    if (orderedNames && orderedNames.length > 0) {
      const idx = new Map(orderedNames.map((n, i) => [n, i]))
      items.sort((a, b) => {
        const ai = idx.has(a.presetName) ? idx.get(a.presetName) : Infinity
        const bi = idx.has(b.presetName) ? idx.get(b.presetName) : Infinity
        return ai - bi
      })
    }
    return items
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

// ─── Offscreen shader preview renderer ───────────────────────────────────────
// Lightweight standalone WebGL1 renderer used by startOffscreenShaderCapture.
// Has NO dependency on Three.js or App — pure WebGL1 API.

const _PREVIEW_VERT = /* glsl */`
autribute vec3 position;
autribute vec2 uv;
void main() { gl_Position = vec4(position, 1.0); }
`

/** Inject a Shadertoy-compatible preamble and wrap in main() if needed. */
function _buildPreviewFragment(source) {
  // Strip existing precision statements; we inject our own
  let body = String(source)
    .replace(/^\s*precision\s+\w+\s+\w+\s*;\s*\n?/gm, '')
    // texture() → texture2D()  (WebGL1)
    .replace(/\btexture\s*\(/g, 'texture2D(')
    // float literal suffix: 1.0f → 1.0
    .replace(/(\b(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)f\b/g, '$1')

  const preamble = [
    'precision highp float;',
    'precision highp int;',
    'uniform vec3  iResolution;',
    'uniform float uPixelRatio;',
    'uniform float iTime;',
    'uniform float iTimeDelta;',
    'uniform float iFrameRate;',
    'uniform int   iFrame;',
    'uniform vec4  iMouse;',
    'uniform vec4  iDate;',
    'uniform float iSampleRate;',
    'uniform sampler2D iChannel0;',
    'uniform sampler2D iChannel1;',
    'uniform sampler2D iChannel2;',
    'uniform sampler2D iChannel3;',
    'uniform vec3  iChannelResolution[4];',
    'uniform float iChannelTime[4];',
  ].join('\n')

  const hasMain = /void\s+main\s*\(/.test(body)
  const wrapper = hasMain ? '' :
    '\nvoid main() {\n  vec4 c = vec4(0.0);\n  mainImage(c, gl_FragCoord.xy);\n  c.a = 1.0;\n  gl_FragColor = c;\n}\n'

  return `${preamble}\n${body}\n${wrapper}`
}

/** Compile a minimal preview WebGL1 program; throws on error. */
function _compilePreviewProgram(gl, fragSrc) {
  function compile(src, type) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error(log)
    }
    return sh
  }
  const vert = compile(_PREVIEW_VERT, gl.VERTEX_SHADER)
  const frag = compile(fragSrc, gl.FRAGMENT_SHADER)
  const prog = gl.createProgram()
  gl.attachShader(prog, vert)
  gl.attachShader(prog, frag)
  gl.linkProgram(prog)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error(log)
  }
  return prog
}

/** Create a 1×1 opaque black texture. */
function _makeBlackTex1x1(gl) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

/** Render one frame with the given iTime value. */
function _drawPreviewFrame(gl, prog, posBuf, uvBuf, blackTex, w, h, iTime) {
  const u = (n) => gl.getUniformLocation(prog, n)
  const d = new Date()

  gl.uniform3f(u('iResolution'), w, h, 1.0)
  gl.uniform1f(u('uPixelRatio'), 1.0)
  gl.uniform1f(u('iTime'), iTime)
  gl.uniform1f(u('iTimeDelta'), 1 / 60)
  gl.uniform1f(u('iFrameRate'), 60.0)
  gl.uniform1i(u('iFrame'), Math.floor(iTime * 60))
  gl.uniform4f(u('iMouse'), 0, 0, 0, 0)
  gl.uniform4f(u('iDate'), d.getFullYear(), d.getMonth(), d.getDate(), d.getSeconds())
  gl.uniform1f(u('iSampleRate'), 44100.0)
  // Bind black texture to iChannel0-3
  for (let i = 0; i < 4; i++) {
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, blackTex)
    const loc = gl.getUniformLocation(prog, `iChannel${i}`)
    if (loc !== null) gl.uniform1i(loc, i)
  }
  gl.uniform3fv(u('iChannelResolution'), [512,2,1, 512,2,1, 512,2,1, 512,2,1])
  gl.uniform1fv(u('iChannelTime'), [0,0,0,0])

  // Draw fullscreen quad
  const posLoc = gl.getAttribLocation(prog, 'position')
  const uvLoc  = gl.getAttribLocation(prog, 'uv')
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  if (posLoc >= 0) { gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0) }
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
  if (uvLoc >= 0) { gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0) }
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function _sanitize(str) {
  return String(str ?? '').replace(/[/\\*?"<>|]/g, '_').trim()
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
  const url = `${_getBcPresetsBase()}/${encodeURIComponent(group)}/index.js?t=${Date.now()}`
  try {
    const resp = await fetch(url, { cache: 'no-store' })
    if (!resp.ok) return { byHash: new Map(), byName: new Map() }
    const code = await resp.text()
    // Execute the script to extract its exported values
    // eslint-disable-next-line no-new-func
    const { previewMeta, previewExt: ext } = new Function(`${code}\nreturn { previewMeta, previewExt }`)() 
    if (!(previewMeta instanceof Map) || !ext) return { byHash: new Map(), byName: new Map() }

    const base = `${_getBcPresetsBase()}/${encodeURIComponent(group)}/previews/`
    const byHash = new Map()  // hash → { imageUrl, imgExt }
    const byName = new Map()  // presetName → hash  (inverse index for O(1) name lookup)
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
      byHash.set(hash, { imageUrl, imgExt: ext })
      // byName key is lowercased so it matches e.name from index.json regardless
      // of whether the jsonPath in index.js uses original case or lowercase
      byName.set(fileBase.toLowerCase(), hash)
    }
    console.log(`[PreviewBatch] pre-built index for "${group}": ${byHash.size} entries`)
    return { byHash, byName }
  } catch (err) {
    console.warn('[PreviewBatch] could not load preview index:', err)
    return { byHash: new Map(), byName: new Map() }
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
  display: flex; align-items: center;
  padding: 8px 12px; gap: 8px;
}
#title { color: #888; flex: 1; }
.tbtn {
  background: #222; border: 1px solid #444; color: #ddd;
  padding: 5px 12px; border-radius: 4px; font-size: 12px; cursor: pointer;
  white-space: nowrap;
}
.tbtn:hover { background: #2e2e2e; }
#copy-count { color: #fa4; }
.grid { display: flex; flex-wrap: wrap; gap: 5px; }
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
  width: 15px; height: 15px; cursor: pointer;
  -webkit-appearance: none; appearance: none;
  background: transparent; border: 1px solid transparent; border-radius: 2px;
  opacity: 0; transition: opacity 0.1s;
}
.tile-cb:checked {
  background: transparent;
  background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><polyline points='2,6 5,9 10,3' stroke='%2344ff9a' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/><\/svg>");
  background-repeat: no-repeat; background-position: center; background-size: 10px;
}
.tile:hover .tile-cb { opacity: 1; border-color: rgba(255,255,255,.9); }
.tile:hover .tile-cb:checked { border-color: #44ff9a; }
.tile.selected .tile-cb { opacity: 1; }
#overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.88); justify-content: center; align-items: center; cursor: pointer;
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
  <button class="tbtn" id="select-all-btn">Select All</button>
  <button class="tbtn" id="toggle-btn">Toggle</button>
  <button class="tbtn" id="copy-btn">Copy IDs (<span id="copy-count">all</span>)</button>
</div>
<div id="root"></div>
<div id="overlay">
  <img id="overlay-img" src="" alt="">
  <div id="overlay-label"></div>
</div>
<script>
(function () {
  // previewMeta is injected by previews/index.js (Map<hash, presetName>)
  function sanitize(s) { return s.replace(/[\/\\*?"<>|]/g, '_').trim() }

  const root = document.getElementById('root')
  const overlay = document.getElementById('overlay')
  const overlayImg = document.getElementById('overlay-img')
  const overlayLabel = document.getElementById('overlay-label')
  const copyBtn = document.getElementById('copy-btn')
  const copyCountEl = document.getElementById('copy-count')
  const titleEl = document.getElementById('title')

  const entries = [...previewMeta.entries()].map(([hash, name]) => ({
    hash,
    name,
    filename: 'previews/' + sanitize(name) + '.' + previewExt,
  }))
  titleEl.textContent = entries.length + ' previews'

  if (entries.length > 0) {
    const probe = new Image()
    probe.onload = function () {
      const scale = Math.min(160 / probe.naturalWidth, 160 / probe.naturalHeight)
      document.documentElement.style.setProperty('--tile-w', Math.round(probe.naturalWidth  * scale) + 'px')
      document.documentElement.style.setProperty('--tile-h', Math.round(probe.naturalHeight * scale) + 'px')
    }
    probe.src = entries[0].filename
  }

  const selected = new Set()
  function updateCount() { copyCountEl.textContent = selected.size > 0 ? selected.size : 'all' }

  const grid = document.createElement('div')
  grid.className = 'grid'
  for (const { hash, filename, name } of entries) {
    const tile = document.createElement('div')
    tile.className = 'tile'; tile.title = name
    const img = document.createElement('img')
    img.src = filename; img.alt = name; img.loading = 'lazy'
    const cb = document.createElement('input')
    cb.type = 'checkbox'; cb.className = 'tile-cb'
    cb.addEventListener('change', (e) => {
      e.stopPropagation()
      if (cb.checked) { selected.add(hash); tile.classList.add('selected') }
      else            { selected.delete(hash); tile.classList.remove('selected') }
      updateCount()
    })
    cb.addEventListener('click', (e) => e.stopPropagation())
    tile.addEventListener('click', () => {
      overlayImg.src = filename; overlayLabel.textContent = name
      overlay.classList.add('open')
    })
    tile.appendChild(img); tile.appendChild(cb); grid.appendChild(tile)
  }
  root.appendChild(grid)

  document.getElementById('select-all-btn').addEventListener('click', () => {
    entries.forEach(({ hash }) => selected.add(hash))
    root.querySelectorAll('.tile').forEach((t) => {
      t.classList.add('selected')
      const cb = t.querySelector('.tile-cb'); if (cb) cb.checked = true
    })
    updateCount()
  })

  document.getElementById('toggle-btn').addEventListener('click', () => {
    const tiles = [...root.querySelectorAll('.tile')]
    entries.forEach(({ hash }, i) => {
      const tile = tiles[i]; const cb = tile?.querySelector('.tile-cb')
      if (selected.has(hash)) {
        selected.delete(hash); tile?.classList.remove('selected'); if (cb) cb.checked = false
      } else {
        selected.add(hash); tile?.classList.add('selected'); if (cb) cb.checked = true
      }
    })
    updateCount()
  })

  overlay.addEventListener('click', (e) => { if (e.target !== overlayImg) overlay.classList.remove('open') })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('open') })

  copyBtn.addEventListener('click', () => {
    const ids = selected.size > 0 ? [...selected] : entries.map((e) => e.hash)
    const text = ids.sort().join('\\n')
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallback(text))
    } else { fallback(text) }
  })
  function fallback(text) {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
})()
<\/script>
</body>
</html>`
}
