#!/usr/bin/env node
/**
 * detect-glsl-version.cjs
 *
 * Shared GLSL version detection logic used by:
 *   - scripts/list-webgl1-shaders.cjs  (CLI reporting)
 *   - src/js/visualizers/ShadertoyMultipassVisualizer.js  (runtime, inline copy)
 *
 * Exported: detectGLSLVersion(source) → { version: 1|2, reason: string }
 */

'use strict'

// Signals that require WebGL1 (GLSL ES 1.00) path.
// These are syntax removed or deprecated in GLSL ES 3.00.
const WEBGL1_SIGNALS = [
  { pattern: /\bgl_FragColor\b/,                    label: 'gl_FragColor (removed in GLSL ES 3.00)' },
  { pattern: /\btexture2D\s*\(/,                    label: 'texture2D() (deprecated in GLSL ES 3.00)' },
  { pattern: /\bvarying\s+/,                        label: 'varying (removed in GLSL ES 3.00)' },
  { pattern: /\battribute\s+/,                      label: 'attribute (removed in GLSL ES 3.00)' },
  // comma-declared for-loop variables: for(float a=0.,b=0.,c=0.;
  // Rejected by many WebGL2/GLSL ES 3.00 compilers even though ES 1.00 allows it
  { pattern: /\bfor\s*\(\s*\w+\s+\w+\s*=[^;]+,[^;]+;/, label: 'comma-declared for-loop variables' },
]

// Signals that require WebGL2 (GLSL ES 3.00) path.
// These are unavailable (or require extensions) in WebGL1.
const WEBGL2_SIGNALS = [
  // bare texture() (not texture2D) is the GLSL ES 3.00 spelling
  // NOTE: listed before WEBGL1 checks run, but WebGL1 signals are tested first in detectGLSLVersion
  { pattern: /\bfwidth\s*\(/,           label: 'fwidth() (built-in in GLSL ES 3.00)' },
  { pattern: /\bdFdx\s*\(/,             label: 'dFdx() (built-in in GLSL ES 3.00)' },
  { pattern: /\bdFdy\s*\(/,             label: 'dFdy() (built-in in GLSL ES 3.00)' },
  { pattern: /\btextureLod\s*\(/,       label: 'textureLod() (built-in in GLSL ES 3.00)' },
  { pattern: /\btexelFetch\s*\(/,       label: 'texelFetch() (WebGL2 / GLSL ES 3.00 only)' },
  { pattern: /#version\s+300\s+es/,     label: '#version 300 es (explicit GLSL ES 3.00)' },
  { pattern: /\blayout\s*\(/,           label: 'layout() (GLSL ES 3.00 only)' },
  // bare texture() (not texture2D) is the GLSL ES 3.00 spelling
  { pattern: /\btexture\s*\(/,          label: 'texture() without 2D suffix (GLSL ES 3.00)' },
  // array constructor syntax: float[9](...) is GLSL ES 3.00 only
  { pattern: /\b[A-Za-z_]\w*\s*\[\s*\d+\s*\]\s*\(/, label: 'array constructor (e.g. float[9](...), GLSL ES 3.00 only)' },
]

/**
 * Detect whether a GLSL shader source requires WebGL1 or WebGL2.
 *
 * @param {string} source  Raw GLSL source text
 * @returns {{ version: 1|2, reason: string }}
 */
function detectGLSLVersion(source) {
  const src = String(source || '')

  // Explicit override comments always take priority
  if (/^\s*\/\/@WebGL1/.test(src)) {
    return { version: 1, reason: 'explicit //@WebGL1 override' }
  }
  if (/^\s*\/\/@WebGL2/.test(src)) {
    return { version: 2, reason: 'explicit //@WebGL2 override' }
  }

  // Strip comments before signal matching to avoid false positives
  // (e.g. "Time varying pixel color" in a line comment)
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .replace(/\/\/[^\n]*/g, ' ')          // line comments

  // WebGL1-specific syntax detected → must use WebGL1 path
  for (const { pattern, label } of WEBGL1_SIGNALS) {
    if (pattern.test(stripped)) {
      return { version: 1, reason: `detected WebGL1 signal: ${label}` }
    }
  }

  // WebGL2-specific syntax detected → must use WebGL2 path
  for (const { pattern, label } of WEBGL2_SIGNALS) {
    if (pattern.test(stripped)) {
      return { version: 2, reason: `detected WebGL2 signal: ${label}` }
    }
  }

  // No signals found — default to WebGL1 (safe: any shader that truly needs WebGL2
  // will have at least one detectable signal like fwidth/dFdx/dFdy/textureLod/layout)
  return { version: 1, reason: 'no signals detected, defaulting to WebGL1' }
}

module.exports = { detectGLSLVersion, WEBGL1_SIGNALS, WEBGL2_SIGNALS }
