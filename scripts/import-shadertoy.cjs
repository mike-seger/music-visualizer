#!/usr/bin/env node
/**
 * import-shadertoy.cjs
 *
 * Convert a Shadertoy export (.zip or .json) to this project's GLSL preset format
 * and place it in a presets-src/ directory, then optionally run mkmeta.sh.
 *
 * Usage:
 *   node scripts/import-shadertoy.cjs <file.zip|file.json> [options]
 *
 * Options:
 *   --out-dir <dir>   Destination presets-src directory
 *                     (default: public/shadertoy-presets/default/presets-src)
 *   --name <slug>     Override output filename slug (no extension)
 *   --no-meta         Skip running mkmeta.sh after writing
 *
 * The script produces a single .glsl file using the project's multi-section format:
 *   // # Common          ← shared code (if present)
 *   // # Buffer A        ← Buffer A pass
 *   // # Image           ← Image / final pass
 *
 * Single-pass shaders (Image only) are written as plain GLSL with no section markers.
 *
 * Texture inputs (iChannel*) that reference Shadertoy's /media/ assets are noted
 * in a comment block at the top of the file — the app cannot load them automatically.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)

function consumeFlag(flag) {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  const val = args[i + 1]
  args.splice(i, 2)
  return val
}

function consumeBoolFlag(flag) {
  const i = args.indexOf(flag)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

const defaultOutDir = path.resolve(__dirname, '../public/shadertoy-presets/default/presets-src')
const outDir  = path.resolve(consumeFlag('--out-dir') || defaultOutDir)
const nameArg = consumeFlag('--name') || null
const noMeta  = consumeBoolFlag('--no-meta')

const inputFile = args[0]
if (!inputFile) {
  console.error('Usage: node scripts/import-shadertoy.cjs <file.zip|file.json> [options]')
  process.exit(1)
}
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Load JSON from ZIP or directly
// ---------------------------------------------------------------------------
function loadJson(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.json') {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }

  if (ext === '.zip') {
    // List files, find the .json
    const list = execSync(`unzip -l "${filePath}"`).toString()
    const jsonMatch = list.match(/\s(\S+\.json)\s*$/m)
    if (!jsonMatch) {
      console.error('No .json file found in ZIP')
      process.exit(1)
    }
    const jsonName = jsonMatch[1].trim()
    const raw = execSync(`unzip -p "${filePath}" "${jsonName}"`).toString()
    return JSON.parse(raw)
  }

  console.error(`Unsupported file type: ${ext} (expected .zip or .json)`)
  process.exit(1)
}

const data = loadJson(inputFile)

// The JSON is either the raw API response { Shader: { ... } } or the export format { ver, renderpass, info }
const shader = data.Shader || data
const info = shader.info || {}
const renderpasses = shader.renderpass || []

if (!renderpasses.length) {
  console.error('No renderpass entries found in shader JSON')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Slugify name
// ---------------------------------------------------------------------------
function slugify(name) {
  return String(name || 'shader')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

const shaderName = info.name || path.basename(inputFile, path.extname(inputFile))
const slug = nameArg || slugify(shaderName)
const outFile = path.join(outDir, `${slug}.glsl`)

// ---------------------------------------------------------------------------
// Parse passes
// ---------------------------------------------------------------------------
// Shadertoy pass types: "image", "buffer", "common", "cubemap", "sound"
// We handle: image, buffer, common. Others are listed as unsupported.

const commonPasses  = renderpasses.filter(p => p.type === 'common')
const bufferPasses  = renderpasses.filter(p => p.type === 'buffer')
  // sort Buffer A, B, C, D by output channel id ascending
  .sort((a, b) => (a.outputs[0]?.channel ?? 0) - (b.outputs[0]?.channel ?? 0))
const imagePasses   = renderpasses.filter(p => p.type === 'image')
const unsupported   = renderpasses.filter(p => !['image', 'buffer', 'common'].includes(p.type))

// ---------------------------------------------------------------------------
// Collect media inputs (textures, cubemaps)
// Shadertoy serves these with auth cookies, so we can't fetch them directly.
// We emit a browser-console snippet the user can paste on shadertoy.com instead.
// ---------------------------------------------------------------------------
const mediaDir = path.resolve(__dirname, '../public/shadertoy-media')
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true })

const allInputs = renderpasses.flatMap(p => p.inputs || [])
const mediaInputs = allInputs.filter(inp =>
  (inp.type === 'texture' || inp.type === 'cubemap' || inp.type === 'volume') && inp.filepath
)

// Map: channel → { filepath, basename, localPublicPath }
const channelLocalPaths = {}
const snippetEntries = []

for (const inp of mediaInputs) {
  const ch = inp.channel
  if (ch == null || channelLocalPaths[ch]) continue
  const basename = path.basename(inp.filepath)
  const localPublicPath = `/shadertoy-media/${basename}`
  channelLocalPaths[ch] = localPublicPath
  snippetEntries.push({ ch, shadertoyPath: inp.filepath, basename, localPublicPath })

  // Remove stale/corrupt files from a previous failed download attempt
  const stale = path.join(mediaDir, basename)
  if (fs.existsSync(stale)) {
    const size = fs.statSync(stale).size
    // Shadertoy's error pages are small HTML; real images are > 1 KB
    if (size < 1024) {
      fs.unlinkSync(stale)
      console.log(`  Removed stale file: ${basename} (${size} B)`)
    }
  }
}

// Inputs with no filepath (rare: procedural noise types built into Shadertoy)
const skippedInputs = allInputs.filter(inp =>
  (inp.type === 'texture' || inp.type === 'cubemap') && !inp.filepath
)
const textureLines = skippedInputs.map(inp => {
  const ch = inp.channel ?? '?'
  return `iChannel${ch}: ${inp.type} id=${inp.id || '?'} (built-in Shadertoy type, no URL)`
})

// ---------------------------------------------------------------------------
// Channel remapping — app always binds audio to iChannel0
// ---------------------------------------------------------------------------
// Detect audio inputs (Shadertoy types: music, musicstream, mic)
const AUDIO_TYPES = new Set(['music', 'musicstream', 'mic'])
const audioInput = allInputs.find(inp => AUDIO_TYPES.has(inp.type))
const audioChannel = audioInput != null ? audioInput.channel : null

const channelRemap = {}  // old channel index → new channel index
const remapLog = []      // human-readable notes emitted into the GLSL header

if (audioChannel != null && audioChannel !== 0) {
  if (channelLocalPaths[0]) {
    // A texture already occupies channel 0 — displace it to the audio channel's slot
    channelRemap[0] = audioChannel
    remapLog.push(`iChannel0 (texture) → iChannel${audioChannel}`)
  }
  channelRemap[audioChannel] = 0
  remapLog.push(`iChannel${audioChannel} (audio) → iChannel0`)

  // Rewrite iChannelN identifiers in all pass GLSL using placeholders so a
  // two-way swap (e.g. 0↔3) doesn't accidentally double-substitute.
  const remapSource = (code) => {
    let result = code
    for (const from of Object.keys(channelRemap)) {
      result = result.replace(new RegExp(`\\biChannel${from}\\b`, 'g'), `__CHMAP${from}__`)
    }
    for (const [from, to] of Object.entries(channelRemap)) {
      result = result.replace(new RegExp(`__CHMAP${from}__`, 'g'), `iChannel${to}`)
    }
    return result
  }
  for (const p of renderpasses) {
    if (p.code) p.code = remapSource(p.code)
  }

  // Update channelLocalPaths keys to match the new channel assignments
  const newPaths = {}
  for (const [ch, localPath] of Object.entries(channelLocalPaths)) {
    const from = parseInt(ch, 10)
    const to = Object.prototype.hasOwnProperty.call(channelRemap, from) ? channelRemap[from] : from
    newPaths[to] = localPath
  }
  Object.keys(channelLocalPaths).forEach(k => delete channelLocalPaths[k])
  Object.assign(channelLocalPaths, newPaths)
}

// Write the browser-console download snippet
const inputBaseName = path.basename(inputFile, path.extname(inputFile))
const snippetFile = path.join(mediaDir, `${inputBaseName}.js`)

if (snippetEntries.length) {
  const lines = snippetEntries.map(e =>
    `fetch('${e.shadertoyPath}').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='${e.basename}';document.body.appendChild(a);a.click();a.remove();console.log('\\u2713 iChannel${e.ch}: ${e.basename}')})`
  ).join('\n\n')

  const snippet = `// Download Shadertoy media for: ${shaderName}
// https://www.shadertoy.com/view/${info.id || '?'}
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

${lines}
`
  fs.writeFileSync(snippetFile, snippet, 'utf8')
}

// ---------------------------------------------------------------------------
// Build output GLSL
// ---------------------------------------------------------------------------
const lines = []

// Header comment
lines.push(`// "${shaderName}" by ${info.username || 'unknown'}`)
lines.push(`// https://www.shadertoy.com/view/${info.id || '?'}`)
if (info.description) {
  const desc = info.description.replace(/\[url\][^\[]*\[\/url\]/g, '').replace(/\s+/g, ' ').trim()
  if (desc) lines.push(`// ${desc}`)
}
lines.push('')

// Channel remap applied during import (audio moved to iChannel0)
if (remapLog.length) {
  lines.push(`// @channelRemap: ${remapLog.join(', ')}`)
  lines.push('')
}

// Texture channel bindings (machine-readable, picked up by the visualizer)
if (Object.keys(channelLocalPaths).length) {
  for (const [ch, localPath] of Object.entries(channelLocalPaths)) {
    lines.push(`// @iChannel${ch}: ${localPath}`)
  }
  lines.push('')
}

// Warn about inputs we couldn't resolve
if (textureLines.length) {
  lines.push('// ⚠  Some texture inputs could not be downloaded:')
  for (const t of textureLines) lines.push(`//   ${t}`)
  lines.push('')
}

// Unsupported pass warnings
if (unsupported.length) {
  lines.push(`// ⚠  Unsupported pass types skipped: ${unsupported.map(p => p.type).join(', ')}`)
  lines.push('')
}

const isSingleImagePass = bufferPasses.length === 0 && commonPasses.length === 0 && imagePasses.length === 1

if (isSingleImagePass) {
  // Simple case: just dump the code directly
  lines.push(imagePasses[0].code.trim())
} else {
  // Multi-section format
  if (commonPasses.length) {
    lines.push('// # Common')
    lines.push('')
    for (const p of commonPasses) {
      lines.push(p.code.trim())
      lines.push('')
    }
  }

  const bufferNames = ['Buffer A', 'Buffer B', 'Buffer C', 'Buffer D']
  for (let i = 0; i < bufferPasses.length; i++) {
    lines.push(`// # ${bufferNames[i] || `Buffer ${i}`}`)
    lines.push('')
    lines.push(bufferPasses[i].code.trim())
    lines.push('')
  }

  if (imagePasses.length) {
    lines.push('// # Image')
    lines.push('')
    lines.push(imagePasses[0].code.trim())
    lines.push('')
  }
}

const glsl = lines.join('\n') + '\n'

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}

fs.writeFileSync(outFile, glsl, 'utf8')
console.log(`✓  Written: ${outFile}`)

if (snippetEntries.length) {
  console.log(`\n→  Texture channels need manual download (${snippetEntries.length} file${snippetEntries.length > 1 ? 's' : ''})`)
  for (const e of snippetEntries) console.log(`   iChannel${e.ch} → ${e.localPublicPath}`)
  console.log(`\n   Open https://www.shadertoy.com (logged in) and paste each line into the DevTools console ONE AT A TIME:`)
  console.log()
  for (const e of snippetEntries) {
    console.log(`   fetch('${e.shadertoyPath}').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='${e.basename}';document.body.appendChild(a);a.click();a.remove();console.log('\\u2713 iChannel${e.ch}: ${e.basename}')})`)
    console.log()
  }
  console.log(`   (also saved to ${snippetFile})`)
}
if (textureLines.length) {
  console.log('\n⚠  Could not resolve (built-in Shadertoy types):')
  for (const t of textureLines) console.log(`   ${t}`)
}

// ---------------------------------------------------------------------------
// Run mkmeta.sh
// ---------------------------------------------------------------------------
if (!noMeta) {
  const metaScript = path.resolve(__dirname, 'mkmeta.sh')
  const presetDir  = path.resolve(outDir, '..')
  if (fs.existsSync(metaScript)) {
    try {
      const rel = path.relative(path.resolve(__dirname, '..'), presetDir)
      console.log(`\n→  Running mkmeta.sh ${rel}`)
      execSync(`bash "${metaScript}" "${presetDir}"`, { stdio: 'inherit' })
    } catch {
      console.error('mkmeta.sh failed — run it manually to sync the preset.')
    }
  }

  // Regenerate preset-groups.json for the parent category dir so the app picks
  // up new/removed groups without needing to run all-presets.sh.
  const categoryDir = path.resolve(outDir, '../..')
  const groupsJson  = path.join(categoryDir, 'preset-groups.json')
  try {
    const groups = fs.readdirSync(categoryDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(categoryDir, e.name, 'presets-src')))
      .map(e => e.name)
      .sort()
    fs.writeFileSync(groupsJson, JSON.stringify(groups, null, 2) + '\n', 'utf8')
    const relCat = path.relative(path.resolve(__dirname, '..'), categoryDir)
    console.log(`→  Updated ${relCat}/preset-groups.json (${groups.length} group${groups.length !== 1 ? 's' : ''})`)
  } catch (e) {
    console.warn('Could not update preset-groups.json:', e.message)
  }
}
