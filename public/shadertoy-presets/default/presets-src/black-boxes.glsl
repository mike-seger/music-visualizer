// Glossy rounded cubes, independently bobbing
// Bootstrapped this shader with AI + reference image
//
// The key technique is to accelerate the SDF evaluation to only the nearest
// 2x2 grid neighbors vs all cubes in the scene

#define MAX_STEPS 64
#define MAX_DIST  11.0
#define SURF_EPS  0.004

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
    vec3 q = abs(p) - b;
    // outside distance + inside distance (via max component) minus rounding radius
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// This version uses a cheap acceleration structure that converts
// world XZ into continuous "grid coordinates" g;
// Only test the 2x2 neighborhood around the base cell (4 cubes total)
// because the closest cube to a point in a grid must be among nearby cells.
// This reduces work from 100 (for N=10) SDF evals per step to ~4 in the common case.
float mapScene(vec3 p, out vec2 cellId)
{
    cellId = vec2(0.0);

    const float spacing = 1.44;
    const int N = 10;

    // Cube shape parameters
    vec3  halfB  = vec3(0.62, 0.35, 0.62);
    float roundR = 0.10;

    // Grid minimum corner in XZ so the grid is centered around origin.
    vec2 gridMin = -0.5 * float(N - 1) * spacing * vec2(1.0);

    // Convert p.xz into continuous grid coordinates:
    // g = (0,0) is at gridMin, g increases by 1 per cell.
    vec2 g = (p.xz - gridMin) / spacing;

    if (g.x < -0.75 || g.y < -0.75 || g.x > float(N)-0.25 || g.y > float(N)-0.25) {
        return 1e6; // "nothing here" large distance
    }

    vec2 base     = floor(g);
    float dBest   = 1e9;
    vec2 bestCell = base;

    // Check only the 2x2 neighborhood around base cell.
    for (int j = 0; j <= 1; j++) {
        for (int i = 0; i <= 1; i++) {
            vec2 c = base + vec2(float(i), float(j));

            // Clamp to valid 0..N-1 so edges behave (no out-of-grid accesses).
            c = clamp(c, vec2(0.0), vec2(float(N-1)));

            // Convert cell coordinate back to world center position in XZ.
            vec2 center = gridMin + c * spacing;

            // Stable per-cell animation:
            // - h0 drives phase and feeds other hashes to decorrelate values
            float h0    = hash12(c + 19.7);
            float phase = 6.2831853 * h0;
            float spd   = mix(0.25, 2.55, hash11(h0 + 2.3));
            float amp   = mix(0.03, 0.38, hash11(h0 + 9.1));
            float bob   = amp * sin(iTime * spd + phase);

            // Local position relative to this cube center, including vertical bob.
            vec3 q = p - vec3(center.x, bob, center.y);

            // Distance to rounded cube
            float d = sdRoundBox(q, halfB, roundR);

            // Keep closest cube
            if (d < dBest) { dBest = d; bestCell = c; }
        }
    }

    cellId = bestCell;
    return dBest;
}

// Small helper to evaluate distance only.
float mapOnly(vec3 p) {
    vec2 cid;
    return mapScene(p, cid);
}

float raymarch(vec3 ro, vec3 rd, out vec3 pos, out vec2 cellId) {
    // Intersect the scene's bounding slab to skip dead space before the grid entirely
    float t = max(0.0, (ro.y - 0.9) / -rd.y); // approximate top slab
    
    cellId = vec2(0.0);

    for (int i = 0; i < MAX_STEPS; i++) {
        pos = ro + rd * t;

        float d = mapScene(pos, cellId);
        if (d < SURF_EPS) return t;

        t += d * 0.9;

        if (t > MAX_DIST) break;
    }

    return -1.0;
}

// Instead of sampling +/-X +/-Y +/-Z (6 taps), sample 4 corners of a tetrahedron.
// This is cheaper and tends to be less axis-biased for similar quality.
vec3 calcNormal(vec3 p)
{
    float e = 0.0012;

    vec3 k1 = vec3( 1, -1, -1);
    vec3 k2 = vec3(-1, -1,  1);
    vec3 k3 = vec3(-1,  1, -1);
    vec3 k4 = vec3( 1,  1,  1);

    return normalize(
        k1 * mapOnly(p + k1*e) +
        k2 * mapOnly(p + k2*e) +
        k3 * mapOnly(p + k3*e) +
        k4 * mapOnly(p + k4*e)
    );
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
    float res = 1.0;
    float t = mint;

    for (int i = 0; i < 15; i++) {
        float h = mapOnly(ro + rd * t);
        
        // These are tweaked for the particular scene
        // Might need updating if camera is moved
        if (h < 0.004) return 0.0;
        res = min(res, k * h / max(t, 0.08));
        t += clamp(h, 0.05, 0.45);
        
        if (t > maxt) break;
    }
    
    return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n)
{
    float ao  = 0.0;
    float sca = 1.0;

    for (int i = 0; i < 3; i++) {
        float h = 0.03 + 0.10 * float(i);
        float d = mapOnly(p + n * h);
        ao += (h - d) * sca;
        sca *= 0.55;
    }

    return clamp(1.0 - 2.0 * ao, 0.0, 1.0);
}

float fresnelSchlick(float cosTheta, float F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

float specGGX(float NoH, float a) {
    float a2 = a*a;
    float d  = (NoH*NoH)*(a2-1.0)+1.0;
    return a2 / (3.14159 * d*d);
}

vec3 shade(vec3 ro, vec3 rd) {
    vec3 p; vec2 cellId;
    float t = raymarch(ro, rd, p, cellId);

    vec3 envColor = vec3(0.);
    if (t < 0.0) return envColor;

    vec3 n = calcNormal(p);
    vec3 v = normalize(-rd);

    // Single key light (softbox-ish direction)
    vec3  l1   = normalize(vec3(-0.75, 0.90, 1.05));
    float ao   = calcAO(p, n);
    float NoL1 = max(dot(n, l1), 0.0);

    // Half vector for specular
    vec3  h1   = normalize(l1 + v);
    float NoH1 = max(dot(n, h1), 0.0);

    // Material: near-black glossy
    const float matColor = 0.7;

    // Per-cube variation to avoid "perfectly identical" look
    float h = hash12(cellId + 3.5);
    vec3  albedo = vec3(matColor) + ((h - 0.5) * 0.7);

    float rough = 0.22; // perceptual roughness
    float F0    = 0.26; // base reflectance (quite high; reads as glossy plastic/ceramic)

    float a = max(0.02, rough*rough);

    // Very low diffuse, mostly spec
    vec3 diff = albedo * (0.30 * NoL1);

    // Microfacet specular:
    // D term from GGX-ish distribution
    float D1 = specGGX(NoH1, a);

    // Schlick Fresnel uses V·H
    float VoH1 = max(dot(v, h1), 0.0);
    float F1   = fresnelSchlick(VoH1, F0);

    // Visibility / geometry term: this is a heuristic, not full Smith GGX.
    // It’s cheap and gives roughly the right energy scaling with roughness.
    float Vis = 0.55 / (a + 0.20);

    // Shadowing from the light
    float sh1 = softShadow(p + n*0.006, l1, 0.02, 12.0, 12.0);

    // Spec contribution
    vec3 spec = (D1 * F1 * Vis) * NoL1 * vec3(1.15) * sh1;

    // Final shading: AO applied to both diffuse and spec (because yes)
    vec3 col = (diff + spec) * ao;

    return col;
}

// lookAt builds an orthonormal basis (right, up, forward).
// roll rotates the right/up frame around forward axis.
mat3 lookAt(vec3 ro, vec3 ta, float roll) {
    vec3 fw = normalize(ta - ro);
    vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(rt, fw);

    float cs = cos(roll), sn = sin(roll);
    rt = rt*cs + up*sn;
    up = cross(rt, fw);

    return mat3(rt, up, fw);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    // Normalized screen coordinates, preserving aspect ratio
    vec2 uv = (fragCoord.xy - 0.5*iResolution.xy) / iResolution.y;

    // Camera setup: slightly elevated, looking downward at the grid
    vec3 ro = vec3(0.6, 3.4, -4.2);
    vec3 ta = vec3(0.0, 0.2, -0.6);

    // Subtle drift / orbit to make the scene feel alive
    float tt = iTime * 1.45;
    ro.xz += vec2(sin(tt), cos(tt)) * 0.05 + vec2(1.5, 1.5);
    ta.xz += vec2(sin(tt*1.1), cos(tt*0.9)) * 0.03;

    mat3 cam = lookAt(ro, ta, 0.0);

    // Pinhole camera ray. focal > 1.0 = narrower FOV (telephoto-ish).
    float focal = 1.20 + sin(tt * 0.5) * 0.1; //subtle 
    vec3 rd = normalize(cam * vec3(uv, focal));

    vec3 col = shade(ro, rd);

    // Simple Reinhard tonemap (compress highlights)
    col = col / (col + vec3(1.0));

    // Slight gamma-ish adjustment (0.95 brightens a bit)
    col = pow(col, vec3(0.95));

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
