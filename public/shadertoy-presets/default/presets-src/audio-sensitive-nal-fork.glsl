// "Audio Sensitive-NaL fork" by TheHarmacist
// https://www.shadertoy.com/view/fdsfRH
// Made some changes to the time scale using the texture rendered out by iChannel0

#define S(a, b, t) smoothstep(a,b,t)

float DistLine(vec2 p, vec2 a, vec2 b)
{
    vec2 pa = p-a;
    vec2 ba = b-a;
    float t = clamp(dot(pa, ba)/dot(ba, ba),0.0,1.0);
    return length(pa-ba*t);
}

float N21(vec2 p)
{
    p = fract(p*vec2(562.54, 853.12));
    p += dot(p, p+213.85);
    return fract(p.x*p.y);
}

vec2 N22(vec2 p)
{
    float n = N21(p);
    return vec2(n, N21(p+n));
}

vec2 GetPos(vec2 id, vec2 offset)
{
    vec2 n = N22(id+offset)*iTime;
    return offset+sin(n)*0.4;
}

float Line(vec2 p, vec2 a, vec2 b)
{

    float d = DistLine(p,a,b);
    float m = S(0.03, 0.005, d);
    float d2 = length(a-b);
    m*= S(1.2,0.8,d2)*0.2 + S(0.05,0.03, abs(d2-0.75));
    return m;
}

float Layer(vec2 uv)
{
    float m = 0.0;
    vec2 gv = fract(uv)-0.5;
    vec2 id = floor(uv);
    
    vec2 p[9];
    int i = 0;
    for(float y = -1.0;y<=1.0;y++)
    {
       for(float x=-1.0;x<=1.0;x++)
       {
           p[i++] = GetPos(id, vec2(x,y));
       }
    }
    float t = iTime*10.0;
    for(int i =0;i<9;i++)
    {
        m+= Line(gv, p[4], p[i]);
        vec2 j = (p[i] - gv)*20.0;
        float sparkle = 1.0/(dot(j,j));
        m+= sparkle*(sin(t+fract(p[i].x)*10.0)*0.5+0.5);
        
    }
    m+= Line(gv, p[1], p[3]);
    m+= Line(gv, p[1], p[5]);
    m+= Line(gv, p[7], p[3]);
    m+= Line(gv, p[7], p[5]);
    return m;
    }

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord-0.5*iResolution.xy)/iResolution.y;
    
    //float d = DistLine(uv, vec2(0), vec2(1));
    
    float fft = texelFetch(iChannel0, ivec2(0.7,0.0),0).x;
    vec2 mouse = (iMouse.xy/iResolution.xy)-0.5;
    float t = iTime*0.05;
    float modif = abs(sin(sin(fft*0.07)*fft));
    clamp(modif, 0.25, 1.5);
    modif*=0.5;
    t += modif;
    float m = 0.0;
    
    float rotScale = 5.0;
    float s = sin(t*rotScale);
    float c = cos(t*rotScale);
    //add some offset to rotScale for bobbing: 1.0-5.0)
    
    float gradient = uv.y;
    mat2 rot = mat2(c,-s, s, c);
    uv*=rot;
    mouse*=rot;
    
    for(float i=0.0;i<1.0;i+=1.0/4.0)
    {
        float z = fract(i+t);
        float size = mix(10.0, 0.5,z);
        float fade =  S(0.0, 0.5, z)*S(1.0, 0.8,z); 
        m += Layer(uv*size+i*20.0-mouse)*fade;
    }
    
    vec3 base = sin(t*20.0*vec3(0.235, 0.69, 0.53))*0.4+0.6;
    vec3 col = m*base;
    gradient*=fft*1.5;
    col-=gradient*base;
    //col.rg= id*0.2;
    
    /*if(gv.x>0.48||gv.y>0.48)
    {
        col=vec3(1,0,0);
    }*/
    
    
    fragColor = vec4(col,1.0);
}
