/**
 * convert-milk.cjs — MilkDrop → Butterchurn Preset Converter
 *
 * Converts MilkDrop .milk preset files into the Butterchurn JSON format.
 * Uses the same pipeline as the webapp:
 *   - EEL → JavaScript via milkdrop-preset-converter-aws (sync, ClojureScript)
 *   - HLSL → GLSL via AWS Lambda (hlsl2glslfork) + glsl-optimizer-js
 *
 * Usage:
 *   node scripts/convert-milk.cjs preset.milk > output.json
 *   cat preset.milk | node scripts/convert-milk.cjs > output.json
 *   node scripts/convert-milk.cjs --batch <inputDir> <outputDir>
 *
 * @module convert-milk
 */

'use strict';

var fs = require('fs');
var path = require('path');
var presetUtils = require('milkdrop-preset-utils');
var splitPreset = presetUtils.splitPreset;
var prepareShader = presetUtils.prepareShader;
var processOptimizedShader = presetUtils.processOptimizedShader;
var converter = require('milkdrop-preset-converter-aws');
var convertPresetEquations = converter.convertPresetEquations;
var convertWaveEquations = converter.convertWaveEquations;
var convertShapeEquations = converter.convertShapeEquations;

var CONVERT_URL = 'https://p2tpeb5v8b.execute-api.us-east-2.amazonaws.com/default/milkdropShaderConverter';

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------

/**
 * Optional log file. Set via LOG_FILE env var or --log <path> CLI flag.
 * Each line is a JSON object: { t, label, shader, hlslBytes, status, ms, ok, error }
 */
var _logStream = null;
var _logFile   = null;
var _logStats  = { calls: 0, ok: 0, fail: 0, totalMs: 0 };

function _openLog(filePath) {
  _logFile = path.resolve(filePath);
  _logStream = fs.createWriteStream(_logFile, { flags: 'a' });
  process.stderr.write('Logging AWS calls → ' + _logFile + '\n');
}

function _appendLog(record) {
  if (_logStream) _logStream.write(JSON.stringify(record) + '\n');
}

function _closeLog() {
  if (_logStream) {
    _logStream.end();
    _logStream = null;
    process.stderr.write(
      'AWS calls: ' + _logStats.calls + ' total, ' +
      _logStats.ok + ' ok, ' + _logStats.fail + ' failed, ' +
      Math.round(_logStats.totalMs) + ' ms total' +
      (_logStats.calls ? ', avg ' + Math.round(_logStats.totalMs / _logStats.calls) + ' ms' : '') + '\n'
    );
  }
}

// ---------------------------------------------------------------------------
// Shader conversion (AWS Lambda + glsl-optimizer)
// ---------------------------------------------------------------------------

/** Cached glsl-optimizer cwrap function */
var _optimizeGlsl = null;

/**
 * Load glsl-optimizer-js and cache the optimize function.
 * @returns {Promise<Function>}
 */
function getOptimizeGlsl() {
  if (_optimizeGlsl) return Promise.resolve(_optimizeGlsl);
  var glslOptModule = require('glsl-optimizer-js');
  // glsl-optimizer-js returns a WASM "thenable" (Module with .then), not a real Promise.
  // Wrap it in a proper Promise so chaining works correctly.
  return new Promise(function (resolve, reject) {
    glslOptModule().then(function (mod) {
      _optimizeGlsl = mod.cwrap('optimize_glsl', 'string', ['string', 'number', 'number']);
      resolve(_optimizeGlsl);
    });
  });
}

/**
 * Convert a raw MilkDrop HLSL shader to optimized GLSL.
 *
 * Pipeline: prepareShader → AWS Lambda hlsl2glslfork → glsl-optimizer → processOptimizedShader
 *
 * @param {Function} optimizeFn  The glsl-optimizer cwrap function.
 * @param {string}   rawHlsl     Raw HLSL from splitPreset.
 * @param {string}   [label]     Human-readable label for logging (e.g. 'preset.milk [warp]').
 * @returns {Promise<string>}    Final GLSL string.
 */
function convertShaderAsync(optimizeFn, rawHlsl, label) {
  if (!rawHlsl || !rawHlsl.trim()) return Promise.resolve('');

  var prepared = prepareShader(rawHlsl);
  if (!prepared) return Promise.resolve('');

  var t0 = Date.now();
  _logStats.calls++;

  return fetch(CONVERT_URL, {
    method: 'POST',
    body: JSON.stringify({ optimize: false, shader: prepared }),
  })
    .then(function (r) {
      var ms = Date.now() - t0;
      _logStats.totalMs += ms;
      if (!r.ok) {
        _logStats.fail++;
        _appendLog({ t: new Date().toISOString(), label: label || '', status: r.status, ms: ms, ok: false, hlslBytes: prepared.length });
        throw new Error('Shader conversion HTTP ' + r.status);
      }
      return r.json().then(function (data) {
        _logStats.ok++;
        _appendLog({ t: new Date().toISOString(), label: label || '', status: r.status, ms: ms, ok: true, hlslBytes: prepared.length, glslBytes: (data.shader||'').length });
        return data;
      });
    })
    .then(function (data) {
      var optimized = optimizeFn(data.shader, 1, 0);
      return processOptimizedShader(optimized);
    });
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

/**
 * Convert the text of a .milk file into a Butterchurn-compatible JSON object.
 *
 * @param {string} milkText  Full contents of a .milk file (including headers).
 * @param {string} [label]   Optional label for logging (e.g. filename).
 * @returns {Promise<object>} Butterchurn preset object.
 */
function convertMilk(milkText, label) {
  // splitPreset expects the full .milk text (including the [preset00] header).
  // Stripping it causes the parser to return empty data for all fields.
  var content = milkText.replace(/\r\n/g, '\n');

  // --- parse ---
  var split = splitPreset(content);
  var presetVersion = split.presetVersion || 1;

  // --- convert EEL → JavaScript ---
  var eqs = convertPresetEquations(
    presetVersion,
    split.presetInit || '',
    split.perFrame || '',
    split.perVertex || ''
  );

  // --- shapes (always 4 slots) ---
  var shapes = [];
  for (var si = 0; si < 4; si++) {
    var sh = (split.shapes && split.shapes[si]) || {};
    var shBase = sh.baseVals || { enabled: 0 };
    if (shBase.enabled) {
      var shEqs = convertShapeEquations(
        presetVersion,
        sh.init_eqs_str || '',
        sh.frame_eqs_str || ''
      );
      shapes.push({
        baseVals: shBase,
        init_eqs_str: shEqs.init_eqs_str,
        frame_eqs_str: shEqs.frame_eqs_str,
      });
    } else {
      shapes.push({ baseVals: { enabled: 0 } });
    }
  }

  // --- waves (always 4 slots) ---
  var waves = [];
  for (var wi = 0; wi < 4; wi++) {
    var wv = (split.waves && split.waves[wi]) || {};
    var wvBase = wv.baseVals || { enabled: 0 };
    if (wvBase.enabled) {
      var wvEqs = convertWaveEquations(
        presetVersion,
        wv.init_eqs_str || '',
        wv.frame_eqs_str || '',
        wv.point_eqs_str || ''
      );
      waves.push({
        baseVals: wvBase,
        init_eqs_str: wvEqs.init_eqs_str,
        frame_eqs_str: wvEqs.frame_eqs_str,
        point_eqs_str: wvEqs.point_eqs_str,
      });
    } else {
      waves.push({ baseVals: { enabled: 0 } });
    }
  }

  // --- convert shaders (async) ---
  var _label = label || '';
  return getOptimizeGlsl().then(function (optimizeFn) {
    return Promise.all([
      convertShaderAsync(optimizeFn, split.warp || '', _label + ' [warp]'),
      convertShaderAsync(optimizeFn, split.comp || '', _label + ' [comp]'),
    ]);
  }).then(function (shaders) {
    return {
      shapes: shapes,
      waves: waves,
      init_eqs_str: eqs.init_eqs_str,
      frame_eqs_str: eqs.frame_eqs_str,
      pixel_eqs_str: eqs.pixel_eqs_str,
      baseVals: split.baseVals || {},
      warp: shaders[0],
      comp: shaders[1],
      presetParts: split,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  process.stderr.write(
    'Usage:\n' +
    '  node scripts/convert-milk.cjs <file.milk>           → stdout\n' +
    '  cat file.milk | node scripts/convert-milk.cjs       → stdout\n' +
    '  node scripts/convert-milk.cjs --batch <in> <out>\n'
  );
}

/**
 * Convert a single .milk file and return the JSON string.
 * @returns {Promise<string>}
 */
function convertFile(filePath) {
  var text = fs.readFileSync(filePath, 'utf8');
  return convertMilk(text, path.basename(filePath)).then(function (preset) {
    return JSON.stringify(preset, null, 2);
  });
}

/**
 * Batch-convert all .milk files in inputDir, writing .json to outputDir.
 */
async function batchConvert(inputDir, outputDir) {
  if (!fs.existsSync(inputDir)) {
    process.stderr.write('Error: input directory does not exist: ' + inputDir + '\n');
    process.exit(1);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  var files = fs.readdirSync(inputDir).filter(function (f) {
    return f.toLowerCase().endsWith('.milk');
  });

  if (files.length === 0) {
    process.stderr.write('No .milk files found in ' + inputDir + '\n');
    process.exit(0);
  }

  var ok = 0;
  var fail = 0;
  for (var i = 0; i < files.length; i++) {
    var basename = path.basename(files[i], path.extname(files[i]));
    var inPath  = path.join(inputDir, files[i]);
    var outPath = path.join(outputDir, basename + '.json');
    try {
      var json = await convertFile(inPath);
      fs.writeFileSync(outPath, json + '\n', 'utf8');
      ok++;
      process.stderr.write('[' + (ok + fail) + '/' + files.length + '] ' + files[i] + '\n');
    } catch (err) {
      fail++;
      process.stderr.write('FAIL  ' + files[i] + ': ' + err.message + '\n');
    }
  }
  process.stderr.write('\nDone. ' + ok + ' converted, ' + fail + ' failed.\n');
  _closeLog();
}

/**
 * Read all of stdin as a string (sync-ish via fd 0).
 */
function readStdin() {
  var chunks = [];
  var buf = Buffer.alloc(65536);
  var fd = fs.openSync('/dev/stdin', 'r');
  var n;
  while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) {
    chunks.push(buf.slice(0, n));
  }
  fs.closeSync(fd);
  return Buffer.concat(chunks).toString('utf8');
}

if (require.main === module) {
  var args = process.argv.slice(2);

  // --log <file>  (or LOG_FILE env var) — log every AWS request as JSON lines
  var logIdx = args.indexOf('--log');
  if (logIdx !== -1 && args[logIdx + 1]) {
    _openLog(args[logIdx + 1]);
    args.splice(logIdx, 2);
  } else if (process.env.LOG_FILE) {
    _openLog(process.env.LOG_FILE);
  }

  if (args[0] === '--batch') {
    if (args.length < 3) {
      process.stderr.write('Error: --batch requires <inputDir> <outputDir>\n');
      printUsage();
      process.exit(1);
    }
    batchConvert(args[1], args[2]);
  } else if (args.length === 1 && args[0] !== '-h' && args[0] !== '--help') {
    // single file
    convertFile(args[0]).then(function (json) {
      process.stdout.write(json + '\n');
    }).catch(function (err) {
      process.stderr.write('Error: ' + err.message + '\n');
      process.exit(1);
    });
  } else if (args.length === 0 && !process.stdin.isTTY) {
    // stdin
    var text = readStdin();
    convertMilk(text).then(function (preset) {
      process.stdout.write(JSON.stringify(preset, null, 2) + '\n');
    }).catch(function (err) {
      process.stderr.write('Error: ' + err.message + '\n');
      process.exit(1);
    });
  } else {
    printUsage();
    process.exit(args[0] === '-h' || args[0] === '--help' ? 0 : 1);
  }
}

// ---------------------------------------------------------------------------
// Module exports (for browser / programmatic reuse)
// ---------------------------------------------------------------------------

module.exports = {
  convertMilk: convertMilk,
  convertFile: convertFile,
};
