#!/usr/bin/env node
/**
 * classify-milk.cjs  —  Analyze MilkDrop .milk presets and output feature
 * classifications as JSON.
 *
 * Usage:
 *   node scripts/classify-milk.cjs <file.milk>           # single file
 *   node scripts/classify-milk.cjs --batch <dir>          # all .milk in dir
 *   node scripts/classify-milk.cjs --batch <dir> --csv    # CSV summary table
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Parse all `key=value` lines from text, returning a Map of key→string */
function parseKeyVals(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
}

/** Parse a numeric value, defaulting if NaN */
function num(val, def = 0) {
  const n = parseFloat(val);
  return Number.isNaN(n) ? def : n;
}

// ──────────────────────────────────────────────────────────────────────
// Feature extraction
// ──────────────────────────────────────────────────────────────────────

function classifyMilk(milkText, filename) {
  const kv = parseKeyVals(milkText);
  const lines = milkText.split('\n');

  // ── Preset version ──
  const milkdropVersion = num(kv.get('milkdrop_preset_version'), 0);
  const psVersion = num(kv.get('psversion'), 0);
  const psVersionWarp = num(kv.get('psversion_warp'), 0);
  const psVersionComp = num(kv.get('psversion_comp'), 0);
  const version = psVersion || (milkdropVersion >= 200 ? 2 : milkdropVersion > 0 ? 1 : 0);

  // ── Shader detection ──
  const warpLines = lines.filter(l => /^warp_\d+\s*=/.test(l));
  const compLines = lines.filter(l => /^comp_\d+\s*=/.test(l));
  const hasWarpShader = warpLines.length > 0;
  const hasCompShader = compLines.length > 0;
  const warpShaderLines = warpLines.length;
  const compShaderLines = compLines.length;

  // Reconstruct shader text for deeper analysis
  const warpCode = warpLines.map(l => l.replace(/^warp_\d+\s*=\s*/, '')).join('\n');
  const compCode = compLines.map(l => l.replace(/^comp_\d+\s*=\s*/, '')).join('\n');

  // ── Shader features ──
  function analyzeShader(code) {
    if (!code) return {};
    return {
      usesNoise: /sampler_noise|noise_lq|noise_mq|noise_hq|noisevol/i.test(code),
      usesBlur: /sampler_blur|blur1|blur2|blur3/i.test(code),
      usesCustomTextures: /sampler_(?!main|fw_main|fc_main|pw_main|pc_main|blur|noise)/i.test(code),
      usesRot: /\brot\b/i.test(code),
      usesRad: /\brad\b/i.test(code),
      usesAng: /\bang\b/i.test(code),
      usesUvOrig: /\buv_orig\b/i.test(code),
      usesHueShader: /\bhue_shader\b/i.test(code),
      usesTime: /\btime\b/i.test(code),
      usesBass: /\bbass\b|\btreb\b|\bmid\b|\bvol\b/i.test(code),
      lineCount: code.split('\n').filter(l => l.trim().length > 0).length,
    };
  }
  const warpShaderFeatures = hasWarpShader ? analyzeShader(warpCode) : null;
  const compShaderFeatures = hasCompShader ? analyzeShader(compCode) : null;

  // ── Per-frame / per-pixel / init equations ──
  const perFrameLines = lines.filter(l => /^per_frame_\d+\s*=/i.test(l));
  const perPixelLines = lines.filter(l => /^per_pixel_\d+\s*=/i.test(l));
  const perFrameInitLines = lines.filter(l => /^per_frame_init_\d+\s*=/i.test(l));

  const hasPerFrame = perFrameLines.length > 0;
  const hasPerPixel = perPixelLines.length > 0;
  const hasPerFrameInit = perFrameInitLines.length > 0;

  // Reconstruct equation text for feature detection
  const perFrameCode = perFrameLines.map(l => l.replace(/^per_frame_\d+\s*=\s*/, '')).join('\n');
  const perPixelCode = perPixelLines.map(l => l.replace(/^per_pixel_\d+\s*=\s*/, '')).join('\n');

  // Which per-frame vars are modified?
  const perFrameVars = new Set();
  for (const line of perFrameLines) {
    const m = line.match(/^per_frame_\d+\s*=\s*(\w+)\s*=/);
    if (m) perFrameVars.add(m[1].toLowerCase());
  }
  const perPixelVars = new Set();
  for (const line of perPixelLines) {
    const m = line.match(/^per_pixel_\d+\s*=\s*(\w+)\s*=/);
    if (m) perPixelVars.add(m[1].toLowerCase());
  }

  // ── Custom waves ──
  const waveCodeLines = lines.filter(l => /^wavecode_/i.test(l));
  const waveIndices = new Set();
  for (const l of waveCodeLines) {
    const m = l.match(/^wavecode_(\d+)_/i);
    if (m) waveIndices.add(parseInt(m[1]));
  }
  const customWaves = [];
  for (const idx of [...waveIndices].sort()) {
    const wLines = waveCodeLines.filter(l => new RegExp(`^wavecode_${idx}_`, 'i').test(l));
    const wkv = parseKeyVals(wLines.map(l => l.replace(new RegExp(`^wavecode_${idx}_`, 'i'), '')).join('\n'));
    const enabled = num(wkv.get('enabled') ?? wkv.get('benabled'), 0);
    const hasPointEqs = lines.some(l => new RegExp(`^wave_${idx}_per_point\\d+`, 'i').test(l));
    const hasFrameEqs = lines.some(l => new RegExp(`^wave_${idx}_per_frame\\d+`, 'i').test(l));
    const hasInitEqs = lines.some(l => new RegExp(`^wave_${idx}_init\\d+`, 'i').test(l));
    customWaves.push({
      index: idx,
      enabled: enabled === 1,
      additive: num(wkv.get('badditive'), 0) === 1,
      thick: num(wkv.get('busedots'), 0) === 1 || num(wkv.get('bdrawthick') ?? wkv.get('busethick'), 0) === 1,
      hasPointEqs,
      hasFrameEqs,
      hasInitEqs,
    });
  }

  // ── Custom shapes ──
  const shapeCodeLines = lines.filter(l => /^shapecode_/i.test(l));
  const shapeIndices = new Set();
  for (const l of shapeCodeLines) {
    const m = l.match(/^shapecode_(\d+)_/i);
    if (m) shapeIndices.add(parseInt(m[1]));
  }
  const customShapes = [];
  for (const idx of [...shapeIndices].sort()) {
    const sLines = shapeCodeLines.filter(l => new RegExp(`^shapecode_${idx}_`, 'i').test(l));
    const skv = parseKeyVals(sLines.map(l => l.replace(new RegExp(`^shapecode_${idx}_`, 'i'), '')).join('\n'));
    const enabled = num(skv.get('enabled') ?? skv.get('benabled'), 0);
    const hasFrameEqs = lines.some(l => new RegExp(`^shape_${idx}_per_frame\\d+`, 'i').test(l));
    const hasInitEqs = lines.some(l => new RegExp(`^shape_${idx}_init\\d+`, 'i').test(l));
    customShapes.push({
      index: idx,
      enabled: enabled === 1,
      additive: num(skv.get('badditive'), 0) === 1,
      textured: num(skv.get('btextured'), 0) === 1,
      sides: num(skv.get('nsides'), 4),
      hasFrameEqs,
      hasInitEqs,
      imageUrl: skv.get('imageurl') || null,
    });
  }

  // ── Base values / visual parameters ──
  const decay = num(kv.get('fdecay'), 0.98);
  const gammaAdj = num(kv.get('fgammaadjustment') || kv.get('fgammaadj'), 2.0);
  const echoZoom = num(kv.get('fvideoechozoom'), 1.0);
  const echoAlpha = num(kv.get('fvideoechoalpha'), 0.0);
  const echoOrient = num(kv.get('nvideoechoorientation'), 0);
  const fShader = num(kv.get('fshader') ?? kv.get('nshader'), 0);
  const waveMode = num(kv.get('nwavemode'), 0);
  const warp = num(kv.get('warp') ?? kv.get('fwarpamount'), 1.0);
  const warpScale = num(kv.get('fwarpscale'), 1.0);
  const warpSpeed = num(kv.get('fwarpanimspeed'), 1.0);
  const zoomExp = num(kv.get('zoomexp') ?? kv.get('fzoomexponent'), 1.0);
  const zoom = num(kv.get('zoom'), 1.0);
  const rot = num(kv.get('rot') ?? kv.get('frot'), 0.0);
  const sx = num(kv.get('sx'), 1.0);
  const sy = num(kv.get('sy'), 1.0);
  const dx = num(kv.get('dx'), 0.0);
  const dy = num(kv.get('dy'), 0.0);
  const cx = num(kv.get('cx'), 0.5);
  const cy = num(kv.get('cy'), 0.5);

  const brighten = num(kv.get('bbrighten'), 0);
  const darken = num(kv.get('bdarken'), 0);
  const solarize = num(kv.get('bsolarize'), 0);
  const invert = num(kv.get('binvert'), 0);

  const texWrap = num(kv.get('btexwrap'), 1);
  const motionVectors = num(kv.get('bmotionvectorson'), 0);
  const mvX = num(kv.get('nmotionvectorsx'), 12);
  const mvY = num(kv.get('nmotionvectorsy'), 9);
  const mvA = num(kv.get('mv_a'), 1.0);

  const additiveWave = num(kv.get('badditivewave'), 0);
  const waveDots = num(kv.get('bwavedots'), 0);
  const waveThick = num(kv.get('bwavethick'), 0);

  const outerBorderSize = num(kv.get('ob_size') || kv.get('fouterbordersize'), 0.01);
  const innerBorderSize = num(kv.get('ib_size') || kv.get('finnerbordersize'), 0.01);

  // ── Classification tags ──
  const tags = [];

  // Preset generation
  if (version >= 2 || hasWarpShader || hasCompShader) tags.push('v2');
  else tags.push('v1');

  if (hasWarpShader) tags.push('custom-warp');
  if (hasCompShader) tags.push('custom-comp');
  if (!hasWarpShader && !hasCompShader) tags.push('no-custom-shaders');

  if (hasPerPixel) tags.push('per-pixel');
  if (hasPerFrame) tags.push('per-frame');
  if (hasPerFrameInit) tags.push('per-frame-init');

  if (echoAlpha > 0.001) tags.push('video-echo');
  if (motionVectors === 1 || mvA > 0.001) tags.push('motion-vectors');

  if (brighten) tags.push('brighten');
  if (darken) tags.push('darken');
  if (solarize) tags.push('solarize');
  if (invert) tags.push('invert');

  if (warp > 0.01 && !hasWarpShader) tags.push('v1-warp');
  if (Math.abs(zoom - 1.0) > 0.001) tags.push('uses-zoom');
  if (Math.abs(rot) > 0.001) tags.push('uses-rot');
  if (Math.abs(sx - 1.0) > 0.001 || Math.abs(sy - 1.0) > 0.001) tags.push('uses-scale');
  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) tags.push('uses-translate');
  if (Math.abs(zoomExp - 1.0) > 0.001) tags.push('custom-zoomexp');

  if (customWaves.filter(w => w.enabled).length > 0) tags.push('custom-waves');
  if (customShapes.filter(s => s.enabled).length > 0) tags.push('custom-shapes');
  if (customShapes.some(s => s.enabled && s.textured)) tags.push('textured-shapes');
  if (customShapes.some(s => s.enabled && s.imageUrl)) tags.push('image-shapes');

  if (fShader > 0) tags.push('hue-shader');
  if (texWrap === 0) tags.push('no-tex-wrap');
  if (decay < 0.9) tags.push('fast-decay');
  if (decay > 0.99) tags.push('slow-decay');

  const perPixelMeshVars = ['zoom', 'zoomexp', 'rot', 'warp', 'cx', 'cy', 'dx', 'dy', 'sx', 'sy'];
  const pixelMeshMods = perPixelMeshVars.filter(v => perPixelVars.has(v));
  if (pixelMeshMods.length > 0) tags.push('per-pixel-mesh');

  const usesQVars = /\bq[1-9]\b|\bq[12]\d\b|\bq3[012]\b/i.test(perFrameCode + warpCode + compCode);
  if (usesQVars) tags.push('q-vars');

  // ── Complexity score (rough) ──
  const complexity =
    (hasWarpShader ? 2 : 0) +
    (hasCompShader ? 2 : 0) +
    (warpShaderLines > 20 ? 1 : 0) +
    (compShaderLines > 20 ? 1 : 0) +
    (hasPerFrame ? 1 : 0) +
    (hasPerPixel ? 1 : 0) +
    (hasPerFrameInit ? 1 : 0) +
    customWaves.filter(w => w.enabled).length +
    customShapes.filter(s => s.enabled).length +
    (echoAlpha > 0.001 ? 1 : 0) +
    (usesQVars ? 1 : 0);

  // ── Assemble result ──
  return {
    file: filename || null,
    version,
    tags,
    complexity,
    shaders: {
      warp: hasWarpShader
        ? { lines: warpShaderLines, ...warpShaderFeatures }
        : null,
      comp: hasCompShader
        ? { lines: compShaderLines, ...compShaderFeatures }
        : null,
    },
    equations: {
      perFrame: hasPerFrame ? { lines: perFrameLines.length, modifiedVars: [...perFrameVars] } : null,
      perPixel: hasPerPixel ? { lines: perPixelLines.length, modifiedVars: [...perPixelVars], meshVarMods: pixelMeshMods } : null,
      perFrameInit: hasPerFrameInit ? { lines: perFrameInitLines.length } : null,
    },
    waves: {
      count: customWaves.filter(w => w.enabled).length,
      details: customWaves.filter(w => w.enabled),
    },
    shapes: {
      count: customShapes.filter(s => s.enabled).length,
      details: customShapes.filter(s => s.enabled),
    },
    visual: {
      decay,
      gammaAdj,
      echoZoom,
      echoAlpha,
      echoOrient,
      fShader,
      waveMode,
      warp,
      warpScale,
      warpSpeed,
      zoomExp,
      zoom,
      rot,
      sx, sy, dx, dy, cx, cy,
      brighten: !!brighten,
      darken: !!darken,
      solarize: !!solarize,
      invert: !!invert,
      texWrap: !!texWrap,
      motionVectors: motionVectors === 1,
      additiveWave: !!additiveWave,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────

function printCsvRow(c) {
  const cols = [
    c.file,
    c.version,
    c.complexity,
    c.tags.join(';'),
    c.shaders.warp ? c.shaders.warp.lines : 0,
    c.shaders.comp ? c.shaders.comp.lines : 0,
    c.equations.perFrame ? c.equations.perFrame.lines : 0,
    c.equations.perPixel ? c.equations.perPixel.lines : 0,
    c.waves.count,
    c.shapes.count,
    c.visual.decay,
    c.visual.echoAlpha,
    c.visual.warp,
    c.visual.zoomExp,
  ];
  return cols.map(v => typeof v === 'string' && v.includes(',') ? `"${v}"` : v).join(',');
}

const CSV_HEADER = 'file,version,complexity,tags,warpLines,compLines,perFrameLines,perPixelLines,waves,shapes,decay,echoAlpha,warp,zoomExp';

function main() {
  const args = process.argv.slice(2);
  const isBatch = args.includes('--batch');
  const isCsv = args.includes('--csv');
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length === 0) {
    console.error('Usage:');
    console.error('  node classify-milk.cjs <file.milk>           # single file → JSON');
    console.error('  node classify-milk.cjs --batch <dir>          # all .milk → JSON array');
    console.error('  node classify-milk.cjs --batch <dir> --csv    # all .milk → CSV table');
    process.exit(1);
  }

  if (isBatch) {
    const dir = positional[0];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.milk')).sort();
    const results = files.map(f => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return classifyMilk(text, f);
    });

    if (isCsv) {
      console.log(CSV_HEADER);
      for (const r of results) console.log(printCsvRow(r));
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } else {
    const file = positional[0];
    const text = fs.readFileSync(file, 'utf8');
    const result = classifyMilk(text, path.basename(file));
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
