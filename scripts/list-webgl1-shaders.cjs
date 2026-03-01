#!/usr/bin/env node
/**
 * list-webgl1-shaders.cjs
 *
 * Scans all .glsl files in a presets-src/ directory and reports which ones
 * are detected as requiring WebGL1 (GLSL ES 1.00) vs WebGL2 (GLSL ES 3.00).
 *
 * Usage:
 *   node scripts/list-webgl1-shaders.cjs [presets-src-dir]
 *
 * Default directory: public/shadertoy-presets/default/presets-src
 *
 * Exit codes:
 *   0 — success (even if WebGL1 shaders are found)
 *   1 — directory not found or no .glsl files
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { detectGLSLVersion } = require('./detect-glsl-version.cjs')

// ---------------------------------------------------------------------------
// Resolve presets-src directory
// ---------------------------------------------------------------------------
const defaultDir = path.resolve(__dirname, '../public/shadertoy-presets/default/presets-src')
const targetDir = path.resolve(process.argv[2] || defaultDir)

if (!fs.existsSync(targetDir)) {
  console.error(`Error: directory not found: ${targetDir}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Scan .glsl files
// ---------------------------------------------------------------------------
const files = fs.readdirSync(targetDir)
  .filter((f) => f.endsWith('.glsl'))
  .sort()

if (files.length === 0) {
  console.error(`No .glsl files found in: ${targetDir}`)
  process.exit(1)
}

const webgl1 = []
const webgl2 = []

for (const file of files) {
  const filePath = path.join(targetDir, file)
  const source = fs.readFileSync(filePath, 'utf8')
  const { version, reason } = detectGLSLVersion(source)
  const entry = { file, reason }
  if (version === 1) webgl1.push(entry)
  else webgl2.push(entry)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const total = files.length

console.log(`\nGLSL version scan: ${targetDir}`)
console.log(`${'─'.repeat(72)}`)
console.log(`Total shaders scanned: ${total}`)
console.log(`  WebGL1 (GLSL ES 1.00): ${webgl1.length}`)
console.log(`  WebGL2 (GLSL ES 3.00): ${webgl2.length}`)
console.log()

if (webgl1.length > 0) {
  console.log(`WebGL1 shaders (${webgl1.length}):`)
  for (const { file, reason } of webgl1) {
    console.log(`  ${file.padEnd(40)}  ${reason}`)
  }
  console.log()
}

if (webgl2.length > 0) {
  console.log(`WebGL2 shaders (${webgl2.length}):`)
  for (const { file, reason } of webgl2) {
    console.log(`  ${file.padEnd(40)}  ${reason}`)
  }
  console.log()
}
