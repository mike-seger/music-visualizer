// "Mutator" by voodoovoid
// https://www.shadertoy.com/view/DttXDj
// Fun times with Braek's music

// @iChannel1: /shadertoy-media/85a6d68622b36995ccb98a89bbb119edf167c914660e4450d313de049320005c.png

#define PI 3.14159265359

// Function to map a value from a certain range to another range.
float map(float value, float inputMin, float inputMax, float outputMin, float outputMax) {
    return outputMin + ((value - inputMin) / (inputMax - inputMin)) * (outputMax - outputMin);
}

// Function to create a circular mandala pattern.
void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    vec2 uv = (fragCoord - 0.5*iResolution.xy) / min(iResolution.y, iResolution.x);
    
    float zoom = pow(2.0, sin(iTime*0.1));
    uv /= zoom;
    
    float radius = length(uv);
    float angle = atan(uv.y, uv.x);
    
    float mandala = 0.0;
    
    // Get sound data
    vec4 sound = texture(iChannel0, vec2(uv.x, 0.0));

    float time = iTime * 17.17;
    float arms = 16.0 + sin(time)*8.0 + sound.x*8.0; // Modify the number of arms based on sound data
    
    angle += time + sin(time)*PI/arms;
    
    for(float i = 0.0; i < 6.0; i++) {
        float pattern = mod(angle * zoom + i*PI/3.0, PI/arms) * arms/PI;
        pattern = abs(1.0 - pattern);
        
        pattern *= sin(radius*20.0 - iTime*0.5 + sound.y*10.0); // Modify the radius based on sound data
        
        radius = pow(radius, map(sin(time), -1.0, 1.0, 0.5, 2.0));
        pattern = pow(pattern, map(cos(time), -1.0, 1.0, 0.5, 2.0));
        
        mandala += sin(10.0 * (pattern + radius - time));
        mandala += sin(20.0 * pattern + time) / 2.0;
    }
    
    mandala *= 1.0 - radius;
    mandala = map(mandala, -2.0, 2.0, 0.0, 1.0);
    
    vec3 color = vec3(mandala);
    color *= 1.0 - 0.5 * radius;
    
    fragColor = vec4(color, 1.0);
}
