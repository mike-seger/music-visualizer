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
var processUnOptimizedShader = presetUtils.processUnOptimizedShader;
var converter = require('milkdrop-preset-converter-aws');
var convertPresetEquations = converter.convertPresetEquations;
var convertWaveEquations = converter.convertWaveEquations;
var convertShapeEquations = converter.convertShapeEquations;

var CONVERT_URL = 'https://p2tpeb5v8b.execute-api.us-east-2.amazonaws.com/default/milkdropShaderConverter';

// ---------------------------------------------------------------------------
// Standard uniforms declared by butterchurn (should be stripped from raw output)
// ---------------------------------------------------------------------------
var BUILTIN_UNIFORMS = new Set([
  'sampler_main', 'sampler_fw_main', 'sampler_pw_main', 'sampler_fc_main',
  'sampler_pc_main', 'sampler_noise_lq', 'sampler_noise_lq_lite',
  'sampler_noise_mq', 'sampler_noise_hq', 'sampler_noisevol_lq',
  'sampler_noisevol_hq', 'sampler_pw_noise_lq', 'sampler_blur1',
  'sampler_blur2', 'sampler_blur3',
  'texsize_noise_lq', 'texsize_noise_mq', 'texsize_noise_hq',
  'texsize_noise_lq_lite', 'texsize_noisevol_lq', 'texsize_noisevol_hq',
  '_qa', '_qb', '_qc', '_qd', '_qe', '_qf', '_qg', '_qh',
  'q1','q2','q3','q4','q5','q6','q7','q8','q9','q10','q11','q12','q13','q14',
  'q15','q16','q17','q18','q19','q20','q21','q22','q23','q24','q25','q26',
  'q27','q28','q29','q30','q31','q32',
  'blur1_min','blur1_max','blur2_min','blur2_max','blur3_min','blur3_max',
  'scale1','scale2','scale3','bias1','bias2','bias3',
  'slow_roam_cos','roam_cos','slow_roam_sin','roam_sin',
  'hue_shader','time','rand_preset','rand_frame','progress',
  'frame','fps','decay','bass','mid','treb','vol',
  'bass_att','mid_att','treb_att','vol_att',
  'texsize','aspect','rad','ang','uv_orig','resolution',
  'gammaAdj','echo_zoom','echo_alpha','echo_orientation',
  'invert','brighten','darken','solarize','fShader',
]);

/**
 * Extract a brace-delimited function body starting at line index i.
 * Returns { bodyLines: string[], endIndex: number }.
 */
function extractFunctionBody(lines, startIdx) {
  var braceCount = 0;
  var bodyLines = [];
  var started = false;
  for (var j = startIdx; j < lines.length; j++) {
    var bline = lines[j];
    for (var k = 0; k < bline.length; k++) {
      if (bline[k] === '{') { braceCount++; started = true; }
      if (bline[k] === '}') braceCount--;
    }
    if (started && j > startIdx) {
      if (braceCount > 0) {
        bodyLines.push(bline);
      } else {
        break;
      }
    }
    if (started && braceCount === 0) break;
  }
  return { bodyLines: bodyLines, endIndex: j };
}

/**
 * Non-square matrix transpose helpers that hlsl2glslfork may reference
 * but not emit (only NxN versions are emitted in the boilerplate).
 */
var XLL_TRANSPOSE_EXTRAS = {
  // hlsl2glslfork maps HLSL floatRxC → GLSL matRxC (keeping RxC order).
  // HLSL rows become GLSL columns. So GLSL matRxC * vecR already corresponds
  // to HLSL mul(transpose(floatRxC), vecR). The xll_transpose function is thus
  // a no-op: it returns the same type and value (identity).
  'xll_transpose_mf3x2':
    'mat3x2 xll_transpose_mf3x2(mat3x2 m) { return m; }',
  'xll_transpose_mf2x3':
    'mat2x3 xll_transpose_mf2x3(mat2x3 m) { return m; }',
  'xll_transpose_mf4x2':
    'mat4x2 xll_transpose_mf4x2(mat4x2 m) { return m; }',
  'xll_transpose_mf2x4':
    'mat2x4 xll_transpose_mf2x4(mat2x4 m) { return m; }',
  'xll_transpose_mf4x3':
    'mat4x3 xll_transpose_mf4x3(mat4x3 m) { return m; }',
  'xll_transpose_mf3x4':
    'mat3x4 xll_transpose_mf3x4(mat3x4 m) { return m; }',
};

/**
 * Non-square matrix index helpers that hlsl2glslfork may reference.
 * xll_matrixindex_mf3x2_i(mat3x2 m, int i) returns column i (vec2).
 */
var XLL_MATRIXINDEX_EXTRAS = {
  'xll_matrixindex_mf3x2_i':
    'vec2 xll_matrixindex_mf3x2_i(mat3x2 m, int i) { return m[i]; }',
  'xll_matrixindex_mf2x3_i':
    'vec3 xll_matrixindex_mf2x3_i(mat2x3 m, int i) { return m[i]; }',
};

/**
 * Fix float(vec3_expr) → (vec3_expr).x throughout a GLSL string.
 * hlsl2glslfork wraps HLSL's implicit vec3→float casts in float() which is
 * invalid in GLSL.  We use paren-counting to handle arbitrarily deep nesting.
 * Only replaces when the inner expression contains .xyz (indicating vec3 output).
 */
function fixFloatVec3Cast(text) {
  var FLOAT_RE = /\bfloat\s*\(/g;
  var result = '';
  var lastIdx = 0;
  var m;
  while ((m = FLOAT_RE.exec(text)) !== null) {
    var openIdx = m.index + m[0].length; // position right after 'float('
    // Walk forward counting parens to find the matching close
    var depth = 1;
    var pos = openIdx;
    while (pos < text.length && depth > 0) {
      if (text[pos] === '(') depth++;
      else if (text[pos] === ')') depth--;
      pos++;
    }
    if (depth !== 0) continue; // unmatched — skip
    var inner = text.substring(openIdx, pos - 1);
    // Detect vec expression: contains .xyz OR calls a known vec-returning function
    var isVecExpr = inner.indexOf('.xyz') !== -1 || /_vf[234]\s*\(/.test(inner);
    if (!isVecExpr) continue;
    // Check for comparison operator at or near top level — if so, result is bool, not vec.
    // float(bool) is valid GLSL, don't convert.
    // The inner may be wrapped in parens, so check at min depth (0 or 1).
    var hasTopLevelComparison = false;
    var d = 0;
    var minD = Infinity;
    for (var ci = 0; ci < inner.length; ci++) {
      if (inner[ci] === '(') d++;
      else if (inner[ci] === ')') d--;
      if (d < minD) minD = d;
    }
    // Reset and scan for comparisons at or near the minimum depth
    d = 0;
    for (var ci2 = 0; ci2 < inner.length - 1; ci2++) {
      if (inner[ci2] === '(') d++;
      else if (inner[ci2] === ')') d--;
      else if (d <= minD + 1) {
        var rest = inner.substring(ci2);
        if (/^(>=|<=|==|!=|>(?!=)|<(?!=))/.test(rest)) {
          hasTopLevelComparison = true;
          break;
        }
      }
    }
    if (hasTopLevelComparison) continue;
    // This float() wraps a vec expression — replace with (expr).x
    result += text.substring(lastIdx, m.index) + '(' + inner + ').x';
    lastIdx = pos;
    FLOAT_RE.lastIndex = pos; // resume after replacement
  }
  result += text.substring(lastIdx);
  return result;
}

// ---------------------------------------------------------------------------
// Shared GLSL fixup functions (used by both raw and optimized shader paths)
// ---------------------------------------------------------------------------

/**
 * Fix cross(a,b)*c → dot(cross(a,b),c) when result feeds a float context.
 * HLSL mul(vec3,vec3) = dot product; hlsl2glslfork emits component-wise multiply.
 */
function fixCrossDot(text) {
  return text.replace(/\(cross\(\s*((?:[^,()]*|\([^()]*\))*)\s*,\s*((?:[^()]*|\([^()]*\))*)\)\s*\*\s*(\w+)\)/g, function(match, a, b, c) {
    return 'dot(cross(' + a.trim() + ', ' + b.trim() + '), ' + c + ')';
  });
}

/**
 * Fix (vec3_var * vec3_var) → dot(vec3_var, vec3_var).
 * HLSL mul(float3,float3) = dot product; hlsl2glslfork emits as (a * b).
 * We detect vec3 variable names and replace the pattern at any nesting level.
 */
function fixVec3Mul(text) {
  // Collect vec3 and float variable names
  var vec3Vars = {};
  text.replace(/\bvec3\s+(\w+)/g, function(m, n) { vec3Vars[n] = true; return m; });
  var floatVars = {};
  text.replace(/\bfloat\s+(\w+)\s*[;,=]/g, function(m, n) { floatVars[n] = true; return m; });
  if (Object.keys(vec3Vars).length === 0 || Object.keys(floatVars).length === 0) return text;

  // Only convert (vec3 * vec3) → dot() in float-assignment context.
  // vec3*vec3 is valid GLSL (component-wise), only wrong when result feeds a float.
  var floatNames = Object.keys(floatVars);
  for (var ni = 0; ni < floatNames.length; ni++) {
    var name = floatNames[ni];
    // Find all "float_var = ...;" assignments
    var re = new RegExp('\\b' + name + '\\s*=\\s*', 'g');
    var match;
    while ((match = re.exec(text)) !== null) {
      // Skip declarations (float name = ...)
      if (match.index > 0 && /\w/.test(text[match.index - 1])) { continue; }
      // Find the statement end (;)
      var semiPos = -1;
      var d = 0;
      for (var si = match.index + match[0].length; si < text.length; si++) {
        if (text[si] === '(') d++;
        else if (text[si] === ')') d--;
        else if (text[si] === ';' && d === 0) { semiPos = si; break; }
      }
      if (semiPos === -1) continue;
      var rhs = text.substring(match.index + match[0].length, semiPos);
      // Replace (vec3_var * vec3_var) with dot()
      var newRhs = rhs.replace(/\((\w+)\s*\*\s*(\w+)\)/g, function(m2, a, b) {
        if (vec3Vars[a] && vec3Vars[b]) return 'dot(' + a + ', ' + b + ')';
        return m2;
      });
      // Also handle ((-vec3_var) * vec3_var)
      newRhs = newRhs.replace(/\(\(-(\w+)\)\s*\*\s*(\w+)\)/g, function(m2, a, b) {
        if (vec3Vars[a] && vec3Vars[b]) return 'dot(-' + a + ', ' + b + ')';
        return m2;
      });
      // Handle ((-vec3_var) * (complex_expr)) where complex_expr references a vec3
      newRhs = newRhs.replace(/\(\(-(\w+)\)\s*\*\s*\(/g, function(m2, a) {
        if (vec3Vars[a]) {
          // Find matching close paren for the complex_expr
          var searchStart = match.index + match[0].length + newRhs.indexOf(m2) + m2.length;
          return 'dot(-' + a + ', (';
        }
        return m2;
      });
      if (newRhs !== rhs) {
        text = text.substring(0, match.index + match[0].length) + newRhs + text.substring(semiPos);
        re.lastIndex = match.index + match[0].length + newRhs.length;
      }
    }
  }
  return text;
}

/**
 * Fix float[N](vec_arg1,...) array constructors — GLSL needs one float per element.
 * Expands each vec arg into .x, .y, .z, .w components.
 */
function fixArrayConstructor(text) {
  var re = /float\[(\d+)\]\s*\(/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var openPos = match.index + match[0].length - 1;
    var depth = 1, pos = openPos + 1;
    while (pos < text.length && depth > 0) {
      if (text[pos] === '(') depth++;
      else if (text[pos] === ')') depth--;
      pos++;
    }
    if (depth !== 0) continue;
    var argStr = text.substring(openPos + 1, pos - 1);
    var args = [], d = 0, cur = '';
    for (var ci = 0; ci < argStr.length; ci++) {
      if (argStr[ci] === '(') d++;
      else if (argStr[ci] === ')') d--;
      else if (argStr[ci] === ',' && d === 0) { args.push(cur.trim()); cur = ''; continue; }
      cur += argStr[ci];
    }
    if (cur.trim()) args.push(cur.trim());
    var n = parseInt(match[1]);
    if (args.length >= n || args.length === 0) continue;
    var vecSize = n / args.length;
    if (vecSize !== Math.floor(vecSize) || vecSize < 2 || vecSize > 4) continue;
    var comps = [['x','y'], ['x','y','z'], ['x','y','z','w']][vecSize - 2];
    var expanded = [];
    for (var ai = 0; ai < args.length; ai++) {
      for (var ki = 0; ki < comps.length; ki++) {
        expanded.push(args[ai] + '.' + comps[ki]);
      }
    }
    var replacement = 'float[' + n + ']( ' + expanded.join(', ') + ')';
    text = text.substring(0, match.index) + replacement + text.substring(pos);
    re.lastIndex = match.index + replacement.length;
  }
  return text;
}

/**
 * Fix xll_matrixindex_mf2x2_i(m, i) = val; (l-value function call).
 * Expands to element-by-element row assignment matching the read semantics.
 */
function fixMatrixIndexLValue(text) {
  var re = /xll_matrixindex_mf2x2_i\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var mVar = match[1];
    var mIdx = match[2];
    var valStart = match.index + match[0].length;
    var depth = 0, pos = valStart;
    while (pos < text.length) {
      if (text[pos] === '(') depth++;
      else if (text[pos] === ')') depth--;
      else if (text[pos] === ';' && depth === 0) break;
      pos++;
    }
    if (pos >= text.length) continue;
    var val = text.substring(valStart, pos).trim();
    var replacement = '{ vec2 _mi = ' + val + '; ' +
      mVar + '[0][' + mIdx + '] = _mi.x; ' +
      mVar + '[1][' + mIdx + '] = _mi.y; }';
    text = text.substring(0, match.index) + replacement + text.substring(pos + 1);
    re.lastIndex = match.index + replacement.length;
  }
  return text;
}

/**
 * Fix vec3 = xll_matrixindex_mf3x2_i(...) dimension mismatch.
 * xll_matrixindex_mf3x2_i returns vec2 (column of mat3x2), but hlsl2glslfork
 * sometimes declares the receiving variable as vec3. Change to vec2.
 */
function fixMatrixIndexReturnType(text) {
  // vec3 var = xll_matrixindex_mf3x2_i(args) → vec3 var = vec3(xll_matrixindex_mf3x2_i(args), 0.0)
  // The function returns vec2 but callers expect vec3; pad with 0.0 to keep downstream types intact.
  return text.replace(
    /\bvec3(\s+\w+\s*=\s*)(xll_matrixindex_mf3x2_i\s*\([^)]*\))/g,
    'vec3$1vec3($2, 0.0)'
  );
}

// ---------------------------------------------------------------------------
// EEL preprocessing — fix constructs the ClojureScript parser can't handle
// ---------------------------------------------------------------------------

function eelStripComments(code) {
  return code.replace(/\/\/[^\n]*/g, '');
}

function eelFixChainedAssigns(code) {
  var result = code, maxIter = 100;
  while (maxIter-- > 0) {
    var m = result.match(
      /((?:\b\w+\s*\[[^\]]*\]|\b\w+\s*\([^)]*(?:\([^)]*\)[^)]*)*\)|\b\w+))\s*=(?!=)\s*((?:\b\w+\s*\[[^\]]*\]|\b\w+\s*\([^)]*(?:\([^)]*\)[^)]*)*\)|\b\w+))\s*=(?!=)/
    );
    if (!m) break;
    var lv1 = m[1].trim(), lv2 = m[2].trim(), idx = m.index;
    var after = result.substring(idx + m[0].length);
    var depth = 0, endIdx = -1;
    for (var i = 0; i < after.length; i++) {
      if (after[i] === '(' || after[i] === '[') depth++;
      else if (after[i] === ')' || after[i] === ']') depth--;
      else if (after[i] === ';' && depth === 0) { endIdx = i; break; }
    }
    if (endIdx === -1)
      result = result.substring(0, idx) + lv2 + ' = ' + after + '; ' + lv1 + ' = ' + lv2;
    else
      result = result.substring(0, idx) + lv2 + ' = ' + after.substring(0, endIdx) + '; ' + lv1 + ' = ' + lv2 + after.substring(endIdx);
  }
  return result;
}

function eelFixChainedCompoundAssign(code) {
  var result = code;
  var re = /(\b\w+)\s*=(?!=)\s*((?:\b\w+\s*\([^)]*(?:\([^)]*\)[^)]*)*\)|\b\w+))\s*([+\-*\/])=(?!=)/;
  var maxIter = 100;
  while (maxIter-- > 0) {
    var m = result.match(re);
    if (!m) break;
    var lv1 = m[1].trim(), lv2 = m[2].trim(), op = m[3], idx = m.index;
    var after = result.substring(idx + m[0].length);
    var depth = 0, endIdx = -1;
    for (var i = 0; i < after.length; i++) {
      if (after[i] === '(') depth++;
      else if (after[i] === ')') depth--;
      else if (after[i] === ';' && depth === 0) { endIdx = i; break; }
    }
    var expr = endIdx >= 0 ? after.substring(0, endIdx) : after.trimEnd();
    var rest = endIdx >= 0 ? after.substring(endIdx) : '';
    result = result.substring(0, idx) + lv2 + ' ' + op + '= ' + expr + '; ' + lv1 + ' = ' + lv2 + rest;
  }
  return result;
}

function eelFixBangParen(code) {
  return code.replace(/!\(/g, 'bnot(').replace(/!(\d)/g, 'bnot($1)');
}

function eelFixArrayIndex(code) {
  var result = code;
  // (expr)[idx] → megabuf((expr)+(idx))
  var re = /\)\[([^\]]*)\]/g, m;
  while ((m = re.exec(result)) !== null) {
    var cp = m.index, depth = 1, op = cp - 1;
    while (op >= 0 && depth > 0) {
      if (result[op] === ')') depth++;
      else if (result[op] === '(') depth--;
      op--;
    }
    op++;
    var inner = result.substring(op + 1, cp);
    var idx2 = m[1] || '0';
    var rep = idx2.trim() ? 'megabuf((' + inner + ')+(' + idx2 + '))' : 'megabuf(' + inner + ')';
    result = result.substring(0, op) + rep + result.substring(cp + m[0].length);
    re.lastIndex = op + rep.length;
  }
  // var[] → gmegabuf(var)
  result = result.replace(/(\b\w+)\[\s*\]/g, 'gmegabuf($1)');
  // var[expr] → gmegabuf(var+(expr))
  result = result.replace(/(\b\w+)\[([^\]]+)\]/g, 'gmegabuf($1+($2))');
  return result;
}

function eelFixCeil(code) {
  var result = code, re = /\bceil\s*\(/g, m;
  while ((m = re.exec(result)) !== null) {
    var start = m.index, ps = m.index + m[0].length - 1, depth = 1, i = ps + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    var inner = result.substring(ps + 1, i - 1);
    var rep = '(0-floor(0-(' + inner + ')))';
    result = result.substring(0, start) + rep + result.substring(i);
    re.lastIndex = start + rep.length;
  }
  return result;
}

function eelFixNegativeParen(code) {
  var result = code, re = /([,(])\s*-\(/g, m;
  while ((m = re.exec(result)) !== null) {
    var mp = result.indexOf('-(', m.index + 1), ps = mp + 1, depth = 1, i = ps + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    var cp = i - 1, inner = result.substring(ps + 1, cp);
    var prefix = result.substring(m.index, mp);
    var rep = prefix + '(0-(' + inner + '))';
    result = result.substring(0, m.index) + rep + result.substring(cp + 1);
    re.lastIndex = m.index + rep.length;
  }
  return result;
}

function eelFixParenAssign(code) {
  var result = code, re = /\((\w+)\s*=(?!=)/g, m;
  while ((m = re.exec(result)) !== null) {
    var before = result.substring(Math.max(0, m.index - 20), m.index).trim();
    if (/\b(if|loop|while|exec2|exec3|above|below|equal|sin|cos|pow|sqrt|log|exp|max|min|int|floor|abs|sign|rand|bnot|bor|band|tan|asin|acos|atan|atan2|megabuf|gmegabuf)\s*$/i.test(before)) continue;
    if (/=\s*$/.test(before) && !/[!<>=]\s*$/.test(before)) continue;
    var ps = m.index, depth = 1, i = ps + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    var cp = i - 1, vn = m[1], ap = result.substring(cp + 1).trim();
    if ('*+-/'.includes(ap[0])) {
      var rest = result.substring(cp + 1), sd = 0, se = -1;
      for (var j = 0; j < rest.length; j++) {
        if (rest[j] === '(') sd++;
        else if (rest[j] === ')') sd--;
        else if (rest[j] === ';' && sd === 0) { se = j; break; }
        else if (rest[j] === ',' && sd === 0) { se = j; break; }
      }
      var inner = result.substring(m.index + 1, cp);
      var re2 = se >= 0 ? rest.substring(0, se) : rest;
      var as = se >= 0 ? rest.substring(se) : '';
      result = result.substring(0, ps) + inner + '; ' + vn + re2 + as;
      re.lastIndex = 0;
    }
  }
  return result;
}

function eelFixInvsqrt(code) {
  var result = code, re = /\binvsqrt\s*\(/g, m;
  while ((m = re.exec(result)) !== null) {
    var start = m.index, ps = m.index + m[0].length - 1, depth = 1, i = ps + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    var inner = result.substring(ps + 1, i - 1);
    var rep = '(1/sqrt(' + inner + '))';
    result = result.substring(0, start) + rep + result.substring(i);
    re.lastIndex = start + rep.length;
  }
  return result;
}

function eelFixMemset(code) {
  var result = code, re = /\bmemset\s*\(/g, m;
  while ((m = re.exec(result)) !== null) {
    var start = m.index, ps = m.index + m[0].length - 1, depth = 1, i = ps + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    var args = result.substring(ps + 1, i - 1);
    var parts = [], d = 0, last = 0;
    for (var j = 0; j < args.length; j++) {
      if (args[j] === '(') d++;
      else if (args[j] === ')') d--;
      else if (args[j] === ',' && d === 0) { parts.push(args.substring(last, j).trim()); last = j + 1; }
    }
    parts.push(args.substring(last).trim());
    if (parts.length === 3) {
      var off = parts[0], val = parts[1], cnt = parts[2];
      var rep = 'mseti=0; loop(' + cnt + ', megabuf(' + off + '+mseti)=' + val + '; mseti+=1)';
      result = result.substring(0, start) + rep + result.substring(i);
      re.lastIndex = start + rep.length;
    } else {
      re.lastIndex = i;
    }
  }
  return result;
}

function eelBuildExecN(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return 'exec2(' + parts[0] + ', ' + parts[1] + ')';
  if (parts.length === 3) return 'exec3(' + parts[0] + ', ' + parts[1] + ', ' + parts[2] + ')';
  return 'exec2(' + parts[0] + ', ' + eelBuildExecN(parts.slice(1)) + ')';
}

function eelFixWhileSemicolons(code) {
  var result = code, changed = true;
  while (changed) {
    changed = false;
    var re = /\bwhile\s*\(/g, m;
    while ((m = re.exec(result)) !== null) {
      var ps = m.index + m[0].length - 1, depth = 1, i = ps + 1;
      while (i < result.length && depth > 0) {
        if (result[i] === '(') depth++;
        else if (result[i] === ')') depth--;
        i++;
      }
      var cp = i - 1, body = result.substring(ps + 1, cp);
      var semis = [];
      depth = 0;
      for (var j = 0; j < body.length; j++) {
        if (body[j] === '(') depth++;
        else if (body[j] === ')') depth--;
        else if (body[j] === ';' && depth === 0) semis.push(j);
      }
      if (semis.length === 0) continue;
      var parts = [], lp = 0;
      for (var s of semis) { parts.push(body.substring(lp, s).trim()); lp = s + 1; }
      parts.push(body.substring(lp).trim());
      parts = parts.filter(function (p) { return p.length > 0; });
      if (parts.length <= 1) continue;
      var nb = eelBuildExecN(parts);
      result = result.substring(0, ps + 1) + nb + result.substring(cp);
      changed = true;
      break;
    }
  }
  return result;
}

/**
 * Preprocess raw EEL code to fix constructs the ClojureScript parser can't handle.
 * Applied BEFORE passing EEL to convertPresetEquations / convertShapeEquations /
 * convertWaveEquations.
 */
function fixEelPre(code) {
  if (!code) return code;
  var r = code;
  r = eelStripComments(r);
  r = eelFixChainedAssigns(r);
  r = eelFixChainedCompoundAssign(r);
  r = eelFixBangParen(r);
  r = eelFixArrayIndex(r);
  r = eelFixCeil(r);
  r = eelFixNegativeParen(r);
  r = eelFixParenAssign(r);
  r = eelFixInvsqrt(r);
  r = r.replace(/\$pi/g, '3.14159265358979');
  r = eelFixMemset(r);
  r = eelFixWhileSemicolons(r);
  return r;
}

/**
 * Post-process EEL-to-JS converted equation strings.
 *
 * 1. Fixes "return for(...)" — the EEL converter wraps if-bodies in IIFEs
 *    with "return lastExpr", but when lastExpr is a loop() → for(), the
 *    resulting "return for(...)" is invalid JS.  Remove the return.
 *
 * 2. Ensures the string ends with ";" so that butterchurn's
 *    `new Function("a", code + " return a;")` doesn't fuse a trailing
 *    bare expression with the appended return.
 */
function fixEelJs(code) {
  if (!code) return code;
  // 1. "return for(" → "for("  (inside IIFEs)
  code = code.replace(/\breturn\s+(for\s*\()/g, '$1');
  // 2. Insert missing semicolons: the EEL parser omits ';' after bare
  //    expressions (statements that aren't assignments), fusing them with the
  //    next statement.  Pattern: ")  a['" with only whitespace between.
  code = code.replace(/\)(\s+)(a\[')/g, ');$1$2');
  // 3. ensure trailing semicolon
  var trimmed = code.trimEnd();
  if (trimmed.length > 0 && !trimmed.endsWith(';') && !trimmed.endsWith('}')) {
    code = trimmed + ';';
  }
  return code;
}

/**
 * Apply all GLSL fixups to a shader result string (preamble + shader_body { body }).
 * rawOutput is the original hlsl2glslfork output, used for recovering declarations.
 */
function postProcessShaderResult(result, rawOutput) {
  if (!result) return result;

  var sbIdx = result.indexOf('shader_body');
  if (sbIdx === -1) return result;

  var preamble = result.substring(0, sbIdx).trim();
  var bodyMatch = result.match(/shader_body\s*\{([\s\S]*)\}\s*$/);
  if (!bodyMatch) return result;
  var body = bodyMatch[1];

  // --- Recover missing declarations from raw output ---
  if (rawOutput) {
    var rawLines = rawOutput.split('\n');

    // Re-add custom (non-builtin, non-sampler) uniforms stripped by processOptimizedShader
    for (var ri = 0; ri < rawLines.length; ri++) {
      var rline = rawLines[ri].trim();
      if (!rline.match(/^uniform\b/)) continue;
      var um = rline.match(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?(?:\w+)\s+(\w+)/);
      if (!um) continue;
      if (BUILTIN_UNIFORMS.has(um[1])) continue;
      if (rline.match(/sampler/)) continue;
      var nameRe = new RegExp('\\b' + um[1] + '\\b');
      if (nameRe.test(body) || nameRe.test(preamble)) {
        var declRe = new RegExp('\\b(uniform|int|float|vec[234]|mat[234]x?[234]?)\\s+' + um[1] + '\\b');
        if (!declRe.test(preamble)) {
          var cleanDecl = rline.replace(/\bhighp\s+/g, '').replace(/\blowp\s+/g, '').replace(/\bmediump\s+/g, '');
          preamble = cleanDecl + '\n' + preamble;
        }
      }
    }

    // Re-add global variable declarations (int n; float tubes; etc.) stripped by optimizer
    for (var ri2 = 0; ri2 < rawLines.length; ri2++) {
      var rline2 = rawLines[ri2].trim();
      // Skip uniforms (handled above), functions, preprocessor, empty lines
      if (rline2.match(/^(uniform|#|\/\/|\s*$|in\s|out\s)/)) continue;
      if (rline2.match(/\{|\}/)) continue;
      var gm = rline2.match(/^(?:highp\s+|mediump\s+|lowp\s+)?(int|float|vec[234]|mat[234]x?[234]?|bool)\s+(\w+)\s*;/);
      if (!gm) continue;
      var varName = gm[2];
      if (BUILTIN_UNIFORMS.has(varName)) continue;
      // Skip variables that are part of the shader template
      if (varName.match(/^(ret|xlv_TEXCOORD|_glesFragData|gl_Frag)/)) continue;
      var nameRe2 = new RegExp('\\b' + varName + '\\b');
      if (nameRe2.test(body)) {
        var declRe2 = new RegExp('\\b(int|float|vec[234]|mat[234]x?[234]?|bool)\\s+' + varName + '\\b');
        if (!declRe2.test(preamble) && !declRe2.test(body)) {
          var cleanDecl2 = rline2.replace(/\bhighp\s+/g, '').replace(/\blowp\s+/g, '').replace(/\bmediump\s+/g, '');
          preamble = cleanDecl2 + '\n' + preamble;
        }
      }
    }
  }

  // --- GLSL semantic fixes ---
  body = fixFloatVec3Cast(body);
  preamble = fixFloatVec3Cast(preamble);

  // uv l-value: butterchurn 'uv' is read-only input.
  // Detect writes to uv, uv.xy, uv.x, etc. and create a local _uv copy.
  var hasUvWrite = /\buv(?:\.\w+)?\s*=[^=]/.test(body) ||
                   /\buv(?:\.\w+)?\s*[+\-*\/]=/.test(body);
  if (hasUvWrite) {
    body = body.replace(/\buv\b/g, '_uv');
    body = body.replace(/\b_uv_orig\b/g, 'uv_orig');
    body = 'vec2 _uv = uv; \n' + body;
  }

  // const stripping: hlsl2glslfork emits 'const' for HLSL 'static const',
  // but some shaders later modify the variable. Also strip const from float arrays.
  body = body.replace(/\bconst\s+(float|int|vec[234]|mat[234]|bool|float\s*\[\s*\d+\s*\])\b/g, '$1');
  preamble = preamble.replace(/\bconst\s+(float|int|vec[234]|mat[234]|bool|float\s*\[\s*\d+\s*\])\b/g, '$1');

  // Move global variable declarations with non-constant initializers into the body.
  // GLSL ES requires global initializers to be constant expressions.
  // Only process lines at brace depth 0 (true global scope, not inside functions).
  var plines = preamble.split('\n');
  var movedInits = [];
  var braceDepth = 0;
  for (var pi = 0; pi < plines.length; pi++) {
    var pl = plines[pi];
    // Track brace depth to distinguish global scope from function bodies
    for (var bi = 0; bi < pl.length; bi++) {
      if (pl[bi] === '{') braceDepth++;
      else if (pl[bi] === '}') braceDepth--;
    }
    if (braceDepth !== 0) continue; // inside a function body — skip
    // Match: type varname = expr; (but NOT uniform, NOT function defs with {)
    var gim = pl.match(/^\s*(float\s*\[\s*\d+\s*\]|float|int|vec[234]|mat[234]x?[234]?|bool)\s+(\w+)\s*=\s*(.+);\s*$/);
    if (!gim) continue;
    if (/\{/.test(pl)) continue; // skip function bodies on same line
    var initExpr = gim[3];
    // Check if initializer is non-constant (contains function calls or variable references)
    if (/[a-zA-Z_]\w*\s*\(/.test(initExpr) && !/^\s*(vec[234]|mat[234]|float|int|bool)\s*\(/.test(initExpr)) {
      // Non-constant: move to body
      plines[pi] = gim[1] + ' ' + gim[2] + ';';
      movedInits.push(gim[2] + ' = ' + initExpr + ';');
    }
  }
  if (movedInits.length > 0) {
    preamble = plines.join('\n');
    body = movedInits.join('\n') + '\n' + body;
  }

  // Array constructor expansion
  preamble = fixArrayConstructor(preamble);
  body = fixArrayConstructor(body);

  // cross(a,b)*c → dot(cross(a,b),c)
  preamble = fixCrossDot(preamble);
  body = fixCrossDot(body);

  // (vec3*vec3) → dot(vec3,vec3)
  // (vec3*vec3) → dot(vec3,vec3) — run on combined so preamble vec3 decls are visible for body
  var SPLIT_MARKER = '\n/*__SPLIT__*/\n';
  var combined = preamble + SPLIT_MARKER + body;
  combined = fixVec3Mul(combined);
  var splitPos = combined.indexOf(SPLIT_MARKER);
  preamble = combined.substring(0, splitPos);
  body = combined.substring(splitPos + SPLIT_MARKER.length);

  // xll_matrixindex l-value fix
  preamble = fixMatrixIndexLValue(preamble);
  body = fixMatrixIndexLValue(body);

  // xll_matrixindex_mf3x2_i return type fix (vec3 → vec2)
  preamble = fixMatrixIndexReturnType(preamble);
  body = fixMatrixIndexReturnType(body);

  // xll helper injection (transpose, matrixindex)
  var allText = preamble + '\n' + body;
  var helperDicts = [XLL_TRANSPOSE_EXTRAS, XLL_MATRIXINDEX_EXTRAS];
  for (var di = 0; di < helperDicts.length; di++) {
    var dict = helperDicts[di];
    for (var fname in dict) {
      if (allText.indexOf(fname) === -1) continue;
      var defRe = new RegExp('\\b(?!return\\b)\\w+\\s+' + fname + '\\s*\\(');
      if (defRe.test(preamble)) continue;
      preamble = dict[fname] + '\n' + preamble;
    }
  }

  // Reassemble
  if (preamble) {
    return preamble + '\n shader_body { ' + body + ' }';
  }
  return ' shader_body { ' + body + ' }';
}

/**
 * Process raw hlsl2glslfork output (without glsl-optimizer) into butterchurn's
 * shader_body format. Used as fallback when glsl-optimizer fails.
 *
 * Improvements over naive extraction:
 * - Extracts initialisation from void main() (static const → q-variable mappings)
 * - Adds missing non-square xll_transpose helpers
 * - Fixes float(vec3_expr) → (vec3_expr).x  (HLSL implicit truncation)
 * - Fixes cross(a,b)*c → dot(cross(a,b),c) when result assigned to float
 */
function processRawShader(raw) {
  if (!raw || !raw.trim()) return '';

  var lines = raw.split('\n');
  var preambleLines = [];
  var inBoilerplate = true;
  var xlatMainBody = null;
  var voidMainBody = null;
  var xlatMainStart = -1;

  // Phase 1: strip boilerplate, collect preamble, find xlat_main AND void main
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // Skip empty lines in boilerplate phase
    if (inBoilerplate && trimmed === '') continue;

    // Skip boilerplate: #version, #define, in declarations, out _glesFragData
    if (trimmed.match(/^#version\b/) ||
        trimmed.match(/^#define\b/) ||
        trimmed.match(/^in\s/) ||
        trimmed.match(/^out\s.*_glesFragData/)) {
      continue;
    }

    // Skip #line directives
    if (trimmed.match(/^#line\b/)) continue;

    // We're past the boilerplate now
    inBoilerplate = false;

    // Skip standard uniform declarations
    if (trimmed.match(/^uniform\b/)) {
      var nameMatch = trimmed.match(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?(?:\w+)\s+(\w+)/);
      if (nameMatch && BUILTIN_UNIFORMS.has(nameMatch[1])) continue;
      // Keep custom uniforms in preamble — strip precision qualifiers
      preambleLines.push(line.replace(/\bhighp\s+/g, '').replace(/\blowp\s+/g, '').replace(/\bmediump\s+/g, ''));
      continue;
    }

    // Check for xlat_main function start
    if (trimmed.match(/\bxlat_main\s*\(/) && !xlatMainBody) {
      var result = extractFunctionBody(lines, i);
      xlatMainBody = result.bodyLines;
      xlatMainStart = i;
      i = result.endIndex; // skip past
      continue; // keep scanning for void main()
    }

    // Check for void main()
    if (trimmed.match(/^void\s+main\s*\(/)) {
      var result2 = extractFunctionBody(lines, i);
      voidMainBody = result2.bodyLines;
      break; // nothing useful after void main()
    }

    // Add non-function declarations to preamble (both before AND after xlat_main)
    // Lines between xlat_main and void main may include global variable declarations
    // (e.g. int tubes; float tlen;) needed by xlat_main.
    if (xlatMainStart === -1 || (xlatMainStart !== -1 && !trimmed.match(/^\w+\s+\w+\s*\(/))) {
      preambleLines.push(line.replace(/\bhighp\s+/g, '').replace(/\blowp\s+/g, '').replace(/\bmediump\s+/g, ''));
    }
  }

  // Determine shader body
  var mainBody;
  if (xlatMainBody && xlatMainBody.length > 0) {
    mainBody = xlatMainBody;
  } else if (voidMainBody && voidMainBody.length > 0) {
    mainBody = voidMainBody;
  } else {
    return '';
  }

  // Phase 1b: Extract initialisation from void main() when xlat_main exists.
  // hlsl2glslfork puts static const initialisations (depth=q30, mov=vec3(q5,..), etc.)
  // in void main() between the uniform→mutable copies and the xlat_main() call.
  var initLines = [];
  if (xlatMainBody && voidMainBody) {
    var inInitBlock = false;
    for (var mi = 0; mi < voidMainBody.length; mi++) {
      var mline = voidMainBody[mi].trim();
      // Skip blank & #line
      if (mline === '' || mline.match(/^#line\b/)) continue;
      // Skip uniform→mutable copies: xlat_mutableFoo = foo;
      if (mline.match(/^\s*xlat_mutable\w+\s*=\s*\w+\s*;/)) continue;
      // Stop at xl_retval or xlat_main call
      if (mline.match(/xl_retval|xlat_main|_glesFragData|gl_FragData/)) break;
      // Everything else is initialisation
      initLines.push(voidMainBody[mi]);
    }
  }

  // Phase 2: clean up body
  var body = mainBody.join('\n');
  // Remove precision qualifiers
  body = body.replace(/\bhighp\s+/g, '');
  body = body.replace(/\blowp\s+/g, '');
  body = body.replace(/\bmediump\s+/g, '');
  // Remove #line directives
  body = body.replace(/^\s*#line\s+\d+.*$/gm, '');
  // Replace xlv_TEXCOORD0 → uv
  body = body.replace(/xlv_TEXCOORD0/g, 'uv');
  // Remove local 'vec3 ret;' declaration (already declared by butterchurn template)
  body = body.replace(/^\s*vec3\s+ret\s*;\s*$/gm, '');
  // Remove the final return statement (butterchurn wraps with fragColor = vec4(ret, ...))
  body = body.replace(/\breturn\s+vec4\s*\(\s*ret\s*,\s*[\d.]+\s*\)\s*;/g, '');
  // Handle gl_FragData[0] = vec4(xl_retval) pattern from void main wrapper
  body = body.replace(/_glesFragData\[0\]\s*=\s*(.+);/g, function(m, val) {
    return 'ret = ' + val + '.xyz;';
  });
  body = body.replace(/gl_FragData\[0\]\s*=\s*(.+);/g, function(m, val) {
    return 'ret = ' + val + '.xyz;';
  });

  // Prepend initialisation from void main() (if any)
  if (initLines.length > 0) {
    var initBlock = initLines.join('\n');
    initBlock = initBlock.replace(/\bhighp\s+/g, '').replace(/\blowp\s+/g, '').replace(/\bmediump\s+/g, '');
    initBlock = initBlock.replace(/^\s*#line\s+\d+.*$/gm, '');
    body = initBlock + '\n' + body;
  }

  // Phase 3: clean up preamble
  var preamble = preambleLines.join('\n').trim();
  // Fix bare 'sampler' type (HLSL artifact) → 'sampler2D' for valid GLSL
  preamble = preamble.replace(/\buniform\s+sampler\s+/g, 'uniform sampler2D ');

  // Assemble and apply all shared GLSL fixups
  var assembled;
  if (preamble) {
    assembled = preamble + '\n shader_body { ' + body + ' }';
  } else {
    assembled = ' shader_body { ' + body + ' }';
  }
  return postProcessShaderResult(assembled, raw);
}

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
 * Inline #define macros in prepared HLSL.
 * hlsl2glslfork doesn't re-scan after object-like macro expansion, so aliases
 * like `#define GB1 GetBlur1` followed by `GB1(uv)` fail. We expand both
 * object-like aliases and function-like macros (GetPixel, GetBlur, lum, etc.)
 * in the source code, leaving the #define lines intact for compatibility.
 */
function inlineHlslMacros(prepared) {
  var lines = prepared.split('\n');

  // Collect simple object-like #define Alias Target (where Target matches known helpers)
  var aliases = {};
  for (var i = 0; i < lines.length; i++) {
    var ma = lines[i].match(/^\s*#define\s+(\w+)\s+((?:GetPixel|GetBlur[123]|GetMain|lum|sat|tex2[dD]|tex3[dD])\b.*)$/);
    if (ma) aliases[ma[1]] = ma[2];
  }

  // Collect function-like #define Name(param) Body
  var funcMacros = {};
  for (var j = 0; j < lines.length; j++) {
    var mf = lines[j].match(/^\s*#define\s+(\w+)\s*\((\w+)\)\s+(.+)$/);
    if (mf) funcMacros[mf[1]] = { param: mf[2], body: mf[3] };
  }

  // Nothing to inline
  if (Object.keys(aliases).length === 0 && Object.keys(funcMacros).length === 0) return prepared;

  var result = prepared;

  // Step 1: expand object-like aliases (skip #define lines)
  for (var alias in aliases) {
    var aRe = new RegExp('\\b' + alias + '\\b', 'g');
    result = result.replace(aRe, function (m, offset) {
      var lineStart = result.lastIndexOf('\n', offset) + 1;
      var lineText = result.substring(lineStart, lineStart + 200);
      if (/^\s*#define/.test(lineText)) return m;
      return aliases[alias];
    });
  }

  // Step 2: expand function-like macros (skip #define lines)
  for (var fname in funcMacros) {
    var macro = funcMacros[fname];
    var fRe = new RegExp('\\b' + fname + '\\s*\\(', 'g');
    var fm;
    while ((fm = fRe.exec(result)) !== null) {
      var fLineStart = result.lastIndexOf('\n', fm.index) + 1;
      var fLineText = result.substring(fLineStart, fLineStart + 200);
      if (/^\s*#define/.test(fLineText)) continue;

      var openP = fm.index + fm[0].length - 1;
      var depth = 1, pos = openP + 1;
      while (pos < result.length && depth > 0) {
        if (result[pos] === '(') depth++;
        else if (result[pos] === ')') depth--;
        pos++;
      }
      var argExpr = result.substring(openP + 1, pos - 1);
      var expanded = macro.body.replace(new RegExp('\\b' + macro.param + '\\b', 'g'), argExpr);
      result = result.substring(0, fm.index) + expanded + result.substring(pos);
      fRe.lastIndex = fm.index + expanded.length;
    }
  }

  return result;
}

/**
 * Fix `static const float3 x = SCALAR;` patterns: hlsl2glslfork rejects
 * implicit scalar→vector conversion for const initialisers.  Wrap scalar
 * initialisers in an explicit vector constructor so we can keep `static const`.
 */
function fixStaticConstVectors(hlsl) {
  // Match each `static const float2/3/4` declaration line
  var re = /^(.*\bstatic\s+const\s+((?:float|half|int)[234])\b.*)$/gm;
  return hlsl.replace(re, function (_line, full, vecType) {
    // Process each `name = expr` initialiser inside the declaration.
    // We wrap expr in vecType(expr) when it looks scalar (no swizzle,
    // no vector constructor, no known vector function/variable).
    return full.replace(
      /=\s*([^;,]+?)(\s*[;,])/g,
      function (_m, init, sep) {
        var t = init.trim();
        // Already a vector constructor → leave alone
        if (/^(?:float|half|int)[234]\s*\(/.test(t)) return _m;
        if (/^(?:float|half|int)[234]x[234]\s*\(/.test(t)) return _m;
        // Contains swizzle (.xy .xyz .xyzw .zw .yx etc.) → probably vector
        if (/\.[xyzwrgba]{2,}/.test(t)) return _m;
        // Contains known vector-returning functions → probably vector
        if (/\b(?:cross|normalize|reflect|refract|frac|fract|lerp|step|smoothstep|pow|saturate|abs|min|max|clamp|sign|floor|ceil|round|sqrt|sin|cos|tan|exp|log|mul)\s*\(/.test(t)) return _m;
        // Contains texsize, rand_preset, tex2D, texture → vector
        if (/\b(?:texsize|rand_preset|rand_frame|tex2D|tex2Dlod|texture)\b/.test(t)) return _m;
        // Looks scalar → wrap in constructor
        return '= ' + vecType + '(' + t + ')' + sep;
      }
    );
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

  // HLSL preprocessing
  var fixedHlsl = rawHlsl
    // Replace unsupported double types with float equivalents
    .replace(/\bdouble4\b/g, 'float4')
    .replace(/\bdouble3\b/g, 'float3')
    .replace(/\bdouble2\b/g, 'float2')
    .replace(/\bdouble\b/g, 'float')
    ;

  // Fix static const vector declarations: hlsl2glslfork rejects implicit type
  // mismatches with const ("non-matching types for const initializer").
  // We keep 'static const' so hlsl2glslfork preserves local variables (stripping
  // const causes it to hoist certain names as uniforms).
  fixedHlsl = fixStaticConstVectors(fixedHlsl);

  fixedHlsl = fixedHlsl
    // Fix bare sampler type → sampler2D
    .replace(/\bsampler\s+sampler_/g, 'sampler2D sampler_')
    // Remove duplicate declarations of built-in samplers (already in prepareShader header)
    // Also remove commented-out sampler lines — prepareShader bugs out and comments the next line
    .replace(/^\s*(?:\/\/)?\s*sampler2D\s+sampler_(main|fw_main|pw_main|fc_main|pc_main|noise_lq|noise_lq_lite|noise_mq|noise_hq|pw_noise_lq|blur[123])\b[^;]*;/gm, '')
    .replace(/^\s*(?:\/\/)?\s*sampler3D\s+sampler_(noisevol_lq|noisevol_hq)\b[^;]*;/gm, '')
    // Rename user-defined noise() function to avoid conflict with GLSL built-in
    .replace(/(\b(?:float[234]?|int|half[234]?)\s+)noise(\s*\()/g, '$1noise_ud$2');

  // Also rename noise() calls if the function was renamed
  if (fixedHlsl.indexOf('noise_ud') !== -1) {
    fixedHlsl = fixedHlsl.replace(/\bnoise\s*\(/g, 'noise_ud(');
  }

  // Fix empty function bodies: type name(...) { } → add return
  fixedHlsl = fixedHlsl.replace(/(\b(?:float[234]?|int|half[234]?)\s+\w+\s*\([^)]*\)\s*\{)\s*\}/g, '$1 return 0; }');

  // Rename HLSL built-in names (cross, noise) used as variables to avoid prepareShader
  // commenting them out. Detect via variable declarations: "float cross," or "float noise,"
  var builtinVarNames = ['cross', 'noise'];
  for (var bvi = 0; bvi < builtinVarNames.length; bvi++) {
    var bvName = builtinVarNames[bvi];
    var bvDeclRe = new RegExp('\\b(?:float[234]?|int|half[234]?)\\s+(?:\\w+\\s*,\\s*)*' + bvName + '\\b');
    if (bvDeclRe.test(fixedHlsl)) {
      fixedHlsl = fixedHlsl.replace(new RegExp('\\b' + bvName + '\\b', 'g'), bvName + '_v');
    }
  }

  var prepared = prepareShader(fixedHlsl);
  if (!prepared) return Promise.resolve('');

  // Inline #define macros — hlsl2glslfork doesn't re-scan after object-like expansion
  prepared = inlineHlslMacros(prepared);

  // hlsl2glslfork is strict with 'const' type matching — it may reject valid HLSL
  // where initializer types don't exactly match (scalar→vector, bool→float, etc.).
  // But keeping 'static const' is important: hlsl2glslfork preserves const variables
  // as locals with initializers, while 'static' (no const) may hoist them as
  // uninitialized uniforms (causing black renders, e.g. city lights).
  // Strategy: try with const first, retry without const on failure.
  var preparedNoConst = prepared.replace(/\bstatic\s+const\b/g, 'static');
  var hasConst = prepared !== preparedNoConst;

  function doConvert(shader) {
    var t0 = Date.now();
    _logStats.calls++;

    return fetch(CONVERT_URL, {
      method: 'POST',
      body: JSON.stringify({ optimize: false, shader: shader }),
    })
      .then(function (r) {
        var ms = Date.now() - t0;
        _logStats.totalMs += ms;
        if (!r.ok) {
          _logStats.fail++;
          _appendLog({ t: new Date().toISOString(), label: label || '', status: r.status, ms: ms, ok: false, hlslBytes: shader.length });
          return r.text().then(function (body) {
            throw new Error('Shader conversion HTTP ' + r.status + ': ' + body.slice(0, 500));
          });
        }
        return r.json().then(function (data) {
          _logStats.ok++;
          _appendLog({ t: new Date().toISOString(), label: label || '', status: r.status, ms: ms, ok: true, hlslBytes: shader.length, glslBytes: (data.shader||'').length });
          return data;
        });
      });
  }

  return doConvert(prepared)
    .catch(function (err) {
      if (hasConst && /HTTP 500/.test(err.message)) {
        // Retry without const — accept potential uniform hoisting as a fallback
        _logStats.fail--; // undo the fail count from the first attempt
        return doConvert(preparedNoConst);
      }
      throw err;
    })
    .then(function (data) {
      var optimized = optimizeFn(data.shader, 1, 0);

      // Detect glsl-optimizer failures:
      // Valid optimized GLSL always contains 'void main'. If missing, optimization
      // failed (error string, garbage output, or corrupted WASM result).
      var optimizerFailed = !optimized || optimized.indexOf('void main') === -1;

      if (optimizerFailed) {
        process.stderr.write('  glsl-optimizer failed for ' + (label || '?') + ', using unoptimized fallback\n');
        return processRawShader(data.shader);
      }

      var result = processOptimizedShader(optimized);
      return postProcessShaderResult(result, data.shader);
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
    fixEelPre(split.presetInit || ''),
    fixEelPre(split.perFrame || ''),
    fixEelPre(split.perVertex || '')
  );
  eqs.init_eqs_str = fixEelJs(eqs.init_eqs_str);
  eqs.frame_eqs_str = fixEelJs(eqs.frame_eqs_str);
  eqs.pixel_eqs_str = fixEelJs(eqs.pixel_eqs_str);

  // --- shapes (always 4 slots) ---
  var shapes = [];
  for (var si = 0; si < 4; si++) {
    var sh = (split.shapes && split.shapes[si]) || {};
    var shBase = sh.baseVals || { enabled: 0 };
    if (shBase.enabled) {
      var shEqs = convertShapeEquations(
        presetVersion,
        fixEelPre(sh.init_eqs_str || ''),
        fixEelPre(sh.frame_eqs_str || '')
      );
      shapes.push({
        baseVals: shBase,
        init_eqs_str: fixEelJs(shEqs.init_eqs_str),
        frame_eqs_str: fixEelJs(shEqs.frame_eqs_str),
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
        fixEelPre(wv.init_eqs_str || ''),
        fixEelPre(wv.frame_eqs_str || ''),
        fixEelPre(wv.point_eqs_str || '')
      );
      waves.push({
        baseVals: wvBase,
        init_eqs_str: fixEelJs(wvEqs.init_eqs_str),
        frame_eqs_str: fixEelJs(wvEqs.frame_eqs_str),
        point_eqs_str: fixEelJs(wvEqs.point_eqs_str),
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
