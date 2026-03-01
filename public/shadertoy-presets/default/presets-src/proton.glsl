// "Proton" by Nimajamin
// https://www.shadertoy.com/view/XlySWd
// Music: https://soundcloud.com/ngc4244/breathe-and-do-shit (C) 2016-17 Intrepid & N-e-b-u-l-o-u-s

// @channelRemap: iChannel0 (texture) → iChannel3, iChannel3 (audio) → iChannel0

// @iChannel1: /shadertoy-media/52d2a8f514c4fd2d9866587f4d7b2a5bfa1a11a0e772077d7682deb8b3b517e5.jpg
// @iChannel2: /shadertoy-media/f735bee5b64ef98879dc618b016ecf7939a5756040c2cde21ccb15e69a6e1cfb.png
// @iChannel3: /shadertoy-media/e6e5631ce1237ae4c05b3563eda686400a401df4548d0f9fad40ecac1659c46c.jpg

//
// [ "Breathe" ] - Nimajamin, iq & chronos 2017
//

// Ray-marching based on: "[NV15] Space Curvature" by iq
    
// Created by inigo quilez - iq/2015
// Modified by benjamin hathaway - nimajamin/2017
// License Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported License.

//
// Audio visualisation..
//
// - Modified version of the Soundcloud example by: chronos
// - https://www.shadertoy.com/view/lsdGR8
//

//
// Music: https://soundcloud.com/ngc4244/breathe-and-do-shit
// 
// (C) 2016-17 Intrepid & N-e-b-u-l-o-u-s
// All rights reserved
//
// [ ncg 4244 ]
//

#define speed1  			0.0003330 
#define K_MAX_DISTANCE		200.0

vec3 fancyCube( sampler2D sam, in vec3 d, in float s, in float b )
{
    vec3 colx = texture( sam, 0.5 + s*d.yz/d.x, b ).xyz;
    vec3 coly = texture( sam, 0.5 + s*d.zx/d.y, b ).xyz;
    vec3 colz = texture( sam, 0.5 + s*d.xy/d.z, b ).xyz;
    
    vec3 n = d*d;
    
    return (colx*n.x + coly*n.y + colz*n.z)/(n.x+n.y+n.z);
}


vec2 hash( vec2 p ) { p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }

vec2 voronoi( in vec2 x )
{
    vec2 n = floor( x );
    vec2 f = fract( x );

	vec3 m = vec3( 8.0 );
    for( int j=-1; j<=1; j++ )
    for( int i=-1; i<=1; i++ )
    {
        vec2  g = vec2( float(i), float(j) );
        vec2  o = hash( n + g );
        vec2  r = g - f + o;
		float d = dot( r, r );
        if( d<m.x )
            m = vec3( d, o );
    }

    return vec2( sqrt(m.x), m.y+m.z );
}

float shpIntersect( in vec3 ro, in vec3 rd, in vec4 sph )
{
    vec3 oc = ro - sph.xyz;
    
    float b = dot( rd, oc );
    float c = dot( oc, oc ) - sph.w*sph.w;
    float h = b*b - c;
    if( h>0.0 ) h = -b - sqrt( h );
    return h;
}

float sphDistance( in vec3 ro, in vec3 rd, in vec4 sph )
{
	vec3 oc = ro - sph.xyz;
    float b = dot( oc, rd );
    float h = dot( oc, oc ) - b*b;
    return sqrt( max(0.0,h)) - sph.w;
}

float sphSoftShadow( in vec3 ro, in vec3 rd, in vec4 sph, in float k )
{
    vec3 oc = sph.xyz - ro;
    float b = dot( oc, rd );
    float c = dot( oc, oc ) - sph.w*sph.w;
    float h = b*b - c;
    return (b<0.0) ? 1.0 : 1.0 - smoothstep( 0.0, 1.0, k*h/b );
}    
   

vec3 sphNormal( in vec3 pos, in vec4 sph )
{
    return (pos - sph.xyz)/sph.w;    
}

//=======================================================

vec3 background( in vec3 d, in vec3 l )
{
    vec3 col = vec3(0.0);
         col += 0.5*pow( fancyCube( iChannel1, d, 0.05, 5.0 ).zyx, vec3(2.0) );
         col += 0.2*pow( fancyCube( iChannel1, d, 0.10, 3.0 ).zyx, vec3(1.5) );
         col += 0.8*vec3(0.80,0.5,0.6)*pow( fancyCube( iChannel1, d, 0.1, 0.0 ).xxx, vec3(6.0) );
    float stars = smoothstep( 0.3, 0.7, fancyCube( iChannel2, d, 0.91, 0.0 ).x );

    
    vec3 n = abs(d);
    n = n*n*n;
    
    vec2 vxy = voronoi( 50.0*d.xy );
    vec2 vyz = voronoi( 50.0*d.yz );
    vec2 vzx = voronoi( 50.0*d.zx );
    vec2 r = (vyz*n.x + vzx*n.y + vxy*n.z) / (n.x+n.y+n.z);
    col += 0.9 * stars * clamp(1.0-(3.0+r.y*5.0)*r.x,0.0,1.0);

    col = 1.5*col - 0.2;
 // Green / Blue / Salmon Tint.. (Purple without!)  
 //   col += vec3(-0.05,0.1,0.0);

    float s = clamp( dot(d,l), 0.0, 1.0 );
    col += 0.4*pow(s,5.0)*vec3(1.0,0.7,0.6)*2.0;
    col += 0.4*pow(s,64.0)*vec3(1.0,0.9,0.8)*2.0;
    
    return col;

}

//--------------------------------------------------------------------

vec4 sph1 = vec4(  0.00, 0.00,  0.00, 1.0 );
vec4 sph2 = vec4( -0.10, 0.00,  0.00, 0.015 );
vec4 sph3 = vec4(  0.10, 0.00,  0.00, 0.015 );
vec4 sph4 = vec4(  0.00, 0.00, -0.10, 0.03 );

float rayTrace( in vec3 ro, in vec3 rd )
{
    return shpIntersect( ro, rd, sph1 );
}

float map( in vec3 pos, in float sample1 )
{
    vec2 delta = (pos.xz - sph1.xz);
    vec2 r = delta;//mix( delta, fract(delta), sample1 );
    float h = 1.0-2.0/(1.0 + 0.3*dot(r,r));
    return pos.y - h;
}

float rayMarch( in vec3 ro, in vec3 rd, float tmax, in vec3 samples123 )
{
    float t = 0.0;
    
    // bounding plane
    float h = (1.0-ro.y)/rd.y;
    if( h>0.0 ) t=h;

    // raymarch
    for( int i=0; i<20; i++ )    
    {        
        vec3 pos = ro + t*rd;
        float h = map( pos, samples123.x );
        if( h<0.001 || t>tmax ) break;
        t += h;
    }
    return t;    
}

vec3 render( in vec3 ro, in vec3 rd, in vec3 samples123, in vec3 spline )
{
    vec3 lig = normalize( vec3(1.0,0.2,1.0) );
    vec3 col = background( rd, lig );
    
    // Raytrace stuff..
    float t1 = shpIntersect( ro, rd, sph1 );
    float t2 = shpIntersect( ro, rd, sph2 );
    float t3 = shpIntersect( ro, rd, sph3 );
    float t4 = shpIntersect( ro, rd, sph4 );

    if ( t1>0.0 )
    {
        vec3 mat = vec3( 0.18 );
        vec3 pos = ro + t1*rd;
        vec3 nor = sphNormal( pos, sph1 );
            
        float am = 0.1*iTime;
        vec2 pr = vec2( cos(am), sin(am) );
        vec3 tnor = nor;
        tnor.xz = mat2( pr.x, -pr.y, pr.y, pr.x ) * tnor.xz;

        float am2 = 0.08*iTime - 1.0*(1.0-nor.y*nor.y);
        pr = vec2( cos(am2), sin(am2) );
        vec3 tnor2 = nor;
        tnor2.xz = mat2( pr.x, -pr.y, pr.y, pr.x ) * tnor2.xz;

        vec3 ref = reflect( rd, nor );
        float fre = clamp( 1.0+dot( nor, rd ), 0.0 ,1.0 );

        float dif = clamp( dot(nor, lig), 0.0, 1.0 );

        col -= col * 0.6;
        col += 0.6*fre*fre*vec3(0.9,0.9,1.0)*(0.3+0.7*dif);
    }
    
    // Raymarch stuff..
    float tmax = K_MAX_DISTANCE;
    if ( t1>0.0 ) tmax = t1; 
    t1 = rayMarch( ro, rd, tmax, samples123 );    
    if ( t1 < tmax )
    {
    		//
    		// ! !! !!! - Time Warp the camera position using the audio freuency data..! :))
    		//
    		t1 += (0.9 + (0.1*samples123.x)) * samples123.z * 0.25;

        	vec3 pos = ro + t1 * rd;

            vec2 scp = sin(2.0*6.2831*pos.xz);
            
            vec3 wir = vec3( 0.0 );
        
        	float offset = samples123.z * (1.0 + (samples123.x * 3.0));
        
            wir += 1.00*exp(-12.0*offset*abs(scp.x));
            wir += 1.00*exp(-12.0*offset*abs(scp.y));
            wir += 0.50*exp( -4.0*offset*abs(scp.x));
            wir += 0.50*exp( -4.0*offset*abs(scp.y));
        
        	wir += 1.00*exp(-12.0*(1.0-samples123.x)*2.0*abs(scp.x));
          	wir += 1.00*exp(-12.0*(1.0-samples123.x)*2.0*abs(scp.y));
          	wir += 0.50*exp( -4.0*(1.0-samples123.x)*2.0*abs(scp.x));
          	wir += 0.50*exp( -4.0*(1.0-samples123.x)*2.0*abs(scp.y));
			wir *= 0.5;
        
        	wir *= 0.2 + 1.0 * sphSoftShadow( pos, lig, sph1, 4.0 );
    
            col += wir * 0.5 * exp( -0.05 * t1 * t1 );
    }        

    // Main sphere...
    if ( dot(rd,sph1.xyz-ro) > 0.0 )
    {
    	float d = sphDistance( ro, rd, sph1 );
    	vec3 glo = vec3(0.0);
    	glo += vec3(0.6, 0.7, 1.0) * 0.3 * exp(  -2.0 * abs(d)) * step(0.0,d);
    	glo += 0.6 * vec3(0.6,0.7,1.0)*0.3*exp(  -8.0 * abs(d));
    	glo += 0.6 * vec3(0.8,0.9,1.0)*0.4*exp(-100.0 * abs(d));
    	col += glo * 2.0 * ( samples123.y + samples123.x );
        
        // R U
        if ( dot(rd,sph2.xyz-ro) > 0.0 )
        {
            float d = sphDistance( ro, rd, sph2 );
            vec3 glo = vec3(0.0);
            glo += vec3(0.6,0.7,1.0)*0.3*exp(-2.0*abs(d))*step(0.0,d);
            glo += 0.6*vec3(0.6,0.7,1.0)*0.3*exp(-8.0*abs(d));
            glo += 0.6*vec3(0.8,0.9,1.0)*0.4*exp(-100.0*abs(d));
            col.x += glo.x*20.0*(samples123.x*(0.3+spline.x));
        }        

        // G U
        if ( dot(rd,sph3.xyz-ro) > 0.0 )
        {
            float d = sphDistance( ro, rd, sph3 );
            vec3 glo = vec3(0.0);
            glo += vec3(0.6,0.7,1.0)*0.3*exp(-2.0*abs(d))*step(0.0,d);
            glo += 0.6*vec3(0.6,0.7,1.0)*0.3*exp(-8.0*abs(d));
            glo += 0.6*vec3(0.8,0.9,1.0)*0.4*exp(-100.0*abs(d));
            col.y += glo.y*20.0*(samples123.x*(0.3+spline.y));
        }        

        // B D
        if ( dot(rd,sph4.xyz-ro) > 0.0 )
        {
            float d = sphDistance( ro, rd, sph4 );
            vec3 glo = vec3(0.0);
            glo += vec3(0.6,0.7,1.0)*0.3*exp(-2.0*abs(d))*step(0.0,d);
            glo += 0.6*vec3(0.6,0.7,1.0)*0.3*exp(-8.0*abs(d));
            glo += 0.6*vec3(0.8,0.9,1.0)*0.4*exp(-100.0*abs(d));
            col.z += glo.z*20.0*(samples123.y*spline.z);
        }        
    }        
    
    col *= smoothstep( 0.0, 6.0, iTime );

    return col;
}

vec2 grid_metric( in vec3 ro, in vec3 rd, in vec3 samples123 )
{
    // raytrace stuff    
    float t = rayTrace( ro, rd );

    // raymarch stuff    
    float tmax = K_MAX_DISTANCE;
    if( t>0.0 ) tmax = t; 
    t = rayMarch( ro, rd, tmax, samples123 );    
    if( t<tmax )
    {
      	vec3 pos = ro + t*rd;

        vec2 scp = ( sin( ( pos.xz * 0.1 ) + 0.0 ) + 0.5 ) * 1.0;
	    return scp;
    }        

    return vec2(0.0, 0.0);
}


mat3 setCamera( in vec3 ro, in vec3 rt, in float cr )
{
	vec3 cw = normalize(rt-ro);
	vec3 cp = vec3(sin(cr), cos(cr),0.0);
	vec3 cu = normalize( cross(cw,cp) );
	vec3 cv = normalize( cross(cu,cw) );
    return mat3( cu, cv, -cw );
}

// RGB Eye response..

const vec3 deSatConst = vec3( 0.299, 0.587, 0.114 );

// Audio sampling helper..

float audio_freq( in sampler2D channel, in float f) { return texture( channel, vec2(f, 0.25) ).x; }
float audio_ampl( in sampler2D channel, in float t) { return texture( channel, vec2(t, 0.75) ).x; }

// Returns 3 B-spline functions of degree 2..

vec3 B2_spline(vec3 x) 
{ 
    vec3 t = 3.0 * x;
    vec3 b0 = step(0.0, t)     * step(0.0, 1.0-t);
	vec3 b1 = step(0.0, t-1.0) * step(0.0, 2.0-t);
	vec3 b2 = step(0.0, t-2.0) * step(0.0, 3.0-t);
	return 0.5 * (
    	b0 * pow(t, vec3(2.0)) +
    	b1 * (-2.0*pow(t, vec3(2.0)) + 6.0*t - 3.0) + 
    	b2 * pow(3.0-t,vec3(2.0))
    );
}

//

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	vec2 p = (-iResolution.xy +2.0*fragCoord.xy) / iResolution.y;

//    vec2 uv = p;
	vec2 uv = fragCoord.xy / iResolution.xy;
	float time = iTime * speed1 + 0.25;

    float zo = 1.0 + smoothstep( 5.0, 15.0, abs(iTime-48.0) );
    float an = 3.0 + 0.05*iTime + 6.0*iMouse.x/iResolution.x;
    vec3 ro = zo*vec3( 2.0*cos(an), 1.0, 2.0*sin(an) );
    vec3 rt = vec3( 1.0, 0.0, 0.0 );
    mat3 cam = setCamera( ro, rt, 0.35 );
    vec3 rd = normalize( cam * vec3( p, -2.0) );
    
    uv = grid_metric( ro, rd, vec3(0.0) );
    vec2 centered = 2.0 * uv - 1.0;
    centered.x *= iResolution.x / iResolution.y;
    float dist2 = dot(centered, centered);
    float clamped_dist = smoothstep(0.0, 1.0, dist2);
    float arclength    = abs(atan(centered.y, centered.x) / radians(360.0))+0.01;
    vec2 fft = uv.xy;
    fft -= 0.5;
    fft *= 1.75;
    fft.x *= iResolution.x / iResolution.y;
    float sample1 = audio_freq(iChannel0, abs(2.0 * sqrt(dot(fft,fft)) - 1.0) + 0.01);
    float sample2 = audio_ampl(iChannel0, clamped_dist);
    float sample3 = audio_ampl(iChannel0, arclength);

    sph1.w = sample2 * 0.3 + 0.707;
    
    uv = grid_metric( ro, rd, vec3( (sample1 + sample3 * 0.7 * sample1) * sample3 * 0.7, sample2, sample3 ) );
   
    centered = 2.0 * uv - 1.0;
    centered.x *= iResolution.x / iResolution.y;
    dist2 = dot(centered, centered);
    clamped_dist = smoothstep(0.0, 1.0, dist2);
    arclength    = abs(atan(centered.y, centered.x) / radians(360.0))+0.01;
    
    //
    // Audio visualisation..
    //
	// - Modified version of the Soundcloud example by: chronos
	// - https://www.shadertoy.com/view/lsdGR8
    //
    float t = iTime / 100.0;
    float polychrome = (1.0 + sin(t*10.0))/2.0; // 0 -> uniform color, 1 -> full spectrum
    vec3 spline_args = fract(vec3(polychrome*uv.x-t) + vec3(0.0, -1.0/3.0, -2.0/3.0));
    vec3 spline = B2_spline(spline_args);
    
    float f = abs(centered.y);
    vec3 base_color  = vec3(1.0, 1.0, 1.0) - f*spline;
    vec3 flame_color = pow(base_color, vec3(3.0));
    vec3 disc_color  = 0.20 * base_color;
    vec3 wave_color  = 0.10 * base_color;
    vec3 flash_color = 0.05 * base_color;
    
    fft    = uv.xy;
    fft   -= 0.5;
    fft   *= 1.75;
    fft.x *= iResolution.x / iResolution.y;
    
    sample1 = audio_freq(iChannel0, abs(2.0 * sqrt(dot(fft,fft)) - 1.0) + 0.01);
    sample2 = 0.6 * audio_ampl(iChannel0, clamped_dist);
    sample3 = 0.6 * audio_ampl(iChannel0, arclength);
    
    float disp_dist = smoothstep(-0.2, -0.1, sample3-dist2);
    disp_dist *= (1.0 - disp_dist);
	
    vec3 color = vec3(0.0);
    
    // Quark Spline R G B..
  	vec3 s = smoothstep(-0.01, 0.01, spline-uv.y); 
    color += clamp((1.0-s) * s,0.0,1.0);
  	     s = smoothstep(-0.03, 0.03, spline-uv.y);
    color += clamp((1.0-s) * s * 0.09,0.0,1.0);

    float v = abs(uv.y - 0.5);
  //  vec3 flame = flame_color * smoothstep(v, v*28.0, sample1);
  //  color += clamp( flame, vec3(0.0,0.0,0.0), vec3(1.0,1.0,1.0) );
    color += disc_color  * smoothstep(0.5, 1.0, sample2) * (1.0 - clamped_dist);
    color += flash_color * smoothstep(0.5, 1.0, sample3) * clamped_dist;
    color += wave_color  * disp_dist;
    color = pow(clamp(color+0.0001,0.0,1.0), vec3(0.4545));
	vec3 sonicColor = color+ wave_color * 3.0;
    
    vec3 col = render( ro, rd, vec3( sample1, sample2, (1.0-disp_dist) + sample3 ), spline );
    
    vec2 q = fragCoord.xy / iResolution.xy;
    col *= 0.2 + 0.8*pow( 16.0*q.x*q.y*(1.0-q.x)*(1.0-q.y), 0.1 );

//	fragColor = vec4( col, 1.0 );
	fragColor = vec4( clamp(col + sonicColor.xyz,0.0,1.0), 1.0 );
}

void mainVR( out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir )
{
    float zo = 1.0 + smoothstep( 5.0, 15.0, abs(iTime-48.0) );
    float an = 3.0 + 0.05*iTime;
    vec3 ro = zo*vec3( 2.0*cos(an), 1.0, 2.0*sin(an) );

    vec3 rt = vec3( 1.0, 0.0, 0.0 );
    mat3 cam = setCamera( ro, rt, 0.35 );
    
    fragColor = vec4( render( ro + cam*fragRayOri,
                                   cam*fragRayDir,
                            	   vec3(0.0,0.0,0.0),
                            	   vec3(0.0,0.0,0.0) ), 1.0 );

}
