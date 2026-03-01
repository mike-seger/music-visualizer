// "Shader Royale #2" by anticore
// https://www.shadertoy.com/view/WdKBWD
// my entry for shader royale 2 4/12/2020 please play the audio in iChannel0 for maximum effect

float sdSphere(vec3 p, vec3 pos, float r) {
  return length(p + pos) -r;
}

mat2 rot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c,s,-s,c);
}

float sdBox(vec3 p, vec3 pos, vec3 b) {
    vec3 q = abs(p + pos) - b;
    return min(max(q.x, max(q.y, q.z)), 0.);
}

float sdBoxes(vec3 p, vec3 pos, vec3 b) {
    float n = texelFetch( iChannel0, ivec2(0.2 * 512.,0), 0 ).x;
    p.xy *= rot(sin(iTime * 3.));
    p.y += sin(iTime * 2. + p.x * (1.2 + sin(iTime) / 2.) + n );
    p = vec3(p.x, mod(p.y, 0.4), p.z);
    vec3 q = abs(p + pos) - b;
    return min(max(q.x, max(q.y, q.z)), 0.);
}

float opMin(float d1, float d2) {
    return max(-d1, d2);
}

float opSmooth(float d1, float d2, float k) {
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0., 1.);
  return mix(d2, d1, h) - k * h * (1.-h);
}

float sdSpheres(vec3 p) {
    float n = texelFetch( iChannel0, ivec2(0.2 * 512.,0), 0 ).x;
    p = p - mod(p, 0.16 + n * 0.1 - abs(cos(iTime)) / 5. );
    float t = iTime;
  
    float spheres = 999.;
    for (int i = 0; i < 18; i++) {
        float p1 = t / 2. * float(i);
        float p2 = t /4. * (5. - float(i));
        float p3 = t + float(i) * 2.;
      
        spheres = opSmooth(spheres, sdSphere(p, vec3(sin(p1)*3., cos(p2)*3., sin(p3)+12.), float(i) * 0.05), 1.);
    }
    
    return spheres;
}

vec2 map(vec3 p) {
    float n = texelFetch( iChannel0, ivec2(0.2 * 512.,0), 0 ).x;
    float s = sdSphere(p, vec3(0.,0.,10.), 2. + n );
    float b = sdBoxes(p, vec3(5,0,10), vec3(10,.2,5));
    float bms = opMin(b,s);
    float ss = sdSpheres(p);
    
    return vec2(opSmooth(bms, ss, 0.5), ss < bms ? 1 : 0);
}

vec3 tr(vec3 ro, vec3 rd){
    float td = 1.;
    vec2 h;
  
    float n = texelFetch( iChannel0, ivec2(0,0), 0 ).x;
  
    vec3 c0 = vec3(0.);
    vec3 glo0 = vec3(abs(sin(iTime)) * n * 0.035,abs(cos(iTime)) * n * 0.035,0.03);
    vec3 c1 = vec3(0.);
    //vec3 glo1 = vec3(0.02, 0,0);
    vec3 glo1 = 0.015 * (0.5 + 0.5 * cos(iTime * 2. + rd.y*2. + vec3(4.,1.,0.))) + 0.015 * (0.5 + 0.5 * cos(iTime * 3. + rd.y*5. + vec3(1.,4.,0.)));
  
    for (int i = 0; i < 100; i++) {
        h = map(ro + rd * td);
        td += h.x;
      
        if (h.y == 0.) c0 += glo0; else c1 += glo1;
      
        if (h.x < 0.01 || h.x > 20.) break;
    }
    
    return c0 + c1;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
  
    float n = texelFetch( iChannel0, ivec2(0,0), 0 ).x;
  vec2 uv = vec2(fragCoord.x / iResolution.x, fragCoord.y / iResolution.y);
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv = sin(iTime / 2.) > 0. ? uv : abs(uv);
  
  vec3 ro= vec3(cos(iTime * 4.) / 4. + 0.2,0.,1.7 + n / 1.);
  vec3 rd = normalize(vec3(uv, 0) - ro);

  fragColor = vec4( tr(ro, rd), 1);
}
