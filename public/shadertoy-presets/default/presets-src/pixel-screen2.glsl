// "Pixel screen" by mfnch
// https://www.shadertoy.com/view/DdXcD7
// Analytical antialiasing for a screen of rectangular pixels (squares separated by a gap). Inspired by https://iquilezles.org/articles/checkerfiltering/

// The MIT License
// Copyright © 2023 Matteo Franchin
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const vec2 pixelGap = vec2(0.01, 0.01);
const vec2 pixelSize = vec2(0.3, 0.3);
const vec2 numPixels = vec2(56, 32);
const vec2 maxCorner = 0.5 * numPixels * (pixelSize + pixelGap);
const vec2 minCorner = -maxCorner;

const vec2 pixelPeriod = pixelSize + pixelGap;

vec2 squareWaveIntegral(vec2 p) {
  vec2 q = (clamp(p, minCorner, maxCorner) - minCorner) / pixelPeriod;
  vec2 qFrac = fract(q);
  return q * pixelSize + min(qFrac * pixelGap, (1.0 - qFrac) * pixelSize);
}

vec3 getPixelColor(vec2 p) {
  vec2 q = (clamp(p, minCorner, maxCorner) - minCorner) / pixelPeriod;
  vec4 col = texture(iChannel0, floor(q) / numPixels);
  return col.rgb;
}

vec3 ledScreen(vec2 pixelCenter, vec2 fragSize) {
  vec2 delta =
    (squareWaveIntegral(pixelCenter + 0.5 * fragSize) -
     squareWaveIntegral(pixelCenter - 0.5 * fragSize));
  float mask = (delta.x / fragSize.x) * (delta.y / fragSize.y);
  return mask * getPixelColor(pixelCenter);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float zoom = 2.0 + cos(iTime);
  float fragSize = 16.0 * zoom / iResolution.x;
  vec2 r = (fragCoord - 0.5 * iResolution.xy) * fragSize;

  vec3 col = ledScreen(r, vec2(fragSize, fragSize));
  fragColor = vec4(col, 1.0);
}
