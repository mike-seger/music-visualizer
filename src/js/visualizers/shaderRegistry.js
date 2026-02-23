import ShadertoyMultipassVisualizer from './ShadertoyMultipassVisualizer'
import { loadShaderConfig, injectUniforms } from '../shaderCustomization'

// Shaders are served from public/shadertoy-presets/default/ and fetched at runtime.
// The index.json lists available presets; individual .glsl files are fetched on demand.
const _SHADERTOY_STORAGE_KEY = 'visualizer.shadertoyPresetsBase'

function _readRoot() {
  try {
    const v = localStorage.getItem(_SHADERTOY_STORAGE_KEY)?.trim() || 'shadertoy-presets'
    return v.replace(/\/default$/, '') || 'shadertoy-presets'
  }
  catch { return 'shadertoy-presets' }
}

/** Current presets base path — mutable so reloadShaderRegistry() can update it. */
export let PRESETS_BASE = `${_readRoot()}/default`

/** Mutable arrays populated once `shadertoyReady` resolves. */
export const SHADER_VISUALIZERS = []       // { name, fileName, filePath, create }[]
export const SHADER_VISUALIZER_NAMES = []  // display names in stable sort order

async function _loadFromBase(base) {
  const baseUrl = import.meta.env?.BASE_URL ?? '/'
  const resp = await fetch(`${baseUrl}${base}/index.json`)
  if (!resp.ok) { console.warn('[shaderRegistry] index.json not found at', base); return }
  const index = await resp.json()
  if (!Array.isArray(index)) { console.warn('[shaderRegistry] index.json is not an array'); return }

  for (const { name, file } of index) {
    if (!name || !file) continue
    SHADER_VISUALIZERS.push({
      name,
      fileName: file,
      filePath: `${base}/presets/${file}`,
      create: async () => {
        const baseUrl2 = import.meta.env?.BASE_URL ?? '/'
        // Read PRESETS_BASE at call time so a reloaded registry uses the right path
        const srcResp = await fetch(`${baseUrl2}${PRESETS_BASE}/presets/${encodeURIComponent(file).replace(/%2B/gi, '+')}`)
        const source = srcResp.ok ? await srcResp.text() : ''
        const config = await loadShaderConfig(file)
        const processedSource = config ? injectUniforms(source, config) : source
        return new ShadertoyMultipassVisualizer({
          name, source: processedSource, filePath: file, shaderConfig: config,
        })
      },
    })
    SHADER_VISUALIZER_NAMES.push(name)
  }
  console.log(`[shaderRegistry] ${SHADER_VISUALIZER_NAMES.length} shader preset(s) loaded from ${base}/index.json`)
}

/**
 * Promise that resolves once the shader preset index is loaded from
 * public/shadertoy-presets/default/index.json.  Eagerly initiated at module
 * load so it is ready by the time the UI renders.
 */
export const shadertoyReady = _loadFromBase(PRESETS_BASE).catch((err) => {
  console.warn('[shaderRegistry] could not load presets index:', err)
})

/**
 * Reload the shader preset registry from localStorage's current base path.
 * Clears SHADER_VISUALIZERS and SHADER_VISUALIZER_NAMES in-place, then
 * re-fetches index.json from the new location.  Call this after writing
 * a new path to localStorage; await it before calling switchGroup('Shadertoy').
 */
export async function reloadShaderRegistry() {
  SHADER_VISUALIZERS.length = 0
  SHADER_VISUALIZER_NAMES.length = 0
  PRESETS_BASE = `${_readRoot()}/default`
  try {
    await _loadFromBase(PRESETS_BASE)
  } catch (err) {
    console.warn('[shaderRegistry] reload failed:', err)
  }
}

/** Create (and return a Promise for) the named shader visualizer. */
export async function createShaderVisualizerByName(name) {
  await shadertoyReady
  const entry = SHADER_VISUALIZERS.find((e) => e.name === name)
  return entry ? entry.create() : null
}
