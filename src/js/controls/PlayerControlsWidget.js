/**
 * PlayerControlsWidget – shared player-controls bar used both as the
 * main-page overlay and inside the pop-out lil-GUI panel.
 *
 * The widget builds its own DOM (buttons, slider, time/fps displays) and
 * exposes every element as a public property so the host can attach
 * additional behaviour (fullscreen API, auto-hide, SyncClient, etc.).
 *
 * Usage (popup – simple forwarding):
 *   const widget = new PlayerControlsWidget({
 *     onAction: (action, payload) => channel.postMessage({ type: action, ...payload }),
 *     hiddenButtons: ['fullscreen-btn', 'lock-btn', 'copy-liked-btn', 'open-controls-btn', 'mic-btn', 'sync'],
 *   })
 *   folder.appendChild(widget.el)
 *
 * Usage (main page – host attaches behaviour directly):
 *   const widget = new PlayerControlsWidget({ showFps: true })
 *   document.getElementById('player-controls').appendChild(widget.el)
 *   widget.playPauseBtn.addEventListener('click', () => { ... })
 */

export default class PlayerControlsWidget {

  /**
   * @param {Object}   opts
   * @param {Function} [opts.onAction]       – (actionType, payload?) => void
   * @param {string[]} [opts.hiddenButtons]  – keys of buttons to hide
   * @param {boolean}  [opts.showFps]        – include FPS display (default false)
   */
  constructor(opts = {}) {
    const { onAction, hiddenButtons = [], showFps = false } = opts
    this._onAction = onAction || null
    this._hiddenSet = new Set(hiddenButtons)
    this._showFps = showFps
    this._isSeeking = false
    this._duration = 0

    this.el = this._build()
    if (this._onAction) this._attachDefaultActions()
  }

  // -------------------------------------------------------------------
  //  DOM construction
  // -------------------------------------------------------------------

  _build() {
    const root = document.createElement('div')
    root.className = 'player-controls-widget'

    // ── Button row ──
    const row = document.createElement('div')
    row.className = 'pcw-button-row'
    root.appendChild(row)

    this.playPauseBtn    = this._mkIconBtn('play-pause-btn', 'play_circle', 'Play / Pause')
    this.muteBtn         = this._mkIconBtn('mute-btn', 'volume_up', 'Mute / Unmute')
    this.micBtn          = this._mkIconBtn('mic-btn', 'mic_off', 'Microphone input not available in this build')
    this.micBtn.disabled = true

    this.syncContainer   = document.createElement('div')
    this.syncContainer.className = 'pcw-sync-slot'
    this.syncContainer.title = 'Sync'

    this.fullscreenBtn   = this._mkIconBtn('fullscreen-btn', 'fullscreen', 'Enter fullscreen')
    this.lockBtn         = this._mkIconBtn('lock-btn', 'lock', 'Unlock controls (allow auto-hide)')
    this.openControlsBtn = this._mkIconBtn('open-controls-btn', 'settings', 'Open controls')
    this.copyLikedBtn    = this._mkIconBtn('copy-liked-btn', 'content_copy', 'Copy liked presets to clipboard')

    this.likeBtn = this._mkVizBtn('pc-like-btn', '♡', 'Like this preset')
    this.prevBtn = this._mkVizBtn('pc-prev-btn', '−', 'Previous visualizer')
    this.nextBtn = this._mkVizBtn('pc-next-btn', '+', 'Next visualizer')

    // Append in order, hiding as requested
    const ordered = [
      ['play-pause-btn',    this.playPauseBtn],
      ['mute-btn',          this.muteBtn],
      ['mic-btn',           this.micBtn],
      ['sync',              this.syncContainer],
      ['fullscreen-btn',    this.fullscreenBtn],
      ['lock-btn',          this.lockBtn],
      ['open-controls-btn', this.openControlsBtn],
      ['copy-liked-btn',    this.copyLikedBtn],
      ['pc-like-btn',       this.likeBtn],
      ['pc-prev-btn',       this.prevBtn],
      ['pc-next-btn',       this.nextBtn],
    ]

    for (const [key, el] of ordered) {
      if (this._hiddenSet.has(key)) el.style.display = 'none'
      row.appendChild(el)
    }

    // ── Position slider ──
    this.positionSlider = document.createElement('input')
    this.positionSlider.type = 'range'
    this.positionSlider.className = 'pcw-position-slider'
    this.positionSlider.min = '0'
    this.positionSlider.max = '100'
    this.positionSlider.value = '0'
    this.positionSlider.step = '0.1'
    root.appendChild(this.positionSlider)

    // ── Metrics row ──
    const metrics = document.createElement('div')
    metrics.className = 'pcw-metrics'

    this.timeDisplay = document.createElement('div')
    this.timeDisplay.className = 'pcw-time-display'
    this.timeDisplay.textContent = '0:00 / 0:00'
    metrics.appendChild(this.timeDisplay)

    if (this._showFps) {
      this.fpsDisplay = document.createElement('div')
      this.fpsDisplay.className = 'pcw-fps-display'
      this.fpsDisplay.setAttribute('aria-label', 'FPS')
      this.fpsDisplay.textContent = 'FPS: --'
      metrics.appendChild(this.fpsDisplay)
    } else {
      this.fpsDisplay = null
    }

    root.appendChild(metrics)
    return root
  }

  /** Material-icon round button. */
  _mkIconBtn(key, icon, title) {
    const btn = document.createElement('button')
    btn.className = 'pcw-icon-btn'
    btn.dataset.pcwKey = key
    btn.textContent = icon
    btn.title = title
    return btn
  }

  /** Viz-nav style button (♡, −, +). */
  _mkVizBtn(key, label, title) {
    const btn = document.createElement('button')
    btn.className = 'pcw-viz-btn'
    btn.dataset.pcwKey = key
    btn.textContent = label
    btn.title = title
    return btn
  }

  // -------------------------------------------------------------------
  //  Default action forwarding (used by popup ControlsApp)
  // -------------------------------------------------------------------

  _attachDefaultActions() {
    this.playPauseBtn.addEventListener('click', () => this._onAction('toggle-play-pause'))
    this.muteBtn.addEventListener('click', () => this._onAction('toggle-mute'))
    this.likeBtn.addEventListener('click', () => this._onAction('toggle-like'))
    this.prevBtn.addEventListener('click', () => this._onAction('cycle-prev'))
    this.nextBtn.addEventListener('click', () => this._onAction('cycle-next'))

    this.positionSlider.addEventListener('mousedown', () => { this._isSeeking = true })
    this.positionSlider.addEventListener('touchstart', () => { this._isSeeking = true }, { passive: true })
    this.positionSlider.addEventListener('mouseup', () => { this._isSeeking = false })
    this.positionSlider.addEventListener('touchend', () => { this._isSeeking = false })
    this.positionSlider.addEventListener('change', () => {
      this._isSeeking = false
      this._onAction('seek-position', { percent: parseFloat(this.positionSlider.value) })
    })
    this.positionSlider.addEventListener('input', () => {
      if (this._duration > 0) {
        const seekTime = (parseFloat(this.positionSlider.value) / 100) * this._duration
        this.timeDisplay.textContent = `${this._fmt(seekTime)} / ${this._fmt(this._duration)}`
      }
    })
  }

  // -------------------------------------------------------------------
  //  Public state setters (called by ControlsApp on incoming messages)
  // -------------------------------------------------------------------

  setPlayState(isPlaying) {
    this.playPauseBtn.textContent = isPlaying ? 'pause_circle' : 'play_circle'
    this.playPauseBtn.title = isPlaying ? 'Pause' : 'Play'
  }

  setMuteState(isMuted) {
    this.muteBtn.textContent = isMuted ? 'volume_off' : 'volume_up'
    this.muteBtn.title = isMuted ? 'Unmute' : 'Mute'
  }

  setLikeState(liked) {
    this.likeBtn.textContent = liked ? '♥' : '♡'
    this.likeBtn.title = liked ? 'Unlike this preset' : 'Like this preset'
    this.likeBtn.classList.toggle('liked', liked)
  }

  /** Update slider + time label. */
  setTime(currentSeconds, durationSeconds) {
    this._duration = durationSeconds || 0
    if (!this._isSeeking) {
      this.positionSlider.value = this._duration ? (currentSeconds / this._duration) * 100 : 0
    }
    this.timeDisplay.textContent = `${this._fmt(currentSeconds)} / ${this._fmt(this._duration)}`
  }

  /** Set slider position (0–100). */
  setPosition(percent) {
    if (!this._isSeeking) this.positionSlider.value = percent
  }

  // -------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------

  _fmt(seconds) {
    const s = Math.max(0, seconds || 0)
    const mins = Math.floor(s / 60)
    const secs = Math.floor(s % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  destroy() {
    this.el?.remove()
  }
}

