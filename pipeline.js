// Dither Studio — Post-processing Pipeline
// Hue shift, saturation, contrast, color toning, upscale for export

'use strict';

const Pipeline = {
  // Apply post-processing to dithered result (RGBA Uint8ClampedArray)
  // inputPixels: original preprocessed input (for tone-by-input)
  // Cache lightest color per palette (H7: avoids O(w*h) scan every frame)
  _cachedLightestPaletteKey: null,
  _cachedLightest: [255, 255, 255],

  lightestFromPalette(paletteColors) {
    const key = paletteColors.map(c => c.join(',')).join('|');
    if (key === this._cachedLightestPaletteKey) return this._cachedLightest;
    let maxLum = -1;
    let lr = 255, lg = 255, lb = 255;
    for (const c of paletteColors) {
      const lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
      if (lum > maxLum) { maxLum = lum; lr = c[0]; lg = c[1]; lb = c[2]; }
    }
    this._cachedLightestPaletteKey = key;
    this._cachedLightest = [lr, lg, lb];
    return this._cachedLightest;
  },

  process(dithered, inputPixels, w, h, params) {
    const hueShift = params.hueShift || 0;
    const saturation = params.saturation !== undefined ? params.saturation / 100 : 1.0;
    const contrast = params.outContrast || 0;
    const toneByInput = !!params.toneByInput;
    const toneColor = params.toneColor || [255, 255, 255];
    const toneStrength = (params.toneStrength || 0) / 100;
    const bgColor = params.bgColor || null;
    const bgR = bgColor ? bgColor[0] : -1;
    const bgG = bgColor ? bgColor[1] : -1;
    const bgB = bgColor ? bgColor[2] : -1;

    // Lightest palette color for background detection (O(palette) not O(pixels))
    const needsBgReplace = bgColor !== null;
    let lightestR = 255, lightestG = 255, lightestB = 255;
    if (needsBgReplace && params.paletteColors) {
      const l = this.lightestFromPalette(params.paletteColors);
      lightestR = l[0]; lightestG = l[1]; lightestB = l[2];
    }

    const noOp = hueShift === 0 && saturation === 1.0 && contrast === 0 &&
                 !toneByInput && toneStrength === 0 && !needsBgReplace;
    if (noOp) return dithered;

    const result = new Uint8ClampedArray(dithered.length);
    const contrastFactor = contrast !== 0 ? (259 * (contrast + 255)) / (255 * (259 - contrast)) : 1;

    // Precompute combined hue rotation + saturation matrix (3x3)
    const needsColorMatrix = hueShift !== 0 || saturation !== 1.0;
    let m0, m1, m2, m3, m4, m5, m6, m7, m8;
    if (needsColorMatrix) {
      // Hue rotation via Rodrigues formula around (1,1,1)/sqrt(3)
      const a = hueShift * Math.PI / 180;
      const cosA = Math.cos(a), sinA = Math.sin(a);
      const c1 = (1 - cosA) / 3;
      const s1 = sinA * Math.sqrt(1/3);

      // Hue rotation matrix
      let h0 = cosA + c1, h1 = c1 - s1, h2 = c1 + s1;
      let h3 = c1 + s1, h4 = cosA + c1, h5 = c1 - s1;
      let h6 = c1 - s1, h7 = c1 + s1, h8 = cosA + c1;

      if (saturation !== 1.0) {
        // Saturation: blend between identity luminance (desaturated) and color
        // Desat matrix: each row = [0.299, 0.587, 0.114] (luminance weights)
        const s = saturation;
        const sr = 0.299, sg = 0.587, sb = 0.114;
        // Composite: sat * hue_matrix + (1-s) * luminance_matrix
        m0 = s * h0 + (1-s) * sr; m1 = s * h1 + (1-s) * sg; m2 = s * h2 + (1-s) * sb;
        m3 = s * h3 + (1-s) * sr; m4 = s * h4 + (1-s) * sg; m5 = s * h5 + (1-s) * sb;
        m6 = s * h6 + (1-s) * sr; m7 = s * h7 + (1-s) * sg; m8 = s * h8 + (1-s) * sb;
      } else {
        m0 = h0; m1 = h1; m2 = h2;
        m3 = h3; m4 = h4; m5 = h5;
        m6 = h6; m7 = h7; m8 = h8;
      }
    }

    for (let i = 0; i < w * h * 4; i += 4) {
      let r = dithered[i], g = dithered[i+1], b = dithered[i+2];

      // Background color replacement
      if (needsBgReplace && r === lightestR && g === lightestG && b === lightestB) {
        r = bgR; g = bgG; b = bgB;
      }

      // Color toning
      if (toneStrength > 0) {
        if (toneByInput && inputPixels) {
          const ir = inputPixels[i], ig = inputPixels[i+1], ib = inputPixels[i+2];
          r = r + (ir - r) * toneStrength;
          g = g + (ig - g) * toneStrength;
          b = b + (ib - b) * toneStrength;
        } else {
          r = r + (toneColor[0] - r) * toneStrength;
          g = g + (toneColor[1] - g) * toneStrength;
          b = b + (toneColor[2] - b) * toneStrength;
        }
      }

      // Hue shift and saturation via rotation matrix (replaces HSL round-trip)
      if (needsColorMatrix) {
        const nr = m0*r + m1*g + m2*b;
        const ng = m3*r + m4*g + m5*b;
        const nb = m6*r + m7*g + m8*b;
        r = nr; g = ng; b = nb;
      }

      // Output contrast
      if (contrast !== 0) {
        r = contrastFactor * (r - 128) + 128;
        g = contrastFactor * (g - 128) + 128;
        b = contrastFactor * (b - 128) + 128;
      }

      result[i] = Math.max(0, Math.min(255, r)) | 0;
      result[i+1] = Math.max(0, Math.min(255, g)) | 0;
      result[i+2] = Math.max(0, Math.min(255, b)) | 0;
      result[i+3] = 255;
    }

    return result;
  },

  // Nearest-neighbor upscale
  upscale(src, srcW, srcH, scale) {
    const dstW = srcW * scale;
    const dstH = srcH * scale;
    const dst = new Uint8ClampedArray(dstW * dstH * 4);

    for (let dy = 0; dy < dstH; dy++) {
      const sy = (dy / scale) | 0;
      for (let dx = 0; dx < dstW; dx++) {
        const sx = (dx / scale) | 0;
        const si = (sy * srcW + sx) * 4;
        const di = (dy * dstW + dx) * 4;
        dst[di] = src[si];
        dst[di+1] = src[si+1];
        dst[di+2] = src[si+2];
        dst[di+3] = src[si+3];
      }
    }

    return { data: dst, width: dstW, height: dstH };
  },

  // Make transparent background (replace lightest color with alpha 0)
  makeTransparent(pixels, w, h, bgColor) {
    const result = new Uint8ClampedArray(pixels);
    const br = bgColor ? bgColor[0] : 255;
    const bg = bgColor ? bgColor[1] : 255;
    const bb = bgColor ? bgColor[2] : 255;

    for (let i = 0; i < w * h * 4; i += 4) {
      if (result[i] === br && result[i+1] === bg && result[i+2] === bb) {
        result[i+3] = 0;
      }
    }
    return result;
  }
};

// ─── Color Conversion Utilities ───
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [r * 255, g * 255, b * 255];
}
