// "sparkly fractal audio visualizer" by lauriparonen
// https://www.shadertoy.com/view/mdcfDS
// based on this tutorial: https://www.youtube.com/watch?v=f4s1h2YETNY as well as this shader: https://www.shadertoy.com/view/wd3XzS

/*  audio processing logic borrowed from https://www.shadertoy.com/view/wd3XzS */
float sigmoid(float x)
{
    return 1. / (1. + exp(x));
}
   
vec3 sigmoid(vec3 xyz)
{
    return vec3(sigmoid(xyz.x), sigmoid(xyz.y), sigmoid(xyz.z));
}

float sampleAt(float f)
{
    return texture(iChannel0, vec2(f / 16.0, 0)).x;
}

float sampleMultiple(float f)
{
    float delta = .1;
    return 0.1 * (sampleAt(f - 2. * delta) + sampleAt(f - delta) + sampleAt(f) + sampleAt(f + delta) + sampleAt(f + 2. * delta));
}


vec3 palette( in float t )
{
    /* 
        gotten from http://dev.thi.ng/gradients/
        find a gradient you like and change the values of the four vectors
        respectively to the values of the vector of coefficients on the page
        
        e.g.: 
        
        [[0.500 0.500 0.500] [0.500 0.500 0.500] [1.000 1.000 1.000] [0.000 0.333 0.667]]
              
        —>
              
        vec3 a = vec3(0.500, 0.500, 0.500);
        vec3 b = vec3(0.500, 0.500, 0.500);
        vec3 c = vec3(1.000, 1.000, 1.000);
        vec3 d = vec3(0.000, 0.333, 0.667);
        
    */
    
    vec3 a = vec3(0.678, -1.502, 0.388);
    vec3 b = vec3(-0.252, 0.054, 0.450);
    vec3 c = vec3(-2.892, 2.168, 0.930);
    vec3 d = vec3(-1.252, -0.918, -1.582);
    
    return a + b*cos( 6.28318*(c*t+d) );
}

float MAX_ITER = 3.5; // edit this value to alter the complexity of the figure
                      // large number -> lots of details

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;  
    vec2 uv0 = uv;
    vec3 finalColor = vec3(0.0);
    
    for (float i = 0.0; i < MAX_ITER; i++) { 
    
        uv = fract(uv * 1.5) - 0.5;

        float d = length(uv) * exp(-length(uv0));
        
        float amplitude = sampleMultiple(d * d);

        d -= .8 * amplitude;
        
        vec3 col = palette(length(uv0) + sampleMultiple(1.0));
        
        float weird = sigmoid(abs(uv.x) * abs(uv.y));

        float speed = 3. * amplitude * sin(sampleMultiple(d) * weird * 0.05) * 0.1;

        float brightness = 1.5 * amplitude * sigmoid(sin(d * d * 16. - speed * iTime + 2. * speed * amplitude));

        //d += sin(d*15. + iTime)/15.; 
        d += sin(d*0.1 + sampleMultiple(1.0)/10.);
        d = abs(d);

        d = 0.02 / d;

        col *= brightness;

        finalColor += col * d;
        
    }
    
    fragColor = vec4(finalColor, 1.0);
}
