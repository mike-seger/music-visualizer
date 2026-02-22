import butterchurn from 'butterchurn'
import App from '../App'

/**
 * ButterchurnVisualizer – wraps the Butterchurn MilkDrop engine as a
 * first-class visualizer alongside entities and shaders.
 *
 * Canvas strategy:
 *   Butterchurn renders to its own <canvas> (2D context – it copies from an
 *   internal OffscreenCanvas / WebGL2 context).  During init() we hide the
 *   Three.js renderer canvas and show ours; during destroy() we reverse that.
 *
 * Audio:
 *   In standalone mode we connect Butterchurn to App.audioManager.analyserNode,
 *   which feeds time-domain data through the normal Web Audio pipeline.
 *
 *   In bridge mode the real AnalyserNodes carry silence (neutered source), so
 *   instead we read the bridge's frequency data and synthesise a waveform that
 *   we pass directly to butterchurn via its render({ audioLevels }) API.  This
 *   bypasses the Web Audio graph entirely.
 */

// Detect bridge mode (URL params set by bridge-integration.js)
const _urlParams = new URLSearchParams(window.location.search)
const _isBridgeMode = _urlParams.get('autostart') === '1' || _urlParams.get('hideui') === '1'

// Tracks the name of the preset currently being compiled/rendered, used to
// attribute GL error messages to the right preset in the console.
let _currentPresetName = ''

/**
 * Patch WebGL2RenderingContext.prototype so that shader compile and program
 * link errors are automatically logged to the console with full info logs.
 * Includes the preset name when available for easy triage.
 * Must run before butterchurn creates its internal WebGL2 context.
 * Safe to call multiple times (idempotent via __logPatched flag).
 */
function patchWebGL2Logging() {
  if (typeof WebGL2RenderingContext === 'undefined') return
  if (WebGL2RenderingContext.prototype.__logPatched) return
  WebGL2RenderingContext.prototype.__logPatched = true

  // Also patch the parent prototype so the wrapper covers WebGL1 contexts too.
  const protos = [WebGL2RenderingContext.prototype]
  if (typeof WebGLRenderingContext !== 'undefined' &&
      WebGLRenderingContext.prototype !== WebGL2RenderingContext.prototype) {
    protos.push(WebGLRenderingContext.prototype)
  }

  for (const proto of protos) {
    const origCompile = proto.compileShader
    if (origCompile) {
      proto.compileShader = function (shader) {
        origCompile.call(this, shader)
        if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
          const who = _currentPresetName ? ` preset="${_currentPresetName}"` : ''
          console.error(`[GLSL compile error]${who}\n` + this.getShaderInfoLog(shader))
        }
      }
    }

    const origLink = proto.linkProgram
    if (origLink) {
      proto.linkProgram = function (prog) {
        origLink.call(this, prog)
        if (!this.getProgramParameter(prog, this.LINK_STATUS)) {
          const who = _currentPresetName ? ` preset="${_currentPresetName}"` : ''
          console.error(`[GL link error]${who}\n` + this.getProgramInfoLog(prog))
        }
      }
    }
  }
}
patchWebGL2Logging()

export default class ButterchurnVisualizer {
  /**
   * @param {Object} opts
   * @param {string}  opts.name          Display name (e.g. "MilkDrop: Geiss – Spiral")
   * @param {Object}  opts.preset        Pre-parsed butterchurn preset object
   * @param {number}  [opts.blendTime=0] Seconds to blend when loading
   */
  constructor({ name, preset, blendTime = 0 } = {}) {
    this.name = name
    this.preset = preset
    this.blendTime = blendTime
    this.isButterchurn = true  // fast-path detection in switchVisualizer

    this._visualizer = null   // butterchurn Visualizer instance
    this._canvas = null       // our output <canvas>
    this._gl = null           // WebGL2 context (same reference butterchurn holds)
    this._glErrFrames = 0     // frames remaining to poll gl.getError() after a preset load
    this._raf = null          // requestAnimationFrame id (not used – App drives update())
    this._resizeHandler = null
  }

  /* ──────────────────── Visualizer interface ──────────────────── */

  init() {
    const audioCtx = App.audioManager?.audioContext ?? null
    const w = window.innerWidth
    const h = window.innerHeight

    // --- Create canvas & insert into DOM ---
    this._canvas = document.createElement('canvas')
    this._canvas.width = w
    this._canvas.height = h
    this._canvas.style.position = 'absolute'
    this._canvas.style.top = '0'
    this._canvas.style.left = '0'
    this._canvas.style.width = '100%'
    this._canvas.style.height = '100%'
    this._canvas.style.display = 'block'
    this._canvas.style.zIndex = '1' // above Three.js canvas (z-index 0)

    const container = document.querySelector('.content') || document.body
    container.appendChild(this._canvas)

    // Hide Three.js canvas while Butterchurn is active
    this._threeCanvas = App.renderer?.domElement ?? null
    if (this._threeCanvas) {
      this._threeCanvasPrevDisplay = this._threeCanvas.style.display
      this._threeCanvas.style.display = 'none'
    }

    // --- Create Butterchurn instance ---
    _currentPresetName = this.name || ''
    this._visualizer = butterchurn.createVisualizer(audioCtx, this._canvas, {
      width: w,
      height: h,
      pixelRatio: window.devicePixelRatio || 1,
      textureRatio: 1,
    })
    // Grab the same WebGL2 context butterchurn uses so we can poll gl.getError().
    this._gl = this._canvas.getContext('webgl2') || null

    // Connect audio
    const analyser = App.audioManager?.analyserNode
    if (analyser) {
      this._visualizer.connectAudio(analyser)
    }

    // Load preset
    if (this.preset) {
      _currentPresetName = this.name || ''
      this._visualizer.loadPreset(this.preset, this.blendTime)
      this._glErrFrames = 8  // poll for deferred GL errors over next 8 render frames
    }

    // Handle resize
    this._resizeHandler = () => this._onResize()
    window.addEventListener('resize', this._resizeHandler)
  }

  update() {
    if (!this._visualizer) return

    if (_isBridgeMode) {
      // In bridge mode the real Web Audio pipeline carries silence.
      // Read the bridge's frequency data and synthesise a time-domain waveform
      // that butterchurn can use for its FFT + audio-level calculations.
      const bridgeTime = window.__bridgeTimeArray // set by bridge-integration.js
      if (bridgeTime && bridgeTime.length) {
        // Butterchurn's AudioProcessor uses fftSize = 1024 (numSamps * 2).
        // Query it at runtime so we stay correct if butterchurn ever changes.
        const bcFft = this._visualizer?.audio?.fftSize || 1024
        const wave = bridgeTime.length > bcFft
          ? bridgeTime.subarray(0, bcFft)
          : bridgeTime

        this._visualizer.render({
          audioLevels: {
            timeByteArray: wave,
            timeByteArrayL: wave,
            timeByteArrayR: wave,
          }
        })
        this._pollGlErrors()
        return
      }
    }

    this._visualizer.render()
    this._pollGlErrors()
  }

  /** Poll gl.getError() for the first few frames after a preset load.
   *  Butterchurn lazily compiles/links shaders during initial render calls,
   *  so GL errors only become visible here rather than at loadPreset() time. */
  _pollGlErrors() {
    if (!this._gl || this._glErrFrames <= 0) return
    this._glErrFrames--
    const err = this._gl.getError()
    if (err !== this._gl.NO_ERROR) {
      console.error(`[GL error] preset="${this.name}" code=0x${err.toString(16)}`)
      this._glErrFrames = 0  // stop after first hit to avoid flooding
    }
  }

  destroy() {
    // Remove resize listener
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler)
      this._resizeHandler = null
    }

    // Disconnect audio
    const analyser = App.audioManager?.analyserNode
    if (analyser && this._visualizer) {
      try { this._visualizer.disconnectAudio(analyser) } catch { /* ignore */ }
    }

    // Lose WebGL context to free GPU memory
    if (this._visualizer) {
      try { this._visualizer.loseGLContext() } catch { /* ignore */ }
      this._visualizer = null
    }

    // Remove canvas from DOM
    if (this._canvas && this._canvas.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas)
    }
    this._canvas = null
    this._gl = null

    // Restore Three.js canvas visibility
    if (this._threeCanvas) {
      this._threeCanvas.style.display = this._threeCanvasPrevDisplay ?? 'block'
      this._threeCanvas = null
    }
  }

  onBPMBeat() {
    // Butterchurn handles beat detection internally – nothing to do here.
  }

  /* ──────────────────── Preset management ──────────────────── */

  /**
   * Load a new preset with optional blend transition.
   * Can be called while running (e.g. from a preset-cycle feature).
   */
  loadPreset(preset, blendTime = 2.7) {
    if (!this._visualizer) return
    _currentPresetName = this.name || ''
    this._visualizer.loadPreset(preset, blendTime)
    this._glErrFrames = 8  // poll gl.getError() for next 8 render frames
  }

  /* ──────────────────── Internal helpers ──────────────────── */

  _onResize() {
    if (!this._visualizer || !this._canvas) return
    const w = window.innerWidth
    const h = window.innerHeight
    this._canvas.width = w
    this._canvas.height = h
    this._visualizer.setRendererSize(w, h)
  }
}
