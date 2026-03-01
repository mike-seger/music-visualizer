// "Another audio visualizer" by leon
// https://www.shadertoy.com/view/MsSyWc
// Experimentation with feedback, trying to make a vinyl effect.

// @channelRemap: iChannel1 (audio) → iChannel0

// # Buffer A

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	vec2 uv = fragCoord.xy / iResolution.xy;
    
	float fft  = texture( iChannel0, vec2(uv.y,0.25) ).x; 
	float wave = texture( iChannel0, vec2(uv.x,0.75) ).x;
    
    float unit = 1./iResolution.y;
    vec2 uvBuffer = uv + vec2(fft*10.,0.)*unit;
    //float should = step(1.-unit, uv.x);
	fft = smoothstep(0.3,0.9,fft);
    float should = (0.5/(fft-(1.-uv.x)/0.1));
    //uvBuffer.x += (1.-fft)*unit*10.;
    vec3 buffer = texture(iChannel0, uvBuffer).rgb;
    
    vec3 sound = vec3(1,0.2,0.1)*fft;
    
    vec3 color = mix(buffer, sound, clamp(should,0.,1.));
    fragColor = vec4(color,1.0);
}

// # Image

// music : https://soundcloud.com/nanarthur/12-jet-set-radio-funky-radio

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	vec2 uv = fragCoord.xy / iResolution.xy;
        
    uv = mod(abs(uv*2.-1.),1.);
    uv *= 0.5;
    uv.x *= iResolution.x/iResolution.y;
    
    //uv.x = 1.-uv.x;
    float a = atan(uv.y,uv.x)/3.14159;
    float r = length(uv);
    uv = vec2(a,r);
    vec3 color = texture(iChannel0, uv).rgb;
    
    uv = vec2(r*1.5, a*2.);
    uv = mod(abs(uv*2.-1.),1.);
    float fft = texture(iChannel0, vec2(1.,uv.y)).r;
    vec3 red = vec3(0.9,0.1,0.2);
    float plotter = 0.1/((0.5/(1.-fft))-uv.x/0.5);
    
    
    color = mix(color, red, plotter);
    
	fragColor = vec4(color,1.0);
}

