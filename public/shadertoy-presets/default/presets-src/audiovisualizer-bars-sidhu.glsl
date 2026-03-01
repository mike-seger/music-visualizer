// "AudioVisualizer bars (sidhu)" by ramansinghdhiman
// https://www.shadertoy.com/view/lfBSRw
// An audio visualization in bars shape

void mainImage(out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord/iResolution.xy;
    
    vec2 nv = uv;
    nv.y = abs((nv.y - 0.5) * 2.0);
    
    float barCount = 50.0;
    float w = texture(iChannel0, vec2(floor(nv.x * barCount) / barCount, 0.0)).r;
    float bars = step(nv.y, w) * step(fract(uv.x * barCount), 0.7) * step(0.01, nv.y);

    vec3 col = mix(vec3(0.7, 0.0, 0.7), vec3(1.0, 0.0, 0.0), nv.y) * bars * mix(0.5, 1.0, step(0.5, uv.y));
    
    fragColor = vec4(col,1.0);
}
