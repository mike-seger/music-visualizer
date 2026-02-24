// https://www.shadertoy.com/view/WfdfDr

float getFreq(float low, float high) {
    float sum = 0.0;
    // GLSL ES 1.00 requires integer loop indices with constant bounds.
    // Run 8 iterations (covers the widest call: high-low=1.0, step=0.2 → 6 steps)
    // and conditionally accumulate only while within [low, high].
    for (int j = 0; j < 8; j++) {
        float fi = low + float(j) * 0.2;
        sum += (fi <= high) ? texture(iChannel0, vec2(fi, 0.25)).x : 0.0;
    }
    return sum / ((high - low) / 0.05);
}

vec3 palette( float t ) {
    vec3 a = vec3(0.5, 0.5, 0.5);
    vec3 b = vec3(0.5, 0.5, 0.5);
    vec3 c = vec3(1.0, 1.0, 1.0);
    vec3 d = vec3(0.263,0.416,0.557);

    return a + b*cos( 6.28318*(c*t+d) );
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;
    vec2 uv0 = uv;

    float bass = getFreq(0.0, 0.1) * 0.6; 
    float mid = getFreq(0.2, 0.5) * 0.6;
    float vol = getFreq(0.0, 1.0) * 0.6;

    vec3 finalColor = vec3(0.0);
    
    for (int i = 0; i < 4; i++) {
        
        uv = fract(uv * 1.5) - 0.5;

        float d = length(uv) * exp(-length(uv0));
        
        vec3 col = palette(length(uv0) + float(i)*.4 + iTime*.4 + mid);

          
        float baseSpeed = iTime * 1.9;
    
        d = sin(d * 10.0 + baseSpeed + vol * 20.0) / 10.0;
        
        d = abs(d);

        d = pow(0.008 / d, 1.9);
        
        finalColor += col * d;
    }
    
   
    float len = length(uv0);
    finalColor *= 1.0 - len * 0.5;
    
    finalColor = pow(finalColor, vec3(0.9));

    fragColor = vec4(finalColor, 1.0);
}
