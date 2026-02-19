import butterchurnPresets from 'butterchurn-presets'
import ButterchurnVisualizer from './ButterchurnVisualizer'

/**
 * MilkDrop visualizer registry – mirrors entityRegistry.js / shaderRegistry.js.
 *
 * Loads presets from the butterchurn-presets npm package.
 *
 * Filtered by optional /milkdrop-presets.json config:
 *   { "presets": ["*"], "excludePatterns": ["regex..."] }
 *
 * The config is fetched lazily on first call to initMilkdropPresets() to
 * avoid top-level await (which causes circular-init errors in the bundled chunk).
 */

const allPresets = butterchurnPresets.getPresets()

/* ---------- Lazy initialisation (avoids top-level await) ---------- */

let _initPromise = null
let _entries = []
let _names = []
let _factoryMap = new Map()

function _buildRegistry(allowedSet, excludeRegexes) {
  // Bundled presets (no prefix)
  const bundledKeys = Object.keys(allPresets)
    .filter((key) => !allowedSet || allowedSet.has(key))
    .filter((key) => !excludeRegexes.some((re) => re.test(key)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  _entries = bundledKeys.map((key) => ({
    name: key,
    create: () =>
      new ButterchurnVisualizer({
        name: key,
        preset: allPresets[key],
        blendTime: 0,
      }),
  }))

  _names = _entries.map((e) => e.name)
  _factoryMap = new Map(_entries.map((e) => [e.name, e.create]))
}

/**
 * Fetch the optional config, load custom presets, and build the preset list.
 * Safe to call multiple times – only the first call does real work.
 */
export function initMilkdropPresets() {
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const baseUrl = import.meta.env.BASE_URL
    let allowedSet = null
    let excludeRegexes = []

    // Load filter config
    try {
      const resp = await fetch(baseUrl + 'milkdrop-presets.json')
      if (resp.ok) {
        const cfg = await resp.json()
        if (Array.isArray(cfg.presets) && cfg.presets.length > 0 && !cfg.presets.includes('*')) {
          allowedSet = new Set(cfg.presets)
        }
        if (Array.isArray(cfg.excludePatterns)) {
          excludeRegexes = cfg.excludePatterns
            .filter((p) => typeof p === 'string' && p.length > 0)
            .map((p) => new RegExp(p, 'i'))
        }
      }
    } catch { /* use all */ }

    _buildRegistry(allowedSet, excludeRegexes)
  })()
  return _initPromise
}

export { _entries as MILKDROP_VISUALIZERS }
export { _names as MILKDROP_VISUALIZER_NAMES }

export function createMilkdropVisualizerByName(name) {
  const fn = _factoryMap.get(name)
  return fn ? fn() : null
}

/**
 * Create a ButterchurnVisualizer from raw preset data (for lazy-loaded user groups).
 */
export function createMilkdropVisualizerFromPreset(name, presetData) {
  return new ButterchurnVisualizer({ name, preset: presetData, blendTime: 0 })
}
