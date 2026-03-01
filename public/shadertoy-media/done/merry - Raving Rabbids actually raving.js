// Download Shadertoy media for: Raving Rabbids actually raving!
// https://www.shadertoy.com/view/wtSXzc
//
// Open https://www.shadertoy.com in a browser while logged in.
// Paste each line below into the DevTools console ONE AT A TIME —
// each paste triggers one browser download.
// Place the downloaded files into: public/shadertoy-media/

fetch('/media/a/585f9546c092f53ded45332b343144396c0b2d70d9965f585ebc172080d8aa58.jpg').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='585f9546c092f53ded45332b343144396c0b2d70d9965f585ebc172080d8aa58.jpg';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel1: 585f9546c092f53ded45332b343144396c0b2d70d9965f585ebc172080d8aa58.jpg')})

fetch('/media/a/550a8cce1bf403869fde66dddf6028dd171f1852f4a704a465e1b80d23955663.png').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='550a8cce1bf403869fde66dddf6028dd171f1852f4a704a465e1b80d23955663.png';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel2: 550a8cce1bf403869fde66dddf6028dd171f1852f4a704a465e1b80d23955663.png')})

fetch('/media/a/488bd40303a2e2b9a71987e48c66ef41f5e937174bf316d3ed0e86410784b919.jpg').then(r=>r.blob()).then(b=>{let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='488bd40303a2e2b9a71987e48c66ef41f5e937174bf316d3ed0e86410784b919.jpg';document.body.appendChild(a);a.click();a.remove();console.log('\u2713 iChannel3: 488bd40303a2e2b9a71987e48c66ef41f5e937174bf316d3ed0e86410784b919.jpg')})
