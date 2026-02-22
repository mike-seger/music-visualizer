#!/usr/bin/env node
/**
 * reapply-glsl.mjs
 *
 * Applies the preamble-uniform-stripping fix to already-converted preset JSONs.
 * Reads warp/comp fields (already in GLSL from a previous conversion run),
 * strips any `uniform <type> <name>;` lines where <name> is declared in
 * butterchurn's preamble (which would cause a GLSL redeclaration compile error),
 * then writes the file back.
 *
 * Usage: node scripts/reapply-glsl.mjs [--dir <presets-dir>]
 */

import { promises as fs } from 'fs'
import path from 'path'

const _args = process.argv.slice(2)
const _dirIdx = _args.indexOf('--dir')
const _dirArg = _dirIdx >= 0 ? _args[_dirIdx + 1] : null
const PRESETS_DIR = path.resolve(_dirArg || 'public/butterchurn-presets/milkdrop3-converted/presets')

/**
 * Uniforms already declared in butterchurn's fragment shader preamble.
 * A second declaration in the preset body causes a GLSL redeclaration error.
 */
const BUTTERCHURN_PREAMBLE_UNIFORMS = new Set([
  'sampler_main', 'sampler_fw_main', 'sampler_fc_main',
  'sampler_pw_main', 'sampler_pc_main',
  'sampler_blur1', 'sampler_blur2', 'sampler_blur3',
  'sampler_noise_lq', 'sampler_noise_lq_lite',
  'sampler_noise_mq', 'sampler_noise_hq',
  'sampler_pw_noise_lq',
  'sampler_noisevol_lq', 'sampler_noisevol_hq',
  'time', 'decay', 'gammaAdj', 'echo_zoom', 'echo_alpha', 'echo_orientation',
  'invert', 'brighten', 'darken', 'solarize',
  'resolution', 'aspect', 'texsize',
  'texsize_noise_lq', 'texsize_noise_mq', 'texsize_noise_hq',
  'texsize_noise_lq_lite', 'texsize_noisevol_lq', 'texsize_noisevol_hq',
  'bass', 'mid', 'treb', 'vol',
  'bass_att', 'mid_att', 'treb_att', 'vol_att',
  'frame', 'fps',
  '_qa', '_qb', '_qc', '_qd', '_qe', '_qf', '_qg', '_qh',
  'slow_roam_cos', 'roam_cos', 'slow_roam_sin', 'roam_sin',
  'blur1_min', 'blur1_max', 'blur2_min', 'blur2_max', 'blur3_min', 'blur3_max',
  'scale1', 'scale2', 'scale3', 'bias1', 'bias2', 'bias3',
  'rand_frame', 'rand_preset', 'fShader',
])

function stripPreambleUniforms(src) {
  if (!src) return src
  return src.replace(
    /^[ \t]*uniform\s+\S+\s+(\w+)\s*;[ \t]*(?:\r?\n)?/gm,
    (match, name) => BUTTERCHURN_PREAMBLE_UNIFORMS.has(name) ? '' : match
  )
}

async function main() {
  const entries = await fs.readdir(PRESETS_DIR)
  const jsonFiles = entries.filter(f => f.endsWith('.json') && f !== 'index.json')

  let changed = 0, unchanged = 0, errors = 0

  for (const f of jsonFiles) {
    const filePath = path.join(PRESETS_DIR, f)
    let preset
    try { preset = JSON.parse(await fs.readFile(filePath, 'utf8')) }
    catch (e) { console.error(`[reapply] Parse error ${f}:`, e.message); errors++; continue }

    const newWarp = stripPreambleUniforms(preset.warp)
    const newComp = stripPreambleUniforms(preset.comp)

    if (newWarp === preset.warp && newComp === preset.comp) { unchanged++; continue }

    preset.warp = newWarp
    preset.comp = newComp
    try {
      await fs.writeFile(filePath, JSON.stringify(preset), 'utf8')
      changed++
    } catch (e) {
      console.error(`[reapply] Write error ${f}:`, e.message); errors++
    }
  }

  console.log(`[reapply] Done: ${changed} presets patched, ${unchanged} unchanged, ${errors} errors`)
}

main()
