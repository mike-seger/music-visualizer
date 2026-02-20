#!/usr/bin/env node
/**
 * hash-presets.mjs
 *
 * Compute the same SHA-256 12-char content hash that the app uses (first 12
 * hex digits of SHA-256 of the raw file text) for one or more preset JSON
 * files and print the results as JSON or TSV.
 *
 * Usage:
 *   node scripts/hash-presets.mjs [options] <path>
 *
 * <path>  A single .json file, or a directory (top-level .json files only).
 *
 * Options:
 *   --format json   Output a JSON array (default)
 *   --format tsv    Output tab-separated values with a header row
 *   --out <file>    Write output to <file> instead of stdout
 *   --help          Show this help message
 *
 * Output columns (in this order):
 *   hash12   – First 12 hex chars of the SHA-256 digest (same key the app uses)
 *   hashfull – Full 64-char hex SHA-256 digest
 *   file     – File name (basename only, e.g. "martin - witchcraft reloaded.json")
 */

import { createHash }  from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
Usage: node scripts/hash-presets.mjs [options] <path>

<path>  A single .json file, or a directory whose top-level .json files are hashed.

Options:
  --format json   Output a JSON array (default)
  --format tsv    Output tab-separated values with a header row
  --out <file>    Write output to a file instead of stdout
  --help          Show this message

Output columns: hash12, hashfull, file
`.trim())
  process.exit(0)
}

let format = 'json'
let outFile = null
let positional = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--format') {
    format = args[++i]
    if (format !== 'json' && format !== 'tsv') {
      console.error(`Error: --format must be "json" or "tsv", got "${format}"`)
      process.exit(1)
    }
  } else if (args[i] === '--out') {
    outFile = args[++i]
  } else if (!args[i].startsWith('--')) {
    positional = args[i]
  }
}

if (!positional) {
  console.error('Error: no input path specified. Run with --help for usage.')
  process.exit(1)
}

// ─── Collect files ────────────────────────────────────────────────────────────

const inputPath = resolve(positional)
let stat
try { stat = statSync(inputPath) } catch {
  console.error(`Error: path not found: ${inputPath}`)
  process.exit(1)
}

/** @type {string[]} absolute paths */
let files = []

if (stat.isDirectory()) {
  files = readdirSync(inputPath)
    .filter((name) => extname(name).toLowerCase() === '.json')
    .sort()
    .map((name) => resolve(inputPath, name))
} else {
  if (extname(inputPath).toLowerCase() !== '.json') {
    console.error(`Error: not a .json file: ${inputPath}`)
    process.exit(1)
  }
  files = [inputPath]
}

if (files.length === 0) {
  console.error('No .json files found at the given path.')
  process.exit(1)
}

// ─── Hash function (matches the browser app exactly) ─────────────────────────

/**
 * SHA-256 of the raw UTF-8 file text, hex-encoded.
 * Returns { hash12, hashfull }.
 */
function hashPreset(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const hashfull = createHash('sha256').update(text, 'utf8').digest('hex')
  return { hash12: hashfull.slice(0, 12), hashfull }
}

// ─── Build rows ───────────────────────────────────────────────────────────────

const rows = []
for (const filePath of files) {
  try {
    const { hash12, hashfull } = hashPreset(filePath)
    rows.push({ hash12, hashfull, file: basename(filePath) })
  } catch (err) {
    console.warn(`Warning: could not hash ${filePath}: ${err.message}`)
  }
}

// ─── Format output ────────────────────────────────────────────────────────────

let output = ''

if (format === 'json') {
  output = JSON.stringify(rows, null, 2) + '\n'
} else {
  // TSV
  const header = ['hash12', 'hashfull', 'file'].join('\t')
  const body = rows.map((r) => [r.hash12, r.hashfull, r.file].join('\t')).join('\n')
  output = header + '\n' + body + '\n'
}

// ─── Write ────────────────────────────────────────────────────────────────────

if (outFile) {
  writeFileSync(resolve(outFile), output, 'utf8')
  console.error(`Written ${rows.length} row(s) to ${outFile}`)
} else {
  process.stdout.write(output)
}
