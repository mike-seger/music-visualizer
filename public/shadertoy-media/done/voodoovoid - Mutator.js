// Download Shadertoy media for: Mutator
// https://www.shadertoy.com/view/DttXDj
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/85a6d68622b36995ccb98a89bbb119edf167c914660e4450d313de049320005c.png').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='85a6d68622b36995ccb98a89bbb119edf167c914660e4450d313de049320005c.png';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel1: 85a6d68622b36995ccb98a89bbb119edf167c914660e4450d313de049320005c.png')})
