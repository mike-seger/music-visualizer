// CC0: Another day, another glowmarcher

// Twigl link: https://twigl.app?ol=true&ss=-OmZSyy0GfTTuMjy66sJ

#define N normalize

void mainImage(out vec4 o, vec2 C) {
    vec3 p, P, Z;
    vec3 I = iResolution;
    vec3 S;

    vec2 A = vec2(0.4, 0.3);
    vec2 s;

    C += C - I.xy;
    s = sin(A * iTime);
    Z = N(vec3(A * cos(A * iTime), 1.0));
    S = N(cross(vec3(0.0, 1.0, 0.0) + vec3(A * A * s, 0.0), Z));
    I = N(C.y * cross(S, Z) + 2.0 * I.y * Z - C.x * S);
    S = vec3(s, iTime);

    vec4 O;

    for (float i = 0.0, d = 0.0, z = 0.0; ++i < 77.0; O += o.w * o / d) {
        p    = z * I + S;
        s    = sin(A * p.z);
        p.xy -= s;
        Z    = N(vec3(A * cos(A * p.z), -1.0));
        p    -= dot(p.xy, Z.xy) * 0.5 * Z;
        p.xy *= mat2(cos(vec4(0.0, 11.0, 33.0, 0.0) - (A * A * s).x));
        P    = p;
        p    -= round(p);
        d    = 1e-3 + 0.7 * abs(0.53 - sqrt(length(p * p)));
        z    += d;
        o    = 0.9 + sin(2.0 * abs(P.x) + vec4(8.0, 3.0, 4.0, 2.0));
    }

    o = tanh(O / 2e4);
}
