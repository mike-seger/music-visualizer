// "Future Flash" by Kali
// https://www.shadertoy.com/view/ftKBR3
// 6kb intro by Latitude Independent Association (LIA) awarded 1st place in combined PC intro/demo compo at Flashparty 2022 code: kali - music: uctumi Please rewind after it starts for proper audio sync It could take forever to compile, sorry!

// # Buffer A

//#define ti iChannelTime[0]
#define ti iTime-2.
float time;

#define resolution iResolution

float st=.11, maxdist=20.,m,mc;
float td, t, yy;
float z, ed, mo;
vec3 neoncolor=vec3(1,0,0);
vec3 lightpos, carpos, advcar;
vec3 from;
vec2 pos;
vec3 cp;
float h;
float siroof = 0.;
float lo;
float det=.003;
vec2 e = vec2(0, .006);

const float escena2=48.5;
const float escena3=55.;
const float escena4=61.5;
const float escena5=68.;
const float escena6=80.;
const float escena7=86.5;
const float escena8=105.;
const float escena9=111.;

#define f1 int[] (271,195,831,1006,819,799,831,33567,3084,25600,0,2437,3207,3462,3463)
#define f2 int[] (207,255,524519,463,0,9199,25600,0,41219,831,195,3276,0,0,0)
#define f3 int[] (24627,243,1006,3276,207,0,9199,25600,0,243,207,3084,243,24627,3276)
float frase;

vec4 text(vec2 U) {
    U.x+=.67; 
    vec2 pp = U*15., A, D;pp.y-=.5+sin(floor(pp.x/1.4)*2.+time*2.)*.1;
	vec4 c = vec4(0), S = vec4(.5,-.5,1,0), V;
    for (int l, i=min(iFrame*2,0); i<15; i++)  {
        if (frase==1.) l=f1[i];
        if (frase==2.) l=f2[i];
        if (frase==3.) l=f3[i];
        float v = 1.;
        vec2 p=pp-.5;
        p*=1.+dot(p,p);
        p+=.5;
        for( int i=0; i<20; i++, l/=2)
            if (l%2 > 0)
            {
                V = vec4[](S.wwwx,S.wxwx,S.wzxw,S.xzxw,S.zxwx,S.zwwx,S.xwxw,S.wwxw,S.wxxw,S.xxxw,S.xwwx,S.xxwx,S.wwxx,S.xxxx,S.wzxy,S.xxxy,S.wxxy,S.xwxx,S.wxxx,S.xzxy)[i],
                A = p - V.xy, D = V.zw,
                v = min(v,length(A-D*clamp(dot(A,D)/dot(D,D),.0,1.)));
            }
        c += step(v,.12) * (1.+pp.y*.0) * vec4(1.5,0.2,0.3,0);
        pp.x -= 1.4;
     }
     return c;
}

vec3 path(float t) {
    t-=smoothstep(escena8+3.,escena8+23.,time)*8.;
    t-=smoothstep(escena8+13.,escena8+30.,time)*5.;
    vec3 p=mix(vec3(sin(t*.2)*5.,6.3+cos(t)*.1,t),vec3(0.,-t-3.,0.),smoothstep(-20.,5.,t));
    p=mix(p,vec3(sin(t*.2)*7.,-16.,t),smoothstep(35.,45.,time));
    if(time>escena4) p=vec3(sin(t*.3)*19.,-21.,cos(t*.3)*19.);
    float s=sin(t*.3);
    if(time>escena6) p=vec3(s*s*s*3.,-20.5,t*5.-115.-escena6);
    float b=smoothstep(escena8,escena8+4.,time);
    p.x*=(1.-b);
    p.y-=b*5.;
    return p;
}

mat3 lookat(vec3 dir, vec3 up) {
	dir=normalize(dir);vec3 rt=normalize(cross(dir,normalize(up)));
    return mat3(rt,cross(rt,dir),dir);
}


mat2 rot(float a) {
	float s=sin(a),c=cos(a);
    return mat2(c,s,-s,c);
}

float hash(vec2 p)
{
	vec3 p3  = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float noise( in vec2 p )
{
    vec2 i = floor( p );
    vec2 f = fract( p );
	
	vec2 u = f*f*(3.0-2.0*f);

    return mix( mix( hash( i + vec2(0.0,0.0) ), 
                     hash( i + vec2(1.0,0.0) ), u.x),
                mix( hash( i + vec2(0.0,1.0) ), 
                     hash( i + vec2(1.0,1.0) ), u.x), u.y);
}


vec3 fractal(vec2 p)
{
    vec2 pp=p;
    p = abs(fract(p * .05) - .5);
    float ot1 = 1000., ot2 = ot1;
    for (float i = 0.; i < 6.; i++) {
        p = abs(p) / clamp(abs(p.x * p.y), 0.15, 5.) - vec2(1.5, 1);
        ot1 = min(ot1, abs(p.x) + step(time,35.)*.08*step(floor(length(p)) * .1 + fract(time * .7 + float(i) * .2), .5 * floor(p.y)))*.8;
        ot2 = min(ot2, length(p));
    }
    ot1 = smoothstep(.1, .05, ot1);
    vec3 col = vec3(p, 0) * ot2 * ot1 * .3 + ot1 * .3; 
    col.rb*=rot(pp.y*.3);
    return abs(col);
}


float line( vec2 p, vec2 a, vec2 b)
{
  vec2 pa = p - a, ba = b - a;
  float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
  return length( pa - ba*h );
}

float logo(vec2 uv) {
    uv*=-.17;
    uv=-uv.yx;
    uv*=rot(-.35);
    float c = line(uv, vec2(-.65,.3), vec2(-.65,-.3));    
	c = min(c,line(uv, vec2(-.65,-.3), vec2(-.35,-.3)));
	c = min(c,line(uv, vec2(-.15,.3), vec2(-.15,-.3)));
	c = min(c,line(uv, vec2(.25,.3), vec2(.05,-.3)));
	c = min(c,line(uv, vec2(.3,.3), vec2(.50,-.3)));
	c = min(c,line(uv, vec2(.5,-.3), vec2(.2,-.3)));
    return smoothstep(.08,.05,c);
}


float obj;

float map(vec2 p) {
    pos = p;
    vec2 p2=p;
    h=0.;
    h-=smoothstep(35.,40.,time)*25.-smoothstep(escena7,escena7+5.,max(0.,time+p.y-75.));
    if (length(p)<5.&&time<escena6) {
        h-=exp(-2.*length(p))*100.;
        return h;
    }
    if (time<escena6) p*=rot(.5),p=vec2(atan(p.x,p.y)/3.1416*4.*10., length(p));
    siroof=0.;
    obj=0.;
    h+=(hash(floor(p))*3.+hash(floor(p*2.))*0.)*step(.7,hash(floor(p*.5)));
    h+=hash(floor(p*2.+123.))*1.;
    h+=hash(floor(p*8.+223.))*1.;
    if (hash(floor(p+321.))>.7) siroof = 1.;
    if(time>30.&&time<escena6) {
        h=-20.+sin(floor(p.x*2.)*.5+time)+(time<escena3?abs((cos(p.y*.5)*20.)/20.):(cos(p.y*.5)*20.)/20.)*4.;
        h-=step(fract(p.x*2.), .3)*20.;
        pos = p;
    }
    h=h*(.15+smoothstep(5.,10.,time));
    if(time<11.) {
        lo=logo((p2-vec2(9.,-22.)));
        h=max(lo,h);
    }
    float h2=length(min(sin(p),step(.5,hash(floor(p)))))*smoothstep(.0,3.5,abs(p.y-19.5))*3.-23.5+step(3.,abs(p.y-19.5));
    h2=mix(h2,-25.+hash(floor(p))*2.-smoothstep(5.,10.,carpos.z-p.y)*2.,smoothstep(escena6-4.,escena6-1.,time));
    if (time<escena6) h = mix(h, h2,smoothstep(escena5,escena5+5.,time));
    else h=mix(h2,h,smoothstep(escena7,escena7+5.,time+p.y-50.));
    p.y-=110.+escena8;
    float l=length(p);
    if (abs(p.x)<3.&&p.y>-55.) h=-27.;
    h=max(h,-15.-abs(p.y));
    if (length(max(vec2(0.),abs(vec2(p.x*.7,yy+27.))-1.15))<.01&&p.y>-55.) h=-100.;
    return h;
}

float de(vec3 p) {
    p.z=min(202.,p.z);
    p-=carpos;
    p.y+=.3+step(escena5,time)*.9*step(time,escena6)-step(escena7,time)*.05+smoothstep(escena8+10.,escena8+15.,time)*.3;
    float bound = length(p)-1.;
    if (bound>0.) return bound+.5;
    advcar.y=0.;
    p=lookat(advcar,vec3(0.,1.,0.))*p;
    p.xy*=rot(-step(escena5,time)*.3*smoothstep(escena6+2.,escena6,time)+.1*sin(time*1.3)+step(escena6,time)*advcar.x+smoothstep(escena8+1.,escena8+3.,time)*3.1416*2.);
    p.y*=1.7;
    p.x*=1.;
    float l=length(p+vec3(0.,-0.05,0.));
    p.x+=smoothstep(-.0,-.1,p.z)*.025*sign(p.x);
    p.y-=smoothstep(.02,0.,abs(p.x))*.02;//*sign(p.y-.03);
    p.y+=smoothstep(.02,0.,abs(p.x)-.05)*.02;
    p.y*=1.+smoothstep(.05,.0,p.y)*.5;
    p.z*=1.-smoothstep(.1,.0,p.z)*.15;
    p.z+=smoothstep(.05,.07,abs(p.x))*.02;
    float d=length(p)-.12;
    d=max(d,-p.y+.045+abs(p.x)*.15+max(0.,-p.z*.1));
    d=max(d,-abs(p.x)+.06-step(0.0,p.z));
    d=min(d,l-.065);
    cp=p;
    return d*.3;
}


vec3 normal2(vec2 p) {
	vec2 eps=vec2(0.,.01);
    return normalize(vec3(map(p+eps.yx)-map(p-eps.yx),2.*eps.y,map(p+eps.xy)-map(p-eps.xy)));
}


float edge=0.;

vec3 normal(vec2 p) { 
	vec2 e = vec2(0.0,.01);
	float d1=map(p+e.yx),d2=map(p-e.yx);
	float d3=map(p+e.xy),d4=map(p-e.xy);
	float d=map(p);
	edge=abs(d-0.5*(d1+d2))+abs(d-0.5*(d4+d3));
	edge=min(1.,edge*10.);
	return normalize(vec3(d1-d2,2.*e.y,d3-d4));
}

vec4 hit(vec3 p) {
    float h = map(p.xz), d = de(p);
    return vec4(step(p.y,h), step(d,det), h, d);
}

vec3 bsearch(vec3 p, vec3 dir) {
    st*=-.5;
    float h2=1.;
    for (int i=0; i<20; i++) {
        p+=dir*st;
        vec4 hi=hit(p);
        float h=max(hi.x, hi.y);
        if (abs(h-h2)>.001) {
            st*=-.5;
	        h2=h;
        }
    }
	return p;
}

vec3 shade(vec3 p, vec3 dir, float h) {
 	vec3 col = vec3(m*obj*2.);
    vec3 ldir=normalize(vec3(-.5,-1.,-1.));
	vec3 n=normal(p.xz);
    float amb=pow(max(0.,dot(dir,n)),3.)*.2;
    float dif=max(0.,dot(ldir,-n))*.0;
    vec3 ref=reflect(dir,ldir);
    float spe=pow(max(0.,dot(ref,-n))*.5,3.)*(4.-step(escena8,time));
    p.y-=(h-10.)*step(38.,time);
    p.xz=pos;
    vec3 fr=fractal(p.xy*1.5)*abs(n.z);
    fr+=fractal(p.yz*1.5)*abs(n.x);
    fr+=fractal(p.xz)*abs(n.y);
    fr*=.6-step(escena5,time)*.2;
    edge*=step(-floor(p.x)*.1,time-5.)-step(escena5,time)*.5;
    vec3 c=col+amb+dif+edge*siroof*step(h-.05, p.y)*neoncolor+fr*smoothstep(12.,12.5,time+p.x*.2);
    vec3 fin=mix(c,(step(.95,fract(pos.x*2.+.5))+step(.9,fract(pos.y*5.+.1)))*(.3+fr*1.5),smoothstep(70.,75.,time));
    fin+=c*.5*smoothstep(escena5,escena5+1.,time);
    return fin+spe+lo*.4;
}


vec3 march(vec3 from, vec3 dir) {
	vec3 p, pd, col=vec3(0.);
    td=2.+hash(dir.xy*100.)*.3+step(time,8.)*5.;
    float td2=-hash(dir.xy*100.)*.1;
    float k=0.;
    float h=0.;
    float l=0.;
    float d=0.;
   	for (int i=0; i<200; i++) {
        st+=.001;
        p=from+dir*td;
    	pd=from+dir*td2;
        z=p.z-from.z;
        yy=p.y;
        d=de(pd);
        if (p.y<5.-20.*step(escena5,time)) h=map(p.xz); 
        if (h > p.y || d<det || td>maxdist) break;
        if (p.z>3.) {
            vec3 p2=p;
            p2*=5.;
            p2.x+=time*sign(sin(p.z));
            vec2 id=floor(p2.xz);
            float hh=hash(id*100.);
            p2.xz=fract(p2.xz)-.5;
            p2.y-=hh*100.-80.;
            l=max(l,step(length(p2),.15)*step(.98,hh));
        }
        td+=st;
        td2+=d;
    }
    float f=pow(td/maxdist,1.);
    if (h > p.y) {
        p=bsearch(p, dir);
    	col=shade(p,dir,h);
    } 
    if (d<det) {
        p-=det*dir;
        pd=bsearch(pd, dir);
        vec3 n=normalize(vec3(de(pd + e.yxx), de(pd + e.xyx), de(pd + e.xxy)) - de(pd));
        vec2 p2=cp.xy*3.;
        float ot=1000.;
        for (int i=0; i<6; i++)
        {
            p2=abs(p2)/clamp(abs(p2.x*p2.y),.25,1.)-2.;
            ot=min(ot,abs(p2.y));
            
        }
        ot=smoothstep(.3,.2,ot);
        col=vec3(.75-ot*.3);
        vec3 ldir=normalize(vec3(-.5,-1.,-1.));
        col*=.6+max(0.,dot(ldir,-n))*(.5-step(escena8-2.,time)*.2);
        col+=fractal(cp.xy*10.)*.5;
        float l=length(cp.xz);
        cp.x=abs(cp.x);
        cp.x-=.025;
        cp.y-=.05;
        col*=.3+.7*max(step(.012,abs(cp.y)),step(.025,cp.x));
        col+=step(abs(cp.x)-.009,.012)*step(abs(cp.y),.006)*vec3(1.,.2,.1);
        col*=.5+.5*step(.05,l);
        col+=step(abs(l-.05),.003)*vec3(0.,0.,1.);
    }
	neoncolor.rb*=rot(-p.y*.15);
	neoncolor*=exp(-.03*p.y);
    if (time>30.) neoncolor+=.3,neoncolor*=.9;
    p.y+=25.47;
    p.x*=-1.;
    float r=max(step(.25,abs(p.y-.24)),step(2.73,abs(p.x)));
    frase=1.;
    if (time>escena9) col=col*r+(1.-r)*.3,col+=text(p.xy*.27).rgb*1.3;
    col=mix(col,neoncolor*.8,f)*(step(escena4,time)+smoothstep(escena4,escena4-.5,time));
    return col+l;
}


void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    time = ti;
    if (ti>129.) time = ti-129.+48.;
    vec2 uv = (fragCoord-resolution.xy*.5)/resolution.y;
	t=-35.+time;
    from=path(t);
    from.x-=cos(time*.3)*.1;
    uv.x+=smoothstep(escena7+5.,escena7,time)*1.5*step(escena7,time);
    if (time>escena4) from=path(t+.6),from.x+=.2,from.y+=.2;
    if (time>escena5) from=path(t+.35), from.y-=1., from.x+=sin(time)*.1;
    if (time>escena6) {
        from=path(t+.6);
        from.y-=-.2+smoothstep(escena6,escena6+3.,time)*.3;
        from.x-=.2;
    }
    if (time>escena7) from=path(t+.3),from.x-=.0,from.z+=.2;
    if (time>escena8-2.&&time<escena9) from=path(t+.6),from.x+=.2,from.y+=.5;
    float tilt=.5*step(time,escena5);
    if (time>17.&&time<23.25) from=vec3(0.,5.,-3.), tilt=0.;
    carpos=path(t+.5);
    carpos.y-=smoothstep(12.,0.,time)*5.;
    advcar=normalize(carpos-path(t+1.5));
    vec3 dir=normalize(vec3(uv,1.));
    vec3 adv=from-path(t-1.);
    if ((time>escena4&&time<escena5)||(time>escena6&&time<escena7)||(time>escena8-2.&&time<escena9)) adv=carpos-from;
    if (time>escena2&&time<escena4) {
        from=vec3(-10.);
        adv=vec3(0.,-25.,0.);
    }
    if (time>escena3&&time<escena4) {
        from=vec3(0,-17.,10.);
        adv=vec3(0.,-30.,-8.);
        from.xz*=rot(time*.1);
    }
    from.z-=smoothstep(88.+escena8,102.+escena8,from.z)*3.;
    from.z=min(94.+escena8,from.z)+max(0.,time-escena8-7.5)*.2;
    dir=lookat(adv+vec3(0.,-.5,0.),vec3(adv.x*tilt,1.,.1))*dir;
    dir.yz*=rot(-.1-step(escena7,time)*.2+smoothstep(escena8,escena8+5.,time)*.3-step(escena7+7.,time)*1.+step(escena7+12.3,time)*1.);
    vec3 col=vec3(0.);
    col=march(from, dir);
    if (ti>129.) frase=2.;
    if (ti>136.) frase=3.;
    if (ti>129.) col=col*.7+text(uv).rgb;
    fragColor = vec4(max(vec3(0.),col),1.);
}

// # Image

#define time iTime

const float max_rad=.015;
const float it=50.;

mat2 rot(float a){
	float s=sin(a);
    float c=cos(a);
    return mat2(c,s,-s,c);
}

float hash(vec2 p)
{
    p*=1342.;
	vec3 p3  = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
	vec2 uv = fragCoord / iResolution.xy;
	mat2 spin=rot(2.39996);
    vec2 p=vec2(0.,1.);
    vec3 res=vec3(0.);
    float rad_step=max_rad/it+hash(uv+time)*.00015;
	float rad=0.;
    float ti=mod(time,10.);
    vec4 col=texture(iChannel0,uv);
    for (float ii=0.;ii<it; ii++) {
        rad+=rad_step;
        p*=spin;
        vec4 col=texture(iChannel0,clamp(uv+p*rad,vec2(0.01),vec2(0.99)));
        res+=smoothstep(.5,1.,max(col.r,max(col.g,col.b)))*col.rgb*2.;
    };
    res/=it;
	col.rgb = length(col.rgb)*vec3(.7);
    fragColor = vec4(col.rgb*.3+res,1.0)*min(1.,time*.5+1.)*(smoothstep(131.,129.,time)+smoothstep(132.,133.,time)-smoothstep(143.,144.,time)); 
}

