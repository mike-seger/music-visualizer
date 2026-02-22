import ShadertoyMultipassVisualizer from './ShadertoyMultipassVisualizer'
import { loadShaderConfig, injectUniforms } from '../shaderCustomization'

// Shaders are served from public/shadertoy-presets/default/ and fetched at runtime.
// The index.json lists available presets; individual .glsl files are fetched on demand.
export const PRESETS_BASE = 'shadertoy-presets/default'

/** Mutable arrays populated once `shadertoyReady` resolves. */
export const SHADER_VISUALIZERS = []       // { name, fileName, filePath, create }[]
export const SHADER_VISUALIZER_NAMES = []  // display names in stable sort order

/**
 * Promise that resolves once the shader preset index is loaded from
 * public/shadertoy-presets/default/index.json.  Eagerly initiated at module
 * load so it is ready by the time the UI renders.
 */
export const shadertoyReady = (async () => {
  try {
    const baseUrl = import.meta.env?.BASE_URL ?? '/'
    const resp = await fetch(`${baseUrl}${PRESETS_BASE}/index.json`)
    if (!resp.ok) { console.warn('[shaderRegistry] index.json not found'); return }
    const index = await resp.json()
    if (!Array.isArray(index)) { console.warn('[shaderRegistry] index.json is not an array'); return }

    for (const { name, file } of index) {
      if (!name || !file) continue
      SHADER_VISUALIZERS.push({
        name,
        fileName: file,
        filePath: `${PRESETS_BASE}/presets/${file}`,
        create: async () => {
          const baseUrl2 = import.meta.env?.BASE_URL ?? '/'
          const srcResp = await fetch(`${baseUrl2}${PRESETS_BASE}/presets/${encodeURIComponent(file)}`)
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
    console.log(`[shaderRegistry] ${SHADER_VISUALIZER_NAMES.length} shader preset(s) loaded from ${PRESETS_BASE}/index.json`)
  } catch (err) {
    console.warn('[shaderRegistry] could not load presets index:', err)
  }
})()

/** Create (and return a Promise for) the named shader visualizer. */
export async function createShaderVisualizerByName(name) {
  await shadertoyReady
  const entry = SHADER_VISUALIZERS.find((e) => e.name === name)
  return entry ? entry.create() : null
}
