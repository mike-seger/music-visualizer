#!/usr/bin/env node
/**
 * Deduplicate preset JSON files across butterchurn preset groups.
 *
 * For each user group (other than 'default'), compares every real JSON file
 * against the default group.  When a file with the same name and MD5 exists
 * in default/, the real file is replaced with a relative symlink:
 *
 *     apple-butter/Foo.json  →  ../default/Foo.json
 *
 * At runtime the chain resolves:
 *     ../default/Foo.json  →  ../../node_modules/butterchurn-presets/…/Foo.json
 *
 * Incremental behaviour:
 *   • Files already symlinked to the correct target are skipped.
 *   • Only real files (or stale/wrong symlinks) are evaluated.
 *   • Only matching name + MD5 triggers replacement.
 *
 * Run AFTER gen-milkdrop-index.mjs so that default/ is fully populated.
 *
 * Usage:  node scripts/dedup-presets.mjs
 */

import {
  readdirSync, readFileSync, lstatSync, readlinkSync,
  symlinkSync, unlinkSync, existsSync,
} from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root      = resolve(__dirname, '..')
const presetsDir = resolve(root, 'public/butterchurn-presets')
const defaultDir = resolve(presetsDir, 'default')

// ---------------------------------------------------------------------------
// 1. Read group list
// ---------------------------------------------------------------------------
const groups = JSON.parse(readFileSync(resolve(presetsDir, 'preset-groups.json'), 'utf8'))
  .filter((g) => typeof g === 'string' && g !== 'default')

// ---------------------------------------------------------------------------
// 2. Build MD5 index of every preset in default/
// ---------------------------------------------------------------------------
function md5File(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex')
}

const defaultMd5 = new Map()       // filename → md5
const defaultFiles = readdirSync(defaultDir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')

for (const f of defaultFiles) {
  try { defaultMd5.set(f, md5File(resolve(defaultDir, f))) } catch { /* broken link */ }
}
console.log(`default: ${defaultMd5.size} preset files indexed\n`)

// ---------------------------------------------------------------------------
// 3. Deduplicate each group
// ---------------------------------------------------------------------------
let totalLinked = 0

for (const group of groups) {
  const groupDir = resolve(presetsDir, group)
  if (!existsSync(groupDir)) { console.log(`${group}: directory not found — skipped`); continue }

  const files = readdirSync(groupDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')

  let linked  = 0
  let skipped = 0
  let kept    = 0

  for (const f of files) {
    const filePath       = resolve(groupDir, f)
    const expectedTarget = join('..', 'default', f)

    // --- already correct symlink? ------------------------------------------
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink()) {
      if (readlinkSync(filePath) === expectedTarget) { skipped++; continue }
      // stale / wrong target — fall through to re-evaluate
    }

    // --- does default/ even have this file? --------------------------------
    if (!defaultMd5.has(f)) { kept++; continue }

    // --- compare content ---------------------------------------------------
    let groupHash
    try { groupHash = md5File(filePath) } catch { kept++; continue }

    if (groupHash === defaultMd5.get(f)) {
      unlinkSync(filePath)
      symlinkSync(expectedTarget, filePath)
      linked++
    } else {
      kept++
    }
  }

  totalLinked += linked
  console.log(
    `${group}: ${linked} deduplicated, ${skipped} already linked, ${kept} unique`
  )
}

console.log(`\nTotal deduplicated: ${totalLinked}`)
