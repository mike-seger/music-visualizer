const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

// Resolve deps from milkdrop-preset-converter's node_modules
// Use v0.2.1 of milkdrop-preset-utils (from -node converter) for better .milk parsing:
//   - Preserves all shape/wave baseVals (not just non-default)
//   - Includes shape/wave EEL strings
//   - Strips version/psversion keys from baseVals
const converterDir = path.resolve(__dirname, '../tmp/milkdrop-preset-converter');
const nodeConverterDir = path.resolve(__dirname, '../tmp/milkdrop-preset-converter-node');
const resolve = (mod) => require(require.resolve(mod, { paths: [converterDir] }));
const resolveNode = (mod) => require(require.resolve(mod, { paths: [nodeConverterDir] }));

const _ = resolve('lodash');
const { splitPreset } = resolveNode('milkdrop-preset-utils');
const { createBasePresetFuns } = resolve('milkdrop-preset-utils');
const milkdropParser = resolve('milkdrop-eel-parser');

// ─── HLSL → GLSL shader conversion (text-based) ──────────────────────────

function findMatchingParen(str, start) {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function replaceFuncCall(src, funcName, replacer) {
  let result = '';
  let i = 0;
  const re = new RegExp(`\\b${funcName}\\s*\\(`);
  while (i < src.length) {
    const sub = src.substring(i);
    const m = sub.match(re);
    if (!m || m.index === undefined) { result += sub; break; }
    result += sub.substring(0, m.index);
    const parenOpen = i + m.index + m[0].length;
    const parenClose = findMatchingParen(src, parenOpen);
    if (parenClose < 0) { result += sub.substring(m.index); break; }
    const inner = src.substring(parenOpen, parenClose);
    result += replacer(inner);
    i = parenClose + 1;
  }
  return result;
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') depth--;
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.substring(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(str.substring(start).trim());
  return parts;
}

/**
 * Check if a position in a line is inside a vec3/vec4/vecN constructor (N > targetN).
 * Used to avoid truncating variables that are legitimately providing components
 * to a larger vec constructor.
 */
function isInsideVecConstructor(line, pos, targetN) {
  const vecRe = /\bvec([234])\s*\(/g;
  let m;
  while ((m = vecRe.exec(line)) !== null) {
    const vecN = parseInt(m[1]);
    if (vecN <= targetN) continue; // only guard vec constructors larger than target
    const parenStart = m.index + m[0].length;
    if (parenStart > pos) break; // constructor starts after our position
    // Check if pos is inside this constructor's parentheses
    let depth = 1;
    for (let c = parenStart; c < line.length && depth > 0; c++) {
      if (line[c] === '(') depth++;
      else if (line[c] === ')') depth--;
      if (depth > 0 && c >= pos) return true;
    }
  }
  return false;
}

/**
 * Convert HLSL % operator to GLSL mod() with proper expression boundary detection.
 * Handles both simple `n%2` and parenthesized `(n+1)%2` cases.
 */
function convertModOperator(src) {
  let result = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '%' && i > 0) {
      // Skip if inside a comment or string
      // Find LHS boundary: scan backwards for the operand
      let lhsEnd = i - 1;
      while (lhsEnd >= 0 && /\s/.test(src[lhsEnd])) lhsEnd--;
      if (lhsEnd < 0) { result += src[i]; i++; continue; }

      let lhsStart;
      if (src[lhsEnd] === ')') {
        // Parenthesized expression: find matching '('
        let depth = 1;
        let j = lhsEnd - 1;
        while (j >= 0 && depth > 0) {
          if (src[j] === ')') depth++;
          else if (src[j] === '(') depth--;
          j--;
        }
        lhsStart = j + 1;
        // Include preceding identifier (function name or type cast like int(...))
        while (lhsStart > 0 && /[\w]/.test(src[lhsStart - 1])) lhsStart--;
      } else if (/[\w.]/.test(src[lhsEnd])) {
        // Identifier or number: scan back to start
        let j = lhsEnd;
        while (j > 0 && /[\w.]/.test(src[j - 1])) j--;
        lhsStart = j;
      } else {
        result += src[i]; i++; continue;
      }

      // Find RHS boundary: scan forwards for the operand
      let rhsStart = i + 1;
      while (rhsStart < src.length && /\s/.test(src[rhsStart])) rhsStart++;
      let rhsEnd;
      if (rhsStart < src.length && src[rhsStart] === '(') {
        // Parenthesized expression
        let depth = 1;
        let j = rhsStart + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        rhsEnd = j;
      } else if (rhsStart < src.length && /[\w.]/.test(src[rhsStart])) {
        let j = rhsStart;
        while (j < src.length && /[\w.]/.test(src[j])) j++;
        rhsEnd = j;
      } else {
        result += src[i]; i++; continue;
      }

      const lhs = src.substring(lhsStart, lhsEnd + 1);
      const rhs = src.substring(rhsStart, rhsEnd);
      // Replace: trim the LHS from result, add mod(lhs, rhs)
      result = result.substring(0, result.length - (i - lhsStart)) + `mod(${lhs}, ${rhs})`;
      i = rhsEnd;
      continue;
    }
    result += src[i];
    i++;
  }
  return result;
}

function addTextureSwizzle(src) {
  let result = '';
  let i = 0;
  while (i < src.length) {
    const sub = src.substring(i);
    const m = sub.match(/\btexture\s*\(/);
    if (!m || m.index === undefined) { result += sub; break; }
    result += sub.substring(0, m.index + m[0].length);
    const parenOpen = i + m.index + m[0].length;
    const parenClose = findMatchingParen(src, parenOpen);
    if (parenClose < 0) { result += sub.substring(m.index + m[0].length); break; }
    result += src.substring(parenOpen, parenClose + 1);
    const after = src.substring(parenClose + 1);
    if (!/^\s*\./.test(after)) {
      result += '.xyz';
    }
    i = parenClose + 1;
  }
  return result;
}

function hlslToGlsl(shaderText) {
  if (!shaderText) return '';
  let s = shaderText;

  // Strip C-style block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // HLSL 'static' keyword → remove.  In HLSL, 'static' on globals means
  // the variable is local to the shader (not external).  GLSL has no
  // equivalent — all file-scope variables are already shader-local.
  // 'static const' → 'const', bare 'static' → removed.
  s = s.replace(/\bstatic\s+const\b/g, 'const');
  s = s.replace(/\bstatic\b\s*/g, '');

  // HLSL header 'const' with uniform-dependent initializers → remove 'const'.
  // After q-variable substitution, `const float x = _qa.z;` would fail in
  // GLSL because _qa is a uniform (not a compile-time constant).
  // In the header (before shader_body), strip 'const' from declarations that
  // reference _q uniforms, texsize, aspect, etc.
  // We do a conservative approach: strip 'const' from ALL header variable
  // declarations since HLSL 'static const' is really just 'initialized var'.
  {
    const sbIdx = s.indexOf('shader_body');
    if (sbIdx > 0) {
      let header = s.substring(0, sbIdx);
      const body = s.substring(sbIdx);
      // Only strip const from variable declarations, not from #define or function params
      header = header.replace(/^(\s*)const\s+(?=\w)/gm, '$1');
      s = header + body;
    }
  }

  // Type replacements (order matters: float4x4 before float4)
  s = s.replace(/\bfloat4x4\b/g, 'mat4');
  s = s.replace(/\bfloat3x3\b/g, 'mat3');
  s = s.replace(/\bfloat2x2\b/g, 'mat2');
  // Non-square matrix types: floatMxN → matMxN
  s = s.replace(/\bfloat(\d)x(\d)\b/g, 'mat$1x$2');
  s = s.replace(/\bfloat4\b/g, 'vec4');
  s = s.replace(/\bfloat3\b/g, 'vec3');
  s = s.replace(/\bfloat2\b/g, 'vec2');  s = s.replace(/\bfloat1\b/g, 'float');
  s = s.replace(/\bhalf4\b/g, 'vec4');
  s = s.replace(/\bhalf3\b/g, 'vec3');
  s = s.replace(/\bhalf2\b/g, 'vec2');
  s = s.replace(/\bhalf\b/g, 'float');
  // HLSL double precision types → float equivalents (GPU rarely has true fp64)
  s = s.replace(/\bdouble4x4\b/g, 'mat4');
  s = s.replace(/\bdouble3x3\b/g, 'mat3');
  s = s.replace(/\bdouble2x2\b/g, 'mat2');
  s = s.replace(/\bdouble4\b/g, 'vec4');
  s = s.replace(/\bdouble3\b/g, 'vec3');
  s = s.replace(/\bdouble2\b/g, 'vec2');
  s = s.replace(/\bdouble\b/g, 'float');
  // HLSL integer vector types → GLSL equivalents
  s = s.replace(/\bint4\b/g, 'ivec4');
  s = s.replace(/\bint3\b/g, 'ivec3');
  s = s.replace(/\bint2\b/g, 'ivec2');
  // HLSL boolean vector types → GLSL equivalents
  s = s.replace(/\bbool4\b/g, 'bvec4');
  s = s.replace(/\bbool3\b/g, 'bvec3');
  s = s.replace(/\bbool2\b/g, 'bvec2');
  // HLSL M_PI constant → GLSL PI (defined in our header)
  s = s.replace(/\bM_PI\b/g, 'PI');
  // HLSL 'sampler' keyword (DX9 combined) → sampler2D
  s = s.replace(/\bsampler\b(?![\d_])/g, 'sampler2D');
  // Ensure sampler/texsize declarations have 'uniform' prefix
  s = s.replace(/^(\s*)(?!uniform\s)(sampler2D\s)/gm, '$1uniform $2');
  s = s.replace(/^(\s*)(?!uniform\s)(sampler3D\s)/gm, '$1uniform $2');
  s = s.replace(/^(\s*)(?!uniform\s)(vec4\s+texsize_)/gm, '$1uniform $2');

  // #define sat saturate → expand to clamp macro (saturate is HLSL-only)
  s = s.replace(/#define\s+sat\s+saturate\b/g, '#define sat(x) clamp(x, 0.0, 1.0)');

  // Simple function renames
  s = s.replace(/\btex2[dD]\b/g, 'texture');
  s = s.replace(/\btex3[dD]\b/g, 'texture');
  s = s.replace(/\blerp\b/g, 'mix');
  s = s.replace(/\bfrac\b/g, 'fract');
  s = s.replace(/\brsqrt\b/g, 'inversesqrt');
  s = s.replace(/\batan2\b/g, 'atan');
  s = s.replace(/\bddx\b/g, 'dFdx');
  s = s.replace(/\bddy\b/g, 'dFdy');

  // HLSL % operator → GLSL mod() for float operands
  // (GLSL % only works on integers; since we convert int→float, use mod)
  s = convertModOperator(s);

  // saturate(expr) → clamp(expr, 0.0, 1.0)
  // Loop to handle nested saturate(1-saturate(...)+...) cases
  { let prev; do { prev = s;
    s = replaceFuncCall(s, 'saturate', inner => `clamp(${inner}, 0.0, 1.0)`);
  } while (s !== prev); }

  // mul(A, B) → (B * A)  (HLSL row-major → GLSL column-major)
  s = replaceFuncCall(s, 'mul', inner => {
    const args = splitTopLevelCommas(inner);
    if (args.length === 2) return `(${args[1]} * ${args[0]})`;
    return `mul(${inner})`;
  });

  // Expand #define aliases for GetPixel/GetBlur before replacing them.
  // e.g., "#define GP GetPixel" → replace all GP( with GetPixel(
  // e.g., "#define GB1 GetBlur3" → replace all GB1( with GetBlur3(
  {
    const defineRe = /#define\s+(\w+)\s+(GetPixel|GetBlur[123])\b/g;
    let dm;
    while ((dm = defineRe.exec(s)) !== null) {
      const alias = dm[1];
      const target = dm[2];
      // Replace the #define line itself (it would cause errors in GLSL if target is removed)
      s = s.replace(dm[0], '// ' + dm[0]);
      // Replace all uses of the alias with the target
      s = s.replace(new RegExp('\\b' + alias + '\\s*\\(', 'g'), target + '(');
    }
  }

  // GetBlur1/2/3(uv) → inline texture reads with scale+bias
  s = replaceFuncCall(s, 'GetBlur1', uv =>
    `((texture(sampler_blur1, ${uv}).xyz * scale1) + bias1)`);
  s = replaceFuncCall(s, 'GetBlur2', uv =>
    `((texture(sampler_blur2, ${uv}).xyz * scale2) + bias2)`);
  s = replaceFuncCall(s, 'GetBlur3', uv =>
    `((texture(sampler_blur3, ${uv}).xyz * scale3) + bias3)`);

  // GetPixel(uv) → texture(sampler_main, uv).xyz
  s = replaceFuncCall(s, 'GetPixel', uv =>
    `texture(sampler_main, ${uv}).xyz`);

  // Auto-add .xyz swizzle to texture() calls without one
  s = addTextureSwizzle(s);

  // Strip duplicate declarations of built-in butterchurn samplers from user
  // headers (they appear before shader_body and would collide with the
  // template's own declarations at runtime / validation).
  const builtinSamplers = new Set([
    'sampler_main','sampler_fw_main','sampler_fc_main','sampler_pw_main','sampler_pc_main',
    'sampler_blur1','sampler_blur2','sampler_blur3',
    'sampler_noise_lq','sampler_noise_lq_lite','sampler_noise_mq','sampler_noise_hq',
    'sampler_pw_noise_lq','sampler_noisevol_lq','sampler_noisevol_hq',
  ]);
  s = s.split('\n').map(line => {
    const sm = line.match(/^\s*uniform\s+sampler[23]D\s+(sampler_\w+)\s*;/);
    if (sm && builtinSamplers.has(sm[1])) return '// (built-in) ' + line.trim();
    return line;
  }).join('\n');

  // Convert standalone "int" variable declarations to "float".
  // HLSL is lenient about int↔float mixing; GLSL ES 3.0 rejects it.
  // Convert ALL int declarations to float, including for-loop variables,
  // since MilkDrop presets freely mix loop vars with float expressions.
  s = s.replace(/^(\s*)int\b(?=\s+[a-zA-Z_])/gm, '$1float');
  // Also convert int inside for-loop headers: for (int i → for (float i
  s = s.replace(/(\bfor\s*\(\s*)int\b/g, '$1float');

  // Convert bare integer literals to float literals in arithmetic contexts.
  // HLSL allows float*2, GLSL ES 3.0 does not.
  s = s.split('\n').map(line => {
    // Skip shader_body, preprocessor, and loop declarations
    if (/^\s*(#|shader_body)/.test(line)) return line;
    // Replace bare integers after operators: op INT
    // NOT followed by: digit, dot (already float), array bracket, 'x'/'u' (hex/suffix)
    line = line.replace(
      /([*\/+\-=<>,(&|?:]\s*)(\d+)(?![\d.xyzwfu\]])/g,
      (match, prefix, num) => {
        if (prefix.trimEnd().endsWith('[')) return match; // array index
        return prefix + num + '.0';
      }
    );
    // Also convert integers after 'return' keyword and after '{' (block start)
    line = line.replace(
      /(\breturn\s+)(\d+)(?![\d.xyzwfu\[])/g,
      '$1$2.0'
    );
    // Convert integers at expression boundaries: after space/tab when in
    // arithmetic context (between operators or in function args)
    line = line.replace(
      /(\s)(\d+)(\s*[-+*\/><])(?![.\dxyzwfu])/g,
      '$1$2.0$3'
    );
    return line;
  }).join('\n');

  // vec4 uniforms used in vec2 arithmetic: add .xy swizzle
  // Common: rand_frame, rand_preset used with uv (vec2) operations
  const vec4Uniforms = ['rand_frame', 'rand_preset', 'roam_cos', 'roam_sin',
                        'slow_roam_cos', 'slow_roam_sin'];
  for (const name of vec4Uniforms) {
    // Add .xy when used in vec2 arithmetic (after * or + with vec2 context)
    // but not when already swizzled
    s = s.replace(
      new RegExp(`\\b${name}\\b(?!\\s*[.\\[])`, 'g'),
      `${name}.xy`
    );
  }

  // Fix HLSL→GLSL type mismatches
  s = fixGlslTypes(s);

  // ── Rename user variables that shadow GLSL built-in functions ──
  // HLSL allows `float3 mod;` but GLSL ES 3.0 treats `mod`, `cross`, `step`,
  // `dot`, `sign`, `normalize`, etc. as reserved function names.
  const glslBuiltins = ['mod', 'cross', 'step', 'dot', 'sign', 'normalize',
                        'reflect', 'length', 'distance', 'abs', 'min', 'max',
                        'exp', 'log', 'pow', 'sqrt', 'floor', 'ceil', 'fract',
                        'sample', 'input', 'output'];
  for (const name of glslBuiltins) {
    // Detect if the name is declared as a variable (type followed by name,
    // including comma-separated multi-variable declarations like "vec3 rsl, mod, ret0;")
    const declPat = new RegExp(
      `\\b(?:float|vec[234]|mat[234]|int|bool)\\b[^;]*\\b${name}\\b\\s*[,;=)]`
    );
    if (declPat.test(s)) {
      // Rename all occurrences as a variable (not as function calls)
      // Use word boundary to avoid partial matches
      s = s.replace(new RegExp(`\\b${name}\\b`, 'g'), `_${name}`);
      // But restore the GLSL built-in function when it's used as a function call
      // (i.e., followed by '(')
      s = s.replace(new RegExp(`\\b_${name}\\s*\\(`, 'g'), `${name}(`);
    }
  }

  // ── q-variable references in header (before shader_body) ──
  // Inside main(), butterchurn declares q1..q32 as local floats derived
  // from _qa.._qh uniforms.  Code in the user header (global scope)
  // cannot see those locals, so replace bare qN references in the header
  // with their _q uniform equivalents.
  {
    const sbIdx = s.indexOf('shader_body');
    if (sbIdx > 0) {
      let header = s.substring(0, sbIdx);
      const body = s.substring(sbIdx);
      const qMap = {};
      const qPacks = ['_qa','_qb','_qc','_qd','_qe','_qf','_qg','_qh'];
      const comps = ['x','y','z','w'];
      for (let i = 0; i < 32; i++) {
        qMap['q' + (i + 1)] = qPacks[Math.floor(i / 4)] + '.' + comps[i % 4];
      }
      header = header.replace(/\bq(\d{1,2})\b/g, (match, num) => {
        return qMap[match] || match;
      });
      s = header + body;
    }
  }

  // ── Move non-constant global initializers inside shader_body ──
  // GLSL ES 3.0 forbids global variables with non-constant initializers.
  // HLSL allows `static float3 CamPos = float3(q4,q5,q6);` at file scope;
  // after conversion this becomes `vec3 CamPos = vec3(_qa.w,_qb.x,_qb.y);`
  // which references uniforms — not compile-time constant.
  // Solution: split such declarations into a global declaration (no init)
  // and an assignment at the start of shader_body.
  {
    const sbIdx = s.indexOf('shader_body');
    if (sbIdx > 0) {
      let header = s.substring(0, sbIdx);
      const body = s.substring(sbIdx);
      const movedInits = [];
      const glTypes = /^(\s*)(float|vec[234]|mat[234]|int)\s+/;

      header = header.split('\n').map(line => {
        // Match: type varName = expr;  (possibly multi-var: type a=expr, b=expr;)
        // Only process if there's an '=' (initializer) and it references
        // uniforms or non-constant values.
        const dm = line.match(/^(\s*)(float|vec[234]|mat[234]|int)\s+(.+)/);
        if (!dm) return line;
        const [, indent, type, rest] = dm;
        // Skip function definitions
        if (/^\s*\w+\s*\(/.test(rest) && /\)\s*{/.test(rest)) return line;
        // Check if there's an initializer with non-constant values
        if (!rest.includes('=')) return line;
        // Check if initializer uses any non-constant expression.
        // In GLSL ES 3.0, global initializers must be compile-time constants:
        // only literals, type constructors with constant args, and const vars.
        // ANY identifier that isn't a type constructor → non-constant.
        const initPart = rest.substring(rest.indexOf('=') + 1);
        const hasNonConst =
          /\b(?!vec[234]\b|mat[234]\b|float\b|int\b|bool\b|uint\b|true\b|false\b)[a-zA-Z_]\w*/.test(initPart);
        if (!hasNonConst) return line;

        // Split multi-var declarations: float a=x, b=y;
        // Into separate declaration + initializers
        const vars = splitTopLevelCommas(rest.replace(/;\s*$/, ''));
        const declParts = [];
        for (const v of vars) {
          const eqIdx = v.indexOf('=');
          if (eqIdx >= 0) {
            const name = v.substring(0, eqIdx).trim();
            const init = v.substring(eqIdx + 1).trim();
            declParts.push(name);
            movedInits.push(`${name} = ${init};`);
          } else {
            declParts.push(v.trim());
          }
        }
        return `${indent}${type} ${declParts.join(', ')};`;
      }).join('\n');

      if (movedInits.length > 0) {
        // Insert moved initializers at the start of the shader body
        // shader_body\n{ → shader_body\n{ movedInits
        const bodyWithInits = body.replace(
          /(shader_body\s*\{)/,
          '$1\n' + movedInits.join('\n')
        );
        s = header + bodyWithInits;
      } else {
        s = header + body;
      }
    }
  }

  // ── Join continuation lines ──
  // Multi-line expressions (e.g., lum(texture(...).xyz\n  - texture(...).xyz))
  // break single-line regex patterns in the error fixer.  Join lines when:
  // 1. Previous line has unbalanced parens, OR
  // 2. Previous line doesn't end with ; or { or } and next starts with operator
  {
    const lines = s.split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
      const prev = lines[i - 1];
      const nextTrimmed = lines[i].trim();
      if (!nextTrimmed) continue;

      const opens = (prev.match(/\(/g) || []).length;
      const closes = (prev.match(/\)/g) || []).length;
      const prevTrimmed = prev.trimEnd();

      // Case 1: Unbalanced parens in previous line
      if (opens > closes) {
        const isControlFlow = /\b(?:for|if|while)\s*\(/.test(prev);
        if (/^\)\s*\{/.test(nextTrimmed) && !isControlFlow) continue;
        if (/^[-+*\/,.)&|?:]/.test(nextTrimmed)) {
          lines[i - 1] = prev + ' ' + nextTrimmed;
          lines.splice(i, 1);
          continue;
        }
      }

      // Case 2: Balanced parens but prev line doesn't end with statement terminator
      // and next line starts with an operator (binary continuation)
      if (opens === closes && prevTrimmed && !/[;{}]$/.test(prevTrimmed)) {
        if (/^[*\/+\-][\s(]/.test(nextTrimmed) || /^[*\/+\-];/.test(nextTrimmed)) {
          lines[i - 1] = prev + ' ' + nextTrimmed;
          lines.splice(i, 1);
        }
      }
    }
    s = lines.join('\n');
  }

  return s;
}

// ─── GLSL type fixup ──────────────────────────────────────────────────────
//
// HLSL is lenient with implicit scalar↔vector casts that GLSL ES 3.0
// rejects.  We track variable declarations and patch the most common
// patterns so shaders compile.
//
function fixGlslTypes(src) {
  // ── Pre-pass: split multi-statement lines ──
  // Lines like `ret1 = 0; anz = 4; n = 1;` must be split so that
  // single-statement regex fixes work correctly.
  const rawLines = src.split('\n');
  const splitLines = [];
  for (const line of rawLines) {
    // Only split inside shader_body (not in struct/function signatures)
    // Detect: line has 2+ semicolons (not inside parens/brackets/comments)
    let depth = 0, semiPositions = [], inComment = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      // Check for // comment start
      if (ch === '/' && j + 1 < line.length && line[j + 1] === '/') {
        inComment = true;
        break; // rest of line is comment
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ';' && depth === 0) semiPositions.push(j);
    }
    if (semiPositions.length > 1) {
      const indent = line.match(/^(\s*)/)[1];
      let prev = 0;
      for (const pos of semiPositions) {
        const stmt = line.substring(prev, pos + 1).trim();
        if (stmt && stmt !== ';') splitLines.push(indent + stmt);
        prev = pos + 1;
      }
      // Any trailing text after last semicolon
      const tail = line.substring(semiPositions[semiPositions.length - 1] + 1).trim();
      if (tail) splitLines.push(indent + tail);
    } else {
      splitLines.push(line);
    }
  }

  const lines = splitLines;
  // varName → type  ('vec2','vec3','vec4','float','mat2','mat3','mat4','int')
  const varTypes = new Map();
  const vecTypes = new Set(['vec2','vec3','vec4']);

  // Regex to detect a declaration: type name [= ...];
  // Handles:  vec3 foo;  vec3 foo = expr;  vec3 foo = expr, bar = expr;
  const declRe = /\b(vec[234]|float|mat[234]|int)\s+([a-zA-Z_]\w*)\s*[=;,]/g;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // ── Pass 1: Record all declarations on this line ──
    declRe.lastIndex = 0;
    let dm;
    while ((dm = declRe.exec(line)) !== null) {
      varTypes.set(dm[2], dm[1]);
    }

    // ── Fix A: vecN var = <bare scalar literal>;  ──
    // e.g.  vec3 mus = .1/(sqrt(uv6.y));  →  vec3 mus = vec3(.1/(sqrt(uv6.y)));
    // Detect: at declaration time the RHS is provably scalar
    {
      const m = line.match(
        /^(\s*)(vec[234])\s+([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/
      );
      if (m) {
        const [, indent, type, name, rhs, trail] = m;
        if (isScalarExpression(rhs, varTypes)) {
          lines[i] = `${indent}${type} ${name} = ${type}(${rhs});${trail || ''}`;
          continue;
        }
      }
    }

    // ── Fix B: vecN_var = <bare scalar literal>;  (re-assignment) ──
    // e.g.  noiseVal = .01;  →  noiseVal = vec3(.01);
    {
      const m = line.match(
        /^(\s*)([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/
      );
      if (m) {
        const [, indent, name, rhs, trail] = m;
        const type = varTypes.get(name);
        if (type && vecTypes.has(type) && isScalarExpression(rhs, varTypes)) {
          lines[i] = `${indent}${name} = ${type}(${rhs});${trail || ''}`;
          continue;
        }
      }
    }

    // NOTE: Fix C (float = vector expression → promote to vecN) was removed.
    // It used heuristic swizzle detection which caused false positives
    // (e.g., `float dy = (vec3_expr).y * 0.5` saw `.xyz` and promoted to vec3).
    // The error-driven fixer (Pattern A in fixGlslFromErrors) handles these
    // cases correctly using actual compiler type feedback.
  }

  return lines.join('\n');
}

/**
 * Heuristic: is this expression definitely scalar-valued?
 * Returns true for number literals, simple arithmetic on scalars, or
 * single-component swizzles.
 */
function isScalarExpression(expr, varTypes) {
  const s = expr.trim();
  // Bare number literal:  .01, -3.14, 42, 0.5, etc.
  if (/^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(s)) return true;
  // Expression containing NO vec constructors, no multi-component swizzles,
  // and no variable known to be vec.
  // If it has functions + math on scalars it's scalar.
  // Quick heuristic: if no vec/mat keyword, no multi-swizzle, and every
  // identified variable is float or unknown.
  if (/\bvec[234]\b|\bmat[234]\b/.test(s)) return false;
  // Multi-component swizzles indicate vector
  if (/\.[xyzw]{2,}|\.[rgba]{2,}|\.[stpq]{2,}/.test(s)) return false;
  // Check referenced variables — if any is vecN, result is probably vector
  // But single-component swizzles (e.g., uv6.y) produce scalars
  // First, collect all "name.singleSwizzle" → treat as scalar
  const singleSwizzled = new Set();
  const swRe = /\b([a-zA-Z_]\w*)\.([xyzwrgba])(?![xyzwrgba\w])/g;
  let swm;
  while ((swm = swRe.exec(s)) !== null) {
    singleSwizzled.add(swm[1]);
  }
  const refs = s.match(/\b[a-zA-Z_]\w*\b/g) || [];
  const builtinScalar = new Set([
    'sin','cos','tan','asin','acos','atan','pow','sqrt','abs','sign',
    'floor','ceil','fract','mod','min','max','clamp','mix','step',
    'smoothstep','length','distance','dot','log','log2','exp','exp2',
    'inversesqrt','radians','degrees','dFdx','dFdy','fwidth',
    'time','fps','frame','progress','decay','bass','mid','treb','vol',
    'bass_att','mid_att','treb_att','vol_att','rad','ang',
    'q1','q2','q3','q4','q5','q6','q7','q8','q9','q10','q11','q12',
    'q13','q14','q15','q16','q17','q18','q19','q20','q21','q22','q23',
    'q24','q25','q26','q27','q28','q29','q30','q31','q32',
  ]);
  for (const ref of refs) {
    if (builtinScalar.has(ref)) continue;
    if (singleSwizzled.has(ref)) continue; // e.g., uv6 in uv6.y → scalar
    const t = varTypes.get(ref);
    if (t && t !== 'float' && t !== 'int') return false;
  }
  return true;
}

/**
 * Detect the vector length of an expression from its swizzles.
 * Returns 2, 3, or 4 if multi-component swizzle found, else 0.
 *
 * Ignores swizzles inside scalar-returning functions (length, distance, dot)
 * so that e.g. `length(texsize.zw)` is correctly seen as scalar.
 */
function detectVectorLength(expr) {
  // Strip arguments of scalar-returning functions so their vector args
  // don't contribute false-positive swizzle hits.
  const stripped = stripScalarFunctionArgs(expr);
  const swizzleMatch = stripped.match(/\.([xyzw]+|[rgba]+|[stpq]+)\b/g);
  if (!swizzleMatch) return 0;
  let maxLen = 0;
  for (const sw of swizzleMatch) {
    const len = sw.length - 1; // minus the dot
    if (len > 1 && len > maxLen) maxLen = len;
  }
  return maxLen;
}

/**
 * Replace the parenthesised arguments of known scalar-returning builtins
 * with a placeholder so their internal swizzles are invisible to
 * detectVectorLength.
 */
function stripScalarFunctionArgs(expr) {
  const scalarFns = ['length', 'distance', 'dot'];
  let s = expr;
  for (const fn of scalarFns) {
    const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(s)) !== null) {
      let depth = 1;
      let pos = m.index + m[0].length;
      while (pos < s.length && depth > 0) {
        if (s[pos] === '(') depth++;
        else if (s[pos] === ')') depth--;
        pos++;
      }
      s = s.slice(0, m.index) + '_S_' + s.slice(pos);
      re.lastIndex = m.index + 3;
    }
  }
  return s;
}

// ─── glslangValidator-based GLSL validation ───────────────────────────────
//
// Build a complete GLSL ES 3.0 program matching Butterchurn's shader
// template, then validate with glslangValidator.  Parse errors and
// iteratively apply targeted type fixes.

const GLSLANG = (() => {
  try {
    execFileSync('glslangValidator', ['--version'], { stdio: 'pipe' });
    return 'glslangValidator';
  } catch {
    try {
      execFileSync('/opt/homebrew/bin/glslangValidator', ['--version'], { stdio: 'pipe' });
      return '/opt/homebrew/bin/glslangValidator';
    } catch { return null; }
  }
})();

/**
 * Butterchurn's built-in uniforms and declarations (shared by warp & comp).
 * User shader code can reference any of these without declaring them.
 */
const BUTTERCHURN_GLSL_HEADER = `#version 300 es
precision mediump float;
precision highp int;
precision mediump sampler2D;
precision mediump sampler3D;

vec3 lum(vec3 v){ return vec3(dot(v, vec3(0.32,0.49,0.29))); }
vec3 lum(vec2 v){ return vec3(dot(vec3(v,0.0), vec3(0.32,0.49,0.29))); }
float lum(float v){ return v; }

in vec2 _uv_in;
in vec2 uv_orig;
in vec4 vColor;
out vec4 fragColor;

uniform sampler2D sampler_main;
uniform sampler2D sampler_fw_main;
uniform sampler2D sampler_fc_main;
uniform sampler2D sampler_pw_main;
uniform sampler2D sampler_pc_main;
uniform sampler2D sampler_blur1;
uniform sampler2D sampler_blur2;
uniform sampler2D sampler_blur3;
uniform sampler2D sampler_noise_lq;
uniform sampler2D sampler_noise_lq_lite;
uniform sampler2D sampler_noise_mq;
uniform sampler2D sampler_noise_hq;
uniform sampler2D sampler_pw_noise_lq;
uniform sampler3D sampler_noisevol_lq;
uniform sampler3D sampler_noisevol_hq;

uniform float time;
uniform float decay;
uniform float gammaAdj;
uniform float echo_zoom;
uniform float echo_alpha;
uniform float echo_orientation;
uniform int invert;
uniform int brighten;
uniform int darken;
uniform int solarize;
uniform float fShader;
uniform float progress;
uniform vec2 resolution;
uniform vec4 aspect;
uniform vec4 texsize;
uniform vec4 texsize_noise_lq;
uniform vec4 texsize_noise_mq;
uniform vec4 texsize_noise_hq;
uniform vec4 texsize_noise_lq_lite;
uniform vec4 texsize_noisevol_lq;
uniform vec4 texsize_noisevol_hq;

uniform float bass;
uniform float mid;
uniform float treb;
uniform float vol;
uniform float bass_att;
uniform float mid_att;
uniform float treb_att;
uniform float vol_att;

uniform float frame;
uniform float fps;

uniform vec4 _qa;
uniform vec4 _qb;
uniform vec4 _qc;
uniform vec4 _qd;
uniform vec4 _qe;
uniform vec4 _qf;
uniform vec4 _qg;
uniform vec4 _qh;

// q1..q32 are declared as writable locals inside main() (see preamble)
// so presets can both read and write them.

uniform vec4 slow_roam_cos;
uniform vec4 roam_cos;
uniform vec4 slow_roam_sin;
uniform vec4 roam_sin;

uniform float blur1_min;
uniform float blur1_max;
uniform float blur2_min;
uniform float blur2_max;
uniform float blur3_min;
uniform float blur3_max;

uniform float scale1;
uniform float scale2;
uniform float scale3;
uniform float bias1;
uniform float bias2;
uniform float bias3;

uniform vec4 rand_frame;
uniform vec4 rand_preset;
uniform vec3 hue_shader;

float PI = 3.141592653589793;
float M_PI = 3.141592653589793;
float M_PI_2 = 1.5707963267948966;
float M_2PI = 6.283185307179586;
float M_INV_PI_2 = 0.15915494309189535;
`;

/** Number of lines in BUTTERCHURN_GLSL_HEADER (for error line offset) */
const HEADER_LINES = BUTTERCHURN_GLSL_HEADER.split('\n').length;

/**
 * Extract header (before shader_body) and body (inside { }) from a
 * butterchurn shader string, same logic as butterchurn's getShaderParts().
 */
function getShaderParts(shaderStr) {
  const sbIdx = shaderStr.indexOf('shader_body');
  if (sbIdx < 0) return ['', shaderStr];
  const header = shaderStr.substring(0, sbIdx);
  const after = shaderStr.substring(sbIdx);
  const open = after.indexOf('{');
  const close = after.lastIndexOf('}');
  if (open < 0 || close < 0) return [header, after];
  return [header, after.substring(open + 1, close)];
}

/**
 * Build a full GLSL ES 3.0 program for validation, matching butterchurn's
 * runtime shader template.  Returns { glsl, bodyLineOffset }.
 */
function buildValidationProgram(shaderStr) {
  const [userHeader, userBody] = getShaderParts(shaderStr);
  // bodyLineOffset = HEADER_LINES + userHeader lines + "void main…" + preamble lines
  const headerPart = userHeader ? userHeader + '\n' : '';
  const preamble = [
    'void main(void) {',
    '  vec2 uv = _uv_in;',
    '  vec3 ret;',
    '  float rad = length(uv_orig - 0.5);',
    '  float ang = atan(uv_orig.x - 0.5, uv_orig.y - 0.5);',
    '  float q1=_qa.x,q2=_qa.y,q3=_qa.z,q4=_qa.w;',
    '  float q5=_qb.x,q6=_qb.y,q7=_qb.z,q8=_qb.w;',
    '  float q9=_qc.x,q10=_qc.y,q11=_qc.z,q12=_qc.w;',
    '  float q13=_qd.x,q14=_qd.y,q15=_qd.z,q16=_qd.w;',
    '  float q17=_qe.x,q18=_qe.y,q19=_qe.z,q20=_qe.w;',
    '  float q21=_qf.x,q22=_qf.y,q23=_qf.z,q24=_qf.w;',
    '  float q25=_qg.x,q26=_qg.y,q27=_qg.z,q28=_qg.w;',
    '  float q29=_qh.x,q30=_qh.y,q31=_qh.z,q32=_qh.w;',
  ].join('\n');
  const epilogue = '  fragColor = vec4(ret, 1.0) * vColor;\n}';

  const glsl = BUTTERCHURN_GLSL_HEADER + headerPart + preamble + '\n'
             + userBody + '\n' + epilogue + '\n';

  // Line offset: how many lines come before the user body starts.
  // The trailing '\n' of the header merges with the next string's first line,
  // so subtract 1 from the header line count.
  const bodyLineOffset = (BUTTERCHURN_GLSL_HEADER.split('\n').length - 1)
                       + (headerPart ? headerPart.split('\n').length - 1 : 0)
                       + preamble.split('\n').length;

  return { glsl, bodyLineOffset };
}

/**
 * Validate a GLSL ES 3.0 fragment shader via glslangValidator.
 * Returns an array of { line, col, msg } objects for any errors,
 * where `line` is 1-based relative to the user body.
 * Returns null if glslangValidator is not available.
 */
function validateGlsl(shaderStr) {
  if (!GLSLANG) return null;

  const { glsl, bodyLineOffset } = buildValidationProgram(shaderStr);
  const tmpFile = path.join(os.tmpdir(), `milk-validate-${process.pid}.frag`);

  try {
    fs.writeFileSync(tmpFile, glsl);
    execFileSync(GLSLANG, [tmpFile], { stdio: 'pipe', timeout: 5000 });
    return []; // no errors
  } catch (e) {
    const output = (e.stdout || '').toString() + (e.stderr || '').toString();
    const errors = [];
    // Format: "ERROR: 0:LINE: 'TOKEN' : message"
    const errRe = /ERROR:\s*\d+:(\d+):\s*(?:'([^']*)'\s*:\s*)?(.+)/g;
    let m;
    while ((m = errRe.exec(output)) !== null) {
      const absLine = parseInt(m[1], 10);
      const userLine = absLine - bodyLineOffset;
      if (m[3].includes('compilation terminated')) continue;
      errors.push({ line: userLine, token: m[2] || '', msg: m[3].trim() });
    }
    return errors;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Fix GLSL type errors reported by glslangValidator.
 *
 * Parses error messages like:
 *   "cannot convert from 'temp mediump 3-component vector of float' to 'temp mediump float'"
 * and applies targeted fixes to the affected shader line.
 *
 * Returns { fixed: string, applied: number } with the patched body and fix count.
 */
function fixGlslFromErrors(shaderStr, errors) {
  if (!errors || errors.length === 0) return { fixed: shaderStr, applied: 0 };

  const [header, body] = getShaderParts(shaderStr);
  const bodyLines = body.split('\n');
  const headerLines = header ? header.split('\n') : [];
  // Number of lines in the validation preamble (void main, uv, ret, rad, ang, q1..q32)
  const PREAMBLE_LINES = 13;
  let applied = 0;

  for (const err of errors) {
    // Determine which array (header or body) and the index into it
    let lines, lineIdx;
    if (err.line <= 0 && header) {
      // Negative/zero line = header line.
      // userLine = headerIdx + 1 - headerLines.length - PREAMBLE_LINES
      // → headerIdx = userLine - 1 + headerLines.length + PREAMBLE_LINES
      lines = headerLines;
      lineIdx = err.line - 1 + headerLines.length + PREAMBLE_LINES;
    } else {
      lines = bodyLines;
      lineIdx = err.line - 1; // 0-based
    }
    if (lineIdx < 0 || lineIdx >= lines.length) continue;
    let line = lines[lineIdx];

    // ── Pattern A: vecN → float  ("X-component vector of float" to "float") ──
    // → change LHS from float to vecN, OR add .x to specific RHS subexpressions
    {
      const cm = err.msg.match(
        /cannot convert from '.*?(\d)-component vector of float' to '.*?float'/
      );
      if (cm) {
        const n = cm[1];
        // For both declarations and assignments: extract .x from the vec expression.
        // This preserves the float type the user declared, preventing cascading
        // dimension mismatches when the variable is used in vec2/vec3 constructors.
        const dm = line.match(/^(\s*)float\s+([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
        if (dm) {
          const [, indent, name, rhs, trail] = dm;
          lines[lineIdx] = `${indent}float ${name} = (${rhs}).x;${trail || ''}`;
          applied++;
          continue;
        }
        // Assignment to var (including swizzled targets like dz.y):
        const am = line.match(/^(\s*)([a-zA-Z_]\w*(?:\.[xyzwrgba]+)?)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
        if (am) {
          const [, indent, name, rhs, trail] = am;
          lines[lineIdx] = `${indent}${name} = (${rhs}).x;${trail || ''}`;
          applied++;
          continue;
        }
        // Compound assignment (+=, -=, *=): extract component
        // Also handles swizzled targets like z.x += vec_expr
        const cam = line.match(/^(\s*)([a-zA-Z_]\w*(?:\.[xyzwrgba]+)?)\s*([+\-*/])=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
        if (cam) {
          const [, indent, name, op, rhs, trail] = cam;
          lines[lineIdx] = `${indent}${name} ${op}= (${rhs}).x;${trail || ''}`;
          applied++;
          continue;
        }
        // Mid-line compound assignment: e.g., {tmp += texture(...).xyz/s; s*= 3.0;}
        // Avoid matching inside for-loop headers (n += 1.0 inside for(;;))
        {
          const midCamRe = new RegExp(
            '(\\b[a-zA-Z_]\\w*(?:\\.[xyzwrgba]+)?)\\s*([+\\-*/])=\\s*(.*?)\\s*;', 'g'
          );
          let midCam;
          while ((midCam = midCamRe.exec(line)) !== null) {
            const [fullMatch, name, op, rhs] = midCam;
            const idx = midCam.index;
            // Guard: skip if this match is inside parentheses (e.g., for(;;) header)
            const before = line.substring(0, idx);
            const opensBefore = (before.match(/\(/g) || []).length;
            const closesBefore = (before.match(/\)/g) || []).length;
            if (opensBefore <= closesBefore) {
              const newMatch = `${name} ${op}= (${rhs}).x;`;
              lines[lineIdx] = line.substring(0, idx) + newMatch + line.substring(idx + fullMatch.length);
              applied++;
              break;
            }
          }
          if (lines[lineIdx] !== line) continue;
        }
        // Mid-line plain assignment: e.g., {float z; z = 1.0/(vec3_expr);}
        {
          const midAmRe = new RegExp(
            '(\\b[a-zA-Z_]\\w*(?:\\.[xyzwrgba]+)?)\\s*=\\s*(.*?)\\s*;', 'g'
          );
          let midAm;
          while ((midAm = midAmRe.exec(line)) !== null) {
            const [fullMatch, name, rhs] = midAm;
            const idx = midAm.index;
            // Guard: skip matches inside parens or that look like ==
            const before = line.substring(0, idx);
            const opensBefore = (before.match(/\(/g) || []).length;
            const closesBefore = (before.match(/\)/g) || []).length;
            if (opensBefore > closesBefore) continue;
            // Skip if this is a compound assignment (already handled above)
            if (/[+\-*/]=/.test(fullMatch.substring(name.length))) continue;
            // Skip declarations (handled by Pattern A full-line)
            if (/\b(?:float|int|vec[234]|mat[234])\s+$/.test(before)) continue;
            const newMatch = `${name} = (${rhs}).x;`;
            lines[lineIdx] = line.substring(0, idx) + newMatch + line.substring(idx + fullMatch.length);
            applied++;
            break;
          }
          if (lines[lineIdx] !== line) continue;
        }
      }
    }

    // ── Pattern B: float → vecN  ("float" to "X-component vector of float") ──
    // → wrap scalar RHS in vecN() constructor
    {
      const cm = err.msg.match(
        /cannot convert from '.*?float' to '.*?(\d)-component vector of float'/
      );
      if (cm) {
        const vecN = 'vec' + cm[1];
        const targetN = parseInt(cm[1]);
        // Check if RHS ends with a scalar swizzle (.x/.y/.z/.w) that over-truncated
        // e.g., (texture(...).xy).x → remove .x to get vec2 back
        {
          const swizzleEndRe = /^(\s*)(.*?)\s*=\s*(.*)\.(x|y|z|w)\s*;(\s*(?:\/\/.*)?)?$/;
          const sm = line.match(swizzleEndRe);
          if (sm) {
            const [, indent, lhs, rhsBase, , trail] = sm;
            // Check if removing the scalar swizzle gives a vecN (look for .xy/.xyz/.xyzw before)
            const innerSwizzleRe = /\.(xy|xyz|xyzw)\s*\)\s*$/;
            const im = rhsBase.match(innerSwizzleRe);
            if (im && im[1].length === targetN) {
              // The inner swizzle produces the right dimension — remove the outer scalar selector
              lines[lineIdx] = `${indent}${lhs} = ${rhsBase};${trail || ''}`;
              applied++;
              continue;
            }
          }
        }
        // Re-assignment: name = expr;
        const am = line.match(/^(\s*)([a-zA-Z_]\w*(?:\.[xyzw]+)?)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
        if (am) {
          const [, indent, name, rhs, trail] = am;
          lines[lineIdx] = `${indent}${name} = ${vecN}(${rhs});${trail || ''}`;
          applied++;
          continue;
        }
        // Declaration: vecN name = expr;
        const dm = line.match(
          /^(\s*)(vec[234])\s+([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/
        );
        if (dm) {
          const [, indent, type, name, rhs, trail] = dm;
          lines[lineIdx] = `${indent}${type} ${name} = ${type}(${rhs});${trail || ''}`;
          applied++;
          continue;
        }
        // Mid-line declaration: vec2 name = scalar; (inside multi-statement lines)
        // e.g., "{vec2 tmp = 1.0; float s = 1.0;}"
        const midRe = new RegExp(
          '(vec' + cm[1] + '\\s+[a-zA-Z_]\\w*\\s*=\\s*)([-+]?\\d*\\.?\\d+(?:[eE][+-]?\\d+)?)(\\s*;)',
          'g'
        );
        const newLine = line.replace(midRe, '$1' + vecN + '($2)$3');
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
        // Mid-line assignment: name = expr; where name is known vecN variable
        // e.g., "vec2 zv; zv = 0.003*time;" — assignment part is not at start of line
        {
          const n = parseInt(cm[1]);
          // Collect known vecN variable names from declarations on this line AND earlier lines
          const vecNames = new Set();
          const vecDeclRe = new RegExp('\\bvec' + n + '\\s+([a-zA-Z_]\\w*(?:\\s*,\\s*[a-zA-Z_]\\w*)*)', 'g');
          // Search current line
          let dm2;
          while ((dm2 = vecDeclRe.exec(line)) !== null) {
            dm2[1].split(',').forEach(function(v) {
              const vn = v.trim();
              if (/^[a-zA-Z_]\w*$/.test(vn)) vecNames.add(vn);
            });
          }
          // Search earlier lines in same section for vecN declarations
          if (vecNames.size === 0) {
            for (let k = lineIdx - 1; k >= 0; k--) {
              vecDeclRe.lastIndex = 0;
              while ((dm2 = vecDeclRe.exec(lines[k])) !== null) {
                dm2[1].split(',').forEach(function(v) {
                  const vn = v.trim();
                  if (/^[a-zA-Z_]\w*$/.test(vn)) vecNames.add(vn);
                });
              }
              if (vecNames.size > 0) break;
            }
          }
          for (const vn of vecNames) {
            // Match assignment with ANY expression (not just literals): name = expr;
            const assignRe = new RegExp(
              '(\\b' + vn + '\\s*=\\s*)([^;]+)(\\s*;)'
            );
            const am = assignRe.exec(line);
            if (am) {
              const rhs = am[2].trim();
              // Only wrap if RHS is a scalar expression (not already a vecN constructor)
              if (!new RegExp('\\bvec' + n + '\\s*\\(').test(rhs)) {
                const newLine2 = line.replace(assignRe, '$1' + vecN + '($2)$3');
                lines[lineIdx] = newLine2;
                applied++;
                break;
              }
            }
          }
          if (lines[lineIdx] !== line) continue;
        }
      }
    }

    // ── Pattern C: float → int  ("const float" to "int") ──
    // Integer conversion over-converted .0 literals; revert
    {
      if (err.msg.includes("to ' temp highp int'") || err.msg.includes("to 'temp highp int'")) {
        // Revert N.0 back to N on int-typed lines
        lines[lineIdx] = line.replace(/(\d+)\.0(?!\d)/g, '$1');
        applied++;
        continue;
      }
    }

    // ── Pattern D: vecM op vecN dimension mismatch ("wrong operand types: no operation") ──
    // → add swizzle to the larger vector to match the smaller
    {
      const cm = err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?(\d)-component vector of float' and a right operand of type '.*?(\d)-component vector of float'/
      );
      if (cm) {
        const [, op, lhsN, rhsN] = cm;
        const lN = parseInt(lhsN), rN = parseInt(rhsN);
        const targetN = Math.min(lN, rN);
        const swizzle = ['.x','.xy','.xyz','.xyzw'][targetN - 1];
        const largerN = Math.max(lN, rN);
        const fromSwizzle = [null, '.x', '.xy', '.xyz', '.xyzw'][largerN];

        // Strategy: truncate the larger vector to match the smaller.
        // HLSL allows operations between mismatched sizes by implicit truncation.
        let fixed = false;

        // 1. Try known vec4 uniform names (add swizzle to bare references)
        if (!fixed) {
          const vec4Names = ['rand_frame', 'rand_preset', 'roam_cos', 'roam_sin',
            'slow_roam_cos', 'slow_roam_sin', 'aspect', '_qa', '_qb', '_qc', '_qd',
            '_qe', '_qf', '_qg', '_qh', 'texsize', 'texsize_noise_lq', 'texsize_noise_mq',
            'texsize_noise_hq', 'texsize_noise_lq_lite', 'texsize_noisevol_lq', 'texsize_noisevol_hq'];
          for (const name of vec4Names) {
            const re = new RegExp(`\\b${name}\\b(?!\\s*[.\\[])`, 'g');
            if (re.test(line)) {
              line = line.replace(re, name + swizzle);
              fixed = true;
              break;
            }
          }
        }

        // 2. Reduce oversize swizzles on texture() calls:
        //    texture(sampler, coord).xyz → .xy, texture(...).xyzw → .xyz, etc.
        //    Uses balanced paren matching to handle nested args like texture(s, vec2(...)).xyz
        //    Skip lines that feed texture results into lum() (which needs vec3/vec4)
        if (!fixed && fromSwizzle && !/\blum\s*\(/.test(line)) {
          const texStartRe = /\btexture\s*\(/g;
          let tm;
          let newLine = line;
          let offset = 0;
          while ((tm = texStartRe.exec(line)) !== null) {
            const parenStart = tm.index + tm[0].length;
            const parenEnd = findMatchingParen(line, parenStart);
            if (parenEnd < 0) continue;
            const afterClose = line.substring(parenEnd + 1);
            if (afterClose.startsWith(fromSwizzle)) {
              // Replace fromSwizzle with target swizzle
              const replaceStart = parenEnd + 1 + offset;
              const replaceEnd = replaceStart + fromSwizzle.length;
              newLine = newLine.substring(0, replaceStart) + swizzle + newLine.substring(replaceEnd);
              offset += swizzle.length - fromSwizzle.length;
              fixed = true;
            }
          }
          if (fixed) line = newLine;
        }
        // 3. Reduce oversize vec constructors: vec3(→vec2(, vec4(→vec3(, etc.
        //    Only when no texture() calls precede the vec constructor on the line
        //    (to avoid breaking texture-based expressions)
        if (!fixed) {
          const srcVec = 'vec' + largerN;
          const dstVec = 'vec' + targetN;
          const vecRe = new RegExp('\\b' + srcVec + '\\s*\\(', 'g');
          if (vecRe.test(line) && !/\btexture\s*\(/.test(line)) {
            line = line.replace(new RegExp('\\b' + srcVec + '\\s*\\(', 'g'), dstVec + '(');
            fixed = true;
          }
        }

        // 4. Reduce lum(...) → lum(...).xy etc. using balanced paren matching
        if (!fixed) {
          const lumRe = /\blum\s*\(/g;
          let lumM;
          while ((lumM = lumRe.exec(line)) !== null) {
            const parenStart = lumM.index + lumM[0].length;
            const parenEnd = findMatchingParen(line, parenStart);
            if (parenEnd >= 0) {
              const afterParen = line.substring(parenEnd + 1);
              if (!/^\s*\./.test(afterParen)) {
                line = line.substring(0, parenEnd + 1) + swizzle + line.substring(parenEnd + 1);
                lumRe.lastIndex = parenEnd + 1 + swizzle.length;
                fixed = true;
              }
            }
          }
        }

        // 5. Promote .xy → .xyz on known vec4 uniforms (when the smaller operand
        //    is a vec4 with .xy swizzle and we can match vec3 instead)
        if (!fixed && targetN === 2 && largerN === 3) {
          const vec4Uniforms = ['rand_frame', 'rand_preset', 'roam_cos', 'roam_sin',
            'slow_roam_cos', 'slow_roam_sin', '_qa', '_qb', '_qc', '_qd',
            '_qe', '_qf', '_qg', '_qh'];
          for (const name of vec4Uniforms) {
            const re = new RegExp('\\b' + name + '\\.xy\\b(?!z)', 'g');
            if (re.test(line)) {
              line = line.replace(
                new RegExp('\\b' + name + '\\.xy\\b(?!z)', 'g'),
                name + '.xyz'
              );
              fixed = true;
              break;
            }
          }
        }

        // 6. Add .xy to vec3 header-declared variables (truncate vec3→vec2)
        if (!fixed && targetN <= 2) {
          const vec3Names = new Set();
          // Join full header to handle multi-line declarations like:
          //   vec3 water, noise, ret1,
          //          sun, forest;
          const fullHeader = headerLines.join('\n');
          const declRe = /\bvec3\s+([\s\S]+?)\s*;/g;
          let dm;
          while ((dm = declRe.exec(fullHeader)) !== null) {
            // Skip function definitions (have '(' in them)
            if (dm[1].includes('(')) continue;
            dm[1].split(',').forEach(function(v) {
              const name = v.trim().replace(/\s*=[\s\S]*/, '').replace(/\n/g, '').trim();
              if (/^[a-zA-Z_]\w*$/.test(name)) vec3Names.add(name);
            });
          }
          for (const name of vec3Names) {
            if (new RegExp('\\bvec[234]\\s+' + name + '\\b').test(line)) continue;
            const re = new RegExp('\\b' + name + '\\b(?!\\s*[.\\[\\(])', 'g');
            if (re.test(line)) {
              line = line.replace(
                new RegExp('\\b' + name + '\\b(?!\\s*[.\\[\\(])', 'g'),
                name + swizzle
              );
              fixed = true;
              break;
            }
          }
        }

        // 7. Add .xy to vec3 body-local variables (truncate vec3→vec2)
        if (!fixed && targetN <= 2) {
          const bodyVec3Names = new Set();
          for (let j = 0; j <= lineIdx; j++) {
            const dm = lines[j].match(/\bvec3\s+(\w+)/g);
            if (dm) dm.forEach(function(s) {
              const n = s.replace(/^vec3\s+/, '');
              if (n !== 'ret') bodyVec3Names.add(n);
            });
          }
          for (const name of bodyVec3Names) {
            if (new RegExp('\\bvec[234]\\s+' + name + '\\b').test(line)) continue;
            const re = new RegExp('\\b' + name + '\\b(?!\\s*[.\\[\\(])', 'g');
            if (re.test(line)) {
              line = line.replace(
                new RegExp('\\b' + name + '\\b(?!\\s*[.\\[\\(])', 'g'),
                name + swizzle
              );
              fixed = true;
              break;
            }
          }
        }

        // 8. Truncate arbitrary swizzles of length largerN to targetN
        //    e.g., .yyy (vec3) → .yy (vec2), .xyzw (vec4) → .xyz (vec3)
        if (!fixed) {
          const swizzleChars = 'xyzwrgba';
          const swRe = /\.([xyzwrgba]+)\b/g;
          let sm;
          while ((sm = swRe.exec(line)) !== null) {
            if (sm[1].length === largerN) {
              // Truncate to targetN components
              const truncated = sm[1].substring(0, targetN);
              line = line.substring(0, sm.index + 1) + truncated + line.substring(sm.index + 1 + sm[1].length);
              fixed = true;
              break; // one fix per iteration to avoid offset drift
            }
          }
        }

        if (fixed) {
          lines[lineIdx] = line;
          applied++;
        }
        continue;
      }
    }

    // ── Pattern L: vecN comparison scalar ──
    // HLSL allows vec3 >= float (component-wise); GLSL comparison operators only
    // work on scalars.  Convert to step() which does component-wise threshold.
    // step(edge, x) returns 1.0 when x >= edge, 0.0 otherwise (same type as x).
    {
      const cm = err.msg.match(
        /no operation '(>=|>|<=|<)' exists that takes a left-hand operand of type '.*?(\d)-component vector of float' and a right operand of type '.*?float'/
      );
      if (cm) {
        const [, op, vecN] = cm;
        const opEsc = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let newLine = line;

        // 1. float(expr OP value) → step(value, expr)  [for >= / >]
        //    float(expr OP value) → step(expr, value)  [for <= / <]
        newLine = replaceFuncCall(newLine, 'float', function(inner) {
          // Find the comparison operator inside
          const compRe = new RegExp('(.+?)\\s*' + opEsc + '\\s*(.+)');
          const m = inner.match(compRe);
          if (m) {
            const lhs = m[1].trim(), rhs = m[2].trim();
            if (op === '>=' || op === '>') return 'step(' + rhs + ', ' + lhs + ')';
            return 'step(' + lhs + ', ' + rhs + ')';
          }
          return 'float(' + inner + ')';
        });

        // 2. Bare parenthesised comparison: (expr OP value) → step(...)
        if (newLine === line) {
          // Find parenthesised groups containing the comparison
          const re = new RegExp('\\(([^()]+?)\\s*' + opEsc + '\\s*([^()]+?)\\)', 'g');
          if (op === '>=' || op === '>') {
            newLine = newLine.replace(re, 'step($2, $1)');
          } else {
            newLine = newLine.replace(re, 'step($1, $2)');
          }
        }

        // 3. Inline comparison without wrapper (e.g., texture(...).xyz > 0.5)
        //    Match EXPR OP LITERAL where LITERAL is a number
        if (newLine === line) {
          const bareRe = new RegExp(
            '(\\b[a-zA-Z_]\\w*(?:\\s*\\([^)]*\\))?(?:\\.[xyzwrgba]+)?)\\s*' + opEsc + '\\s*([\\d.]+)',
            'g'
          );
          if (op === '>=' || op === '>') {
            newLine = newLine.replace(bareRe, 'step($2, $1)');
          } else {
            newLine = newLine.replace(bareRe, 'step($1, $2)');
          }
        }

        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern M: boolean expression expected ──
    // HLSL allows numeric values in boolean context (if, while, ternary).
    // GLSL requires explicit bool. Convert: if(x) → if(x != 0.0)
    {
      if (err.msg.includes('boolean expression expected')) {
        // Find if/while conditions with non-boolean expressions
        // Match: if (EXPR) or while (EXPR) where EXPR doesn't contain comparison ops
        const newLine = line.replace(
          /\b(if|while)\s*\(([^()]+)\)/g,
          function(match, keyword, expr) {
            const trimmed = expr.trim();
            // Already has a comparison → leave it alone
            if (/>=|<=|!=|==|(?<!=)>(?!=)|(?<!=)<(?!=)|&&|\|\|/.test(trimmed)) return match;
            return keyword + '(' + trimmed + ' != 0.0)';
          }
        );
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern E: redefinition in header (negative line = header area) ──
    // Already handled by stripping built-in samplers in hlslToGlsl, but
    // some non-sampler redefinitions may remain. Skip these gracefully.

    // ── Pattern F: float op int or int op float ──
    // HLSL allows implicit int↔float; GLSL ES 3.0 does not.
    {
      const intFloat = err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?float' and a right operand of type '.*?int'/
      ) || err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?int' and a right operand of type '.*?float'/
      );
      if (intFloat) {
        // Step 1: find int variable declarations referenced on this line
        // Use \bint\s+ to also match mid-line declarations like "{int n;"
        let foundInt = false;
        for (let j = 0; j < lines.length; j++) {
          const dm = lines[j].match(/\bint\s+([a-zA-Z_]\w*)/);
          if (dm && line.includes(dm[1])) {
            lines[j] = lines[j].replace(/\bint\b/, 'float');
            applied++;
            foundInt = true;
            break;
          }
        }
        // Step 2: wrap int() casts in float() on the error line
        if (!foundInt) {
          const newLine = replaceFuncCall(line, 'int', function(inner) {
            return 'float(int(' + inner + '))';
          });
          if (newLine !== line) {
            lines[lineIdx] = newLine;
            applied++;
            foundInt = true;
          }
        }
        // Step 3: convert float literals to int in comparison with int variable
        // e.g., n <= 2.0 → n <= 2 when n is int
        if (!foundInt) {
          const newLine = line.replace(/(\w+)\s*(<=|>=|<|>|==|!=)\s*(\d+)\.0\b/g, '$1 $2 $3');
          if (newLine !== line) {
            lines[lineIdx] = newLine;
            applied++;
            foundInt = true;
          }
        }
        if (foundInt) continue;
        // Fall through to later patterns if no fix was applied
      }

      // Also handle "cannot convert from int to float" (assignment context)
      if (err.msg.match(/cannot convert from '.*?int' to '.*?float'/)) {
        // Find the int variable declaration and change to float
        let foundInt = false;
        for (let j = 0; j < lines.length; j++) {
          const dm = lines[j].match(/\bint\s+([a-zA-Z_]\w*)/);
          if (dm && line.includes(dm[1])) {
            lines[j] = lines[j].replace(/\bint\b/, 'float');
            applied++;
            foundInt = true;
            break;
          }
        }
        // Fallback: wrap int() casts in float()
        if (!foundInt) {
          const newLine = replaceFuncCall(line, 'int', function(inner) {
            return 'float(int(' + inner + '))';
          });
          if (newLine !== line) {
            lines[lineIdx] = newLine;
            applied++;
            foundInt = true;
          }
        }
        if (foundInt) continue;
        // Fall through to Pattern J if no fix was applied
      }
    }

    // ── Pattern G: bool op float / bool op bool  (e.g., (x >= 0.5) * mask) ──
    // HLSL treats comparison results as numeric (0 or 1); GLSL has distinct bool.
    // Wrap parenthesised comparison in float() to cast bool → 0.0/1.0.
    {
      const boolFloat = err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?bool' and a right operand of type '.*?float'/
      ) || err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?float' and a right operand of type '.*?bool'/
      ) || err.msg.match(
        /no operation '([^']+)' exists that takes a left-hand operand of type '.*?bool' and a right operand of type '.*?bool'/
      );
      if (boolFloat) {
        // Find parenthesized comparisons and wrap with float()
        // Negative lookbehind prevents double-wrapping float(float(...))
        lines[lineIdx] = line.replace(
          /(?<!\w)\(([^()]*(?:>=|<=|!=|==|>(?!=)|<(?!=))[^()]*)\)/g,
          'float($1)'
        );
        applied++;
        continue;
      }

      // Also handle "cannot convert from bool to vecN/float" (assignment context)
      if (err.msg.match(/cannot convert from '.*?bool' to '.*?(?:float|vec)/)) {
        lines[lineIdx] = line.replace(
          /(?<!\w)\(([^()]*(?:>=|<=|!=|==|>(?!=)|<(?!=))[^()]*)\)/g,
          'float($1)'
        );
        applied++;
        continue;
      }
    }

    // ── Pattern H: vecM → vecN dimension conversion in assignments ──
    // Promotion (M < N): e.g., ret = vec2_expr where ret is vec3 → vec3(vec2_expr, 0.0)
    // Truncation (M > N): e.g., vec2 result = vec3_expr → (vec3_expr).xy
    {
      const vecMToN = err.msg.match(
        /cannot convert from '.*?(\d)-component vector of float' to '.*?(\d)-component vector of float'/
      );
      if (vecMToN) {
        const srcN = parseInt(vecMToN[1]), dstN = parseInt(vecMToN[2]);
        if (srcN < dstN) {
          const dstVec = 'vec' + dstN;
          const padding = dstN - srcN;
          const padArgs = Array(padding).fill('0.0').join(',');
          // Assignment: name = expr;  (single-line)
          const am = line.match(/^(\s*)([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
          if (am) {
            const [, indent, name, rhs, trail] = am;
            lines[lineIdx] = `${indent}${name} = ${dstVec}(${rhs}, ${padArgs});${trail || ''}`;
            applied++;
            continue;
          }
          // Compound assignment: name op= expr;  (single-line)
          const cam = line.match(/^(\s*)([a-zA-Z_]\w*)\s*([+\-*/])=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
          if (cam) {
            const [, indent, name, op, rhs, trail] = cam;
            lines[lineIdx] = `${indent}${name} ${op}= ${dstVec}(${rhs}, ${padArgs});${trail || ''}`;
            applied++;
            continue;
          }
          // Multi-line assignment: name = expr  (no semicolon on this line)
          const mam = line.match(/^(\s*)([a-zA-Z_]\w*)\s*=\s*(.*)$/);
          if (mam && !line.trimEnd().endsWith(';')) {
            // Join continuation lines until we find the semicolon
            let joinedRhs = mam[3];
            let endIdx = lineIdx;
            for (let k = lineIdx + 1; k < lines.length; k++) {
              joinedRhs += '\n' + lines[k];
              if (lines[k].includes(';')) { endIdx = k; break; }
            }
            // Find the semicolon position
            const semiPos = joinedRhs.lastIndexOf(';');
            if (semiPos >= 0) {
              const rhs = joinedRhs.substring(0, semiPos).trim();
              const after = joinedRhs.substring(semiPos + 1);
              const wrapped = `${mam[1]}${mam[2]} = ${dstVec}(${rhs}, ${padArgs});${after}`;
              // Write back as the original line count
              const wrappedLines = wrapped.split('\n');
              for (let k = lineIdx; k <= endIdx; k++) {
                lines[k] = wrappedLines[k - lineIdx] || '';
              }
              applied++;
              continue;
            }
          }
        }
        if (srcN > dstN) {
          const swizzle = ['.x','.xy','.xyz'][dstN - 1];
          // Declaration: vecN name = expr;
          const dm = line.match(
            /^(\s*)(vec[234])\s+([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/
          );
          if (dm) {
            const [, indent, type, name, rhs, trail] = dm;
            lines[lineIdx] = `${indent}${type} ${name} = (${rhs})${swizzle};${trail || ''}`;
            applied++;
            continue;
          }
          // Assignment: name = expr;
          const am = line.match(/^(\s*)([a-zA-Z_]\w*)\s*=\s*(.*?)\s*;(\s*(?:\/\/.*)?)?$/);
          if (am) {
            const [, indent, name, rhs, trail] = am;
            lines[lineIdx] = `${indent}${name} = (${rhs})${swizzle};${trail || ''}`;
            applied++;
            continue;
          }
          // Mid-line: find vecDst name = expr; patterns
          const midRe = new RegExp(
            '(vec' + dstN + '\\s+[a-zA-Z_]\\w*\\s*=\\s*)(' +
            '[^;]+?)(\\s*;)', 'g'
          );
          const newLine = line.replace(midRe, function(m, pre, rhs, semi) {
            // Only add swizzle if RHS doesn't already have one matching dstN
            if (new RegExp('\\.' + 'xyzw'.substring(0, dstN) + '\\s*$').test(rhs.trim())) return m;
            return pre + '(' + rhs.trim() + ')' + swizzle + semi;
          });
          if (newLine !== line) {
            lines[lineIdx] = newLine;
            applied++;
            continue;
          }
          // Fallback: reduce oversize swizzles on the line
          // e.g., texture(...).xyz → .xy when we need vec2
          const fromSwizzle = [null, '.x', '.xy', '.xyz', '.xyzw'][srcN];
          if (fromSwizzle) {
            const swzRe = new RegExp(
              fromSwizzle.replace('.', '\\.') + '\\b', 'g'
            );
            if (swzRe.test(line)) {
              const newLine2 = line.replace(swzRe, swizzle);
              if (newLine2 !== line) {
                lines[lineIdx] = newLine2;
                applied++;
                continue;
              }
            }
          }
        }
      }
    }

    // ── Pattern I: no matching overloaded function (mixed vec/float args) ──
    // e.g., pow(vec3, float) → pow(vec3, vec3(float))
    // or   clamp(vec3, float, float) → clamp(vec3, vec3(float), vec3(float))
    // or   texture(sampler, scalar) → texture(sampler, vec2(scalar))
    {
      if (err.msg.includes('no matching overloaded function found')) {
        let newLine = line;

        // Helper: detect vec size of an expression (2, 3, 4, or 0 for scalar/unknown)
        // Returns the MAXIMUM dimension found across all indicators (constructors,
        // swizzles), since operations like vec3 * float stay vec3.
        function argVecSize(expr) {
          const t = expr.trim();
          let maxDim = 0;
          // Trailing swizzle takes highest priority (outermost operation)
          const sw = t.match(/\.([xyzw]{2,4}|[rgba]{2,4}|[stpq]{2,4})\s*$/);
          if (sw) return sw[1].length;
          // Collect all vec constructors
          const vecRe = /\bvec([234])\s*\(/g;
          let m;
          while ((m = vecRe.exec(t)) !== null) {
            maxDim = Math.max(maxDim, parseInt(m[1]));
          }
          // Collect all multi-component swizzles
          const swRe = /\.([xyzw]{2,4}|[rgba]{2,4}|[stpq]{2,4})(?!\w)/g;
          while ((m = swRe.exec(t)) !== null) {
            maxDim = Math.max(maxDim, m[1].length);
          }
          return maxDim;
        }

        // Helper: is this expression likely scalar?
        function isLikelyScalar(expr) {
          const t = expr.trim();
          // Bare numeric literal
          if (/^[-+]?\d*\.?\d+([eE][+-]?\d+)?$/.test(t)) return true;
          // No vec constructors or multi-component swizzles
          if (/\bvec[234]\b/.test(t)) return false;
          if (/\.([xyzw]{2,}|[rgba]{2,}|[stpq]{2,})\b/.test(t)) return false;
          // Single-component swizzle or simple expression → scalar
          return true;
        }

        // Fix texture(sampler, coord) — wrap scalar coords in vec2(), truncate vec3+ to .xy
        newLine = replaceFuncCall(newLine, 'texture', function(inner) {
          const args = splitTopLevelCommas(inner);
          if (args.length >= 2 && /sampler/.test(args[0])) {
            const coord = args[1].trim();
            const coordVecSize = argVecSize(coord);

            // vec3+ coord → truncate to .xy
            if (coordVecSize >= 3) {
              args[1] = ' (' + coord + ').xy';
              return 'texture(' + args.join(',') + ')';
            }

            // Scalar coord → wrap in vec2()
            const isScalarCoord =
              !/\bvec[234]/.test(coord) &&
              !/\.([xyzw]{2,}|[rgba]{2,})\b/.test(coord) &&
              !/\btexture\s*\(/.test(coord) &&
              isLikelyScalar(coord);
            if (isScalarCoord) {
              args[1] = ' vec2(' + coord + ')';
              return 'texture(' + args.join(',') + ')';
            }
          }
          return 'texture(' + inner + ')';
        });

        // Fix mod(int, float) → mod(float, float): GLSL mod requires float args
        newLine = replaceFuncCall(newLine, 'mod', function(inner) {
          const args = splitTopLevelCommas(inner);
          if (args.length === 2) {
            const newArgs = args.map(function(a) {
              const t = a.trim();
              // Wrap int() casts in float(): int(x) → float(int(x)) for mod()
              if (/^\s*int\s*\(/.test(t)) return ' float(' + t + ')';
              // Wrap floor() in float() if needed: floor returns genType so usually ok
              return a;
            });
            const candidate = 'mod(' + newArgs.join(',') + ')';
            if (candidate !== 'mod(' + inner + ')') return candidate;
          }
          return 'mod(' + inner + ')';
        });

        // Fix pow, mix, min, max, clamp, step, smoothstep, dot
        for (const fn of ['pow', 'min', 'max', 'clamp', 'step', 'smoothstep', 'mix', 'dot']) {
          newLine = replaceFuncCall(newLine, fn, function(inner) {
            const args = splitTopLevelCommas(inner);

            // Determine the vec size from any argument
            let vecSize = 0;
            for (const a of args) {
              const sz = argVecSize(a);
              if (sz > vecSize) vecSize = sz;
            }

            // Also infer vec from known vec patterns without explicit constructor
            if (vecSize === 0) {
              for (const a of args) {
                const t = a.trim();
                if (/\.xyz\b|scale[123]|bias[123]|\btexture\b|\blum\b/.test(t)) {
                  vecSize = 3;
                  break;
                }
                if (/\.xy\b/.test(t)) { vecSize = 2; break; }
              }
            }

            if (vecSize === 0) {
              // Last resort for binary functions like pow(A, B):
              // This error only fires when there's a type mismatch, so one arg
              // must be vec and the other scalar. Heuristic: the arg with fewer
              // identifier tokens (more literal-heavy) is the scalar one.
              // Default to vec3 (most common in MilkDrop presets).
              vecSize = 3;
            }

            // For each arg, determine a "scalar score" — higher means more likely scalar
            function scalarScore(expr) {
              const t = expr.trim();
              // Bare numeric literal → definitely scalar
              if (/^[-+]?\s*\d*\.?\d+([eE][+-]?\d+)?$/.test(t)) return 10;
              // Expression with explicit vec constructor → definitely not scalar
              if (/\bvec[234]\s*\(/.test(t)) return -10;
              // Multi-component swizzle → vec
              if (/\.([xyzw]{2,}|[rgba]{2,})\b/.test(t)) return -5;
              // texture() call → vec3 (from .xyz)
              if (/\btexture\s*\(/.test(t)) return -5;
              // Expression containing a literal number → possibly scalar
              if (/\d+\.?\d*/.test(t)) return 3;
              // Single-component swizzle → scalar
              if (/\.[xyzwrgba](?![xyzwrgba\w])/.test(t)) return 5;
              // Just an identifier → ambiguous, slightly lean toward vec (since
              // the error says types don't match)
              return 0;
            }

            // Find the arg with highest scalar score and wrap it
            if (args.length >= 2) {
              const scores = args.map(a => scalarScore(a));
              const maxScore = Math.max(...scores);
              const minScore = Math.min(...scores);

              // Only wrap if there's a meaningful difference between args
              if (maxScore !== minScore || maxScore > 0) {
                const vecType = 'vec' + vecSize;
                const threshold = Math.min(maxScore, 3); // wrap args at or above this score
                const newArgs = args.map(function(a, idx) {
                  if (scores[idx] >= threshold && scores[idx] > -5) {
                    return ' ' + vecType + '(' + a.trim() + ')';
                  }
                  return a;
                }).join(',');
                const candidate = fn + '(' + newArgs + ')';
                if (candidate !== fn + '(' + inner + ')') return candidate;
              }

              // Promote mismatched vec dimensions: e.g., pow(vec3, vec2) → pow(vec3, vec3(...))
              {
                const sizes = args.map(a => argVecSize(a));
                const nonZeroSizes = sizes.filter(s => s > 0);
                if (nonZeroSizes.length >= 2) {
                  const maxSz = Math.max(...nonZeroSizes);
                  const minSz = Math.min(...nonZeroSizes);
                  if (maxSz !== minSz) {
                    const targetVec = 'vec' + maxSz;
                    const newArgs = args.map(function(a, idx) {
                      const sz = sizes[idx];
                      if (sz > 0 && sz < maxSz) {
                        const trimmed = a.trim();
                        // Check if this is a scalar-broadcast vec: vec2(scalar) → vec3(scalar)
                        const scalarBroadcast = trimmed.match(/^vec[234]\s*\(\s*([^,()]+)\s*\)$/);
                        if (scalarBroadcast) {
                          return ' ' + targetVec + '(' + scalarBroadcast[1].trim() + ')';
                        }
                        // General case: pad with 0.0
                        const padding = Array(maxSz - sz).fill('0.0').join(', ');
                        return ' ' + targetVec + '(' + trimmed + ', ' + padding + ')';
                      }
                      return a;
                    }).join(',');
                    return fn + '(' + newArgs + ')';
                  }
                }
              }
            }

            // Special case: dot(vec3, vec2) → truncate the longer
            if (fn === 'dot' && args.length === 2) {
              const s1 = argVecSize(args[0]), s2 = argVecSize(args[1]);
              if (s1 > 0 && s2 > 0 && s1 !== s2) {
                const minSize = Math.min(s1, s2);
                const swizzle = minSize === 2 ? '.xy' : '.xyz';
                const newArgs = args.map(function(a) {
                  if (argVecSize(a) > minSize) return a.trim() + swizzle;
                  return a;
                }).join(', ');
                return fn + '(' + newArgs + ')';
              }
            }

            return fn + '(' + inner + ')';
          });
        }

        // Fix user-defined function calls with mismatched arg types.
        // Parse function signatures from the header and promote/demote args.
        if (newLine === line && headerLines.length > 0) {
          // Build a map of user-defined function signatures from header
          const funcSigs = {};
          const headerText = headerLines.join('\n');
          const sigRe = /\b(float|vec[234]|int|bool|void)\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/g;
          let sigM;
          while ((sigM = sigRe.exec(headerText)) !== null) {
            const retType = sigM[1];
            const fname = sigM[2];
            const paramStr = sigM[3].trim();
            if (!paramStr || paramStr === 'void') {
              funcSigs[fname] = { retType, params: [] };
            } else {
              const params = paramStr.split(',').map(function(p) {
                const parts = p.trim().split(/\s+/);
                return { type: parts[0], name: parts.length > 1 ? parts[1] : '' };
              });
              funcSigs[fname] = { retType, params };
            }
          }

          // Find ALL function calls on the error line and check against signatures
          const callRe = /\b([a-zA-Z_]\w*)\s*\(/g;
          let callM;
          while ((callM = callRe.exec(newLine)) !== null) {
            const funcName = callM[1];
            const sig = funcSigs[funcName];
            if (!sig || sig.params.length === 0) continue;

            // Skip function DEFINITIONS (preceded by a return type)
            const beforeCall = newLine.substring(Math.max(0, callM.index - 20), callM.index);
            if (/\b(?:float|vec[234]|int|bool|void|mat[234])\s*$/.test(beforeCall)) continue;

            // Use replaceFuncCall to get at the args
            const before = newLine;
            newLine = replaceFuncCall(newLine, funcName, function(inner) {
              const args = splitTopLevelCommas(inner);
              if (args.length !== sig.params.length) return funcName + '(' + inner + ')';

              let changed = false;
              const newArgs = args.map(function(a, idx) {
                const paramType = sig.params[idx].type;
                const argTrimmed = a.trim();

                // Get arg's apparent vec size
                const argSz = argVecSize(a);
                const paramSz = paramType === 'float' ? 1
                              : paramType === 'int' ? 1
                              : paramType.match(/vec([234])/) ? parseInt(paramType.match(/vec([234])/)[1])
                              : 0;

                if (paramSz === 0) return a; // unknown param type

                // Arg is scalar but param wants vec → wrap in vecN()
                if (paramSz > 1 && (argSz === 0 || argSz === 1)) {
                  changed = true;
                  return ' vec' + paramSz + '(' + argTrimmed + ')';
                }

                // Arg is vec but param wants scalar → add .x
                if (paramSz === 1 && argSz > 1) {
                  changed = true;
                  return ' (' + argTrimmed + ').x';
                }

                // Arg is ambiguous (argSz===0) but param wants scalar →
                // the error says overloaded, so the arg must be wrong type. Add .x.
                if (paramSz === 1 && argSz === 0) {
                  changed = true;
                  return ' (' + argTrimmed + ').x';
                }

                // Arg is vec of wrong size → truncate or promote
                if (paramSz > 1 && argSz > 1 && paramSz !== argSz) {
                  changed = true;
                  if (argSz > paramSz) {
                    // Truncate: vec3→vec2 via swizzle
                    const sw = paramSz === 2 ? '.xy' : '.xyz';
                    return ' (' + argTrimmed + ')' + sw;
                  } else {
                    // Promote: vec2→vec3
                    const scalarBroadcast = argTrimmed.match(/^vec[234]\s*\(\s*([^,()]+)\s*\)$/);
                    if (scalarBroadcast) {
                      return ' vec' + paramSz + '(' + scalarBroadcast[1].trim() + ')';
                    }
                    const padding = Array(paramSz - argSz).fill('0.0').join(', ');
                    return ' vec' + paramSz + '(' + argTrimmed + ', ' + padding + ')';
                  }
                }

                return a;
              });

              if (changed) return funcName + '(' + newArgs.join(',') + ')';
              return funcName + '(' + inner + ')';
            });
            if (newLine !== before) break; // Only fix one function call per pass
          }
        }

        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern N: scalar integer expression required ──
    // Float expressions used as array indices need int() wrapping.
    // e.g., arr[mod(x, 4.0)] → arr[int(mod(x, 4.0))]
    //        arr[kolb_no] → arr[int(kolb_no)]  (when kolb_no is float)
    {
      if (err.msg.includes('scalar integer expression required')) {
        let newLine = line;
        // Find all array subscript brackets and wrap float expressions in int()
        const bracketRe = /\[([^\[\]]+)\]/g;
        newLine = newLine.replace(bracketRe, function(m, inner) {
          const t = inner.trim();
          // Skip if already an int expression
          if (/^\s*int\s*\(/.test(t)) return m;
          // Skip if it's a plain integer literal
          if (/^\s*\d+\s*$/.test(t)) return m;
          // Wrap everything else — the error tells us it needs int()
          return '[int(' + t + ')]';
        });
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern O: "not enough data provided for construction" ──
    // Happens when vec3(vec2_expr) or similar — HLSL allows implicit padding, GLSL doesn't.
    // Strategy: find vecN constructors on the error line, check if inner content
    // is a lower-dimension expression, and add padding (0.0 components).
    {
      if (err.msg.includes('not enough data provided for construction')) {
        let newLine = line;
        let patOFixed = false;

        // Find all vec3( or vec4( constructors and check their contents
        const vecRe = /\b(vec[34])\s*\(/g;
        let vm;
        while ((vm = vecRe.exec(line)) !== null) {
          const vecType = vm[1];
          const targetDim = parseInt(vecType[3]); // 3 or 4
          const parenStart = vm.index + vm[0].length;
          const parenEnd = findMatchingParen(line, parenStart);
          if (parenEnd < 0) continue;
          const inner = line.substring(parenStart, parenEnd).trim();

          // Count commas at paren depth 0 to determine argument count
          let commas = 0;
          let depth = 0;
          for (let ci = 0; ci < inner.length; ci++) {
            if (inner[ci] === '(' || inner[ci] === '[') depth++;
            else if (inner[ci] === ')' || inner[ci] === ']') depth--;
            else if (inner[ci] === ',' && depth === 0) commas++;
          }

          // If there's already the right number of comma-separated args, skip
          if (commas >= targetDim - 1) continue;

          // Check if inner expression looks like it produces fewer components
          // (has .xy swizzle, or vec2() constructor, or texture().xy etc.)
          const hasVec2Indicator = /\.xy\b|\.rg\b|\bvec2\s*\(/.test(inner);
          const hasVec3Indicator = /\.xyz\b|\.rgb\b|\bvec3\s*\(/.test(inner);
          const hasSingleArg = commas === 0;

          let needPad = false;
          let padCount = 0;

          if (targetDim === 3 && hasSingleArg) {
            if (hasVec2Indicator && !hasVec3Indicator) {
              needPad = true;
              padCount = 1; // vec3(vec2_expr) → vec3(vec2_expr, 0.0)
            }
          } else if (targetDim === 4 && hasSingleArg) {
            if (hasVec2Indicator && !hasVec3Indicator) {
              needPad = true;
              padCount = 2; // vec4(vec2_expr) → vec4(vec2_expr, 0.0, 0.0)
            } else if (hasVec3Indicator) {
              needPad = true;
              padCount = 1; // vec4(vec3_expr) → vec4(vec3_expr, 0.0)
            }
          } else if (targetDim === 3 && commas === 1) {
            // vec3(float, float) → vec3(float, float, 0.0)
            needPad = true;
            padCount = 1;
          }

          if (needPad) {
            const pad = Array(padCount).fill(', 0.0').join('');
            // Insert padding before the closing paren
            const insertPos = parenEnd + (newLine.length - line.length);
            newLine = newLine.substring(0, insertPos) + pad + newLine.substring(insertPos);
            patOFixed = true;
            break; // Fix one at a time, re-validate will catch others
          }
        }

        // Fallback: if no vec3/vec4 constructor was padded, try downgrading
        // vec3→vec2 constructors when they're nested inside vec2() context.
        // e.g., vec2(pow( vec3(x), vec3(2.0))) → vec2(pow( vec2(x), vec2(2.0)))
        if (!patOFixed) {
          const downgradeRe = /\bvec3\s*\(/g;
          let newLine2 = line;
          let dm;
          while ((dm = downgradeRe.exec(line)) !== null) {
            const pStart = dm.index + dm[0].length;
            const pEnd = findMatchingParen(line, pStart);
            if (pEnd < 0) continue;
            const inner = line.substring(pStart, pEnd).trim();
            // Only downgrade single-arg vec3 where the arg doesn't have vec3 indicators
            const commas2 = (inner.match(/,/g) || []).length;
            if (commas2 === 0 && !/\.xyz\b|\.rgb\b|\bvec3\s*\(/.test(inner)) {
              // Replace this vec3( with vec2(
              const replaceStart = dm.index + (newLine2.length - line.length);
              newLine2 = newLine2.substring(0, replaceStart) + 'vec2(' + newLine2.substring(replaceStart + dm[0].length);
              patOFixed = true;
            }
          }
          if (patOFixed) {
            newLine = newLine2;
          }
        }

        if (patOFixed) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern J: const int in arithmetic with float/vec ──
    // Convert remaining bare integers on the error line to float literals.
    // Negative lookahead protects: hex (x), swizzles (y,z,w), float/unsigned suffix (f,u),
    // array indices (]) and multi-digit numbers (digit, dot).
    // Does NOT exclude ;,) since int→float conversion is needed there too.
    {
      if (err.msg.includes("' const int'") || err.msg.includes("' temp highp int'")
          || err.msg.includes("' temp mediump int'")) {
        const newLine = line.replace(/\b(\d+)\b(?![\d.xyzwfu\]])/g, '$1.0');
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern P: float→int conversion ("cannot convert from ... float to ... int") ──
    // HLSL allows implicit float→int; GLSL needs explicit ivec/int cast.
    // e.g., ivec2 k1 = mod(...) → ivec2 k1 = ivec2(mod(...))
    {
      const cm = err.msg.match(/cannot convert from '.*?(\d)-component vector of float' to '.*?(\d)-component vector of int'/);
      const cm2 = err.msg.match(/cannot convert from '.*float' to '.*int'/);
      if (cm || cm2) {
        // Find assignment: ivecN var = expr  or  var = expr
        const assignRe = /\b(ivec[234]|int)\s+(\w+)\s*=\s*/;
        const am = line.match(assignRe);
        if (am) {
          const castType = am[1]; // ivec2, ivec3, ivec4, or int
          const afterAssign = line.substring(am.index + am[0].length);
          // Find the expression end (semicolon at depth 0)
          let depth = 0;
          let exprEnd = afterAssign.length;
          for (let ci = 0; ci < afterAssign.length; ci++) {
            if (afterAssign[ci] === '(' || afterAssign[ci] === '[') depth++;
            else if (afterAssign[ci] === ')' || afterAssign[ci] === ']') depth--;
            else if (afterAssign[ci] === ';' && depth === 0) { exprEnd = ci; break; }
          }
          const expr = afterAssign.substring(0, exprEnd).trim();
          // Skip if already wrapped in the cast type
          if (!new RegExp('^' + castType + '\\s*\\(').test(expr)) {
            const newExpr = castType + '(' + expr + ')';
            const insertStart = am.index + am[0].length;
            const insertEnd = insertStart + exprEnd;
            const newLine = line.substring(0, insertStart) + newExpr + line.substring(insertEnd);
            lines[lineIdx] = newLine;
            applied++;
            continue;
          }
        }
      }
    }

    // ── Pattern K: return value → function return type mismatch ──
    // HLSL silently truncates/promotes return values. GLSL does not.
    // Find the enclosing function's return type and adjust the return expression.
    // Handles both single-line and multi-line return statements.
    {
      if (err.msg.includes('cannot convert return value to function return type')) {
        // Find the start of the return statement (may be on current line or above for multi-line)
        let retStartIdx = lineIdx;
        if (/\breturn\b/.test(line)) {
          retStartIdx = lineIdx;
        } else {
          // Scan backwards to find the return keyword
          for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 15); j--) {
            if (/\breturn\b/.test(lines[j])) { retStartIdx = j; break; }
          }
        }

        // Find the end of the return statement (line with ;)
        let retEndIdx = lineIdx;
        if (!/;\s*/.test(lines[retEndIdx])) {
          for (let j = lineIdx + 1; j < Math.min(lines.length, lineIdx + 15); j++) {
            if (/;\s*/.test(lines[j])) { retEndIdx = j; break; }
          }
        }

        // Find enclosing function return type (scan backwards from return start)
        let funcRetType = null;
        for (let j = retStartIdx; j >= Math.max(0, retStartIdx - 20); j--) {
          const fm = lines[j].match(/^\s*(float|vec[234]|int|mat[234])\s+\w+\s*\(/);
          if (fm) { funcRetType = fm[1]; break; }
        }

        if (funcRetType) {
          // Check if the return is a single-line statement on the error line
          const singleLineRm = line.match(/(\breturn\s+)(.*?)\s*;/);

          if (singleLineRm) {
            // Single-line return: apply targeted fix
            const retKeyword = singleLineRm[1];
            const rhs = singleLineRm[2];

            if (funcRetType === 'float') {
              lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, '$1($2).x;');
              applied++; continue;
            }
            if (funcRetType === 'vec2') {
              let newRhs = rhs.replace(/\.xyz\b/g, '.xy').replace(/\bvec3\s*\(/g, 'vec2(');
              if (newRhs !== rhs) {
                lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, `${retKeyword}${newRhs};`);
              } else {
                lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, '$1($2).xy;');
              }
              applied++; continue;
            }
            if (funcRetType === 'vec3') {
              let newRhs = rhs.replace(/\.xy\b/g, '.xyz').replace(/\bvec2\s*\(/g, 'vec3(');
              if (newRhs !== rhs) {
                lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, `${retKeyword}${newRhs};`);
              } else {
                lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, '$1vec3($2);');
              }
              applied++; continue;
            }
            if (funcRetType === 'vec4') {
              lines[lineIdx] = line.replace(/(\breturn\s+)(.*?)\s*;/, '$1vec4($2);');
              applied++; continue;
            }
          } else {
            // Multi-line return: apply dimension conversion to ALL lines of the return
            let anyChanged = false;
            for (let j = retStartIdx; j <= retEndIdx; j++) {
              const origLine = lines[j];
              if (funcRetType === 'float') {
                // For float: add .x to the final expression (last line with ;)
                if (j === retEndIdx) {
                  lines[j] = lines[j].replace(/(.*?)\s*;\s*/, '($1).x; ');
                }
              } else if (funcRetType === 'vec2') {
                lines[j] = lines[j].replace(/\.xyz\b/g, '.xy').replace(/\bvec3\s*\(/g, 'vec2(');
              } else if (funcRetType === 'vec3') {
                lines[j] = lines[j].replace(/\.xy\b(?!z)/g, '.xyz').replace(/\bvec2\s*\(/g, 'vec3(');
              }
              if (lines[j] !== origLine) anyChanged = true;
            }
            if (anyChanged) { applied++; continue; }
          }
        }
      }
    }

    // ── Pattern Q: function does not return a value ──
    // Empty functions or functions with missing return statements.
    // Find the function definition and add a default return.
    {
      const qm = err.msg.match(/function does not return a value:\s*(\w+)/);
      if (qm) {
        const funcName = qm[1];
        // Search for the function definition in header lines
        for (let hi = 0; hi < headerLines.length; hi++) {
          const defRe = new RegExp('\\b(float|vec[234]|int|ivec[234]|bool|mat[234])\\s+' + funcName + '\\s*\\(');
          const dm = headerLines[hi].match(defRe);
          if (dm) {
            const retType = dm[1];
            // Build default return value
            let defaultVal;
            if (retType === 'float' || retType === 'int') defaultVal = '0';
            else if (retType === 'bool') defaultVal = 'false';
            else defaultVal = retType + '(0.0)'; // vec2(0.0), vec3(0.0), etc.
            // Find the closing brace of the function — check if it's on same line or later
            let braceIdx = headerLines[hi].lastIndexOf('}');
            if (braceIdx >= 0) {
              // Same line: insert return before the closing brace
              headerLines[hi] = headerLines[hi].substring(0, braceIdx) +
                ' return ' + defaultVal + '; ' + headerLines[hi].substring(braceIdx);
              applied++;
              break;
            } else {
              // Multi-line: find the closing brace
              for (let hj = hi + 1; hj < headerLines.length; hj++) {
                braceIdx = headerLines[hj].indexOf('}');
                if (braceIdx >= 0) {
                  headerLines[hj] = headerLines[hj].substring(0, braceIdx) +
                    ' return ' + defaultVal + '; ' + headerLines[hj].substring(braceIdx);
                  applied++;
                  break;
                }
              }
              break;
            }
          }
        }
        continue;
      }
    }

    // ── Pattern R: too many arguments to constructor ──
    // HLSL vec2(a,b,c) silently truncates; GLSL requires exact arg count.
    // Find vecN() constructors on the error line and truncate excess args.
    {
      if (err.msg.match(/too many arguments/i)) {
        let newLine = line;
        let patRFixed = false;
        // Try vec2, vec3, vec4, ivec2, ivec3, ivec4 constructors
        for (const ctype of ['vec2','vec3','vec4','ivec2','ivec3','ivec4']) {
          const expected = parseInt(ctype.charAt(ctype.length - 1));
          const re = new RegExp('\\b' + ctype + '\\s*\\(', 'g');
          let m;
          while ((m = re.exec(newLine)) !== null) {
            const pStart = m.index + m[0].length;
            const pEnd = findMatchingParen(newLine, pStart);
            if (pEnd < 0) continue;
            const inner = newLine.substring(pStart, pEnd);
            // Count comma-separated args (respecting paren depth)
            const args = [];
            let depth = 0, argStart = 0;
            for (let ci = 0; ci <= inner.length; ci++) {
              if (ci === inner.length || (inner[ci] === ',' && depth === 0)) {
                args.push(inner.substring(argStart, ci).trim());
                argStart = ci + 1;
              } else if (inner[ci] === '(' || inner[ci] === '[') depth++;
              else if (inner[ci] === ')' || inner[ci] === ']') depth--;
            }
            // If too many scalar args, truncate
            if (args.length > expected) {
              const truncated = args.slice(0, expected).join(', ');
              newLine = newLine.substring(0, pStart) + truncated + newLine.substring(pEnd);
              patRFixed = true;
              break; // restart since positions changed
            }
          }
          if (patRFixed) break;
        }
        if (patRFixed) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern S: non-constant global initializer ──
    // GLSL ES 3.0 forbids non-constant expressions in global-scope initializers.
    // Move the initialization into the body (first line) and leave just a declaration.
    // Only applies to header errors.
    {
      if (err.msg.match(/non-constant (global |expression: )?initializer/i) ||
          (err.msg.match(/not supported for this version/i) && lines === headerLines)) {
        // Check if the error line is a global variable with initializer
        const initRe = /^(\s*)(mat[234](?:x[234])?|vec[234]|ivec[234]|float|int)\s+(\w+)\s*=\s*/;
        const im = line.match(initRe);
        if (im) {
          const [fullMatch, indent, varType, varName] = im;
          // Extract the initializer expression — may span multiple lines
          const afterEquals = line.substring(im.index + fullMatch.length);
          // Find the semicolon at depth 0 on this line
          let dpth = 0, exprEnd = -1;
          for (let ci = 0; ci < afterEquals.length; ci++) {
            if (afterEquals[ci] === '(' || afterEquals[ci] === '[') dpth++;
            else if (afterEquals[ci] === ')' || afterEquals[ci] === ']') dpth--;
            else if (afterEquals[ci] === ';' && dpth === 0) { exprEnd = ci; break; }
          }

          if (exprEnd >= 0) {
            // Single-line initializer
            const initExpr = afterEquals.substring(0, exprEnd).trim();
            const trailComment = afterEquals.substring(exprEnd + 1).trim();
            lines[lineIdx] = `${indent}${varType} ${varName};${trailComment ? ' ' + trailComment : ''}`;
            const assignLine = `${varName} = ${initExpr};`;
            let insertIdx = 0;
            for (let bi = 0; bi < bodyLines.length; bi++) {
              if (bodyLines[bi].includes('_uv = uv') || bodyLines[bi].trim() === '') {
                insertIdx = bi + 1;
              } else if (bodyLines[bi].trim().length > 0) {
                break;
              }
            }
            bodyLines.splice(insertIdx, 0, assignLine);
            applied++;
            continue;
          } else {
            // Multi-line initializer: join continuation lines until we find the closing ;
            let joinedExpr = afterEquals;
            let endLineIdx = lineIdx;
            for (let li = lineIdx + 1; li < lines.length; li++) {
              joinedExpr += '\n' + lines[li];
              // Check for semicolon at depth 0 in the joined expression
              dpth = 0;
              let found = false;
              for (let ci = 0; ci < joinedExpr.length; ci++) {
                if (joinedExpr[ci] === '(' || joinedExpr[ci] === '[') dpth++;
                else if (joinedExpr[ci] === ')' || joinedExpr[ci] === ']') dpth--;
                else if (joinedExpr[ci] === ';' && dpth === 0) {
                  exprEnd = ci;
                  found = true;
                  break;
                }
              }
              if (found) { endLineIdx = li; break; }
            }
            if (exprEnd >= 0) {
              const initExpr = joinedExpr.substring(0, exprEnd).trim();
              // Replace original line with just declaration
              lines[lineIdx] = `${indent}${varType} ${varName};`;
              // Remove continuation lines from header
              for (let ri = lineIdx + 1; ri <= endLineIdx; ri++) {
                lines[ri] = ''; // blank out continuation lines
              }
              // Add assignment to body
              const assignLine = `${varName} = ${initExpr};`;
              let insertIdx = 0;
              for (let bi = 0; bi < bodyLines.length; bi++) {
                if (bodyLines[bi].includes('_uv = uv') || bodyLines[bi].trim() === '') {
                  insertIdx = bi + 1;
                } else if (bodyLines[bi].trim().length > 0) {
                  break;
                }
              }
              bodyLines.splice(insertIdx, 0, assignLine);
              applied++;
              continue;
            }
          }
        }
      }
    }

    // ── Pattern T: vector swizzle selection out of range ──
    // e.g., .zzz on a vec2 (z is component index 2, but vec2 only has x,y)
    // Downgrade swizzle components: z→y, w→y for vec2 results, w→z for vec3
    {
      if (err.msg.match(/vector swizzle selection out of range/i)) {
        // Find swizzle patterns on the error line and downgrade them
        // Look for .xyz/.xyzw-style or .rgb/.rgba-style swizzles after expressions
        const swizzleRe = /\.([xyzwrgba]{1,4})\b/g;
        let newLine = line;
        let patTFixed = false;
        let sm;
        while ((sm = swizzleRe.exec(line)) !== null) {
          const sw = sm[1];
          // Check if this swizzle contains z/w/b/a components
          if (/[zwba]/.test(sw)) {
            // Downgrade: z→y, w→y, b→g, a→g (for vec2 context)
            // This is a heuristic — we assume the expression is vec2 if z/w are used
            const fixed = sw.replace(/z/g, 'y').replace(/w/g, 'y')
                           .replace(/b/g, 'g').replace(/a/g, 'g');
            if (fixed !== sw) {
              newLine = newLine.substring(0, sm.index + 1) + fixed +
                        newLine.substring(sm.index + 1 + sw.length);
              patTFixed = true;
              break; // one fix per iteration to avoid offset drift
            }
          }
        }
        if (patTFixed) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern U: extraneous semicolon after closing brace ──
    // GLSL ES 3.0 doesn't allow `};` after function definitions.
    // Remove the semicolon.
    {
      if ((err.token === 'extraneous semicolon' || err.msg.includes('extraneous semicolon')) && (err.msg.includes('not supported') || err.token.includes('not supported'))) {
        const newLine = line.replace(/\}\s*;/, '}');
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern V: scalar swizzle not supported in ES ──
    // e.g., (1.0-x).x where x is float → result is scalar, .x is redundant.
    // Remove the swizzle from the scalar expression.
    {
      if ((err.token === 'scalar swizzle' || err.msg.includes('scalar swizzle')) && (err.msg.includes('not supported') || err.token.includes('not supported'))) {
        // Find patterns like (expr).x or (expr).xy etc. where expr is scalar
        // We look for ).<swizzle> and remove the . and swizzle
        const newLine = line.replace(/(\))\.[xyzwrgba]{1,4}\b/g, '$1');
        if (newLine !== line) {
          lines[lineIdx] = newLine;
          applied++;
          continue;
        }
      }
    }

    // ── Pattern W: undeclared identifier — promote function-local to global ──
    // MilkDrop treats all variables as global. When the .milk→GLSL conversion
    // places variable declarations inside header functions, the body can't see them.
    // Fix: add a global declaration at the top of the header, and remove the local
    // declaration from inside the function to avoid shadowing.
    {
      if (err.msg.includes('undeclared identifier') && err.token && lines === bodyLines) {
        const token = err.token;
        // Search header for a declaration of this token inside a function body
        let inFunc = 0; // brace depth for tracking function scopes
        let foundType = null;
        let foundLineIdx = -1;
        let isParam = false;
        for (let hi = 0; hi < headerLines.length; hi++) {
          const hl = headerLines[hi];
          // Use startDepth (depth at START of line) to avoid matching
          // function parameters on the same line as the opening brace
          const startDepth = inFunc;
          for (const ch of hl) {
            if (ch === '{') inFunc++;
            else if (ch === '}') inFunc--;
          }
          if (startDepth <= 0) continue; // only look at lines already inside function bodies
          // Look for: type token; or type token, or type ..., token, or type ..., token;
          const declRe = new RegExp('\\b(float|int|vec[234]|ivec[234]|mat[234]|bool|bvec[234])\\s+(?:[a-zA-Z_]\\w*\\s*,\\s*)*\\b' + token + '\\b');
          const dm = hl.match(declRe);
          if (dm) {
            foundType = dm[1];
            foundLineIdx = hi;
            break;
          }
        }
        // Also check function parameters
        if (!foundType) {
          for (let hi = 0; hi < headerLines.length; hi++) {
            const hl = headerLines[hi];
            // Match function signature: type funcName(...type token...)
            const paramRe = new RegExp('\\b(float|int|vec[234]|ivec[234]|mat[234]|bool)\\s+' + token + '\\b');
            // Only if this looks like a function signature (has types before parens)
            if (/\w+\s*\(/.test(hl) && paramRe.test(hl)) {
              const pm = hl.match(paramRe);
              if (pm) {
                foundType = pm[1];
                isParam = true;
                break;
              }
            }
          }
        }
        if (foundType) {
          // Add global declaration at the top of the header
          headerLines.unshift(foundType + ' ' + token + ';');
          // Remove the local declaration if it's not a parameter (to avoid shadowing)
          if (!isParam && foundLineIdx >= 0) {
            // Adjust index since we inserted at position 0
            const adjIdx = foundLineIdx + 1;
            const hline = headerLines[adjIdx];
            // Try to remove just this variable from a multi-var declaration
            // e.g., "float a, iterations, b;" → "float a, b;"
            const singleRe = new RegExp('^(\\s*)(float|int|vec[234]|ivec[234]|mat[234]|bool|bvec[234])\\s+' + token + '\\s*;');
            if (singleRe.test(hline)) {
              // Entire declaration is just this variable — blank the line
              headerLines[adjIdx] = '';
            } else {
              // Multi-var declaration — remove this variable from the list
              const multiRe = new RegExp(',\\s*' + token + '\\b|\\b' + token + '\\s*,');
              headerLines[adjIdx] = hline.replace(multiRe, '');
            }
          }
          applied++;
          continue;
        }
      }
    }
  }

  const fixedBody = bodyLines.join('\n');
  const fixedHeader = headerLines.join('\n');
  const fixedShader = fixedHeader
    ? fixedHeader + '\nshader_body\n{' + fixedBody + '\n}'
    : 'shader_body\n{' + fixedBody + '\n}';

  return { fixed: fixedShader, applied };
}

/**
 * For warp shaders: make `uv` writable via a local copy.
 *
 * Butterchurn's warp fragment shader template declares `in vec2 uv;`
 * (a read-only varying from the vertex shader), but many MilkDrop presets
 * modify `uv` in their warp shader body.  The comp template avoids this
 * by creating a local `vec2 uv = vUv;`.
 *
 * We rename all `uv` references in the warp body to `_uv` and declare
 * `vec2 _uv = uv;` at the top, giving the body a writable local copy.
 * `\buv\b` matches the token `uv` but not `uv1`, `uv_orig`, `uv2`, etc.
 */
function makeWarpUvWritable(shaderStr) {
  const [header, body] = getShaderParts(shaderStr);
  const renamedBody = body.replace(/\buv\b/g, '_uv');
  const newBody = '\nvec2 _uv = uv;\n' + renamedBody;
  return (header || '') + 'shader_body\n{' + newBody + '\n}';
}

/**
 * Convert and validate a shader with iterative error fixing.
 * Returns the final shader string (butterchurn format).
 */
function convertAndValidateShader(rawShader, shaderType, presetName) {
  if (!rawShader || rawShader.length === 0) return { shader: '', hasWarnings: false };

  let shader = hlslToGlsl(rawShader);
  let hasWarnings = false;

  if (!GLSLANG) return { shader, hasWarnings };

  const MAX_ITERATIONS = 5;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const errors = validateGlsl(shader);
    if (!errors || errors.length === 0) break;

    const { fixed, applied } = fixGlslFromErrors(shader, errors);
    if (applied === 0) {
      // Could not auto-fix; log and return what we have
      const errSummary = errors.map(e => `  L${e.line}: ${e.msg}`).join('\n');
      console.error(`  WARN [${presetName}] ${shaderType}: ${errors.length} unfixed GLSL error(s):\n${errSummary}`);
      hasWarnings = true;
      break;
    }
    shader = fixed;
  }

  // For warp shaders: make `uv` writable.
  // Butterchurn's warp template uses `in vec2 uv` (read-only varying),
  // but MilkDrop presets freely modify uv in their warp shader body.
  if (shaderType === 'warp') {
    shader = makeWarpUvWritable(shader);
  }

  return { shader, hasWarnings };
}

function convertShader(shader) {
  if (!shader || shader.length === 0) return '';
  return hlslToGlsl(shader);
}

async function convertMilkToButterchurn(milkText, presetName) {
  const presetParts = splitPreset(milkText);

  const warpResult = convertAndValidateShader(presetParts.warp, 'warp', presetName || '?');
  const compResult = convertAndValidateShader(presetParts.comp, 'comp', presetName || '?');
  const warpShader = warpResult.shader;
  const compShader = compResult.shader;
  const hasWarnings = warpResult.hasWarnings || compResult.hasWarnings;

  // 1. Convert EEL2 → JS via the official milkdrop-eel-parser
  const parsedPreset = milkdropParser.convert_preset_wave_and_shape(
    presetParts.presetVersion,
    presetParts.presetInit,
    presetParts.perFrame,
    presetParts.perVertex,
    presetParts.shapes,
    presetParts.waves
  );

  // 2. Assemble preset structure with compiled JS equation strings
  const presetMap = createBasePresetFuns(
    parsedPreset,
    presetParts.shapes,
    presetParts.waves
  );

  // --- Fix A: createBasePresetFuns passes through raw EEL2 _eqs_str for
  // disabled waves/shapes (enabled===0).  Butterchurn still compiles ALL
  // _eqs_str fields via new Function(), so raw EEL2 causes SyntaxErrors.
  // Always use the parser's compiled JS output for every wave/shape. ---
  for (let i = 0; i < presetMap.waves.length; i++) {
    if (parsedPreset.waves[i]) {
      presetMap.waves[i].init_eqs_str = parsedPreset.waves[i].perFrameInitEQs || '';
      presetMap.waves[i].frame_eqs_str = parsedPreset.waves[i].perFrameEQs || '';
      presetMap.waves[i].point_eqs_str = parsedPreset.waves[i].perPointEQs || '';
    }
  }
  for (let i = 0; i < presetMap.shapes.length; i++) {
    if (parsedPreset.shapes[i]) {
      presetMap.shapes[i].init_eqs_str = parsedPreset.shapes[i].perFrameInitEQs || '';
      presetMap.shapes[i].frame_eqs_str = parsedPreset.shapes[i].perFrameEQs || '';
    }
  }

  // --- Fix B: milkdrop-eel-parser can emit "return for(...)" when an
  // EEL2 loop() is the last expression in an if-branch IIFE.  "for" is a
  // statement, not an expression, so "return for(...)" is invalid JS.
  // Strip the "return " that immediately precedes a for-loop. ---
  const fixReturnFor = (s) => s ? s.replace(/return (for\s*\()/g, '$1') : s;
  presetMap.init_eqs_str  = fixReturnFor(presetMap.init_eqs_str);
  presetMap.frame_eqs_str = fixReturnFor(presetMap.frame_eqs_str);
  presetMap.pixel_eqs_str = fixReturnFor(presetMap.pixel_eqs_str);
  for (const w of presetMap.waves) {
    w.init_eqs_str  = fixReturnFor(w.init_eqs_str);
    w.frame_eqs_str = fixReturnFor(w.frame_eqs_str);
    w.point_eqs_str = fixReturnFor(w.point_eqs_str);
  }
  for (const s of presetMap.shapes) {
    s.init_eqs_str  = fixReturnFor(s.init_eqs_str);
    s.frame_eqs_str = fixReturnFor(s.frame_eqs_str);
  }

  // MilkDrop v1 uses bMotionVectorsOn=0 to disable motion vectors, but
  // butterchurn ignores that flag and only checks mv_a > 0.001.
  // splitPreset omits mv_a when it equals the default (1), so butterchurn
  // would render a 12×9 motion-vector grid (hairlines). Fix: translate
  // the v1 flag into the v2 equivalent.
  const baseVals = { ...presetParts.baseVals };
  if (baseVals.bmotionvectorson === 0 && baseVals.mv_a === undefined) {
    baseVals.mv_a = 0;
  }

  return {
    baseVals,
    ...presetMap,
    warp: warpShader,
    comp: compShader,
    _hasWarnings: hasWarnings,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--batch') {
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
    console.error('Converting ' + files.length + ' presets...');

    let success = 0, failed = 0;
    for (const file of files) {
      try {
        const milk = fs.readFileSync(path.join(inputDir, file), 'utf8');
        const result = await convertMilkToButterchurn(milk, file.replace(/\.milk$/, ''));
        const hasWarnings = result._hasWarnings;
        delete result._hasWarnings;
        const baseName = file.replace(/\.milk$/, '.json');
        const outFile = hasWarnings ? '_broken_' + baseName : baseName;
        // Remove stale counterpart (broken↔clean) to avoid duplicates
        const staleFile = hasWarnings ? baseName : '_broken_' + baseName;
        try { fs.unlinkSync(path.join(outputDir, staleFile)); } catch {}
        fs.writeFileSync(path.join(outputDir, outFile), JSON.stringify(result));
        success++;
        console.error('  OK: ' + file);
      } catch (e) {
        failed++;
        console.error('  FAIL: ' + file + ': ' + e.message);
      }
    }
    console.error('Done: ' + success + ' converted, ' + failed + ' failed');
  } else if (args[0] === '--compare') {
    const milkFile = args[1];
    const refFile = args[2];
    const milk = fs.readFileSync(milkFile, 'utf8');
    const result = await convertMilkToButterchurn(milk, path.basename(milkFile, '.milk'));
    const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));

    console.log('BaseVals match:', JSON.stringify(result.baseVals) === JSON.stringify(ref.baseVals));
    console.log('Init EEL match:', result.init_eqs_eel === ref.init_eqs_eel);
    console.log('Frame EEL match:', result.frame_eqs_eel === ref.frame_eqs_eel);
    console.log('Pixel EEL match:', result.pixel_eqs_eel === ref.pixel_eqs_eel);

    for (let i = 0; i < 4; i++) {
      console.log('Shape ' + i + ' bv match:', JSON.stringify(result.shapes[i].baseVals) === JSON.stringify(ref.shapes[i].baseVals));
      console.log('Shape ' + i + ' init match:', result.shapes[i].init_eqs_eel === ref.shapes[i].init_eqs_eel);
      console.log('Shape ' + i + ' frame match:', result.shapes[i].frame_eqs_eel === ref.shapes[i].frame_eqs_eel);
    }

    for (let i = 0; i < 4; i++) {
      console.log('Wave ' + i + ' bv match:', JSON.stringify(result.waves[i].baseVals) === JSON.stringify(ref.waves[i].baseVals));
      console.log('Wave ' + i + ' init match:', result.waves[i].init_eqs_eel === ref.waves[i].init_eqs_eel);
      console.log('Wave ' + i + ' frame match:', result.waves[i].frame_eqs_eel === ref.waves[i].frame_eqs_eel);
      console.log('Wave ' + i + ' point match:', result.waves[i].point_eqs_eel === ref.waves[i].point_eqs_eel);
    }

    console.log('Warp match:', result.warp === ref.warp);
    console.log('Comp match:', result.comp === ref.comp);
    console.log('Warp len:', result.warp.length, 'vs', ref.warp.length);
    console.log('Comp len:', result.comp.length, 'vs', ref.comp.length);
  } else {
    const milkFile = args[0] || '/dev/stdin';
    const milk = fs.readFileSync(milkFile, 'utf8');
    const result = await convertMilkToButterchurn(milk, path.basename(milkFile, '.milk'));
    process.stdout.write(JSON.stringify(result));
  }
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
