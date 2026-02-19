#!/usr/bin/env node
/**
 * Extract exact GLSL error lines for the 31 WARN presets.
 * Parses the converter's own WARN output + extracts GLSL from the JSON.
 */
const fs = require('fs');
const path = require('path');

const outDir = 'public/butterchurn-presets/martinsCollectionMarch2025';

// These come from the WARN lines in the conversion log
const warns = [
  { name: "Martin - Hades' Discotheque - headache edition", shader: 'comp', line: -19, err: 'no matching overloaded function found' },
  { name: 'martin - alien grand theft water', shader: 'comp', line: 20, err: "vec2-vec3 '-'" },
  { name: 'martin - another kind of groove', shader: 'comp', line: 19, err: 'not enough data' },
  { name: 'martin - badlands', shader: 'comp', line: 16, err: 'not enough data' },
  { name: 'martin - castle in the air', shader: 'warp', line: 13, err: 'undeclared identifier' },
  { name: 'martin - city lights', shader: 'comp', line: -19, err: 'not supported for version' },
  { name: 'martin - city of shadows', shader: 'warp', line: -54, err: 'not supported profile es' },
  { name: 'martin - cope - laser dome', shader: 'warp', line: 4, err: 'undeclared identifier' },
  { name: 'martin - enlighten me', shader: 'comp', line: 9, err: 'not supported profile es' },
  { name: 'martin - frosty caves 2', shader: 'comp', line: 15, err: 'not enough data' },
  { name: 'martin - fulldome (flexis fractal distortion)', shader: 'warp', line: 2, err: 'undeclared identifier' },
  { name: 'martin - gentle happiness', shader: 'warp', line: 7, err: 'undeclared identifier' },
  { name: 'martin - glassworks 2', shader: 'comp', line: -24, err: "vec2*vec4 '*'" },
  { name: 'martin - gold rush', shader: 'warp', line: -38, err: 'return type mismatch' },
  { name: 'martin - invasion', shader: 'comp', line: 13, err: "vec2-vec3 '-'" },
  { name: 'martin - juggernaut', shader: 'comp', line: 4, err: 'undeclared identifier' },
  { name: 'martin - lock and release', shader: 'comp', line: 5, err: 'no matching overloaded function found' },
  { name: 'martin - lonely goose', shader: 'warp', line: -16, err: 'not supported profile es' },
  { name: 'martin - mandelbox explorer - wreck diver', shader: 'comp', line: -21, err: "int<=float" },
  { name: 'martin - mandelbulb slideshow', shader: 'warp', line: -61, err: 'not supported for version' },
  { name: 'martin - mandelbulb slideshow', shader: 'comp', line: 4, err: 'too many arguments' },
  { name: 'martin - nivush - emergency power supply only', shader: 'warp', line: 8, err: 'not supported profile es' },
  { name: 'martin - nivush - emergency power supply only', shader: 'comp', line: -129, err: 'unexpected SEMICOLON' },
  { name: 'martin - on air', shader: 'comp', line: 4, err: 'undeclared identifier' },
  { name: 'martin - on silent paths', shader: 'comp', line: -16, err: 'function no return value rsp' },
  { name: 'martin - reflections on black tiles', shader: 'comp', line: 4, err: 'not enough data' },
  { name: 'martin - shifter - armorial bearings of robotopia', shader: 'comp', line: 14, err: 'swizzle selection out of range' },
  { name: 'martin - shiny tunnel', shader: 'warp', line: 7, err: 'undeclared identifier' },
  { name: 'martin - smooth spectrum analyser - mono 16 channels', shader: 'warp', line: -27, err: 'redefinition' },
  { name: 'martin - warming up the house', shader: 'warp', line: 28, err: 'scalar integer expression required' },
  { name: 'martin - warming up the house', shader: 'comp', line: 18, err: 'not enough data' },
  { name: 'martin [shadow harlequins shape code] - fata morgana', shader: 'comp', line: 16, err: "vec2+vec3 '+'" },
];

for (const w of warns) {
  const jsonFile = path.join(outDir, w.name + '.json');
  if (!fs.existsSync(jsonFile)) {
    console.log(`\n=== MISSING: ${w.name} [${w.shader}] ===`);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  const src = j[w.shader];
  if (!src) { console.log(`\n=== NO ${w.shader}: ${w.name} ===`); continue; }

  const sbIdx = src.indexOf('shader_body');
  const headerPart = src.substring(0, sbIdx);
  const after = src.substring(sbIdx);
  const braceIdx = after.indexOf('{');
  const bodyPart = after.substring(braceIdx + 1, after.lastIndexOf('}'));
  
  const headerLines = headerPart.split('\n');
  const bodyLines = bodyPart.split('\n');

  console.log(`\n=== ${w.name} [${w.shader}] L${w.line}: ${w.err} ===`);
  
  if (w.line > 0) {
    // Body line
    const idx = w.line - 1;
    const start = Math.max(0, idx - 2);
    const end = Math.min(bodyLines.length - 1, idx + 2);
    for (let i = start; i <= end; i++) {
      const marker = i === idx ? '>>>' : '   ';
      console.log(`${marker} B${i+1}: ${bodyLines[i]}`);
    }
  } else {
    // Header line: userLine <= 0 means it's in the header
    // The header line index: count back from end of header
    const headerIdx = headerLines.length + w.line;
    const start = Math.max(0, headerIdx - 2);
    const end = Math.min(headerLines.length - 1, headerIdx + 2);
    for (let i = start; i <= end; i++) {
      const marker = i === headerIdx ? '>>>' : '   ';
      console.log(`${marker} H${i+1}: ${headerLines[i]}`);
    }
  }
}
