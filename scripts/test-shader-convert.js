/**
 * Simple test to check if convertHLSLString works in the Docker container
 */
const { convertHLSLString } = require('milkdrop-shader-converter');
const { splitPreset, prepareShader, processOptimizedShader } = require('milkdrop-preset-utils');
const fs = require('fs');

console.error('Loaded modules OK');

const milk = fs.readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
console.error('Read file OK, length:', milk.length);

const presetParts = splitPreset(milk);
console.error('Parsed OK, warp length:', (presetParts.warp || '').length, 'comp length:', (presetParts.comp || '').length);

// Try shader conversion
if (presetParts.warp && presetParts.warp.length > 0) {
  console.error('Preparing warp shader...');
  const prepared = prepareShader(presetParts.warp);
  const processed = prepared.replace('shader_body', 'xlat_main');
  console.error('Prepared shader length:', processed.length);
  console.error('Converting HLSL to GLSL...');
  const glsl = convertHLSLString(processed);
  console.error('GLSL result length:', (glsl || '').toString().length);
  const final = processOptimizedShader(glsl.toString());
  console.error('Final shader length:', final.length);
  console.error('First 200 chars:', final.substring(0, 200));
} else {
  console.error('No warp shader');
}

// Output basic structure
const output = {
  version: presetParts.presetVersion,
  baseVals: presetParts.baseVals,
};

process.stdout.write(JSON.stringify(output));
console.error('Done');
