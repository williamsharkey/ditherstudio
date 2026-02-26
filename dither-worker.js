// Dither Studio — Web Worker: Downscale + All Dither Algorithms + Pre-processing
// Receives raw RGBA pixels, returns small dithered result via Transferable

'use strict';

// ─── Blue Noise 64x64 Texture (precomputed) ───
// Void-and-cluster blue noise, normalized 0-255
const BLUE_NOISE_SIZE = 64;
let blueNoise = null;

function generateBlueNoise() {
  // Generate a reasonable blue noise approximation using a shuffled threshold pattern
  // This gives visually good results without needing an external file
  const size = BLUE_NOISE_SIZE;
  const n = size * size;
  const arr = new Uint8Array(n);

  // Start with ordered values and apply spatial shuffling for blue-noise-like properties
  // Use a method based on recursive subdivision with jitter
  const values = new Float32Array(n);

  // Seed a deterministic PRNG
  let seed = 12345;
  function rand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  // Initialize with interleaved gradient noise (good approximation)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Interleaved gradient noise formula
      const v = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1.0)) % 1.0;
      values[y * size + x] = v;
    }
  }

  // Convert to rank-ordered values (0-255)
  const indices = Array.from({length: n}, (_, i) => i);
  indices.sort((a, b) => values[a] - values[b]);
  for (let rank = 0; rank < n; rank++) {
    arr[indices[rank]] = (rank * 256 / n) | 0;
  }

  return arr;
}

// ─── Bayer Matrix Generation ───
function generateBayerMatrix(size) {
  if (size === 2) return [0, 2, 3, 1];
  const half = size / 2;
  const smaller = generateBayerMatrix(half);
  const matrix = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x % half, sy = y % half;
      const smallVal = smaller[sy * half + sx];
      const quadrant = (y < half ? 0 : 1) * 2 + (x < half ? 0 : 1);
      const offsets = [0, 2, 3, 1]; // Bayer pattern multipliers
      matrix[y * size + x] = 4 * smallVal + offsets[quadrant];
    }
  }
  return matrix;
}

// Pre-generate Bayer matrices
const bayerMatrices = {
  2: generateBayerMatrix(2),
  4: generateBayerMatrix(4),
  8: generateBayerMatrix(8),
  16: generateBayerMatrix(16)
};

// Normalize Bayer matrices to 0-1 range
const bayerNormalized = {};
for (const size of [2, 4, 8, 16]) {
  const m = bayerMatrices[size];
  const n = size * size;
  bayerNormalized[size] = new Float32Array(m.map(v => (v + 0.5) / n));
}

// ─── Color LUT for fast palette lookup ───
let currentLUT = null;
let currentPaletteKey = '';

function buildColorLUT(palette) {
  const size = 32;
  const lut = new Uint8Array(size * size * size * 3);
  const n = palette.length;

  for (let ri = 0; ri < size; ri++) {
    const r = (ri * 255 / (size - 1)) | 0;
    for (let gi = 0; gi < size; gi++) {
      const g = (gi * 255 / (size - 1)) | 0;
      for (let bi = 0; bi < size; bi++) {
        const b = (bi * 255 / (size - 1)) | 0;
        let bestDist = Infinity;
        let bestIdx = 0;
        for (let i = 0; i < n; i++) {
          const cr = palette[i * 3], cg = palette[i * 3 + 1], cb = palette[i * 3 + 2];
          const dr = r - cr, dg = g - cg, db = b - cb;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        const idx = (ri * size * size + gi * size + bi) * 3;
        lut[idx] = palette[bestIdx * 3];
        lut[idx + 1] = palette[bestIdx * 3 + 1];
        lut[idx + 2] = palette[bestIdx * 3 + 2];
      }
    }
  }
  return lut;
}

function nearestColor(lut, r, g, b) {
  const size = 32;
  const ri = (r * 31 / 255 + 0.5) | 0;
  const gi = (g * 31 / 255 + 0.5) | 0;
  const bi = (b * 31 / 255 + 0.5) | 0;
  const idx = (ri * 1024 + gi * 32 + bi) * 3;
  return [lut[idx], lut[idx + 1], lut[idx + 2]];
}

// Direct nearest color (no LUT) — for small palettes or precise matching
function nearestColorDirect(palette, nColors, r, g, b) {
  let bestDist = Infinity;
  let br = 0, bg = 0, bb = 0;
  for (let i = 0; i < nColors; i++) {
    const cr = palette[i * 3], cg = palette[i * 3 + 1], cb = palette[i * 3 + 2];
    const dr = r - cr, dg = g - cg, db = b - cb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      br = cr; bg = cg; bb = cb;
    }
  }
  return [br, bg, bb];
}

// ─── Buffer Pools ───
// Reuse allocations across frames to reduce GC pressure
const _rLut = new Uint8ClampedArray(256);
const _gLut = new Uint8ClampedArray(256);
const _bLut = new Uint8ClampedArray(256);

let _downBuf = null, _downBufSize = 0;
function getPooledBuffer(size) {
  if (_downBufSize < size) { _downBuf = new Uint8ClampedArray(size); _downBufSize = size; }
  return _downBuf;
}

let _errBuf = null, _errBufSize = 0;
function getErrorBuffer(size) {
  if (_errBufSize < size) { _errBuf = new Float32Array(size); _errBufSize = size; }
  return _errBuf;
}

// ─── Downscale (area average) ───
function downscaleAverage(src, srcW, srcH, dstW, dstH) {
  const needed = dstW * dstH * 4;
  const dst = getPooledBuffer(needed);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = (dy + 1) * scaleY;
    const iy0 = sy0 | 0;
    const iy1 = Math.min(Math.ceil(sy1), srcH);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = (dx + 1) * scaleX;
      const ix0 = sx0 | 0;
      const ix1 = Math.min(Math.ceil(sx1), srcW);

      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        for (let sx = ix0; sx < ix1; sx++) {
          const si = (sy * srcW + sx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          count++;
        }
      }

      const di = (dy * dstW + dx) * 4;
      if (count > 0) {
        dst[di] = (r / count + 0.5) | 0;
        dst[di + 1] = (g / count + 0.5) | 0;
        dst[di + 2] = (b / count + 0.5) | 0;
      }
      dst[di + 3] = 255;
    }
  }
  return dst;
}

function downscaleNearest(src, srcW, srcH, dstW, dstH) {
  const dst = getPooledBuffer(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy * scaleY + scaleY * 0.5) | 0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx * scaleX + scaleX * 0.5) | 0;
      const si = (sy * srcW + sx) * 4;
      const di = (dy * dstW + dx) * 4;
      dst[di] = src[si]; dst[di+1] = src[si+1]; dst[di+2] = src[si+2]; dst[di+3] = 255;
    }
  }
  return dst;
}

function downscaleBilinear(src, srcW, srcH, dstW, dstH) {
  const dst = getPooledBuffer(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = dy * scaleY + scaleY * 0.5 - 0.5;
    const iy = sy | 0;
    const fy = sy - iy;
    const y0 = Math.max(0, Math.min(iy, srcH - 1));
    const y1 = Math.max(0, Math.min(iy + 1, srcH - 1));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = dx * scaleX + scaleX * 0.5 - 0.5;
      const ix = sx | 0;
      const fx = sx - ix;
      const x0 = Math.max(0, Math.min(ix, srcW - 1));
      const x1 = Math.max(0, Math.min(ix + 1, srcW - 1));

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const di = (dy * dstW + dx) * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i00+c]*(1-fx)*(1-fy) + src[i10+c]*fx*(1-fy) +
                  src[i01+c]*(1-fx)*fy + src[i11+c]*fx*fy;
        dst[di+c] = (v + 0.5) | 0;
      }
      dst[di+3] = 255;
    }
  }
  return dst;
}

// ─── Pre-processing: brightness, contrast, gamma, per-channel ───
function preprocess(pixels, w, h, params) {
  const brightness = params.brightness || 0;
  const contrast = params.contrast || 0;
  const gamma = params.gamma || 1.0;
  const rBri = params.redBrightness || 0;
  const gBri = params.greenBrightness || 0;
  const bBri = params.blueBrightness || 0;

  // Skip if everything is default
  if (brightness === 0 && contrast === 0 && gamma === 1.0 &&
      rBri === 0 && gBri === 0 && bBri === 0) return;

  // Build LUT for speed (reuse pooled buffers)
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const gammaInv = 1.0 / gamma;

  const lutR = _rLut;
  const lutG = _gLut;
  const lutB = _bLut;

  for (let i = 0; i < 256; i++) {
    let r = i + brightness + rBri;
    let g = i + brightness + gBri;
    let b = i + brightness + bBri;

    // Contrast
    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    // Gamma
    if (gamma !== 1.0) {
      r = 255 * Math.pow(Math.max(0, r) / 255, gammaInv);
      g = 255 * Math.pow(Math.max(0, g) / 255, gammaInv);
      b = 255 * Math.pow(Math.max(0, b) / 255, gammaInv);
    }

    lutR[i] = Math.max(0, Math.min(255, r + 0.5)) | 0;
    lutG[i] = Math.max(0, Math.min(255, g + 0.5)) | 0;
    lutB[i] = Math.max(0, Math.min(255, b + 0.5)) | 0;
  }

  const len = w * h * 4;
  for (let i = 0; i < len; i += 4) {
    pixels[i] = lutR[pixels[i]];
    pixels[i + 1] = lutG[pixels[i + 1]];
    pixels[i + 2] = lutB[pixels[i + 2]];
  }
}

// ─── Error Diffusion Kernels ───
const KERNELS = {
  'floyd-steinberg': {
    offsets: [[1,0,7/16], [-1,1,3/16], [0,1,5/16], [1,1,1/16]]
  },
  'atkinson': {
    offsets: [[1,0,1/8], [2,0,1/8], [-1,1,1/8], [0,1,1/8], [1,1,1/8], [0,2,1/8]]
  },
  'burkes': {
    offsets: [[1,0,8/32], [2,0,4/32], [-2,1,2/32], [-1,1,4/32], [0,1,8/32], [1,1,4/32], [2,1,2/32]]
  },
  'jarvis': {
    offsets: [
      [1,0,7/48], [2,0,5/48],
      [-2,1,3/48], [-1,1,5/48], [0,1,7/48], [1,1,5/48], [2,1,3/48],
      [-2,2,1/48], [-1,2,3/48], [0,2,5/48], [1,2,3/48], [2,2,1/48]
    ]
  },
  'stucki': {
    offsets: [
      [1,0,8/42], [2,0,4/42],
      [-2,1,2/42], [-1,1,4/42], [0,1,8/42], [1,1,4/42], [2,1,2/42],
      [-2,2,1/42], [-1,2,2/42], [0,2,4/42], [1,2,2/42], [2,2,1/42]
    ]
  },
  'sierra': {
    offsets: [
      [1,0,5/32], [2,0,3/32],
      [-2,1,2/32], [-1,1,4/32], [0,1,5/32], [1,1,4/32], [2,1,2/32],
      [-1,2,2/32], [0,2,3/32], [1,2,2/32]
    ]
  },
  'sierra-two-row': {
    offsets: [
      [1,0,4/16], [2,0,3/16],
      [-2,1,1/16], [-1,1,2/16], [0,1,3/16], [1,1,2/16], [2,1,1/16]
    ]
  },
  'sierra-lite': {
    offsets: [[1,0,2/4], [-1,1,1/4], [0,1,1/4]]
  }
};

// ─── Error Diffusion Dithering ───
function ditherErrorDiffusion(pixels, w, h, lut, palette, nColors, kernel, strength, serpentine) {
  const offsets = kernel.offsets;
  // Work in float for error accumulation (pooled buffer)
  const bufSize = w * h * 3;
  const buf = getErrorBuffer(bufSize);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    buf[j] = pixels[i];
    buf[j + 1] = pixels[i + 1];
    buf[j + 2] = pixels[i + 2];
  }

  const result = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const leftToRight = !serpentine || (y & 1) === 0;
    const startX = leftToRight ? 0 : w - 1;
    const endX = leftToRight ? w : -1;
    const stepX = leftToRight ? 1 : -1;

    for (let x = startX; x !== endX; x += stepX) {
      const j = (y * w + x) * 3;
      const r = Math.max(0, Math.min(255, buf[j]));
      const g = Math.max(0, Math.min(255, buf[j + 1]));
      const b = Math.max(0, Math.min(255, buf[j + 2]));

      // Find nearest palette color
      let nr, ng, nb;
      if (lut) {
        const ri = (r * 31 / 255 + 0.5) | 0;
        const gi = (g * 31 / 255 + 0.5) | 0;
        const bi = (b * 31 / 255 + 0.5) | 0;
        const li = (ri * 1024 + gi * 32 + bi) * 3;
        nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
      } else {
        [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
      }

      // Store result
      const pi = (y * w + x) * 4;
      result[pi] = nr;
      result[pi + 1] = ng;
      result[pi + 2] = nb;
      result[pi + 3] = 255;

      // Compute and diffuse error
      const er = (r - nr) * strength;
      const eg = (g - ng) * strength;
      const eb = (b - nb) * strength;

      for (let k = 0; k < offsets.length; k++) {
        const ox = leftToRight ? offsets[k][0] : -offsets[k][0];
        const oy = offsets[k][1];
        const weight = offsets[k][2];
        const nx = x + ox;
        const ny = y + oy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nj = (ny * w + nx) * 3;
          buf[nj] += er * weight;
          buf[nj + 1] += eg * weight;
          buf[nj + 2] += eb * weight;
        }
      }
    }
  }

  return result;
}

// ─── Ordered (Bayer) Dithering ───
function ditherOrdered(pixels, w, h, lut, palette, nColors, matrixSize, bias) {
  const result = new Uint8ClampedArray(w * h * 4);
  const matrix = bayerNormalized[matrixSize];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const mx = x % matrixSize;
      const my = y % matrixSize;
      const threshold = matrix[my * matrixSize + mx] - 0.5 + bias;

      // Add threshold-based noise to each channel before quantization
      const spread = 255 / Math.max(1, Math.cbrt(nColors) - 1); // approximate level spacing
      const r = Math.max(0, Math.min(255, pixels[si] + threshold * spread));
      const g = Math.max(0, Math.min(255, pixels[si + 1] + threshold * spread));
      const b = Math.max(0, Math.min(255, pixels[si + 2] + threshold * spread));

      let nr, ng, nb;
      if (lut) {
        const ri = (r * 31 / 255 + 0.5) | 0;
        const gi = (g * 31 / 255 + 0.5) | 0;
        const bi = (b * 31 / 255 + 0.5) | 0;
        const li = (ri * 1024 + gi * 32 + bi) * 3;
        nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
      } else {
        [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
      }

      const di = (y * w + x) * 4;
      result[di] = nr; result[di+1] = ng; result[di+2] = nb; result[di+3] = 255;
    }
  }
  return result;
}

// ─── Threshold Dithering ───
function ditherThreshold(pixels, w, h, lut, palette, nColors, level) {
  const result = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    // Just quantize to nearest palette color (threshold is handled by pre-adjusting brightness)
    let r = pixels[si], g = pixels[si + 1], b = pixels[si + 2];

    let nr, ng, nb;
    if (lut) {
      const ri = (r * 31 / 255 + 0.5) | 0;
      const gi = (g * 31 / 255 + 0.5) | 0;
      const bi = (b * 31 / 255 + 0.5) | 0;
      const li = (ri * 1024 + gi * 32 + bi) * 3;
      nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
    } else {
      [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
    }

    result[si] = nr; result[si+1] = ng; result[si+2] = nb; result[si+3] = 255;
  }
  return result;
}

// ─── Random (White Noise) Dithering ───
function ditherRandom(pixels, w, h, lut, palette, nColors) {
  const result = new Uint8ClampedArray(w * h * 4);
  const spread = 255 / Math.max(1, Math.cbrt(nColors) - 1);
  for (let i = 0; i < w * h; i++) {
    const si = i * 4;
    const noise = (Math.random() - 0.5) * spread;
    const r = Math.max(0, Math.min(255, pixels[si] + noise));
    const g = Math.max(0, Math.min(255, pixels[si + 1] + noise));
    const b = Math.max(0, Math.min(255, pixels[si + 2] + noise));

    let nr, ng, nb;
    if (lut) {
      const ri = (r * 31 / 255 + 0.5) | 0;
      const gi = (g * 31 / 255 + 0.5) | 0;
      const bi = (b * 31 / 255 + 0.5) | 0;
      const li = (ri * 1024 + gi * 32 + bi) * 3;
      nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
    } else {
      [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
    }

    result[si] = nr; result[si+1] = ng; result[si+2] = nb; result[si+3] = 255;
  }
  return result;
}

// ─── Blue Noise Dithering ───
function ditherBlueNoise(pixels, w, h, lut, palette, nColors) {
  if (!blueNoise) blueNoise = generateBlueNoise();
  const result = new Uint8ClampedArray(w * h * 4);
  const spread = 255 / Math.max(1, Math.cbrt(nColors) - 1);
  const bnSize = BLUE_NOISE_SIZE;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const bn = blueNoise[(y % bnSize) * bnSize + (x % bnSize)];
      const noise = (bn / 255 - 0.5) * spread;

      const r = Math.max(0, Math.min(255, pixels[si] + noise));
      const g = Math.max(0, Math.min(255, pixels[si + 1] + noise));
      const b = Math.max(0, Math.min(255, pixels[si + 2] + noise));

      let nr, ng, nb;
      if (lut) {
        const ri = (r * 31 / 255 + 0.5) | 0;
        const gi = (g * 31 / 255 + 0.5) | 0;
        const bi = (b * 31 / 255 + 0.5) | 0;
        const li = (ri * 1024 + gi * 32 + bi) * 3;
        nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
      } else {
        [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
      }

      result[si] = nr; result[si+1] = ng; result[si+2] = nb; result[si+3] = 255;
    }
  }
  return result;
}

// ─── Halftone Dithering ───
function ditherHalftone(pixels, w, h, lut, palette, nColors, dotSize, angle) {
  const result = new Uint8ClampedArray(w * h * 4);
  const rad = angle * Math.PI / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;

      // Rotate coordinates
      const rx = x * cosA + y * sinA;
      const ry = -x * sinA + y * cosA;

      // Distance to nearest dot center
      const cx = (Math.floor(rx / dotSize) + 0.5) * dotSize;
      const cy = (Math.floor(ry / dotSize) + 0.5) * dotSize;
      const dx = rx - cx;
      const dy = ry - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = dotSize * 0.707; // sqrt(2)/2

      // Normalize distance as threshold
      const threshold = dist / maxDist;

      // Get pixel luminance
      const lum = (pixels[si] * 0.299 + pixels[si+1] * 0.587 + pixels[si+2] * 0.114) / 255;

      // Compare luminance against threshold to decide dot
      const spread = 255 / Math.max(1, Math.cbrt(nColors) - 1);
      const offset = (threshold - 0.5) * spread;
      const r = Math.max(0, Math.min(255, pixels[si] + offset));
      const g = Math.max(0, Math.min(255, pixels[si + 1] + offset));
      const b = Math.max(0, Math.min(255, pixels[si + 2] + offset));

      let nr, ng, nb;
      if (lut) {
        const ri = (r * 31 / 255 + 0.5) | 0;
        const gi = (g * 31 / 255 + 0.5) | 0;
        const bi = (b * 31 / 255 + 0.5) | 0;
        const li = (ri * 1024 + gi * 32 + bi) * 3;
        nr = lut[li]; ng = lut[li + 1]; nb = lut[li + 2];
      } else {
        [nr, ng, nb] = nearestColorDirect(palette, nColors, r, g, b);
      }

      result[si] = nr; result[si+1] = ng; result[si+2] = nb; result[si+3] = 255;
    }
  }
  return result;
}

// ─── Main Message Handler ───
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'dither') {
    const {
      pixels, srcW, srcH, dstW, dstH,
      algorithm, palette, paletteKey,
      brightness, contrast, gamma,
      redBrightness, greenBrightness, blueBrightness,
      diffusionStrength, serpentine, bayerBias,
      thresholdLevel, halftoneSize, halftoneAngle,
      downscaleMethod, frameId
    } = msg;

    // Reconstruct palette as flat array
    const flatPalette = new Uint8Array(palette);
    const nColors = flatPalette.length / 3;

    // Rebuild LUT if palette changed
    if (paletteKey !== currentPaletteKey) {
      currentLUT = buildColorLUT(flatPalette);
      currentPaletteKey = paletteKey;
    }

    // Downscale
    const srcData = new Uint8ClampedArray(pixels);
    let downscaled;
    if (srcW === dstW && srcH === dstH) {
      downscaled = srcData;
    } else {
      switch (downscaleMethod || 'average') {
        case 'nearest': downscaled = downscaleNearest(srcData, srcW, srcH, dstW, dstH); break;
        case 'bilinear': downscaled = downscaleBilinear(srcData, srcW, srcH, dstW, dstH); break;
        default: downscaled = downscaleAverage(srcData, srcW, srcH, dstW, dstH); break;
      }
    }

    // Pre-process
    preprocess(downscaled, dstW, dstH, {
      brightness: brightness || 0,
      contrast: contrast || 0,
      gamma: gamma || 1.0,
      redBrightness: redBrightness || 0,
      greenBrightness: greenBrightness || 0,
      blueBrightness: blueBrightness || 0
    });

    // Keep a copy of the preprocessed (input) image for toning
    const inputCopy = new Uint8ClampedArray(downscaled);

    // Dither
    let result;
    const strength = diffusionStrength !== undefined ? diffusionStrength : 1.0;

    if (KERNELS[algorithm]) {
      result = ditherErrorDiffusion(downscaled, dstW, dstH, currentLUT, flatPalette, nColors,
                                     KERNELS[algorithm], strength, !!serpentine);
    } else if (algorithm === 'bayer2') {
      result = ditherOrdered(downscaled, dstW, dstH, currentLUT, flatPalette, nColors, 2, bayerBias || 0);
    } else if (algorithm === 'bayer4') {
      result = ditherOrdered(downscaled, dstW, dstH, currentLUT, flatPalette, nColors, 4, bayerBias || 0);
    } else if (algorithm === 'bayer8') {
      result = ditherOrdered(downscaled, dstW, dstH, currentLUT, flatPalette, nColors, 8, bayerBias || 0);
    } else if (algorithm === 'bayer16') {
      result = ditherOrdered(downscaled, dstW, dstH, currentLUT, flatPalette, nColors, 16, bayerBias || 0);
    } else if (algorithm === 'threshold') {
      // Apply threshold as brightness offset before quantization
      const thr = (thresholdLevel !== undefined ? thresholdLevel : 128) - 128;
      for (let i = 0; i < dstW * dstH * 4; i += 4) {
        downscaled[i] = Math.max(0, Math.min(255, downscaled[i] + thr));
        downscaled[i+1] = Math.max(0, Math.min(255, downscaled[i+1] + thr));
        downscaled[i+2] = Math.max(0, Math.min(255, downscaled[i+2] + thr));
      }
      result = ditherThreshold(downscaled, dstW, dstH, currentLUT, flatPalette, nColors, thresholdLevel || 128);
    } else if (algorithm === 'random') {
      result = ditherRandom(downscaled, dstW, dstH, currentLUT, flatPalette, nColors);
    } else if (algorithm === 'blue-noise') {
      result = ditherBlueNoise(downscaled, dstW, dstH, currentLUT, flatPalette, nColors);
    } else if (algorithm === 'halftone') {
      result = ditherHalftone(downscaled, dstW, dstH, currentLUT, flatPalette, nColors,
                              halftoneSize || 4, halftoneAngle || 45);
    } else {
      // Default to Floyd-Steinberg
      result = ditherErrorDiffusion(downscaled, dstW, dstH, currentLUT, flatPalette, nColors,
                                     KERNELS['floyd-steinberg'], strength, !!serpentine);
    }

    // Transfer result back (zero-copy)
    const resultBuffer = result.buffer;
    const inputBuffer = inputCopy.buffer;
    self.postMessage({
      type: 'result',
      pixels: resultBuffer,
      inputPixels: inputBuffer,
      width: dstW,
      height: dstH,
      frameId: frameId
    }, [resultBuffer, inputBuffer]);
  }
};
