#!/usr/bin/env node
/**
 * Generate public/butterchurn-presets/default/index.json and copy
 * the individual preset JSON files from the butterchurn-presets npm package
 * so they can be served as static assets and committed to git.
 *
 * Exclude patterns from public/milkdrop-presets.json are applied at index-
 * generation time so the runtime has no special-case filtering.
 *
 * Incremental: files whose content already matches are skipped.
 *
 * Usage: node scripts/gen-milkdrop-index.mjs
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, lstatSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const srcDir = resolve(root, 'node_modules/butterchurn-presets/presets/converted')
const outDir = resolve(root, 'public/butterchurn-presets/default')

// Load exclude patterns from milkdrop-presets.json
let excludeRegexes = []
try {
  const cfg = JSON.parse(readFileSync(resolve(root, 'public/milkdrop-presets.json'), 'utf8'))
  if (Array.isArray(cfg.excludePatterns)) {
    excludeRegexes = cfg.excludePatterns
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => new RegExp(p, 'i'))
  }
} catch { /* no exclusions */ }

const files = readdirSync(srcDir)
  .filter(f => f.endsWith('.json'))
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

// Build index, excluding patterns
const index = files
  .map(f => ({ name: f.replace(/\.json$/, ''), file: f }))
  .filter(e => !excludeRegexes.some(re => re.test(e.name)))

mkdirSync(outDir, { recursive: true })
mkdirSync(resolve(outDir, 'presets'), { recursive: true })
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')

// Copy individual preset JSON files (only those in the index) into the presets/ subfolder
const indexedFiles = new Set(index.map(e => e.file))
let copied = 0
let skipped = 0
let replaced = 0
for (const f of files) {
  if (!indexedFiles.has(f)) continue
  const dest = resolve(outDir, 'presets', f)
  const src = resolve(srcDir, f)

  // Check if dest already exists (as real file or symlink)
  let destStat
  try { destStat = lstatSync(dest) } catch { destStat = null }

  if (destStat) {
    // Replace stale symlinks with real copies
    if (destStat.isSymbolicLink()) {
      unlinkSync(dest)
      copyFileSync(src, dest)
      replaced++
      continue
    }
    // Real file — skip if content matches (incremental)
    const srcBuf = readFileSync(src)
    const destBuf = readFileSync(dest)
    if (srcBuf.equals(destBuf)) {
      skipped++
      continue
    }
    // Content changed — overwrite
    copyFileSync(src, dest)
    replaced++
    continue
  }

  copyFileSync(src, dest)
  copied++
}

const excluded = files.length - index.length
console.log(`Wrote ${index.length} entries to public/butterchurn-presets/default/index.json (${excluded} excluded)`)
console.log(`Copied ${copied} new, updated ${replaced}, skipped ${skipped} unchanged (dest: default/presets/)`)
