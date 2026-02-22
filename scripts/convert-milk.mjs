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

// Optional: --src <dir> --dst <dir> on the command line
const _args = process.argv.slice(2)
const _srcArg = _args[_args.indexOf('--src') + 1]
const _dstArg = _args[_args.indexOf('--dst') + 1]
const SOURCE_DIR = path.resolve(_srcArg || 'src/milkdrop-presets')
const TARGET_DIR = path.resolve(_dstArg || 'public/milkdrop-presets')


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
  s = s.replace(/\bfloat1\b/g, 'float')  // float1 is HLSL-only
  s = s.replace(/\bhalf4\b/g,  'vec4')
  s = s.replace(/\bhalf3\b/g,  'vec3')
  s = s.replace(/\bhalf2\b/g,  'vec2')
  s = s.replace(/\bhalf\b/g,   'float')
  s = s.replace(/\bint4\b/g,   'ivec4')
  s = s.replace(/\bint3\b/g,   'ivec3')
  s = s.replace(/\bint2\b/g,   'ivec2')
  s = s.replace(/\buint4\b/g,  'uvec4')
  s = s.replace(/\buint3\b/g,  'uvec3')
  s = s.replace(/\buint2\b/g,  'uvec2')

  // ── Remove HLSL-only storage qualifiers ──
  // 'static const X' → 'const X',  'static X' → 'X'
  s = s.replace(/\bstatic\s+const\b/g, 'const')
  s = s.replace(/\bstatic\s+/g, '')

  // ── Ensure sampler/texsize declarations have 'uniform' prefix ──
  // Bare 'sampler sampler_XXX' (HLSL) → 'uniform sampler2D sampler_XXX'
  s = s.replace(/\bsampler\s+(sampler_\w+)/g, 'uniform sampler2D $1')
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

  // ─── IIFE-wrap EEL _str fields ────────────────────────────────────────────
  // Butterchurn's milkdrop engine evaluates _str fields inside `return()` as a
  // comma-expression.  When the EEL parser compiles loop(n, body) it emits a
  // bare `for(...){}` statement which is invalid as an expression.
  // Wrapping the entire field in an IIFE makes it a single call-expression
  // that works in any expression context and still applies all side-effects.
  const wrapEelStr = (s) => (s && s.trim()) ? `(function(){${s}}())` : s

  presetMap.init_eqs_str   = wrapEelStr(presetMap.init_eqs_str)
  presetMap.frame_eqs_str  = wrapEelStr(presetMap.frame_eqs_str)
  presetMap.pixel_eqs_str  = wrapEelStr(presetMap.pixel_eqs_str)

  for (const shape of presetMap.shapes || []) {
    if (shape) {
      shape.init_eqs_str  = wrapEelStr(shape.init_eqs_str)
      shape.frame_eqs_str = wrapEelStr(shape.frame_eqs_str)
    }
  }
  for (const wave of presetMap.waves || []) {
    if (wave) {
      wave.init_eqs_str  = wrapEelStr(wave.init_eqs_str)
      wave.frame_eqs_str = wrapEelStr(wave.frame_eqs_str)
      wave.point_eqs_str = wrapEelStr(wave.point_eqs_str)
    }
  }

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

// ─── .milk2 extraction ─────────────────────────────────────────────────────

/**
 * Extract embedded presets from a MilkDrop 3 .milk2 blend file.
 * Returns an array of { name, text } objects (one per PRESET block).
 */
function extractMilk2Presets(src) {
  const results = []
  const blockRe = /\[PRESET(\d+)_BEGIN\]\r?\n([\s\S]*?)\[PRESET\1_END\]/g
  let m
  while ((m = blockRe.exec(src)) !== null) {
    const block = m[2]
    // First non-empty line may be NAME=...
    const nameMatch = block.match(/^NAME=(.*)$/m)
    const name = nameMatch ? nameMatch[1].trim() : `preset${m[1]}`
    // Strip the NAME= line — the rest is standard .milk content
    const text = block.replace(/^NAME=.*\r?\n?/m, '')
    results.push({ name, text })
  }
  return results
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

  // Discover source files (.milk and .milk2)
  const srcEntries = await fs.readdir(SOURCE_DIR, { withFileTypes: true })
  const milkFiles  = srcEntries.filter(e => e.isFile() && e.name.endsWith('.milk'))
  const milk2Files = srcEntries.filter(e => e.isFile() && e.name.endsWith('.milk2'))

  let converted = 0
  let skipped = 0
  let errors = 0
  const manifest = []
  const expectedJsonNames = new Set(['index.json'])

  // Build a flat list of { stem, jsonName, sourcePath, getText } tasks.
  // .milk files → one task each.
  // .milk2 files → extract embedded presets at read time (may be 1 or 2).
  const tasks = []

  for (const entry of milkFiles) {
    const sourcePath = path.join(SOURCE_DIR, entry.name)
    const stem       = entry.name.replace(/\.milk$/, '')
    tasks.push({ stem, sourcePath, getText: async () => fs.readFile(sourcePath, 'utf8') })
  }

  for (const entry of milk2Files) {
    const sourcePath = path.join(SOURCE_DIR, entry.name)
    const raw = await fs.readFile(sourcePath, 'utf8')
    const embedded = extractMilk2Presets(raw)
    if (embedded.length === 0) {
      console.warn(`[convert-milk] No preset blocks in ${entry.name} — skipping`)
      continue
    }
    for (const { name, text } of embedded) {
      const getStem = name  // closure capture
      tasks.push({ stem: getStem, sourcePath, getText: async () => text })
    }
  }

  for (const { stem, sourcePath, getText } of tasks) {
    const jsonName   = `${stem}.json`
    const targetPath = path.join(TARGET_DIR, jsonName)
    expectedJsonNames.add(jsonName)
    manifest.push({ name: stem, file: jsonName })

    // Check mtime — skip if destination is up-to-date (only meaningful for .milk;
    // .milk2 embedded presets always check against the container file mtime).
    const srcStat = await fs.stat(sourcePath)
    let needsConvert = true
    try {
      const dstStat = await fs.stat(targetPath)
      if (dstStat.mtimeMs >= srcStat.mtimeMs) { needsConvert = false; skipped++ }
    } catch { /* target missing → convert */ }

    if (!needsConvert) continue

    try {
      const text   = await getText()
      const preset = convertMilkFile(text)
      await fs.writeFile(targetPath, JSON.stringify(preset), 'utf8')
      converted++
    } catch (err) {
      console.error(`[convert-milk] Error converting ${stem}: ${err.message}`)
      errors++
    }
  }

  // Delete stale destination files (no matching source)
  const dstEntries = await fs.readdir(TARGET_DIR, { withFileTypes: true })
  for (const de of dstEntries) {
    if (de.isFile() && de.name.endsWith('.json') && !expectedJsonNames.has(de.name)) {
      await fs.unlink(path.join(TARGET_DIR, de.name))
      console.log(`[convert-milk] Deleted stale ${de.name}`)
    }
  }

  if (tasks.length === 0) {
    console.log('[convert-milk] No .milk/.milk2 files found in', SOURCE_DIR)
    await fs.writeFile(path.join(TARGET_DIR, 'index.json'), '[]', 'utf8')
    return
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
