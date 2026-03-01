// "Audio Visualizer MB" by MarvelousBilly
// https://www.shadertoy.com/view/wdBfW1
// WARNING: FLASHING LIGHTS Just a little project I wanted to work on for a while now and it was a lot easier than I thought Update: improved the random flashing lights to not repeat as often, due to bad randomizing.

// @iChannel1: /shadertoy-media/cb49c003b454385aa9975733aff4571c62182ccdda480aaba9a8d250014f00ec.png

// # Buffer A

// Current song: https://soundcloud.com/teresa-tesla/operation-pyrite-arknights
// Operation Pyrite (Arknights) - Monster Siren Records; Jason Walsh; Alan Day

float decay = 0.02;
float attack = 0.1;
bool doDecay = true;
bool doAttack = true;

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    if(fragCoord.y == 0.5){
        vec4 ffv = texelFetch( iChannel0, ivec2(fragCoord), 0 ); 
        vec4 ffvP = texelFetch( iChannel1, ivec2(fragCoord), 0);
        if(ffv.x < ffvP.x && doDecay){ //if new value is less than previous value (i.e. value decreases)
            if(ffvP.x - decay >= ffv.x){ //if decreasing previous value by decay does not reach the new value,
            	ffv.x = ffvP.x - decay; //set the new value to the decayed value
            }
        }
        else if(ffv.x > ffvP.x && doAttack){ //if new value is more than previous value (i.e. value increases)
            if(ffvP.x + attack <= ffv.x){ //if raising the previous value by attack does not surpass the new value,
            	ffv.x = ffvP.x + attack; //set the new value to the increased value
            }
        }

        fragColor = ffv;
    }
    if(fragCoord.y == 1.5){ //return wave as-is
        vec4 wave = texelFetch( iChannel0, ivec2(fragCoord), 0 ); 
        fragColor = wave;
    }
}

// # Image

//for decay and attack rates, look in Buf A

int barWidth = 1; //width of each bar,each bar uses the left most value inside it's bar

vec3 color(float w){
    float b = 1.-smoothstep(0. ,1.,w);
    float g = smoothstep(-0.5,0.61,w);
    if(w > 0.61){
        g = 1.-smoothstep(0.61,1.,w);
    }
    float r = smoothstep(0.,1.,w);    
    return vec3(r,g,b);
}

vec3 colForm(vec2 fragC){
    vec3 col;
    vec2 fragCoord = fragC;
    
    float bass;
    bass =  texelFetch( iChannel0, ivec2(0,0), 0 ).x;
    bass += texelFetch( iChannel0, ivec2(1,0), 0 ).x;
    bass += texelFetch( iChannel0, ivec2(2,0), 0 ).x;
    bass /= 6.; //average bass from first 3 values
    bass = max(0.3,bass);
    
    //draw particle
    if(bass >= 0.43){
    
        float T = iTime;
        T = floor(T+(bass/10.));
        
        float width = iChannelResolution[1].x;
        
        vec2 index  = vec2(mod(float(bass+T),width),    floor(float(bass+T) / width));
        vec2 indexP = vec2(mod(float(bass+T+1.),width), floor(float(bass+T+1.) / width));
        
        vec2 A = texelFetch( iChannel1, ivec2(index), 0 ).rg * iResolution.xy;
        vec2 AP = texelFetch( iChannel1, ivec2(indexP), 0 ).rg * iResolution.xy;

        vec2 B = texelFetch( iChannel1, ivec2(index), 0 ).gb * iResolution.xy;
        vec2 BP = texelFetch( iChannel1, ivec2(indexP), 0 ).gb * iResolution.xy;

        vec2 C = texelFetch( iChannel1, ivec2(index), 0 ).rb * iResolution.xy;
        vec2 CP = texelFetch( iChannel1, ivec2(indexP), 0 ).rb * iResolution.xy;

        vec2 posA = mix(A, AP, smoothstep(0.,1.,mod(iTime, 1.1)));
        vec2 posB = mix(B, BP, smoothstep(0.,1.,mod(iTime, 1.1)));
        vec2 posC = mix(C, CP, smoothstep(0.,1.,mod(iTime, 1.1)));

		col = vec3(1.-distance(fragC, posA)/(bass*posA.x),1.-distance(fragC, posB)/(bass*posB.x),1.-distance(fragC, posC)/(bass*posC.x));
        col = max(col,-0.65);
    }
    
    fragC -= iResolution.xy/2.; //translate to center
    fragC *= (bass*2.)+(0.7/1.75); //scale
    fragC += iResolution.xy/2.; //translate back
    
    fragC = max(fragC,0.); //clamp the bars and extend them if zoomed out
    fragC = min(fragC,iResolution.xy-vec2(1.,0.)); 
    
    //avoid weird length bars
    if(barWidth > 1){
    	fragC = floor(fragC); 
    }
    
    vec2 BarFragC = fragC;
    BarFragC.x -= float(int(BarFragC.x) % barWidth); //strech each bar to be barWidth wide
    
    vec2 uv = BarFragC / iResolution.xy;
    
    // the sound texture is 512x2
    int tx = int(uv.x*512.0);
    float fft;
    float wave;
    // first row is frequency data (48Khz/4 in 512 texels, meaning 23 Hz per texel)
    fft  = texelFetch( iChannel0, ivec2(tx,0), 0 ).x; 
    // second row is the sound wave, one texel is one mono sample
    wave = texelFetch( iChannel0, ivec2(tx,1), 0 ).x;
        
    if(uv.y < fft/1.3){ //if showing bar, smooth color transition
        return col + color(fft);
    }
    else{ //if not showing bar, draw circle (which uses the wave)
        float bassCircSize = distance(fragCoord, iResolution.xy/2.) - (iResolution.x/2. * wave * bass); //circle size in bg
        if(bassCircSize < 1.){ //if pixel contains circle,
           return min(vec3(1.),col + vec3(0.8));
        }
        else{ //if background
        	return col;
        }
    }
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{   
    //generate bars
    vec3 col = colForm(fragCoord);
    
    // Output to screen
    fragColor = vec4(col,1.0);
}

