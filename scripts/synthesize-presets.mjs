#!/usr/bin/env node
/**
 * synthesize-presets.mjs
 *
 * Synthesize new butterchurn presets by combining structural components from
 * multiple source presets.  Each output preset is built from N randomly-chosen
 * input presets (N between --minIn and --maxIn).  Blendable components can
 * optionally be interpolated rather than copied wholesale.
 *
 * See README-synthesize.md for full usage.
 */

import { createHash } from 'node:crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync,
  symlinkSync,
} from 'node:fs'
import { resolve, join, basename, dirname, relative } from 'node:path'

// ─── Argument parsing ───────────────────────────────────────────────────────

function usage() {
  console.error(`\
Usage: node scripts/synthesize-presets.mjs [options] <group-dir> <input...>

Options:
  --minIn <n>           Minimum number of input presets to combine (default: 2)
  --maxIn <n>           Maximum number of input presets to combine (default: 2)
  --nOut  <n>           Number of output presets to generate (default: 100)
  --components <list>   Comma-delimited components to blend:
                        BaseVals,InitEQs,Shapes,Waves  (default: all four)

Arguments:
  group-dir    Preset group directory (created if needed).
               Presets are written to <group-dir>/presets-src/NNNN.json.
               Input sources are symlinked as NNNN-A.json, NNNN-B.json, etc.
  input...     One or more input sources — either:
                 • a directory containing *.json preset files, or
                 • individual .json preset file paths`)
  process.exit(1)
}

const args = process.argv.slice(2)
let minIn = 2
let maxIn = 2
let nOut  = 100
let blendComponents = new Set(['BaseVals', 'InitEQs', 'Shapes', 'Waves'])

const positional = []

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--minIn')      { minIn = parseInt(args[++i], 10); continue }
  if (a === '--maxIn')      { maxIn = parseInt(args[++i], 10); continue }
  if (a === '--nOut')       { nOut  = parseInt(args[++i], 10); continue }
  if (a === '--components') {
    const raw = args[++i]
    const valid = new Set(['BaseVals', 'InitEQs', 'Shapes', 'Waves'])
    blendComponents = new Set(
      raw.split(',').map(s => s.trim()).filter(s => {
        if (!valid.has(s)) { console.error(`Unknown component: ${s}`); process.exit(1) }
        return true
      })
    )
    continue
  }
  if (a === '--help' || a === '-h') usage()
  if (a.startsWith('--'))  { console.error(`Unknown option: ${a}`); usage() }
  positional.push(a)
}

if (positional.length < 2) {
  console.error('Error: need at least an output directory and one input source.')
  usage()
}

const outDir     = resolve(positional[0])
const inputPaths = positional.slice(1).map(p => resolve(p))

if (minIn < 1)       { console.error('--minIn must be >= 1'); process.exit(1) }
if (maxIn < minIn)   { console.error('--maxIn must be >= --minIn'); process.exit(1) }
if (nOut < 1)        { console.error('--nOut must be >= 1'); process.exit(1) }

// ─── Helpers ────────────────────────────────────────────────────────────────

function hash20(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 20)
}

function clone(o)             { return JSON.parse(JSON.stringify(o)) }
function lerp(a, b, t)        { return a + (b - a) * t }
function rf(lo = 0, hi = 1)   { return lo + Math.random() * (hi - lo) }
function pick(arr)             { return arr[Math.floor(Math.random() * arr.length)] }

function pickN(arr, n) {
  const copy = [...arr]
  const out = []
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)) }

/** Merge two baseVals objects: lerp numerics, union keys. */
function mergeBaseVals(a, b, bias) {
  const result = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number' && typeof result[k] === 'number') {
      result[k] = lerp(result[k], v, bias)
    } else if (!(k in result)) {
      result[k] = v
    }
  }
  return result
}

/** Extract variable names declared in an equation string. */
function extractVarDecls(eqStr) {
  if (!eqStr) return new Set()
  const vars = new Set()
  for (const m of eqStr.matchAll(/a\['(\w+)'\]\s*=/g))  vars.add(m[1])
  for (const m of eqStr.matchAll(/a\.(\w+)\s*=/g))       vars.add(m[1])
  return vars
}

/** Merge init_eqs_str by combining all variable declarations. */
function mergeInitEqs(...strs) {
  const allVars = new Set()
  for (const s of strs) {
    for (const v of extractVarDecls(s)) allVars.add(v)
  }
  if (allVars.size === 0) return ''
  return [...allVars].map(v => `a['${v}'] = 0;`).join(' ')
}

function disabledShape() { return { baseVals: { enabled: 0 } } }
function disabledWave()  { return { baseVals: { enabled: 0 } } }

function padShapes(arr) {
  const out = arr.slice(0, 4)
  while (out.length < 4) out.push(disabledShape())
  return out
}

function padWaves(arr) {
  const out = arr.slice(0, 4)
  while (out.length < 4) out.push(disabledWave())
  return out
}

/** Blend shapes by lerping their baseVals. Code eqs are taken from shape A. */
function blendShapes(shapesA, shapesB, bias) {
  const result = []
  for (let i = 0; i < 4; i++) {
    const a = shapesA[i]
    const b = shapesB[i]
    if (!a && !b) { result.push(disabledShape()); continue }
    if (!a)       { result.push(clone(b)); continue }
    if (!b)       { result.push(clone(a)); continue }
    const blended = clone(a)
    if (a.baseVals && b.baseVals) {
      blended.baseVals = mergeBaseVals(a.baseVals, b.baseVals, bias)
    }
    result.push(blended)
  }
  return result
}

/** Blend waves by lerping their baseVals. Code eqs are taken from wave A. */
function blendWaves(wavesA, wavesB, bias) {
  const result = []
  for (let i = 0; i < 4; i++) {
    const a = wavesA[i]
    const b = wavesB[i]
    if (!a && !b) { result.push(disabledWave()); continue }
    if (!a)       { result.push(clone(b)); continue }
    if (!b)       { result.push(clone(a)); continue }
    const blended = clone(a)
    if (a.baseVals && b.baseVals) {
      blended.baseVals = mergeBaseVals(a.baseVals, b.baseVals, bias)
    }
    result.push(blended)
  }
  return result
}

// ─── Load input presets ─────────────────────────────────────────────────────

function loadPresetFile(filePath) {
  const raw  = readFileSync(filePath)
  const data = JSON.parse(raw)
  const h    = hash20(raw)
  return { path: filePath, hash: h, data }
}

function loadInputs(paths) {
  const presets = []
  const seen    = new Set()
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) {
      const files = readdirSync(p)
        .filter(f => f.endsWith('.json') && !f.startsWith('.'))
        .sort()
      for (const f of files) {
        const pr = loadPresetFile(join(p, f))
        if (!seen.has(pr.hash)) { seen.add(pr.hash); presets.push(pr) }
      }
    } else if (st.isFile() && p.endsWith('.json')) {
      const pr = loadPresetFile(p)
      if (!seen.has(pr.hash)) { seen.add(pr.hash); presets.push(pr) }
    } else {
      console.warn(`Skipping non-JSON path: ${p}`)
    }
  }
  return presets
}

const sources = loadInputs(inputPaths)
if (sources.length < minIn) {
  console.error(`Need at least ${minIn} unique input presets, found ${sources.length}.`)
  process.exit(1)
}
console.log(`Loaded ${sources.length} unique input preset(s).`)
console.log(`Generating ${nOut} preset(s), ${minIn}–${maxIn} sources each.`)
console.log(`Blending: ${[...blendComponents].join(', ') || '(none)'}`)

// ─── Synthesize ─────────────────────────────────────────────────────────────

/**
 * Build one synthesized preset from the given source presets.
 * Components listed in `blendSet` are blended; others are taken from one
 * randomly-chosen source.
 */
function synthesizeOne(chosen, blendSet) {
  const n = chosen.length

  // ── BaseVals ──────────────────────────────────────────────────────────────
  let baseVals
  if (blendSet.has('BaseVals') && n >= 2) {
    baseVals = clone(chosen[0].data.baseVals || {})
    for (let i = 1; i < n; i++) {
      baseVals = mergeBaseVals(baseVals, chosen[i].data.baseVals || {}, rf(0.2, 0.6))
    }
  } else {
    baseVals = clone(pick(chosen).data.baseVals || {})
  }

  // ── InitEQs ──────────────────────────────────────────────────────────────
  let init_eqs_str
  if (blendSet.has('InitEQs') && n >= 2) {
    init_eqs_str = mergeInitEqs(...chosen.map(s => s.data.init_eqs_str))
  } else {
    init_eqs_str = pick(chosen).data.init_eqs_str || ''
  }

  // ── Shapes ────────────────────────────────────────────────────────────────
  let shapes
  if (blendSet.has('Shapes') && n >= 2) {
    const [sa, sb] = pickN(chosen, 2)
    shapes = blendShapes(sa.data.shapes || [], sb.data.shapes || [], rf(0.2, 0.8))
  } else {
    shapes = clone(pick(chosen).data.shapes || [])
  }

  // ── Waves ─────────────────────────────────────────────────────────────────
  let waves
  if (blendSet.has('Waves') && n >= 2) {
    const [wa, wb] = pickN(chosen, 2)
    waves = blendWaves(wa.data.waves || [], wb.data.waves || [], rf(0.2, 0.8))
  } else {
    waves = clone(pick(chosen).data.waves || [])
  }

  // ── Non-blendable components (always one source each) ─────────────────────
  const frame_eqs_str = pick(chosen).data.frame_eqs_str || ''
  const pixel_eqs_str = pick(chosen).data.pixel_eqs_str || ''
  const warp          = pick(chosen).data.warp || ''
  const comp          = pick(chosen).data.comp || ''

  return {
    baseVals,
    shapes: padShapes(shapes),
    waves:  padWaves(waves),
    init_eqs_str,
    frame_eqs_str,
    pixel_eqs_str,
    warp,
    comp,
  }
}

// ─── Generate outputs ───────────────────────────────────────────────────────
// Follow the preset group directory structure:
//   <outDir>/presets-src/NNNN.json   ← synthesized source presets
// Report is placed next to the group directory, not inside it.

const presetsSrcDir = join(outDir, 'presets-src')
mkdirSync(presetsSrcDir, { recursive: true })

const reportLines = []
const usedCombos  = new Set()
const numWidth    = Math.max(String(nOut).length, 4)

for (let i = 0; i < nOut; i++) {
  const numSrcs = randInt(minIn, Math.min(maxIn, sources.length))

  // Pick unique combination of sources
  let chosen, comboKey
  let attempts = 0
  do {
    chosen   = pickN(sources, numSrcs)
    comboKey = chosen.map(s => s.hash).sort().join('+')
    attempts++
  } while (usedCombos.has(comboKey) && attempts < 500)
  usedCombos.add(comboKey)

  const preset = synthesizeOne(chosen, blendComponents)

  const num     = String(i + 1).padStart(numWidth, '0')
  const outPath = join(presetsSrcDir, `${num}.json`)
  const json    = JSON.stringify(preset, null, 2)
  writeFileSync(outPath, json + '\n', 'utf8')

  // Symlink each input source preset alongside the output so they
  // can be compared in the UI.  Uses relative symlinks so the group
  // directory stays relocatable.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (let j = 0; j < chosen.length; j++) {
    const suffix   = LETTERS[j]
    const linkPath = join(presetsSrcDir, `${num}-${suffix}.json`)
    const target   = relative(presetsSrcDir, chosen[j].path)
    symlinkSync(target, linkPath)
  }

  const outHash   = hash20(readFileSync(outPath))
  const srcHashes = chosen.map(s => s.hash).join(',')
  reportLines.push(`${outHash}\t${srcHashes}`)

  if ((i + 1) % 25 === 0 || i + 1 === nOut) {
    console.log(`  ${i + 1}/${nOut} generated`)
  }
}

// ─── Write report ───────────────────────────────────────────────────────────
// Placed next to (not inside) the group directory so it doesn't interfere
// with mkmeta.sh scanning presets-src/.

const reportPath = join(dirname(outDir), `${basename(outDir)}-synthesis-report.tsv`)
writeFileSync(reportPath, reportLines.join('\n') + '\n', 'utf8')

console.log(`\nReport:  ${reportPath}`)
console.log(`Presets: ${presetsSrcDir}`)
