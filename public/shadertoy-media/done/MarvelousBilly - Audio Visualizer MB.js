// Download Shadertoy media for: Audio Visualizer MB
// https://www.shadertoy.com/view/wdBfW1
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/cb49c003b454385aa9975733aff4571c62182ccdda480aaba9a8d250014f00ec.png').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='cb49c003b454385aa9975733aff4571c62182ccdda480aaba9a8d250014f00ec.png';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel1: cb49c003b454385aa9975733aff4571c62182ccdda480aaba9a8d250014f00ec.png')})
