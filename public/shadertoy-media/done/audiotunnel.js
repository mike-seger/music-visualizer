// Download Shadertoy media for: audiotunnel
// https://www.shadertoy.com/view/lslfR7
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/f735bee5b64ef98879dc618b016ecf7939a5756040c2cde21ccb15e69a6e1cfb.png').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='f735bee5b64ef98879dc618b016ecf7939a5756040c2cde21ccb15e69a6e1cfb.png';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel1: f735bee5b64ef98879dc618b016ecf7939a5756040c2cde21ccb15e69a6e1cfb.png')})
