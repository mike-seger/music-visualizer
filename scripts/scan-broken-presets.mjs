#!/usr/bin/env node
/**
 * scan-broken-presets.mjs
 *
 * Bulk-identifies Butterchurn preset JSON files that would crash or
 * throw when loaded, by replicating the exact `new Function(...)` calls
 * that the Butterchurn engine makes during preset initialisation.
 *
 * No browser / WebGL required — runs in Node.js.
 *
 * Usage:
 *   node scripts/scan-broken-presets.mjs [dir...]
 *
 * If no dirs are given, scans public/butterchurn-presets/ recursively.
 * Broken presets are printed grouped by error type, and optionally written
 * to a JSON report (--output <file>).
 *
 * Examples:
 *   node scripts/scan-broken-presets.mjs
 *   node scripts/scan-broken-presets.mjs public/butterchurn-presets/cream-of-the-crop
 *   node scripts/scan-broken-presets.mjs --output tmp/broken-report.json
 *   node scripts/scan-broken-presets.mjs --tsv > tmp/broken.tsv
 *   node scripts/scan-broken-presets.mjs --move
 *
 * Flags:
 *   --output <file>  Write a JSON report to <file>
 *   --tsv            Print file<tab>error rows to stdout (pipe-friendly)
 *   --move           Move broken files into a broken/ subdir with _broken_ prefix
 *
 * Files already inside a broken/ directory or named _broken_* are skipped.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
let outputFile = null
let tsvMode = false
let moveMode = false
const scanDirs = []

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[++i]
  } else if (args[i] === '--tsv') {
    tsvMode = true
  } else if (args[i] === '--move') {
    moveMode = true
  } else {
    scanDirs.push(args[i])
  }
}

if (scanDirs.length === 0) {
  scanDirs.push(join(ROOT, 'public/butterchurn-presets'))
}

// ── Collect .json files ───────────────────────────────────────────────────────
function collectJsonFiles(dir, results = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return results }
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'broken') continue   // skip already-quarantined dirs
      collectJsonFiles(full, results)
    } else if (entry.endsWith('.json') && entry !== 'index.json' && !entry.startsWith('_broken_')) {
      results.push(full)
    }
  }
  return results
}

// ── Replicate Butterchurn's exact new Function calls ─────────────────────────
// Source: node_modules/butterchurn/lib/butterchurn.js
//   new Function('a', preset.init_eqs_str   + " return a;")
//   new Function('a', preset.frame_eqs_str  + " return a;")
//   new Function('a', preset.pixel_eqs_str  + " return a;")
//   shapes[i].init_eqs_str / frame_eqs_str
//   waves[i].init_eqs_str  / frame_eqs_str / point_eqs_str

function tryCompile(code, label) {
  if (!code || typeof code !== 'string') return null
  try {
    // eslint-disable-next-line no-new-func
    new Function('a', code + ' return a;')
    return null
  } catch (e) {
    return { label, error: e.message }
  }
}

function checkPreset(preset) {
  const failures = []

  const top = [
    ['init_eqs_str',   preset.init_eqs_str],
    ['frame_eqs_str',  preset.frame_eqs_str],
    ['pixel_eqs_str',  preset.pixel_eqs_str],
  ]
  for (const [key, code] of top) {
    const f = tryCompile(code, key)
    if (f) failures.push(f)
  }

  if (Array.isArray(preset.shapes)) {
    preset.shapes.forEach((shape, i) => {
      if (!shape) return
      for (const key of ['init_eqs_str', 'frame_eqs_str']) {
        const f = tryCompile(shape[key], `shapes[${i}].${key}`)
        if (f) failures.push(f)
      }
    })
  }

  if (Array.isArray(preset.waves)) {
    preset.waves.forEach((wave, i) => {
      if (!wave) return
      for (const key of ['init_eqs_str', 'frame_eqs_str', 'point_eqs_str']) {
        const f = tryCompile(wave[key], `waves[${i}].${key}`)
        if (f) failures.push(f)
      }
    })
  }

  return failures
}

// ── Main ──────────────────────────────────────────────────────────────────────
const files = scanDirs.flatMap(d => collectJsonFiles(d))
if (!tsvMode) console.log(`Scanning ${files.length} preset files…\n`)

const broken = []
let ok = 0

for (const file of files) {
  let preset
  try {
    preset = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    broken.push({ file: relative(ROOT, file), parseError: e.message, failures: [] })
    continue
  }

  // Skip index/group manifests (no baseVals)
  if (!preset.baseVals && !preset.init_eqs_str && !preset.frame_eqs_str) continue

  const failures = checkPreset(preset)
  if (failures.length > 0) {
    broken.push({ file: relative(ROOT, file), failures })
  } else {
    ok++
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (tsvMode) {
  // TSV output: file \t error  (one row per failing field)
  process.stdout.write('file\terror\n')
  for (const entry of broken) {
    if (entry.parseError) {
      process.stdout.write(`${entry.file}\tJSON parse error: ${entry.parseError}\n`)
    }
    for (const f of entry.failures) {
      process.stdout.write(`${entry.file}\t${f.error}\n`)
    }
  }
} else if (broken.length === 0) {
  console.log(`All ${ok} presets compiled cleanly.`)
} else {
  // Group by error message
  const byError = new Map()
  for (const entry of broken) {
    for (const f of entry.failures) {
      const key = f.error
      if (!byError.has(key)) byError.set(key, [])
      byError.get(key).push(`${entry.file} → ${f.label}`)
    }
    if (entry.parseError) {
      const key = `JSON parse error: ${entry.parseError}`
      if (!byError.has(key)) byError.set(key, [])
      byError.get(key).push(entry.file)
    }
  }

  for (const [err, instances] of [...byError.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n── ${err} (${instances.length} instance${instances.length > 1 ? 's' : ''}) ──`)
    for (const i of instances) console.log(`  ${i}`)
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Total broken: ${broken.length}  |  Clean: ${ok}  |  Scanned: ${files.length}`)
}

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({ broken, clean: ok, total: files.length }, null, 2))
  const msg = `\nReport written to ${outputFile}`
  tsvMode ? process.stderr.write(msg + '\n') : console.log(msg)
}

// ── Move broken files ─────────────────────────────────────────────────────────
if (moveMode && broken.length > 0) {
  let moved = 0
  for (const entry of broken) {
    if (entry.parseError && entry.failures.length === 0) continue // skip pure parse errors
    const abs = join(ROOT, entry.file)
    const dir = dirname(abs)
    const name = basename(abs)
    const destDir = join(dir, 'broken')
    const destFile = join(destDir, '_broken_' + name)
    try {
      mkdirSync(destDir, { recursive: true })
      renameSync(abs, destFile)
      const msg = `  moved → ${relative(ROOT, destFile)}`
      tsvMode ? process.stderr.write(msg + '\n') : console.log(msg)
      moved++
    } catch (e) {
      const msg = `  ERROR moving ${entry.file}: ${e.message}`
      tsvMode ? process.stderr.write(msg + '\n') : console.error(msg)
    }
  }
  const summary = `\nMoved ${moved} file${moved !== 1 ? 's' : ''} to broken/ subdirectories.`
  tsvMode ? process.stderr.write(summary + '\n') : console.log(summary)
}
