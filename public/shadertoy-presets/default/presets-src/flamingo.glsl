// "flamingo" by jshrake
// https://www.shadertoy.com/view/wlf3Rr
// Audio reactive shader with a fun beat :)

#define PI 3.14159265359

// From https://www.shadertoy.com/view/4dS3Wd
float hash(float n) { return fract(sin(n) * 2e4); }

vec3 hsv2rgb(vec3 c) {
  c = vec3(c.x, clamp(c.yz, 0.0, 1.0));
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

mat2 rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, s, -s, c);
}

// https://en.wikipedia.org/wiki/Distance_from_a_point_to_a_line#Line_defined_by_two_points
float line(vec2 uv, vec2 a, vec2 b, float thickness) {
  float d =
      abs((b.y - a.y) * uv.x - (b.x - a.x) * uv.y + b.x * a.y - b.y * a.x) /
      distance(a, b);
  return abs(d) - thickness;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy - 0.5;
  float line_thickness = 0.01;
  vec2 a = vec2(0.0, -1.0);
  vec2 b = vec2(0.0, 1.0);
  float line_count = 50.0;
  vec3 color = vec3(0.0);
  for (float line_i = 0.0; line_i < line_count; line_i += 1.0) {
    vec2 mod_uv = uv;
    float line_pct = line_i / line_count;
    float fft = 1.0 * texture(iChannel0, vec2(line_pct, 0.25)).x;
    // For a cooler preview?
    if (iFrame < 20) {
        fft = hash(line_i);
    }
    mod_uv.x +=
        15.0 * fft * line_thickness * cos(fft * 17.0 * uv.y + 0.5 * iTime);
    mod_uv.y +=
        9.0 * fft * line_thickness * sin(fft * 15.0 * uv.x + 0.3 * iTime);
    mat2 R = rot(PI * line_pct + 0.2 * iTime);
    float d = line(mod_uv, R * a, R * b, line_thickness);
    float blur = (1.0 + fft) * 5.0 / iResolution.y;
    float m = smoothstep(-blur, blur, d);
    vec3 line_color = hsv2rgb(vec3(0.8 + 0.1 * iTime, 1.0, 1.0));
    color += mix(line_color, vec3(0.0), m);
  }
  fragColor.rgb = pow(color, vec3(1.0 / 2.2));
}
