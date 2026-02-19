/**
 * convert-milk-to-butterchurn.js
 *
 * Converts MilkDrop .milk preset files to Butterchurn "converted" JSON format.
 *
 * Usage:
 *   Run inside the milkdrop-preset-converter-node Docker container:
 *     docker run --rm -v /path/to/presets:/presets milkdrop-converter \
 *       node /app/convert.js /presets/input.milk
 *
 *   Or batch mode:
 *     docker run --rm -v /path/to/milk:/input -v /path/to/output:/output \
 *       milkdrop-converter node /app/convert.js --batch /input /output
 */

const fs = require('fs');
const path = require('path');

// These come from the milkdrop-preset-converter-node webpack bundle
const converter = require('./dist/milkdrop-preset-converter-node.min');

function convertMilkToButterchurn(milkText) {
  // Use convertShaders path (shadersOnly=true) which:
  // 1. Parses .milk file with splitPreset
  // 2. Keeps raw EEL in *_eel_str fields
  // 3. Converts HLSL→GLSL via native milkdrop-shader-converter
  // 4. Post-processes GLSL with processOptimizedShader
  // Does NOT convert EEL→JS (no *_str fields) or run closure compiler
  const result = converter.convertPreset(milkText, false, true);

  // The convertShaders output uses *_eel_str keys; rename to *_eel
  const output = {
    version: 2, // TODO: detect from preset
    baseVals: result.baseVals,
    shapes: result.shapes.map(s => ({
      baseVals: s.baseVals,
      init_eqs_eel: s.init_eqs_eel_str || '',
      frame_eqs_eel: s.frame_eqs_eel_str || '',
    })),
    waves: result.waves.map(w => ({
      baseVals: w.baseVals,
      init_eqs_eel: w.init_eqs_eel_str || '',
      frame_eqs_eel: w.frame_eqs_eel_str || '',
      point_eqs_eel: w.point_eqs_eel_str || '',
    })),
    init_eqs_eel: result.init_eqs_eel_str || '',
    frame_eqs_eel: result.frame_eqs_eel_str || '',
    pixel_eqs_eel: result.pixel_eqs_eel_str || '',
    warp: result.warp || '',
    comp: result.comp || '',
  };

  return output;
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--batch') {
    // Batch mode: convert all .milk files in inputDir, write to outputDir
    const inputDir = args[1];
    const outputDir = args[2];

    if (!inputDir || !outputDir) {
      console.error('Usage: node convert.js --batch <inputDir> <outputDir>');
      process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.milk'));
    console.error(`Converting ${files.length} presets...`);

    let success = 0;
    let failed = 0;
    for (const file of files) {
      const inputPath = path.join(inputDir, file);
      const outputFile = file.replace(/\.milk$/, '.json');
      const outputPath = path.join(outputDir, outputFile);

      try {
        const milk = fs.readFileSync(inputPath, 'utf8');
        const result = convertMilkToButterchurn(milk);
        fs.writeFileSync(outputPath, JSON.stringify(result));
        success++;
        console.error(`  OK: ${file}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL: ${file}: ${e.message}`);
      }
    }

    console.error(`Done: ${success} converted, ${failed} failed`);
  } else {
    // Single file mode: read from arg or stdin, write JSON to stdout
    const inputPath = args[0] || '/dev/stdin';
    const milk = fs.readFileSync(inputPath, 'utf8');
    const result = convertMilkToButterchurn(milk);
    process.stdout.write(JSON.stringify(result));
  }
}

main();
