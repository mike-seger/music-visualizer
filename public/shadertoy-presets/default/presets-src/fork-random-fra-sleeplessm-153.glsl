// "Fork Random fra sleeplessm 153" by sleeplessmonk
// https://www.shadertoy.com/view/DllfWS
// added neon colors and audioreactivity

#define less(a,b,c) mix(a,b,step(0.,c))
#define sabs(x,k) less((.5/k)*x*x+k*.5,abs(x),abs(x)-k)

// Helper function for neon psychedelic colors
vec3 NeonPsychedelicColor(float t) {
    return vec3(
        0.5 + 0.5 * sin(6.0 * t + 2.0),
        0.5 + 0.5 * sin(6.0 * t + 1.0),
        0.5 + 0.5 * sin(6.0 * t + 3.0)
    );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 q = fragCoord / iResolution.xy;
    vec2 p = -1.0 + 2.0 * q;
    p.x *= iResolution.x / iResolution.y;
    p *= 2.2;

    vec2 c = vec2(-0.5, -0.5) * 1.0;
    vec2 u = p;
    
    // Sample audio input from iChannel0
    float audioInput = texture(iChannel0, vec2(0.5, 0.5)).r * 2.0 - 1.0;

    for (int i = 0; i < 5; ++i) {
        float m = pow(dot(u, u), 0.3);
        u = sabs(u, (0.33 + 0.1 * p.y)) / m + c;
    }

    // Apply audioreactive neon psychedelic colors
    float time = iTime * 1.5;
    float spread = sin(time) * 0.2 + audioInput * 1.1;
    vec3 col = NeonPsychedelicColor(length(u + spread));

    fragColor = vec4(col, 1.0);
}
