// "Electromagnetic Politics" by Kali
// https://www.shadertoy.com/view/3d2cDt
// Decided to take out this scene from my previous shader and post it in a new one. The other shader was renamed as "Psychoid".

// @channelRemap: iChannel1 (audio) → iChannel0

// # Buffer A

#define iTime iChannelTime[1]
const int aa=3;
float k;

mat2 rot(float a) {
    a=radians(a);
	float s=sin(a), c=cos(a);
    return mat2(c,s,-s,c);
}

vec3 fractal(vec2 p) {
    p+=vec2(sin(iTime),cos(iTime))*.150;
    float snd = 0.;
    for(int i = 0; i<4; i++) snd += texelFetch(iChannel0, ivec2(i, 1), 0).x/4.;
    p *= 1. - (smoothstep(0., .05, snd - .5) - .5)*.03;
    p/=dot(p,p); 
	float d=length(p)*.0015*k;
    p*=rot(sin(iTime*.5)*45.);    
    p*=-sin(iTime*.1)*2.;
    p+=.5+cos(iTime*1.15*.5);
	float ml=100., m=100.;
    vec2 mc=vec2(100.);
    for (int i=0; i<5; i++) {
    	p=abs(5.-mod(p*2.,10.))-.5;
        p*=4./dot(p,p);
    	p*=rot(-180.);
        ml=min(ml,min(abs(p.x),abs(p.y)));
        mc=min(mc,abs(p));
        m=min(m,abs(p.x-1.));
    }
    float l=smoothstep(.0,.5,abs(.5-fract(m+iTime*1.15)));
    ml=exp(-20.*ml);
    m=exp(-20.*m);
    mc=exp(-10.*mc);
    return vec3(mc.x,ml*.6,mc.y*1.5)*ml*l*l+m+d*(1.+k);
}




void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	k=texture(iChannel0,vec2(.6)).r;
    k=smoothstep(.3,.7,k)*4.;
    vec2 uv=(fragCoord.xy-iResolution.xy*.5)/iResolution.y;
    vec2 pix=1./iResolution.xy/float(aa*2);
    vec3 col=vec3(0.);
    for(int i=-aa; i<=aa; i++) {
	    for(int j=-aa; j<=aa; j++) {
        	vec2 d=vec2(i,j)*pix;
            col+=fractal(uv+d);
        }
    }
    col/=float(aa*aa*4);
    col=mix(vec3(length(col)),col,.7);
    col=mix(texture(iChannel0,fragCoord.xy/iResolution.xy).rgb,col,.3);
    fragColor = vec4(col,k)*step(.1,iChannelTime[1]);
}

// # Image

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	vec2 uv=fragCoord.xy/iResolution.xy;
    vec4 col=texture(iChannel0,uv);
    fragColor = vec4(col);
}

