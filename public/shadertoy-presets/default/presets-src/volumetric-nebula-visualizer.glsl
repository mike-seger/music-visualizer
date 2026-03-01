// "Volumetric Nebula Visualizer" by Zi7ar21
// https://www.shadertoy.com/view/ttjfRz
// Could be made more interesting...

// @iChannel1: /shadertoy-media/27012b4eadd0c3ce12498b867058e4f717ce79e10a99568cca461682d84a4b04.bin

// # Buffer A

// Fork of "Volumetric Nebula" by Zi7ar21. https://shadertoy.com/view/ttfBDX
// 2020-08-24 04:39:10

// Fork of "My Nebula" by Zi7ar21. https://shadertoy.com/view/ttfBDN
// 2020-08-19 23:12:29

// Zi7ar21's In Progress Nebula Ray Marcher --- August 6th, 2020
// I Deem You Allowed to Use My Code even Commercially and Even Modify it as Long as:
// You keep this disclaimer.
// You do not modify the terms

// You do not have to keep my credits, however I urge you to leave them here in the source.

// If this Code is Being Reused Entirely,
// Then the Original and Possibly Updated Version Can be Found Here:
// https://www.shadertoy.com/view/ttfBDN
// Fork of "My Very First Working Raymarcher" by Zi7ar21. [2020-07-06 23:50:09]
// https://shadertoy.com/view/WlBcDz

// Learn the Basics of Raymarching Like I Did Here:
// https://youtu.be/PGtv-dBi2wE

// ##### COMMON VALUES #####

// Change these Parameters to Your Liking!
// Maximum Number of Marches,
// You want it to limit the raymarcher before the max distance parameter or it will look bad.
#define MAX_MARCHES 16

// Redundant for this idk if the max marches are large and you see ugly stuff then increase this
#define MAX_DISTANCE 32.0

// fBm Number of Octaves (Detail)
#define NUM_OCTAVES 8

// Size of Steps, smaller means more sampling over depth but also means more computation.
// Increase max marches if the scene goes invisible.
#define STEP_SIZE 0.5

// If you march less rays, the nebula will appear darker. Bump this up to make it brighter again,
// Beware there will be more noise
#define DENSITY 2.0

// Oof ugly mess below watch out lol

// ##### NOISE #####

/*// White Noise
float mod289(float x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}

// Convert Noise to 3D
float noise(vec3 p){
    vec3 a = floor(p);
    vec3 d = p - a;
    d = d * d * (3.0 - 2.0 * d);
    vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
    vec4 k1 = perm(b.xyxy);
    vec4 k2 = perm(k1.xyxy + b.zzww);
    vec4 c = k2 + a.zzzz;
    vec4 k3 = perm(c);
    vec4 k4 = perm(c + 1.0);
    vec4 o1 = fract(k3 * (1.0 / 41.0));
    vec4 o2 = fract(k4 * (1.0 / 41.0));
    vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
    vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
    return o4.y * d.y + o4.x * (1.0 - d.y);
}*/

// Noise for Dithering
float rand(vec2 n) { 
	return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
}
float noised(vec2 p){
	vec2 ip = floor(p);
	vec2 u = fract(p);
	u = u*u*(3.0-2.0*u);
	
	float res = mix(
		mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),
		mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);
	return res*res;
}

// fBm Noise
float fbm(vec3 x){
	float v = 0.0;
	float a = 0.5;
	for (int i = 0; i < NUM_OCTAVES; ++i){
		v += a * texture(iChannel1, (x+vec3(1.0, 1.0, 0.0))/16.0).x;
		x = x * 2.0;
		a *= 0.5;
	}
	return v;
}

float nebulanoise(vec3 raypos){
	float density = clamp(fbm(raypos)-(-float(texture(iChannel0, vec2(0.0)))*-0.75), 0.0, 1.0)/pow(distance(vec3(0.0), raypos),4.0);
	return density;
}

// ##### RAYMARCHING #####

// Compute/March the Ray
float raymarch(vec3 camerapos, vec3 raydir, vec2 coord){
	float distorigin=0.0;
	float density=0.0;
    vec3 raypos = camerapos;
	vec3 raydirmod = (raydir+(raydir*(noised(coord+((sin(float(iFrame%60))+3.14)*sqrt(coord.x*coord.x+coord.y*coord.y))))*STEP_SIZE))*STEP_SIZE;
    for(int i=0; i<MAX_MARCHES; i++) {
    	raypos = raypos + raydirmod;
        float densityadd = nebulanoise(raypos)*DENSITY;
        density = density+densityadd;
        distorigin = raypos.z-camerapos.z;
        if(distorigin>MAX_DISTANCE) break;
    }
    return density;
}

// ##### RENDERING #####

// ACES Tone Curve
vec3 acesFilm(const vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}

// Render the Image
void mainImage( out vec4 fragColor, in vec2 fragCoord ){
	// Dumb rotation matrix hecking Michael begged me to add
	float xrot = 0.0;
	float yrot = 0.0;
	float zrot = float(texture(iChannel0, vec2(0.0)))*2.0;
	// Camera Orientation (Cursed)
	vec3 xdir = vec3(cos(yrot)*cos(zrot),-cos(yrot)*sin(zrot),sin(yrot));
	vec3 ydir = vec3(cos(xrot)*sin(zrot)+sin(xrot)*sin(yrot)*cos(zrot),cos(xrot)*cos(zrot)-sin(xrot)*sin(yrot)*sin(zrot),-sin(xrot)*cos(yrot));
	vec3 zdir = vec3(sin(xrot)*sin(zrot)-cos(xrot)*sin(yrot)*cos(zrot),sin(xrot)*cos(zrot)+cos(xrot)*sin(yrot)*sin(zrot),cos(xrot)*cos(yrot));
	float FOV = 3.0;
	vec3 camerapos = vec3(0.0, 0.0, (texture(iChannel0, vec2(0.0)).x*0.25)-2.0);

    // Undistorted Normalized Pixel Coordinates (From 0 to 1)
    vec2 uv = (((fragCoord - 0.5*iResolution.xy)/iResolution.x));
	vec3 raydir = normalize(FOV*(uv.x*xdir + uv.y*ydir) + zdir);
	float raymarched = raymarch(camerapos, raydir, vec2(fragCoord));

    // Pixel Color
    vec3 col = vec3(raymarched);
	
	// Apply Tone Map
    col = vec3(acesFilm(col*vec3(0.5, 0.75, 1.0)));

    // Output to Screen
    fragColor = vec4(col,1.0);
}

// # Buffer B

void mainImage( out vec4 fragColor, in vec2 fragCoord ){
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = (texture(iChannel0, uv).rgb+texture(iChannel1, uv).rgb+texture(iChannel2, uv).rgb)/3.0;

    // Output to screen
    fragColor = vec4(col,1.0);
}

// # Buffer C

void mainImage( out vec4 fragColor, in vec2 fragCoord ){
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = (texture(iChannel0, uv).rgb+texture(iChannel1, uv).rgb+texture(iChannel2, uv).rgb)/3.0;

    // Output to screen
    fragColor = vec4(col,1.0);
}

// # Buffer D

void mainImage( out vec4 fragColor, in vec2 fragCoord ){
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = (texture(iChannel0, uv).rgb+texture(iChannel1, uv).rgb+texture(iChannel2, uv).rgb)/3.0;

    // Output to screen
    fragColor = vec4(col,1.0);
}

// # Image

void mainImage( out vec4 fragColor, in vec2 fragCoord ){
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord/iResolution.xy;

    // Time varying pixel color
    vec3 col = (texture(iChannel0, uv).rgb+texture(iChannel1, uv).rgb+texture(iChannel2, uv).rgb+texture(iChannel3, uv).rgb)/4.0;

    // Output to screen
    fragColor = vec4(col,1.0);
}

