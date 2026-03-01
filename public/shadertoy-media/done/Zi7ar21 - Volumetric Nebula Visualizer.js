// Download Shadertoy media for: Volumetric Nebula Visualizer
// https://www.shadertoy.com/view/ttjfRz
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/27012b4eadd0c3ce12498b867058e4f717ce79e10a99568cca461682d84a4b04.bin').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='27012b4eadd0c3ce12498b867058e4f717ce79e10a99568cca461682d84a4b04.bin';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel1: 27012b4eadd0c3ce12498b867058e4f717ce79e10a99568cca461682d84a4b04.bin')})
