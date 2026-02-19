#!/usr/bin/env node
/**
 * convert-milk.mjs
 *
 * Converts MilkDrop .milk preset files into Butterchurn-compatible JSON.
 *
 * Uses the official milkdrop-eel-parser (proper EEL2→JS parser by jberg,
 * same author as butterchurn) and milkdrop-preset-utils for .milk file
 * parsing.  HLSL→GLSL shader conversion is done with a custom text-based
 * transpiler since the native milkdrop-shader-converter cannot be built
 * on modern Node / ARM64.
 *
 * Usage:  node scripts/convert-milk.mjs
 * Input:  src/milkdrop-presets/*.milk
 * Output: public/milkdrop-presets/<name>.json  +  public/milkdrop-presets/index.json
 *
 * Behaviour:
 *   - Only (re-)creates a JSON when source is newer or target is missing.
 *   - Deletes JSON files in the destination that have no matching source.
 *   - Generates an index.json manifest of all converted presets.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const milkdropParser = require('milkdrop-eel-parser')
const { splitPreset, createBasePresetFuns } = require('milkdrop-preset-utils')

const SOURCE_DIR = path.resolve('src/milkdrop-presets')
const TARGET_DIR = path.resolve('public/milkdrop-presets')


// ─── HLSL → GLSL shader conversion ────────────────────────────────────────

/**
 * Helper: find the matching close-paren for a function call starting after
 * the opening '(' at position `start` in `str`.  Returns index of ')'.
 */
function findMatchingParen(str, start) {
  let depth = 1
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++
    else if (str[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Replace func(arg) with replacement(arg) where replacement is a string
 * template.  `replacer` receives the inner argument string and returns
 * the replacement text.
 */
function replaceFuncCall(src, funcName, replacer) {
  let result = ''
  let i = 0
  const re = new RegExp(`\\b${funcName}\\s*\\(`)
  while (i < src.length) {
    const sub = src.substring(i)
    const m = sub.match(re)
    if (!m || m.index === undefined) { result += sub; break }
    result += sub.substring(0, m.index)
    const parenOpen = i + m.index + m[0].length
    const parenClose = findMatchingParen(src, parenOpen)
    if (parenClose < 0) { result += sub.substring(m.index); break }
    const inner = src.substring(parenOpen, parenClose)
    result += replacer(inner)
    i = parenClose + 1
  }
  return result
}

/**
 * Split a string on commas at depth 0 (respecting nested parens).
 */
function splitTopLevelCommas(str) {
  const parts = []
  let depth = 0, start = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++
    else if (str[i] === ')') depth--
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.substring(start, i).trim())
      start = i + 1
    }
  }
  parts.push(str.substring(start).trim())
  return parts
}

/**
 * Convert MilkDrop HLSL shader text to Butterchurn-compatible GLSL.
 *
 * Handles: types, tex2D, lerp, frac, saturate, mul, atan2,
 *          GetBlur1/2/3, GetPixel, and adds helper definitions.
 */
function hlslToGlsl(shaderText) {
  if (!shaderText) return shaderText

  let s = shaderText

  // ── Strip C-style block comments ──
  s = s.replace(/\/\*[\s\S]*?\*\//g, '')

  // ── Type replacements (order matters: float4x4 before float4) ──
  s = s.replace(/\bfloat4x4\b/g, 'mat4')
  s = s.replace(/\bfloat3x3\b/g, 'mat3')
  s = s.replace(/\bfloat2x2\b/g, 'mat2')
  s = s.replace(/\bfloat4\b/g, 'vec4')
  s = s.replace(/\bfloat3\b/g, 'vec3')
  s = s.replace(/\bfloat2\b/g, 'vec2')

  // ── Ensure sampler/texsize declarations have 'uniform' prefix ──
  // MilkDrop .milk files write: sampler2D sampler_XXX;
  // Butterchurn expects:        uniform sampler2D sampler_XXX;
  // (must run AFTER type replacements so float4→vec4 is done)
  s = s.replace(/^(\s*)(?!uniform\s)(sampler2D\s)/gm, '$1uniform $2')
  s = s.replace(/^(\s*)(?!uniform\s)(vec4\s+texsize_)/gm, '$1uniform $2')

  // ── Simple function renames ──
  s = s.replace(/\btex2D\b/g, 'texture')
  s = s.replace(/\btex3D\b/g, 'texture')
  s = s.replace(/\blerp\b/g, 'mix')
  s = s.replace(/\bfrac\b/g, 'fract')
  s = s.replace(/\brsqrt\b/g, 'inversesqrt')
  s = s.replace(/\batan2\b/g, 'atan')
  s = s.replace(/\bddx\b/g, 'dFdx')
  s = s.replace(/\bddy\b/g, 'dFdy')

  // ── saturate(expr) → clamp(expr, 0.0, 1.0) ──
  s = replaceFuncCall(s, 'saturate', inner => `clamp(${inner}, 0.0, 1.0)`)

  // ── mul(A, B) → (B * A)  (HLSL row-major → GLSL column-major) ──
  s = replaceFuncCall(s, 'mul', inner => {
    const args = splitTopLevelCommas(inner)
    if (args.length === 2) return `(${args[1]} * ${args[0]})`
    return `mul(${inner})`  // fallback
  })

  // ── GetBlur1/2/3(uv) → inline texture reads with scale+bias ──
  s = replaceFuncCall(s, 'GetBlur1', uv =>
    `((texture(sampler_blur1, ${uv}).xyz * scale1) + bias1)`)
  s = replaceFuncCall(s, 'GetBlur2', uv =>
    `((texture(sampler_blur2, ${uv}).xyz * scale2) + bias2)`)
  s = replaceFuncCall(s, 'GetBlur3', uv =>
    `((texture(sampler_blur3, ${uv}).xyz * scale3) + bias3)`)

  // ── GetPixel(uv) → texture(sampler_main, uv).xyz ──
  s = replaceFuncCall(s, 'GetPixel', uv =>
    `texture(sampler_main, ${uv}).xyz`)

  // ── Auto-add .xyz swizzle to texture() calls without one ──
  // In HLSL, tex2D returns float4 which implicitly truncates to float3.
  // In GLSL, texture() returns vec4 — assigning to vec3 is an error.
  // Add .xyz to any texture() call not already followed by a swizzle.
  s = addTextureSwizzle(s)

  return s
}

/**
 * Find texture(...) calls and add .xyz if no swizzle follows.
 * Leaves existing swizzles (.x, .xy, .xyz, .rgba, etc.) untouched.
 */
function addTextureSwizzle(src) {
  let result = ''
  let i = 0
  while (i < src.length) {
    const sub = src.substring(i)
    const m = sub.match(/\btexture\s*\(/)
    if (!m || m.index === undefined) { result += sub; break }
    // Copy everything before this texture call
    result += sub.substring(0, m.index + m[0].length)
    const parenOpen = i + m.index + m[0].length
    const parenClose = findMatchingParen(src, parenOpen)
    if (parenClose < 0) { result += sub.substring(m.index + m[0].length); break }
    // Copy the inner args + closing paren
    result += src.substring(parenOpen, parenClose + 1)
    // Check what follows the closing paren
    const after = src.substring(parenClose + 1)
    if (!/^\s*\./.test(after)) {
      // No swizzle — add .xyz
      result += '.xyz'
    }
    i = parenClose + 1
  }
  return result
}

// ─── Preset conversion ────────────────────────────────────────────────────

/**
 * Convert a .milk preset text into a Butterchurn-compatible JSON object.
 *
 * Pipeline:
 *   1. splitPreset()  — parse .milk INI format (official milkdrop-preset-utils)
 *   2. milkdropParser.convert_preset_wave_and_shape() — EEL2→JS (official parser)
 *   3. createBasePresetFuns() — assemble preset structure (official utils)
 *   4. hlslToGlsl() — convert HLSL shaders to GLSL (custom text transpiler)
 */
function convertMilkFile(text) {
  // 1. Parse .milk file
  const presetParts = splitPreset(text)

  // 2. Convert EEL2 equations to JS using the official parser
  const parsedPreset = milkdropParser.convert_preset_wave_and_shape(
    presetParts.presetVersion,
    presetParts.presetInit,
    presetParts.perFrame,
    presetParts.perVertex,
    presetParts.shapes,
    presetParts.waves
  )

  // 3. Create base preset structure with converted equation strings
  const presetMap = createBasePresetFuns(
    parsedPreset,
    presetParts.shapes,
    presetParts.waves
  )

  // 4. Store original EEL source for debugging
  presetMap.init_eqs_eel = presetParts.presetInit
    ? presetParts.presetInit.trim()
    : ''
  presetMap.frame_eqs_eel = presetParts.perFrame
    ? presetParts.perFrame.trim()
    : ''
  presetMap.pixel_eqs_eel = presetParts.perVertex
    ? presetParts.perVertex.trim()
    : ''

  for (let i = 0; i < presetParts.shapes.length; i++) {
    if (presetParts.shapes[i]) {
      presetMap.shapes[i].init_eqs_eel = presetParts.shapes[i].init_eqs_str || ''
      presetMap.shapes[i].frame_eqs_eel = presetParts.shapes[i].frame_eqs_str || ''
    }
  }

  for (let i = 0; i < presetParts.waves.length; i++) {
    if (presetParts.waves[i]) {
      presetMap.waves[i].init_eqs_eel = presetParts.waves[i].init_eqs_str || ''
      presetMap.waves[i].frame_eqs_eel = presetParts.waves[i].frame_eqs_str || ''
      presetMap.waves[i].point_eqs_eel = presetParts.waves[i].point_eqs_str || ''
    }
  }

  // 5. Convert HLSL shaders to GLSL
  const warp = hlslToGlsl(presetParts.warp)
  const comp = hlslToGlsl(presetParts.comp)

  // 6. Assemble final output
  const output = {
    version: presetParts.presetVersion,
    baseVals: presetParts.baseVals,
    ...presetMap,
    warp: warp || '',
    comp: comp || '',
    warp_hlsl: presetParts.warp || '',
    comp_hlsl: presetParts.comp || '',
  }

  return output
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Ensure source directory exists
  try { await fs.access(SOURCE_DIR) } catch {
    console.log(`[convert-milk] Creating ${SOURCE_DIR} — place .milk files there and re-run.`)
    await fs.mkdir(SOURCE_DIR, { recursive: true })
    await fs.mkdir(TARGET_DIR, { recursive: true })
    await fs.writeFile(path.join(TARGET_DIR, 'index.json'), '[]', 'utf8')
    return
  }

  await fs.mkdir(TARGET_DIR, { recursive: true })

  // Discover source .milk files
  const srcEntries = await fs.readdir(SOURCE_DIR, { withFileTypes: true })
  const milkFiles = srcEntries.filter(e => e.isFile() && e.name.endsWith('.milk'))
  const expectedJsonNames = new Set(milkFiles.map(e => e.name.replace(/\.milk$/, '.json')))
  expectedJsonNames.add('index.json') // don't delete the manifest

  // Delete stale destination files (no matching source)
  const dstEntries = await fs.readdir(TARGET_DIR, { withFileTypes: true })
  for (const de of dstEntries) {
    if (de.isFile() && de.name.endsWith('.json') && !expectedJsonNames.has(de.name)) {
      await fs.unlink(path.join(TARGET_DIR, de.name))
      console.log(`[convert-milk] Deleted stale ${de.name}`)
    }
  }

  if (milkFiles.length === 0) {
    console.log('[convert-milk] No .milk files found in src/milkdrop-presets/')
    await fs.writeFile(path.join(TARGET_DIR, 'index.json'), '[]', 'utf8')
    return
  }

  let converted = 0
  let skipped = 0
  let errors = 0
  const manifest = []

  for (const entry of milkFiles) {
    const filename = entry.name
    const stem = filename.replace(/\.milk$/, '')
    const jsonName = `${stem}.json`
    const sourcePath = path.join(SOURCE_DIR, filename)
    const targetPath = path.join(TARGET_DIR, jsonName)

    manifest.push({ name: stem, file: jsonName })

    // Check mtime — skip if destination is up-to-date
    const srcStat = await fs.stat(sourcePath)
    let needsConvert = true
    try {
      const dstStat = await fs.stat(targetPath)
      if (dstStat.mtimeMs >= srcStat.mtimeMs) {
        needsConvert = false
        skipped++
      }
    } catch {
      // target doesn't exist → needs convert
    }

    if (!needsConvert) continue

    const text = await fs.readFile(sourcePath, 'utf8')
    try {
      const preset = convertMilkFile(text)
      await fs.writeFile(targetPath, JSON.stringify(preset), 'utf8')
      converted++
    } catch (err) {
      console.error(`[convert-milk] Error converting ${filename}: ${err.message}`)
      errors++
    }
  }

  // Sort manifest alphabetically
  manifest.sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  await fs.writeFile(
    path.join(TARGET_DIR, 'index.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  )

  console.log(`[convert-milk] ${converted} converted, ${skipped} up-to-date, ${errors} errors (${manifest.length} total)`)
  if (errors > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
