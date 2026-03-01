// Download Shadertoy media for: Sinefield 2
// https://www.shadertoy.com/view/MstSzj
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/ad56fba948dfba9ae698198c109e71f118a54d209c0ea50d77ea546abad89c57.png').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='ad56fba948dfba9ae698198c109e71f118a54d209c0ea50d77ea546abad89c57.png';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel0: ad56fba948dfba9ae698198c109e71f118a54d209c0ea50d77ea546abad89c57.png')})
