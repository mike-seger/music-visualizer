#!/usr/bin/env node
/**
 * Diagnostic: Extract the actual GLSL lines causing errors for all WARN presets.
 * Usage: node scripts/diag-all-warns.cjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outDir = 'public/butterchurn-presets/martinsCollectionMarch2025';
const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));

const PREAMBLE_LINES = 13;

// Butterchurn GLSL header (same as convert-milk.cjs)
const BUTTERCHURN_GLSL_HEADER = `#version 300 es
precision mediump float;
uniform float time;
uniform float fps;
uniform float frame;
uniform float bass;
uniform float bass_att;
uniform float mid;
uniform float mid_att;
uniform float treb;
uniform float treb_att;
uniform float progress;
uniform float meshx;
uniform float meshy;
uniform float pixelsx;
uniform float pixelsy;
uniform float aspectx;
uniform float aspecty;
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
uniform sampler2D sampler_noisevol_lq;
uniform sampler2D sampler_noisevol_hq;
in vec2 uv;
in vec2 uv_orig;
in float rad;
in float ang;
out vec4 fragColor;
#define GetMain(uv) (texture(sampler_main,(uv)))
#define GetPixel(uv) (texture(sampler_main,(uv)).xyz)
#define GetBlur1(uv) (texture(sampler_blur1,(uv)).xyz*scale1 + bias1)
#define GetBlur2(uv) (texture(sampler_blur2,(uv)).xyz*scale2 + bias2)
#define GetBlur3(uv) (texture(sampler_blur3,(uv)).xyz*scale3 + bias3)
vec3 lum(vec3 v){return vec3(dot(v,vec3(0.32,0.49,0.29)));}
vec3 lum(vec2 v){return vec3(dot(v,vec2(0.32,0.49)));}
float lum(float v){return v*0.32;}
#define tex2d texture
#define tex3d texture
#define PI 3.14159265359
`;
const BH_LINES = BUTTERCHURN_GLSL_HEADER.split('\n').length - 1;

function buildProgram(headerPart, bodyPart, shaderType) {
  const preambleWarp = `vec2 _uv_orig = uv;\nfloat _rad_orig = rad;\nfloat _ang_orig = ang;\nvec3 ret = texture(sampler_main, uv).xyz;\nfloat q1=0.0,q2=0.0,q3=0.0,q4=0.0,q5=0.0,q6=0.0,q7=0.0,q8=0.0;\nfloat t1=0.0,t2=0.0,t3=0.0,t4=0.0,t5=0.0,t6=0.0,t7=0.0,t8=0.0;\nvec3 scale1=vec3(1.0),scale2=vec3(1.0),scale3=vec3(1.0);\nvec3 bias1=vec3(0.0),bias2=vec3(0.0),bias3=vec3(0.0);\nfloat monitor=0.0;\nvoid shader_body(){\n`;
  const preambleComp = `vec3 ret = texture(sampler_main, uv).xyz;\nfloat q1=0.0,q2=0.0,q3=0.0,q4=0.0,q5=0.0,q6=0.0,q7=0.0,q8=0.0;\nfloat t1=0.0,t2=0.0,t3=0.0,t4=0.0,t5=0.0,t6=0.0,t7=0.0,t8=0.0;\nvec3 scale1=vec3(1.0),scale2=vec3(1.0),scale3=vec3(1.0);\nvec3 bias1=vec3(0.0),bias2=vec3(0.0),bias3=vec3(0.0);\nfloat monitor=0.0;\nfloat hue_shader=0.0;\nvoid shader_body(){\n`;

  const preamble = shaderType === 'warp' ? preambleWarp : preambleComp;
  const epilogue = `\nfragColor = vec4(ret, 1.0);\n}\n`;
  
  const full = BUTTERCHURN_GLSL_HEADER + headerPart + '\n' + preamble + '\n' + bodyPart + epilogue;
  return { full, bodyLineOffset: BH_LINES + (headerPart.split('\n').length - 1) + preamble.split('\n').length };
}

for (const file of files) {
  const j = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf-8'));

  for (const shaderType of ['warp', 'comp']) {
    const src = j[shaderType];
    if (!src) continue;

    const sbIdx = src.indexOf('shader_body');
    if (sbIdx < 0) continue;
    const headerPart = src.substring(0, sbIdx);
    const after = src.substring(sbIdx);
    const braceIdx = after.indexOf('{');
    const bodyPart = after.substring(braceIdx + 1, after.lastIndexOf('}'));

    const { full, bodyLineOffset } = buildProgram(headerPart, bodyPart, shaderType);

    // Write temp file
    const tmpFile = '/tmp/diag-shader.frag';
    fs.writeFileSync(tmpFile, full);
    
    try {
      execSync(`/opt/homebrew/bin/glslangValidator ${tmpFile}`, { encoding: 'utf-8' });
    } catch (e) {
      const output = e.stdout || '';
      const errLines = output.split('\n').filter(l => l.includes('ERROR:'));
      if (errLines.length === 0) continue;

      const presetName = file.replace('.json', '');
      const fullLines = full.split('\n');
      const headerLines = headerPart.split('\n');
      const bodyLines = bodyPart.split('\n');

      for (const errLine of errLines) {
        const m = errLine.match(/ERROR:\s*0:(\d+):\s*'([^']*)'\s*:\s*(.*)/);
        if (!m) continue;
        const absLine = parseInt(m[1]);
        const token = m[2];
        const msg = m[3].trim();
        const userLine = absLine - bodyLineOffset;

        console.log(`\n=== ${presetName} [${shaderType}] ===`);
        console.log(`Error: '${token}' : ${msg}`);
        console.log(`AbsLine=${absLine}, BodyOffset=${bodyLineOffset}, UserLine=${userLine}`);
        
        if (userLine > 0 && userLine <= bodyLines.length) {
          const start = Math.max(0, userLine - 3);
          const end = Math.min(bodyLines.length - 1, userLine + 1);
          console.log(`--- Body context (user lines ${start+1}-${end+1}) ---`);
          for (let i = start; i <= end; i++) {
            const marker = i === userLine - 1 ? '>>>' : '   ';
            console.log(`${marker} B${i+1}: ${bodyLines[i]}`);
          }
        } else if (userLine <= 0) {
          // Error is in header
          const headerIdx = absLine - 1 - BH_LINES;
          if (headerIdx >= 0 && headerIdx < headerLines.length) {
            const start = Math.max(0, headerIdx - 2);
            const end = Math.min(headerLines.length - 1, headerIdx + 2);
            console.log(`--- Header context (header lines ${start+1}-${end+1}) ---`);
            for (let i = start; i <= end; i++) {
              const marker = i === headerIdx ? '>>>' : '   ';
              console.log(`${marker} H${i+1}: ${headerLines[i]}`);
            }
          } else {
            console.log(`--- Full line ${absLine}: ${fullLines[absLine - 1] || '(out of range)'} ---`);
          }
        }
      }
    }
  }
}
