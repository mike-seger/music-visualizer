// "In Berlin after Sandy" by hamoid
// https://www.shadertoy.com/view/XtjfD3
// Another audio reactive experiment

const float PI = 3.14159;
void mainImage( out vec4 O, in vec2 uv ) {
    uv /= iResolution.y;   
    float t = iChannelTime[0] / 180.;
    uv.x -= t*.5;
    uv.y += iResolution.y/(iResolution.x*t*5.);
    
    vec2 m = uv - 0.5;
    float a = atan(m.x, m.y) / PI;
    a = abs(a);
    float d = length(m) / 0.7;

    // look at low freqs
    float v1 = texture(iChannel0, vec2(a * .3, .0)).r;
    v1 *= smoothstep(.8-t, .9, sin(d*20.-iTime - t*2.*v1));
    v1 *= .5 + .5 * cos(d * 7.5 + PI);

    // look at high freqs
    float v2 = 5. * texture(iChannel0, vec2(d * .7 + .3, .0)).r;
    
    d = d + v2 + t * 6.;   
    vec3 c = vec3(v1) + 
        v2 * (.5 + .5 * vec3(sin(d*2.), sin(d*1.5), sin(d)));

    O = vec4(c, 1.0);
}
