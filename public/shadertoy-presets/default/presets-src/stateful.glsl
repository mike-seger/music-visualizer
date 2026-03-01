// "Stateful" by oneshade
// https://www.shadertoy.com/view/sssGzn
// An interesting music driven idea. Music reference taken from this shader: [url=https://www.shadertoy.com/view/tdsXDX]https://www.shadertoy.com/view/tdsXDX[/url]

// @channelRemap: iChannel1 (audio) → iChannel0

// # Common

#define FFT_PARTICLES 50

// # Buffer A

vec2 wrap(in vec2 p, in vec2 rmin, in vec2 rmax) {
   return rmin + mod(p - rmin, rmax - rmin);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 corner = vec2(iResolution.x / iResolution.y * 0.5, 0.5);
    ivec2 iFragCoord = ivec2(fragCoord);
    fragColor = vec4(0.0);
    if (iFrame > 0 && iFragCoord.x < FFT_PARTICLES && iFragCoord.y == 0) {
        fragColor = texelFetch(iChannel0, iFragCoord, 0);
        float freq = fragCoord.x / float(FFT_PARTICLES);

        if (iFrame > 1) fragColor.xy = fragColor.zw;

        float fft = texture(iChannel0, vec2(freq, 0.0)).x;
        fragColor.zw += sin(fft * 6.28 - 3.14 + vec2(1.57, 0.0)) * iTimeDelta;

        bool outOfBounds = any(greaterThan(abs(fragColor.zw), corner));
        fragColor.zw = wrap(fragColor.zw, -corner, corner);
        if (outOfBounds) fragColor.xy = fragColor.zw;
    }
}

// # Buffer B

#define rgb(r, g, b) vec3(r, g, b) / 255.0

// Palette from https://www.color-hex.com/color-palette/26292
// Perhaps there is a better one?
// Added first color at end for a wraparound
vec3[] palette = vec3[](rgb(  0, 137, 123),
                        rgb(  0,  86,  77),
                        rgb( 40,  40,  40),
                        rgb( 54,  54,  54),
                        rgb(150, 150, 150),
                        rgb(  0, 137, 123));

vec3 getColor(in float t) {
    t = fract(t) * float(palette.length() - 1);
    return mix(palette[int(t)], palette[int(t) + 1], smoothstep(0.0, 1.0, fract(t)));
}

vec2 sdLine(in vec2 p, in vec2 a, in vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float d = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return vec2(length(pa - ba * d), d);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = texture(iChannel0, fragCoord / iResolution.xy);

    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float unit = 2.0 / iResolution.y;

    for (int i=0; i < FFT_PARTICLES; i++) {
        vec4 pos = texelFetch(iChannel0, ivec2(i, 0), 0);
        vec2 line = sdLine(uv, pos.xy, pos.zw);
        vec3 color = mix(getColor(iTime - iTimeDelta), getColor(iTime), smoothstep(0.0, 1.0, line.y));
        fragColor = mix(fragColor, vec4(color, 1.0), exp(-50.0 * line.x));
    }

    fragColor *= 0.9;
}

// # Image

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = texture(iChannel0, fragCoord / iResolution.xy);
}

