/**
 * ControlsApp – lil-gui controls panel (popup window version).
 *
 * Runs inside a popup window opened from the main visualizer.
 * Communicates with the main page exclusively via BroadcastChannel
 * ('visualizer-controls').
 *
 * Protocol (outgoing → main page):
 *   { type: 'controls-ready' }
 *   { type: 'select-visualizer', name }
 *   { type: 'select-group', group }
 *   { type: 'set-debug-information', enabled }
 *   { type: 'set-toast-transient', enabled }
 *   { type: 'set-cycle-enabled', enabled }
 *   { type: 'set-cycle-time', time }
 *   { type: 'set-quality', antialias?, pixelRatio? }
 *   { type: 'save-quality-defaults' }
 *   { type: 'clear-quality-overrides' }
 *   { type: 'set-fv3-param', key, value }
 *   { type: 'apply-fv3-params', params }
 *   { type: 'set-shader-uniform', uniform, value }
 *
 * Protocol (incoming ← main page):
 *   { type: 'init', visualizerList, activeVisualizer, debugInformationEnabled, toastTransientEnabled, cycleEnabled, cycleTime, groupNames, currentGroup, perfHidden }
 *   { type: 'visualizer-changed', name, hasFV3?, fv3Params?, hasShaderConfig?, shaderConfig? }
 *   { type: 'global-update', debugInformationEnabled, toastTransientEnabled, cycleEnabled, cycleTime }
 *   { type: 'quality-update', antialias, pixelRatio }
 *   { type: 'visualizer-list-update', visualizerList }
 *   { type: 'group-changed', group, visualizerList, activeVisualizer, perfHidden }
 *   { type: 'perf-visibility', hidden }
 *   { type: 'fv3-params', params }
 */

import GUI from 'lil-gui'
import { loadSpectrumFilters } from '../spectrumFilters'

const CHANNEL_NAME = 'visualizer-controls'

export default class ControlsApp {
  constructor() {
    this.gui = null
    this.visualizerList = []
    this.activeVisualizer = ''

    // Visualizer switcher state
    this.visualizerSwitcherConfig = null
    this.visualizerController = null
    this.groupController = null
    this.groupNames = []
    this.groupDisplayMap = {}  // { internalName: displayName }

    // Debug / cycle / toast state
    this.debugInformationEnabled = false
    this.toastTransientEnabled = true
    this._cycleEnabled = false
    this._cycleTime = 30
    this._transitionTime = 5.7
    this._cycleEnabledController = null
    this._cycleTimeController = null
    this._transitionTimeController = null
    this._debugMainController = null
    this._debugTransientController = null

    // Performance + Quality state
    this.performanceQualityFolder = null
    this.performanceQualityConfig = null
    this.performanceQualityControllers = { antialias: null, pixelRatio: null }

    // FV3 controls state
    this.variant3Folder = null
    this.variant3Controllers = {}
    this.variant3Config = null
    this.variant3PresetState = null
    this.variant3LoadController = null
    this.variant3ScrollContainer = null
    this.variant3UploadInput = null
    this.variant3Overlay = null
    this.variant3PresetApplied = false
    this.variant3FolderObserver = null
    this.fv3FilePresets = {}
    this.fv3FilePresetsLoaded = false

    // Shader controls state
    this.shaderControlsFolder = null

    this.storageKeys = {
      fv3Presets: 'visualizer.fv3.presets',
      fv3SelectedPreset: 'visualizer.fv3.selectedPreset',
    }

    // Preview controls state
    this.previewFolder = null
    this._previewConfig = {
      resolution: 'fixed',
      format: 'PNG',
      width: 160,
      height: 90,
      settleDelay: 300,
      status: 'Idle',
    }
    this._previewStatusCtrl = null
    this._previewWidthCtrl = null
    this._previewHeightCtrl = null

    // BroadcastChannel for communicating with the main page
    this.channel = new BroadcastChannel(CHANNEL_NAME)
    this.channel.onmessage = (e) => this.handleMessage(e)

    // Send ready and keep retrying until we receive 'init' back
    this._readyInterval = setInterval(() => this._send({ type: 'controls-ready' }), 250)
    this._send({ type: 'controls-ready' })

    // Notify main page when this window is closing
    window.addEventListener('beforeunload', () => {
      this._send({ type: 'controls-closed' })
      this.channel.close()
    })
  }

  // -------------------------------------------------------------------
  // BroadcastChannel helpers
  // -------------------------------------------------------------------

  _send(msg) {
    try { this.channel.postMessage(msg) } catch { /* */ }
  }

  handleMessage(event) {
    const msg = event?.data
    if (!msg || typeof msg !== 'object') return

    switch (msg.type) {
      case 'init':
        // Stop retrying ready
        if (this._readyInterval) { clearInterval(this._readyInterval); this._readyInterval = null }
        this.visualizerList = msg.visualizerList || []
        this.activeVisualizer = msg.activeVisualizer || ''
        this.debugInformationEnabled = !!msg.debugInformationEnabled
        this.toastTransientEnabled = msg.toastTransientEnabled !== false
        this._cycleEnabled = !!msg.cycleEnabled
        this._cycleTime = Number.isFinite(msg.cycleTime) ? msg.cycleTime : 30
        this._transitionTime = Number.isFinite(msg.transitionTime) ? msg.transitionTime : 5.7
        this.groupNames = msg.groupNames || []
        this.groupDisplayMap = msg.groupDisplayMap || {}
        this.currentGroup = msg.currentGroup || ''
        this._perfHidden = !!msg.perfHidden
        this.initGui()
        break
      case 'visualizer-changed':
        this.activeVisualizer = msg.name || ''
        if (this.gui) {
          this.syncVisualizerDropdown(msg.name)
          this.teardownFrequencyViz3Controls()
          this.teardownShaderControls()
          if (msg.hasFV3 && msg.fv3Params) this.setupFrequencyViz3Controls(msg.fv3Params)
          if (msg.hasShaderConfig && msg.shaderConfig) this.setupShaderControls(msg.shaderConfig)
        } else {
          // GUI not ready yet — store for when initGui runs
          this._pendingVisualizerChanged = msg
        }
        break
      case 'quality-update':
        if (this.gui) {
          this.syncQualityControls(msg.antialias, msg.pixelRatio)
        } else {
          this._pendingQualityUpdate = msg
        }
        break
      case 'global-update':
        if (this.gui) {
          this.syncGlobalControls(msg)
        } else {
          this._pendingGlobalUpdate = msg
        }
        break
      case 'visualizer-list-update':
        this.visualizerList = msg.visualizerList || []
        this.rebuildVisualizerDropdown()
        break
      case 'group-changed':
        this.currentGroup = msg.group || ''
        this.visualizerList = msg.visualizerList || []
        if (msg.activeVisualizer) this.activeVisualizer = msg.activeVisualizer
        if (this.visualizerSwitcherConfig) this.visualizerSwitcherConfig.group = msg.group
        this.groupController?.updateDisplay?.()
        this.rebuildVisualizerDropdown()
        // Update perf folder visibility
        if (this.performanceQualityFolder) {
          this._perfHidden = !!msg.perfHidden
          this.performanceQualityFolder.domElement.style.display = this._perfHidden ? 'none' : ''
        }
        break
      case 'perf-visibility':
        this._perfHidden = !!msg.hidden
        if (this.performanceQualityFolder) {
          this.performanceQualityFolder.domElement.style.display = this._perfHidden ? 'none' : ''
        }
        break
      case 'fv3-params':
        this.syncFV3Controls(msg.params)
        break
      case 'preview-status':
        if (this._previewConfig) {
          this._previewConfig.status = msg.text || ''
          this._previewStatusCtrl?.updateDisplay?.()
        }
        break
      default:
        break
    }
  }

  // -------------------------------------------------------------------
  // GUI initialisation
  // -------------------------------------------------------------------

  initGui() {
    if (this.gui) return // already created

    this.gui = new GUI({ title: 'VISUALIZER CONTROLS' })
    this.gui.open()

    this.setupGuiCloseButton()
    this.addVisualizerSwitcher()
    this.addPerformanceQualityControls()
    this.addPreviewControls()
    // Apply initial perf folder visibility
    if (this._perfHidden && this.performanceQualityFolder) {
      this.performanceQualityFolder.domElement.style.display = 'none'
    }

    // Replay any visualizer-changed message that arrived before GUI was ready
    if (this._pendingVisualizerChanged) {
      const msg = this._pendingVisualizerChanged
      this._pendingVisualizerChanged = null
      this.syncVisualizerDropdown(msg.name)
      if (msg.hasFV3 && msg.fv3Params) this.setupFrequencyViz3Controls(msg.fv3Params)
      if (msg.hasShaderConfig && msg.shaderConfig) this.setupShaderControls(msg.shaderConfig)
    }

    // Replay any quality-update that arrived before GUI was ready
    if (this._pendingQualityUpdate) {
      const q = this._pendingQualityUpdate
      this._pendingQualityUpdate = null
      this.syncQualityControls(q.antialias, q.pixelRatio)
    }

    if (this._pendingGlobalUpdate) {
      const g = this._pendingGlobalUpdate
      this._pendingGlobalUpdate = null
      this.syncGlobalControls(g)
    }
  }

  // -------------------------------------------------------------------
  // GUI close / collapse button
  // -------------------------------------------------------------------

  setupGuiCloseButton() {
    if (!this.gui?.domElement) return
    const guiRoot = this.gui.domElement
    const titleButton = guiRoot.querySelector('.lil-title')
    if (!titleButton) return

    // Title is hidden via CSS in the popup; just disable collapsing
    titleButton.disabled = true
    titleButton.style.cursor = 'default'
    titleButton.style.pointerEvents = 'none'
  }

  // -------------------------------------------------------------------
  // Visualizer switcher
  // -------------------------------------------------------------------

  addVisualizerSwitcher() {
    const folder = this.gui.addFolder('PRESET')
    folder.open()

    this.visualizerSwitcherConfig = {
      group: this.currentGroup || '',
      visualizer: this.activeVisualizer,
      cycleEnabled: !!this._cycleEnabled,
      cycleTime: this._cycleTime,
      transitionTime: this._transitionTime,
      debugMain: !!this.debugInformationEnabled,
      debugTransient: !!this.toastTransientEnabled,
    }

    // Group selector (above visualizer dropdown)
    if (this.groupNames.length > 0) {
      // Build {displayName: internalName} map for clean labels
      const groupOpts = {}
      for (const g of this.groupNames) {
        const display = this.groupDisplayMap[g] || g
        groupOpts[display] = g
      }
      this.groupController = folder
        .add(this.visualizerSwitcherConfig, 'group', groupOpts)
        .name('Group')
        .listen()
        .onChange((value) => {
          this._send({ type: 'select-group', group: value })
        })
      this._selectArrowNav(this.groupController)
    }

    // Author filter (above the name filter)
    this.visualizerSwitcherConfig.authorFilter = ''
    this._authorFilterController = folder
      .add(this.visualizerSwitcherConfig, 'authorFilter', this._buildAuthorList(this.visualizerList))
      .name('Author')
      .listen()
      .onChange(() => this._applyPresetFilter())
    this._selectArrowNav(this._authorFilterController)

    // Preset name filter (above Preset dropdown)
    this.visualizerSwitcherConfig.presetFilter = ''
    this._presetFilterController = folder
      .add(this.visualizerSwitcherConfig, 'presetFilter')
      .name('Name')
      .onChange(() => this._applyPresetFilter())
    const filterInput = this._presetFilterController.domElement.querySelector('input')
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        this.visualizerSwitcherConfig.presetFilter = filterInput.value
        this._applyPresetFilter()
      })
      filterInput.setAttribute('placeholder', 'regex filter\u2026')
    }

    this.visualizerController = folder
      .add(this.visualizerSwitcherConfig, 'visualizer', this.visualizerList)
      .name(`List (${this.visualizerList.length})`)
      .listen()
      .onChange((value) => {
        this._send({ type: 'select-visualizer', name: value })
      })
    this._selectArrowNav(this.visualizerController)

    // Debug: two checkboxes on one row (placed directly after the list)
    this._debugMainController = folder
      .add(this.visualizerSwitcherConfig, 'debugMain')
      .name('Debug Information')
      .listen()
      .onChange((value) => {
        this._send({ type: 'set-debug-information', enabled: !!value })
      })

    this._debugTransientController = folder
      .add(this.visualizerSwitcherConfig, 'debugTransient')
      .name('transient')
      .listen()
      .onChange((value) => {
        this._send({ type: 'set-toast-transient', enabled: !!value })
      })

    this._mergeLilGuiRows(this._debugMainController, this._debugTransientController, { showLabelB: true })

    // Transition time slider
    this._transitionTimeController = folder
      .add(this.visualizerSwitcherConfig, 'transitionTime', 0, 20, 0.1)
      .name('Transition Time')
      .listen()
      .onChange((value) => {
        this._send({ type: 'set-transition-time', time: value })
      })

    // Auto-cycle: checkbox + time slider
    this._cycleEnabledController = folder
      .add(this.visualizerSwitcherConfig, 'cycleEnabled')
      .name('Cycle Visualizers')
      .listen()
      .onChange((value) => {
        this._send({ type: 'set-cycle-enabled', enabled: !!value })
      })

    this._cycleTimeController = folder
      .add(this.visualizerSwitcherConfig, 'cycleTime', 5, 300, 5)
      .name('Cycle Time')
      .listen()
      .onChange((value) => {
        this._send({ type: 'set-cycle-time', time: value })
      })
  }

  /**
   * Prevent a lil-gui select from opening on ArrowUp/ArrowDown;
   * instead navigate to the previous/next value directly.
   */
  _selectArrowNav(ctrl) {
    const sel = ctrl?.domElement?.querySelector('select')
    if (!sel) return
    sel.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      e.stopPropagation()
      const dir = e.key === 'ArrowUp' ? -1 : 1
      const next = sel.selectedIndex + dir
      if (next >= 0 && next < sel.options.length) {
        sel.selectedIndex = next
        sel.dispatchEvent(new Event('change'))
      }
    })
  }

  /**
   * Merge two consecutive lil-gui controller rows into a single visual row.
   */
  _mergeLilGuiRows(ctrlA, ctrlB, { gap, showLabelB, label, compactButtons } = {}) {
    const liA = ctrlA?.domElement
    const liB = ctrlB?.domElement
    if (!liA || !liB) return
    const widgetA = liA.querySelector('.lil-widget')
    const widgetB = liB.querySelector('.lil-widget')
    if (!widgetA || !widgetB) return
    // If B contains a slider, propagate the class so lil-gui slider CSS applies
    if (widgetB.querySelector('.lil-slider')) {
      liA.classList.add('lil-has-slider')
    }
    // Override A's label text
    if (label) {
      const nameA = liA.querySelector('.lil-name')
      if (nameA) nameA.textContent = label
    }
    // Make buttons wrap their text instead of full width
    if (compactButtons) {
      liA.classList.add('lil-compact-buttons')
      const btnA = widgetA.querySelector('button')
      if (btnA) {
        const nameSpan = btnA.querySelector('.lil-name')
        if (nameSpan) {
          const btnText = nameSpan.textContent
          nameSpan.textContent = label || btnText
          liA.insertBefore(nameSpan, widgetA)
          btnA.textContent = btnText
        }
      }
      const btnB = widgetB.querySelector('button')
      if (btnB) {
        const nameBSpan = btnB.querySelector('.lil-name')
        if (nameBSpan) {
          const btnBText = nameBSpan.textContent
          btnB.textContent = btnBText
        }
        widgetA.appendChild(btnB)
      }
      widgetA.style.display = 'flex'
      widgetA.style.gap = gap || '6px'
      liB.style.display = 'none'
      return
    }
    if (gap) {
      const spacer = document.createElement('span')
      spacer.style.display = 'inline-block'
      spacer.style.width = gap
      spacer.style.flexShrink = '0'
      widgetA.appendChild(spacer)
    }
    // Optionally inject B's label text before B's content
    if (showLabelB) {
      const nameB = liB.querySelector('.lil-name')
      if (nameB?.textContent?.trim()) {
        const lbl = document.createElement('span')
        lbl.className = 'merged-label'
        lbl.textContent = nameB.textContent.trim()
        widgetA.appendChild(lbl)
      }
    }
    while (widgetB.firstChild) {
      widgetA.appendChild(widgetB.firstChild)
    }
    liB.style.display = 'none'
  }

  syncVisualizerDropdown(name) {
    if (!this.visualizerSwitcherConfig || !this.visualizerController) return
    this.visualizerSwitcherConfig.visualizer = name
    this.visualizerController.updateDisplay()
    const sel = this.visualizerController.domElement?.querySelector('select')
    if (sel && sel.value !== name) { try { sel.value = name } catch { /* */ } }
  }

  rebuildVisualizerDropdown() {
    if (!this.visualizerController) return
    this._applyPresetFilter()
    const validName = this.visualizerList.includes(this.activeVisualizer)
      ? this.activeVisualizer : (this.visualizerList[0] || '')
    this.visualizerSwitcherConfig.visualizer = validName
    this.visualizerController.updateDisplay()
  }

  /**
   * Extract normalised authors from a preset name.
   */
  _extractAuthors(name) {
    const idx = name.indexOf(' - ')
    const raw = idx > 0 ? name.substring(0, idx) : ''
    if (!raw.trim()) return ['UNKNOWN']
    const parts = raw.split(/[,&+]/)
      .map((s) => s.trim().toLowerCase().replace(/^_+/, '').replace(/[^\w\d]/g, ''))
      .filter(Boolean)
    return parts.length ? parts : ['UNKNOWN']
  }

  /**
   * Build sorted author list for the Author filter dropdown.
   */
  _buildAuthorList(presetNames) {
    const counts = new Map()
    for (const name of presetNames) {
      for (const a of this._extractAuthors(name)) counts.set(a, (counts.get(a) || 0) + 1)
    }
    const regular = []
    let hasOther = false
    for (const [author, count] of counts) {
      if (author === 'UNKNOWN') continue
      if (count < 5) { hasOther = true } else { regular.push(author) }
    }
    regular.sort((a, b) => a.localeCompare(b))
    const opts = { ALL: '' }
    if (counts.has('UNKNOWN')) opts.UNKNOWN = 'UNKNOWN'
    if (hasOther) opts.OTHER = 'OTHER'
    for (const a of regular) opts[a] = a
    return opts
  }

  /**
   * Filter the Preset dropdown by author and regex name filters.
   */
  _applyPresetFilter() {
    if (!this.visualizerController) return
    const authorFilter = this.visualizerSwitcherConfig?.authorFilter || ''
    const raw = this.visualizerSwitcherConfig?.presetFilter || ''
    let filtered = this.visualizerList

    // Author filter
    if (authorFilter === 'OTHER') {
      const counts = new Map()
      for (const name of this.visualizerList) {
        for (const a of this._extractAuthors(name)) counts.set(a, (counts.get(a) || 0) + 1)
      }
      filtered = filtered.filter((name) => {
        const authors = this._extractAuthors(name)
        return authors.some((a) => a !== 'UNKNOWN' && (counts.get(a) || 0) < 5)
      })
    } else if (authorFilter) {
      filtered = filtered.filter((name) => this._extractAuthors(name).includes(authorFilter))
    }

    // Regex name filter
    if (raw.trim()) {
      try {
        const re = new RegExp(raw, 'i')
        filtered = filtered.filter((name) => re.test(name))
      } catch {
        // Invalid regex — don't filter further
      }
    }
    this.visualizerController.options(filtered.length ? filtered : ['(no matches)'])
    if (filtered.includes(this.activeVisualizer)) {
      this.visualizerSwitcherConfig.visualizer = this.activeVisualizer
    } else if (filtered.length) {
      this.visualizerSwitcherConfig.visualizer = filtered[0]
    }
    this.visualizerController.updateDisplay()
    this.visualizerController.name(`List (${filtered.length})`)
    if (this._authorFilterController) {
      this._authorFilterController.options(this._buildAuthorList(this.visualizerList))
      this.visualizerSwitcherConfig.authorFilter = authorFilter
      this._authorFilterController.updateDisplay()
    }
    // Keep preview panel in sync with the name filter
    this._send({ type: 'preview-filter', filter: raw })
  }

  // -------------------------------------------------------------------
  // Global controls sync
  // -------------------------------------------------------------------

  syncGlobalControls(msg) {
    if (!this.visualizerSwitcherConfig) return
    if (typeof msg.debugInformationEnabled === 'boolean') {
      this.visualizerSwitcherConfig.debugMain = msg.debugInformationEnabled
      this._debugMainController?.updateDisplay?.()
    }
    if (typeof msg.toastTransientEnabled === 'boolean') {
      this.visualizerSwitcherConfig.debugTransient = msg.toastTransientEnabled
      this._debugTransientController?.updateDisplay?.()
    }
    if (typeof msg.cycleEnabled === 'boolean') {
      this.visualizerSwitcherConfig.cycleEnabled = msg.cycleEnabled
      this._cycleEnabledController?.updateDisplay?.()
    }
    if (Number.isFinite(msg.cycleTime)) {
      this.visualizerSwitcherConfig.cycleTime = msg.cycleTime
      this._cycleTimeController?.updateDisplay?.()
    }
    if (Number.isFinite(msg.transitionTime)) {
      this.visualizerSwitcherConfig.transitionTime = msg.transitionTime
      this._transitionTimeController?.updateDisplay?.()
    }
  }

  // -------------------------------------------------------------------
  // Performance + Quality controls
  // -------------------------------------------------------------------

  addPerformanceQualityControls() {
    if (this.performanceQualityFolder) return
    const folder = this.gui.addFolder('PERFORMANCE + QUALITY')
    folder.open()
    this.performanceQualityFolder = folder

    const prOptions = { '0.25': 0.25, '0.5': 0.5, '1 ': 1, '2 ': 2 }

    this.performanceQualityConfig = {
      antialias: false,
      pixelRatio: 1,
      saveAsDefaults: () => this._send({ type: 'save-quality-defaults' }),
      clearUserValues: () => this._send({ type: 'clear-quality-overrides' }),
    }

    this.performanceQualityControllers.antialias = folder
      .add(this.performanceQualityConfig, 'antialias')
      .name('Antialiasing')
      .onChange((v) => this._send({ type: 'set-quality', antialias: !!v }))

    this.performanceQualityControllers.pixelRatio = folder
      .add(this.performanceQualityConfig, 'pixelRatio', prOptions)
      .name('PixelRatio')
      .onChange((v) => {
        const pr = typeof v === 'string' ? Number.parseFloat(v) : v
        this._send({ type: 'set-quality', pixelRatio: pr })
      })

    const saveCtrl = folder.add(this.performanceQualityConfig, 'saveAsDefaults').name('Set Default')
    const clearCtrl = folder.add(this.performanceQualityConfig, 'clearUserValues').name('Clear Custom')
    this._mergeLilGuiRows(saveCtrl, clearCtrl, { gap: '6px', label: 'P + Q Controls', compactButtons: true })
  }

  syncQualityControls(antialias, pixelRatio) {
    if (!this.performanceQualityConfig) return
    if (typeof antialias === 'boolean') this.performanceQualityConfig.antialias = antialias
    if (Number.isFinite(pixelRatio)) this.performanceQualityConfig.pixelRatio = pixelRatio
    this.performanceQualityControllers.antialias?.updateDisplay()
    this.performanceQualityControllers.pixelRatio?.updateDisplay()
  }

  // -------------------------------------------------------------------
  // FV3 controls (full preset management)
  // -------------------------------------------------------------------

  getFV3Presets() { try { const r = window.localStorage.getItem(this.storageKeys.fv3Presets); if (!r) return {}; const p = JSON.parse(r); return p && typeof p === 'object' && !Array.isArray(p) ? p : {} } catch { return {} } }
  saveFV3Presets(p) { try { window.localStorage.setItem(this.storageKeys.fv3Presets, JSON.stringify(p || {})) } catch { /* */ } }
  getStoredFV3PresetName() { try { return window.localStorage.getItem(this.storageKeys.fv3SelectedPreset) || '' } catch { return '' } }
  saveFV3PresetName(n) { try { if (n) window.localStorage.setItem(this.storageKeys.fv3SelectedPreset, n); else window.localStorage.removeItem(this.storageKeys.fv3SelectedPreset) } catch { /* */ } }

  teardownFrequencyViz3Controls() {
    if (!this.variant3Folder) return
    try { this.variant3Folder.destroy() } catch { const p = this.variant3Folder.domElement?.parentElement; if (p) p.removeChild(this.variant3Folder.domElement) }
    this.variant3Folder = null; this.variant3Controllers = {}; this.variant3Config = null
    this.variant3PresetState = null; this.variant3LoadController = null; this.variant3ScrollContainer = null
    if (this.variant3FolderObserver) { this.variant3FolderObserver.disconnect(); this.variant3FolderObserver = null }
    if (this.variant3Overlay?.parentElement) this.variant3Overlay.parentElement.removeChild(this.variant3Overlay)
    this.variant3Overlay = null
  }

  setupFrequencyViz3Controls(initialParams) {
    this.teardownFrequencyViz3Controls()
    if (!initialParams || !this.gui) return

    this.variant3Config = { ...initialParams }
    this.variant3PresetApplied = false
    const folder = this.gui.addFolder('FREQUENCY VIZ 3 CONTROLS')
    folder.open()
    folder.domElement.classList.add('fv3-controls')
    folder.domElement.style.position = 'relative'
    this.variant3Folder = folder
    this.variant3Controllers = {}

    const presets = this.getFV3Presets()
    const mergedPresets = () => ({ ...(this.fv3FilePresets || {}), ...presets })

    this.variant3PresetState = { presetName: '', loadPreset: this.getStoredFV3PresetName() || Object.keys(mergedPresets())[0] || '' }
    if (this.variant3PresetState.loadPreset) this.saveFV3PresetName(this.variant3PresetState.loadPreset)

    const roundParams = (p) => { if (!p) return p; const r = {}; Object.entries(p).forEach(([k, v]) => { r[k] = Number.isFinite(v) ? parseFloat(v.toFixed(6)) : v }); return r }

    let isSyncing = false

    const applyParams = (params) => {
      if (!params) return
      this.variant3Config = { ...params }
      Object.entries(this.variant3Controllers).forEach(([prop, ctrl]) => { if (ctrl?.setValue) ctrl.setValue(params[prop]); else ctrl?.updateDisplay() })
      this._send({ type: 'apply-fv3-params', params })
    }

    const refreshLoadOptions = () => {
      const names = Object.keys(mergedPresets())
      if (names.length === 0) return // nothing to populate yet; wait for async load

      const ctrl = this.variant3LoadController
      if (!ctrl) return

      // Priority: current state → localStorage → first available
      const stored = this.getStoredFV3PresetName() || ''
      const current = this.variant3PresetState?.loadPreset || ''
      const wanted = (current && names.includes(current)) ? current
        : (stored && names.includes(stored)) ? stored
        : names[0]

      this.variant3PresetState.loadPreset = wanted

      const opts = {}; names.forEach((n) => { opts[n] = n })
      ctrl.options(opts)
      ctrl.updateDisplay()

      // Re-inject Edit button
      const widget = ctrl.domElement.querySelector('.lil-widget')
      if (widget && !widget.querySelector('.fv3-edit-btn')) {
        const editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.textContent = 'Edit'; editBtn.className = 'fv3-edit-btn'
        editBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openOverlay() })
        widget.appendChild(editBtn)
      }

      if (wanted) this.saveFV3PresetName(wanted)

      if (!this.variant3PresetApplied && wanted && names.includes(wanted)) {
        onPresetSelect(wanted)
        this.variant3PresetApplied = true
      }
    }

    const onPresetSelect = (value) => {
      if (!value || isSyncing) return
      const preset = mergedPresets()[value]
      if (!preset) return
      isSyncing = true
      applyParams(preset)
      this.variant3PresetState.loadPreset = value
      this.saveFV3PresetName(value)
      this.variant3LoadController?.updateDisplay()
      isSyncing = false
      this.variant3PresetState.presetName = value
    }

    // Load spectrum filter presets
    if (!this.fv3FilePresetsLoaded) {
      this.fv3FilePresetsLoaded = true
      loadSpectrumFilters().then((loaded) => { this.fv3FilePresets = loaded || {}; this.variant3PresetApplied = false; refreshLoadOptions() }).catch(() => {})
    }

    // Preset actions
    const presetActions = {
      savePreset: () => {
        const name = (this.variant3PresetState.presetName || '').trim()
        if (!name) { alert('Enter a preset name first.'); return }
        presets[name] = roundParams(this.variant3Config)
        this.saveFV3Presets(presets)
        this.variant3PresetState.loadPreset = name; this.saveFV3PresetName(name); refreshLoadOptions()
      },
      downloadPreset: () => {
        const data = { name: (this.variant3PresetState.presetName || '').trim() || 'preset', visualizer: 'Frequency Visualization 3', controls: roundParams(this.variant3Config) }
        const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset'
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `fv3-preset-${slug}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
      },
      uploadPreset: () => {
        if (!this.variant3UploadInput) { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json'; inp.style.display = 'none'; document.body.appendChild(inp); this.variant3UploadInput = inp }
        this.variant3UploadInput.onchange = (e) => {
          const file = e.target?.files?.[0]; if (!file) return
          const reader = new FileReader()
          reader.onload = () => {
            try { const parsed = JSON.parse(reader.result); const controls = parsed?.controls || parsed; const name = parsed?.name || file.name.replace(/\.json$/i, '') || 'Imported'
              presets[name] = roundParams(controls); this.saveFV3Presets(presets); this.variant3PresetState.presetName = name; this.variant3PresetState.loadPreset = name; this.saveFV3PresetName(name)
              applyParams(roundParams(controls)); refreshLoadOptions()
            } catch (err) { alert('Failed to load preset: ' + (err?.message || err)) } finally { this.variant3UploadInput.value = '' }
          }
          reader.readAsText(file)
        }
        this.variant3UploadInput.click()
      },
      deletePreset: () => {
        const name = this.variant3PresetState.loadPreset || ''
        if (!name) return
        if (this.fv3FilePresets?.[name]) { alert('Built-in presets cannot be deleted.'); return }
        if (!presets[name]) { alert('Preset not found.'); return }
        if (!confirm(`Delete preset "${name}"?`)) return
        delete presets[name]; this.saveFV3Presets(presets)
        if (this.variant3PresetState.loadPreset === name) { this.variant3PresetState.loadPreset = Object.keys(presets)[0] || ''; this.saveFV3PresetName(this.variant3PresetState.loadPreset) }
        refreshLoadOptions()
      },
    }

    // Overlay
    let overlayNameInput = null
    const hideOverlay = () => { if (this.variant3Overlay) this.variant3Overlay.style.display = 'none'; folder.domElement?.classList.remove('blur-active') }
    const makeIconButton = (lig, title, handler) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.title = title; const i = document.createElement('span'); i.className = 'fv3-icon'; i.textContent = lig; b.appendChild(i); b.addEventListener('click', handler); return b }

    const buildOverlay = () => {
      if (this.variant3Overlay?.parentElement) return this.variant3Overlay
      const overlay = document.createElement('div'); overlay.className = 'fv3-overlay'
      const modal = document.createElement('div'); modal.className = 'fv3-modal'
      const header = document.createElement('header')
      const title = document.createElement('h3'); title.textContent = 'Edit FV3 Presets'
      const closeBtn = document.createElement('button'); closeBtn.className = 'close-btn'; closeBtn.title = 'Close'; closeBtn.textContent = '×'; closeBtn.addEventListener('click', hideOverlay)
      header.appendChild(title); header.appendChild(closeBtn); modal.appendChild(header)

      const makeRow = (label, el) => { const r = document.createElement('div'); r.className = 'row'; const l = document.createElement('div'); l.className = 'label'; l.textContent = label; const f = document.createElement('div'); f.className = 'field'; f.appendChild(el); r.appendChild(l); r.appendChild(f); return r }
      const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.placeholder = 'Preset name'; nameInput.value = this.variant3PresetState.presetName
      nameInput.addEventListener('input', (e) => { this.variant3PresetState.presetName = e.target.value })
      overlayNameInput = nameInput; modal.appendChild(makeRow('Save as', nameInput))

      const actions = document.createElement('div'); actions.className = 'actions'
      actions.appendChild(makeIconButton('save', 'Save preset', presetActions.savePreset))
      actions.appendChild(makeIconButton('file_download', 'Download', presetActions.downloadPreset))
      actions.appendChild(makeIconButton('upload_file', 'Upload', presetActions.uploadPreset))
      actions.appendChild(makeIconButton('delete', 'Delete', presetActions.deletePreset))
      const ar = document.createElement('div'); ar.className = 'row'; const al = document.createElement('div'); al.className = 'label'; al.textContent = 'Actions'
      const af = document.createElement('div'); af.className = 'field'; af.appendChild(actions); ar.appendChild(al); ar.appendChild(af); modal.appendChild(ar)

      overlay.appendChild(modal)
      folder.domElement.appendChild(overlay); this.variant3Overlay = overlay; refreshLoadOptions()
      return overlay
    }

    const openOverlay = () => { const o = buildOverlay(); if (o) { refreshLoadOptions(); o.style.display = 'flex'; folder.domElement?.classList.add('blur-active') } }

    // Scroller
    const ensureScrollContainer = () => {
      if (this.variant3ScrollContainer?.isConnected) return this.variant3ScrollContainer
      const parent = folder.$children || folder.domElement?.querySelector('ul') || folder.domElement
      if (!parent) return null
      const s = document.createElement('div'); s.className = 'fv3-scroll'; parent.appendChild(s); this.variant3ScrollContainer = s; return s
    }
    const moveToScroller = (ctrl) => { const li = ctrl?.domElement; const s = ensureScrollContainer(); if (li && s && li.parentElement !== s) s.appendChild(li) }

    // Load preset dropdown
    const addLoadRow = () => {
      const ctrl = folder.add(this.variant3PresetState, 'loadPreset', {}).name('Load preset')
      ctrl.onChange((v) => { if (!isSyncing) onPresetSelect(v) })
      this.variant3LoadController = ctrl
      const widget = ctrl.domElement.querySelector('.lil-widget')
      if (widget) {
        const editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.textContent = 'Edit'; editBtn.className = 'fv3-edit-btn'
        editBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openOverlay() })
        widget.appendChild(editBtn)
      }
      ctrl.domElement.classList.add('fv3-load-preset')
      refreshLoadOptions()
    }

    addLoadRow()

    // Add sliders/dropdowns/toggles
    const addSlider = (prop, label, min, max, step = 1) => {
      const ctrl = folder.add(this.variant3Config, prop, min, max).step(step).name(label).listen()
      ctrl.onChange((v) => { if (Number.isFinite(v)) this._send({ type: 'set-fv3-param', key: prop, value: v }) })
      this.variant3Controllers[prop] = ctrl; moveToScroller(ctrl); return ctrl
    }
    const addToggle = (prop, label) => {
      const ctrl = folder.add(this.variant3Config, prop).name(label).listen()
      ctrl.onChange((v) => this._send({ type: 'set-fv3-param', key: prop, value: !!v }))
      this.variant3Controllers[prop] = ctrl; moveToScroller(ctrl); return ctrl
    }
    const addDropdown = (prop, label, options) => {
      const ctrl = folder.add(this.variant3Config, prop, options).name(label).listen()
      ctrl.onChange((v) => this._send({ type: 'set-fv3-param', key: prop, value: v }))
      this.variant3Controllers[prop] = ctrl; moveToScroller(ctrl); return ctrl
    }

    const controlsToAdd = [
      { type: 'dropdown', prop: 'weightingMode', label: 'Weighting mode', options: ['ae', 'fv2'] },
      { type: 'dropdown', prop: 'spatialKernel', label: 'Smoothing kernel', options: ['wide', 'narrow'] },
      { type: 'toggle', prop: 'useBinFloor', label: 'Use per-bin floor' },
      { type: 'dropdown', prop: 'beatBoostEnabled', label: 'Beat accent enabled', options: [1, 0] },
      { type: 'slider', prop: 'analyserSmoothing', label: 'Analyser smoothing', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'kickHz', label: 'Kick center Hz', min: 20, max: 200, step: 1 },
      { type: 'slider', prop: 'kickWidthOct', label: 'Kick width (oct)', min: 0.1, max: 2.0, step: 0.01 },
      { type: 'slider', prop: 'kickBoostDb', label: 'Kick boost (dB)', min: -12, max: 24, step: 0.25 },
      { type: 'slider', prop: 'subShelfDb', label: 'Sub shelf (dB)', min: -12, max: 24, step: 0.25 },
      { type: 'slider', prop: 'tiltLo', label: 'Tilt low mult', min: 0.1, max: 3.0, step: 0.01 },
      { type: 'slider', prop: 'tiltHi', label: 'Tilt high mult', min: 0.1, max: 2.5, step: 0.01 },
      { type: 'slider', prop: 'floorAtkLow', label: 'Floor atk low', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'floorRelLow', label: 'Floor rel low', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'floorAtkHi', label: 'Floor atk high', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'floorRelHi', label: 'Floor rel high', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'floorStrengthLow', label: 'Floor strength low', min: 0.0, max: 1.5, step: 0.01 },
      { type: 'slider', prop: 'floorStrengthHi', label: 'Floor strength high', min: 0.0, max: 1.5, step: 0.01 },
      { type: 'slider', prop: 'bassFreqHz', label: 'Bass boost freq (Hz)', min: 20, max: 140, step: 1 },
      { type: 'slider', prop: 'bassWidthHz', label: 'Boost width (Hz)', min: 1, max: 50, step: 1 },
      { type: 'slider', prop: 'bassGainDb', label: 'Boost gain (dB)', min: -6, max: 30, step: 0.5 },
      { type: 'slider', prop: 'hiRolloffDb', label: 'High rolloff (dB)', min: -24, max: 0, step: 0.5 },
      { type: 'slider', prop: 'beatBoost', label: 'Beat boost', min: 0.0, max: 2.0, step: 0.05 },
      { type: 'slider', prop: 'attack', label: 'Attack', min: 0.01, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'release', label: 'Release', min: 0.01, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'noiseFloor', label: 'Noise floor', min: 0.0, max: 0.2, step: 0.001 },
      { type: 'slider', prop: 'peakCurve', label: 'Peak curve', min: 0.5, max: 4.0, step: 0.05 },
      { type: 'slider', prop: 'minDb', label: 'Min dB', min: -120, max: -10, step: 1 },
      { type: 'slider', prop: 'maxDb', label: 'Max dB', min: -60, max: 0, step: 1 },
      { type: 'slider', prop: 'baselinePercentile', label: 'Baseline percentile', min: 0.01, max: 0.5, step: 0.005 },
      { type: 'slider', prop: 'baselineStrength', label: 'Baseline strength', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'displayThreshold', label: 'Display threshold', min: 0.0, max: 0.05, step: 0.0005 },
      { type: 'slider', prop: 'targetPeak', label: 'Target peak', min: 0.1, max: 1.5, step: 0.01 },
      { type: 'slider', prop: 'minGain', label: 'Min gain', min: 0.05, max: 3.0, step: 0.01 },
      { type: 'slider', prop: 'maxGain', label: 'Max gain', min: 0.1, max: 5.0, step: 0.01 },
      { type: 'slider', prop: 'agcAttack', label: 'AGC attack', min: 0.0, max: 1.0, step: 0.01 },
      { type: 'slider', prop: 'agcRelease', label: 'AGC release', min: 0.0, max: 1.0, step: 0.01 },
    ]

    controlsToAdd.sort((a, b) => a.label.localeCompare(b.label)).forEach((cfg) => {
      if (cfg.type === 'slider') addSlider(cfg.prop, cfg.label, cfg.min, cfg.max, cfg.step)
      else if (cfg.type === 'dropdown') addDropdown(cfg.prop, cfg.label, cfg.options)
      else if (cfg.type === 'toggle') addToggle(cfg.prop, cfg.label)
    })
  }

  syncFV3Controls(params) {
    if (!params || !this.variant3Config) return
    Object.assign(this.variant3Config, params)
    Object.entries(this.variant3Controllers).forEach(([, ctrl]) => ctrl?.updateDisplay?.())
  }

  // -------------------------------------------------------------------
  // Shader controls
  // -------------------------------------------------------------------

  teardownShaderControls() {
    if (!this.shaderControlsFolder) return
    try { this.shaderControlsFolder.destroy() } catch { const p = this.shaderControlsFolder.domElement?.parentElement; if (p) p.removeChild(this.shaderControlsFolder.domElement) }
    this.shaderControlsFolder = null
  }

  setupShaderControls(config) {
    this.teardownShaderControls()
    if (!config?.controls?.length || !this.gui) return

    const folder = this.gui.addFolder(config.name || 'Shader Settings')
    const params = {}
    const storagePrefix = `shaderConfig:${config.name}:`

    for (const control of config.controls) {
      if (control.type === 'select') {
        const options = {}; control.options.forEach((o) => { options[o.label] = o.value })
        const saved = localStorage.getItem(storagePrefix + control.uniform)
        params[control.name] = saved !== null ? parseInt(saved, 10) : control.default
        folder.add(params, control.name, options).name(control.name).onChange((v) => {
          localStorage.setItem(storagePrefix + control.uniform, String(v))
          this._send({ type: 'set-shader-uniform', uniform: control.uniform, value: v })
        })
        this._send({ type: 'set-shader-uniform', uniform: control.uniform, value: params[control.name] })
      } else if (control.type === 'slider') {
        const saved = localStorage.getItem(storagePrefix + control.uniform)
        params[control.name] = saved !== null ? parseFloat(saved) : control.default
        folder.add(params, control.name, control.min, control.max).name(control.name).onChange((v) => {
          localStorage.setItem(storagePrefix + control.uniform, String(v))
          this._send({ type: 'set-shader-uniform', uniform: control.uniform, value: v })
        })
        this._send({ type: 'set-shader-uniform', uniform: control.uniform, value: params[control.name] })
      }
    }

    folder.open()
    this.shaderControlsFolder = folder
  }

  // -------------------------------------------------------------------
  // Preview controls
  // -------------------------------------------------------------------

  addPreviewControls() {
    if (this.previewFolder) return
    const cfg = this._previewConfig

    const folder = this.gui.addFolder('PREVIEWS')
    folder.close()
    this.previewFolder = folder

    folder
      .add(cfg, 'resolution', ['dynamic', 'fixed'])
      .name('Resolution')
      .onChange((v) => {
        this._previewWidthCtrl?.show(v === 'fixed')
        this._previewHeightCtrl?.show(v === 'fixed')
      })

    this._previewWidthCtrl = folder
      .add(cfg, 'width', 1, 3840, 1)
      .name('Width')
    this._previewHeightCtrl = folder
      .add(cfg, 'height', 1, 2160, 1)
      .name('Height')

    // Show/hide W/H depending on current resolution mode
    this._previewWidthCtrl.show(cfg.resolution === 'fixed')
    this._previewHeightCtrl.show(cfg.resolution === 'fixed')

    folder.add(cfg, 'format', ['PNG', 'JPG']).name('Format')

    folder.add(cfg, 'settleDelay', 0, 2000, 50).name('Settle ms')

    this._previewStatusCtrl = folder
      .add(cfg, 'status')
      .name('Status')
      .disable()

    // Re-Generate button
    folder
      .add({ capture: () => this._send({ type: 'preview-start', config: { ...cfg } }) }, 'capture')
      .name('Re-Generate')
  }
}
