// "Sinefield 2" by halcy
// https://www.shadertoy.com/view/MstSzj
// 200% bullshit powered needs audio, looks bad without

// @channelRemap: iChannel0 (texture) → iChannel1, iChannel1 (audio) → iChannel0

// @iChannel1: /shadertoy-media/ad56fba948dfba9ae698198c109e71f118a54d209c0ea50d77ea546abad89c57.png

// Twiddle these knobs:
const float GLOWINESS = 212.0;
const float FLOOR_STRETCH = 150.0;
const float SKY_STRETCH = 4.0;
const float FLOOR_ZPART_MUL = 0.01;
const float FLOOR_ZPART_STRETCH = 3.0;
const float HEIGHT_OVER_FLOOR = 1.0;
const float SINE_Z_DIVIDE = 3.0;
const float BASSVAL_MULT = 0.5;
const float BASSVAL_EXP = 2.5;
const float TEXVAL_MULT = 0.5;

// WAHas Spectrum analyzer palette
vec3 palette(float i){
	if(i<4.0){
		if(i<2.0){
			if(i<1.0) return vec3(0.0,0.0,0.0);
			else return vec3(1.0,3.0,31.0);
		}
        else {
			if(i<3.0) return vec3(1.0,3.0,53.0);
			else return vec3(28.0,2.0,78.0);
		}
	} 
    else if(i<8.0) {
		if(i<6.0) {
			if(i<5.0) return vec3(80.0,2.0,110.0);
			else return vec3(143.0,3.0,133.0);
		}
		else {
			if(i<7.0) return vec3(181.0,3.0,103.0);
			else return vec3(229.0,3.0,46.0);
		}
	}
	else {
		if(i<10.0) {
			if(i<9.0) return vec3(252.0,73.0,31.0);
			else return vec3(253.0,173.0,81.0);
		}
		else if(i<12.0) {
			if(i<11.0) return vec3(254.0,244.0,139.0);
			else return vec3(239.0,254.0,203.0);
		}
		else {
			return vec3(242.0,255.0,236.0);
		}
	}
}

// Palette usage function
vec4 colour(float c) {
	c*=12.0;
	vec3 col1=palette(c)/256.0;
	vec3 col2=palette(c+1.0)/256.0;
	return vec4(mix(col1,col2,c-floor(c)),1.0);
}

// Actual rendered thing
float distfunc(vec3 pos) {
    float actz = pos.z - iTime*10.0;
    float skyz = pos.y - abs(pos.z) * 0.001;
    float sky = skyz < 0.0 ? 1.0 : 1.0 - pow(abs(pos.x / 80.0) * skyz, 0.3);
    float texpos = -cos(actz / FLOOR_ZPART_STRETCH) * FLOOR_ZPART_MUL + (sin(abs(pos.x / FLOOR_STRETCH)) + 1.0) / 2.0;
    float texval = pow(clamp(texture(iChannel0, vec2(texpos,0.0)).r, 0.0, 1.0), 2.0) * 10.0;
    float bassval = texture(iChannel0, vec2(0.01,0.0)).r +
                    texture(iChannel0, vec2(0.03,0.0)).r +
                    texture(iChannel0, vec2(0.06,0.0)).r;
    bassval = pow(bassval, BASSVAL_EXP);
    bassval += 4.0;
    float dist = (cos(pos.x) + cos(pos.z / SINE_Z_DIVIDE)) + texval * TEXVAL_MULT + pos.y + HEIGHT_OVER_FLOOR + bassval * BASSVAL_MULT;
    return(dist * sky);
}

// For ray fuzzing, from some other shader
vec3 hash33(vec3 p){ 
    float n = sin(dot(p, vec3(7, 157, 113)));    
    return fract(vec3(2097152, 262144, 32768)*n); 
}

void mainVR( out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir ) {
    vec2 coords=(2.0*fragCoord.xy-iResolution.xy)/max(iResolution.x,iResolution.y);

	vec3 ray_dir=fragRayDir;
	vec3 ray_pos=vec3(0.0,-3.0,iTime*10.0) + fragRayOri - vec3(0.0, 1.0, 0.0);
    
    
	ray_dir += hash33(ray_dir) * 0.005 * length(coords);
	float a=sin(-3.14 * iTime * 0.05) * 10.0;

	float i=512.0;
	for(int j=0;j<512;j++)
	{
		float dist=distfunc(ray_pos);
		ray_pos+=dist*ray_dir*0.3;

		if(abs(dist)<0.01) { i=float(j); break; }
	}
    
    float skyz = ray_pos.y - abs(ray_pos.z) * 0.001;
    float sky = skyz < 0.0 ? clamp(abs(skyz / 5.0), 0.0, 1.0) : 1.0 - pow(abs(ray_pos.x / 80.0) * skyz, 0.3);
    float skytex = texture(iChannel1, ray_dir.xy).r;
     
	float c = i/(512.0 - GLOWINESS);
    float bval = texture(iChannel0, vec2(abs(coords.x / SKY_STRETCH), 0.0)).r * 2.0 + 0.5;
	fragColor = colour(c * bval);
    fragColor += colour(clamp(skytex - 0.3, 0.0, 1.0)) * (1.0 - sky);
    fragColor = fragColor * clamp(mod(fragCoord.y, 2.0),  .7, 1.0); 
}

// Actual rendering
void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    
	vec2 coords=(2.0*fragCoord.xy-iResolution.xy)/max(iResolution.x,iResolution.y);

	vec3 ray_dir=normalize(vec3(coords.x, coords.y - 0.1, 1.0+0.0*sqrt(coords.x*coords.x+coords.y*coords.y)));
	vec3 ray_pos=vec3(0.0,-3.0,iTime*10.0);
    
    
	ray_dir += hash33(ray_dir) * 0.005 * length(coords);
	float a=sin(-3.14 * iTime * 0.05) * 10.0;

	float i=512.0;
	for(int j=0;j<512;j++)
	{
		float dist=distfunc(ray_pos);
		ray_pos+=dist*ray_dir*0.3;

		if(abs(dist)<0.01) { i=float(j); break; }
	}
    
    float skyz = ray_pos.y - abs(ray_pos.z) * 0.001;
    float sky = skyz < 0.0 ? clamp(abs(skyz / 5.0), 0.0, 1.0) : 1.0 - pow(abs(ray_pos.x / 80.0) * skyz, 0.3);
    float skytex = texture(iChannel1, ray_dir.xy).r;
     
	float c = i/(512.0 - GLOWINESS);
    float bval = texture(iChannel0, vec2(abs(coords.x / SKY_STRETCH), 0.0)).r * 2.0 + 0.5;
	fragColor = colour(c * bval);
    fragColor += colour(clamp(skytex - 0.3, 0.0, 1.0)) * (1.0 - sky);
    fragColor = fragColor * clamp(mod(fragCoord.y, 2.0),  .7, 1.0); 
}
