// Dither Studio — Main App Controller
// Camera, render loop, state, UI, events

'use strict';

// ─── State ───
const S = {
  // Source
  sourceType: 'none', // 'none', 'camera', 'image'
  sourceImage: null,   // HTMLImageElement or null
  sourceWidth: 0,
  sourceHeight: 0,

  // Algorithm
  algorithm: 'floyd-steinberg',
  diffusionStrength: 1.0,
  serpentine: false,
  bayerBias: 0,
  thresholdLevel: 128,
  halftoneSize: 4,
  halftoneAngle: 45,

  // Palette
  paletteName: 'Black & White',
  paletteColors: [[0,0,0], [255,255,255]],
  paletteKey: 'bw',
  customColors: [[0,0,0], [255,255,255]],

  // Input processing
  brightness: 0,
  contrast: 0,
  gamma: 1.0,
  redBrightness: 0,
  greenBrightness: 0,
  blueBrightness: 0,

  // Output processing
  hueShift: 0,
  saturation: 100,
  outContrast: 0,
  toneByInput: false,
  toneColor: [255, 255, 255],
  toneStrength: 0,
  bgColor: null,

  // Resolution
  pixelScale: 16,
  customWidth: 0,
  customHeight: 0,
  downscaleMethod: 'average',

  // Transport
  transportEnabled: false,
  transportMode: 'overdamped',
  transportSpring: 0.5,
  transportDamping: 0.8,
  transportRepulsion: 1.0,
  transportMass: 1.0,
  transportMaxVel: 5,
  transportAssignment: 'greedy',
  transportInit: 'previous',
  transportTrails: false,
  transportTrailLen: 5,
  transportMassLock: false,

  // Export
  exportScale: 4,
  exportFormat: 'png',
  exportTransparent: false,

  // Camera
  cameraActive: false,
  cameraDeviceId: null,
  cameraFacingMode: 'environment',

  // Internal
  workerBusy: false,
  frameId: 0,
  lastResult: null,       // Uint8ClampedArray RGBA of dithered output
  lastInputPixels: null,  // Uint8ClampedArray RGBA of preprocessed input
  lastProcessedOutput: null, // Final post-processed output for export
  lastResultW: 0,
  lastResultH: 0,
  needsRedraw: true,
  captures: [],           // Array of {dataUrl, timestamp}
  recording: false,       // Video recording active
};

// ─── DOM References ───
const $ = id => document.getElementById(id);
const canvas = $('output-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });
const video = $('camera-video');

// ─── Worker ───
const ditherWorker = new Worker('dither-worker.js');

// ─── Undo/Redo ───
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50;
const UNDO_KEYS = [
  'algorithm', 'diffusionStrength', 'serpentine', 'bayerBias', 'thresholdLevel',
  'halftoneSize', 'halftoneAngle', 'paletteName', 'brightness', 'contrast', 'gamma',
  'redBrightness', 'greenBrightness', 'blueBrightness', 'hueShift', 'saturation',
  'outContrast', 'toneByInput', 'toneStrength', 'pixelScale', 'customWidth', 'customHeight',
  'downscaleMethod', 'transportEnabled', 'transportMode', 'transportSpring', 'transportDamping',
  'transportRepulsion', 'transportMass', 'transportMaxVel'
];

function saveUndoState() {
  const snapshot = {};
  for (const k of UNDO_KEYS) snapshot[k] = S[k];
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (undoStack.length === 0) return;
  const current = {};
  for (const k of UNDO_KEYS) current[k] = S[k];
  redoStack.push(current);
  const prev = undoStack.pop();
  Object.assign(S, prev);
  syncUIFromState();
  S.needsRedraw = true;
}

function redo() {
  if (redoStack.length === 0) return;
  const current = {};
  for (const k of UNDO_KEYS) current[k] = S[k];
  undoStack.push(current);
  const next = redoStack.pop();
  Object.assign(S, next);
  syncUIFromState();
  S.needsRedraw = true;
}

// ─── Palette Management ───
function setPalette(name) {
  const pal = PALETTES[name];
  if (!pal) return;
  S.paletteName = name;
  S.paletteColors = name === 'Custom' ? [...S.customColors] : [...pal.colors];
  S.paletteKey = name + ':' + S.paletteColors.map(c => c.join(',')).join('|');
  updatePaletteStrip();
  updateCustomPaletteUI();
  S.needsRedraw = true;
}

function updatePaletteStrip() {
  const strip = $('palette-strip');
  strip.innerHTML = '';
  for (const c of S.paletteColors) {
    const sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    strip.appendChild(sw);
  }
}

function updateCustomPaletteUI() {
  const group = $('custom-palette-group');
  const container = $('custom-palette-colors');
  group.style.display = S.paletteName === 'Custom' ? '' : 'none';
  if (S.paletteName !== 'Custom') return;

  container.innerHTML = '';
  S.customColors.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'custom-color';
    el.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    el.onclick = () => {
      if (S.customColors.length <= 2) return; // minimum 2 colors
      S.customColors.splice(i, 1);
      setPalette('Custom');
    };
    container.appendChild(el);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'add-color-btn';
  addBtn.textContent = '+';
  addBtn.onclick = () => {
    const picker = $('color-picker-input');
    picker.onchange = () => {
      const hex = picker.value;
      const r = parseInt(hex.substr(1,2), 16);
      const g = parseInt(hex.substr(3,2), 16);
      const b = parseInt(hex.substr(5,2), 16);
      S.customColors.push([r, g, b]);
      setPalette('Custom');
    };
    picker.click();
  };
  container.appendChild(addBtn);
}

function populatePaletteSelect() {
  const sel = $('palette-select');
  sel.innerHTML = '';
  for (const name of Object.keys(PALETTES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${PALETTES[name].colors.length})`;
    sel.appendChild(opt);
  }
  sel.value = S.paletteName;
}

// ─── Compute Working Resolution ───
function getWorkingSize() {
  if (S.customWidth > 0 && S.customHeight > 0) {
    return { w: S.customWidth, h: S.customHeight };
  }
  if (S.customWidth > 0) {
    const aspect = S.sourceHeight / S.sourceWidth;
    return { w: S.customWidth, h: Math.max(2, Math.round(S.customWidth * aspect)) };
  }
  if (S.customHeight > 0) {
    const aspect = S.sourceWidth / S.sourceHeight;
    return { w: Math.max(2, Math.round(S.customHeight * aspect)), h: S.customHeight };
  }
  const scale = Math.max(1, S.pixelScale);
  return {
    w: Math.max(2, Math.round(S.sourceWidth / scale)),
    h: Math.max(2, Math.round(S.sourceHeight / scale))
  };
}

// ─── Send Frame to Worker ───
function sendFrameToWorker(pixels, srcW, srcH) {
  if (S.workerBusy) return;

  const { w: dstW, h: dstH } = getWorkingSize();
  if (dstW < 2 || dstH < 2) return;

  S.workerBusy = true;
  S.frameId++;

  // Flatten palette to Uint8Array
  const flatPalette = new Uint8Array(S.paletteColors.length * 3);
  for (let i = 0; i < S.paletteColors.length; i++) {
    flatPalette[i*3] = S.paletteColors[i][0];
    flatPalette[i*3+1] = S.paletteColors[i][1];
    flatPalette[i*3+2] = S.paletteColors[i][2];
  }

  // Always copy — getImageData returns a buffer tied to the canvas
  const pixelsCopy = new Uint8ClampedArray(pixels);
  const buffer = pixelsCopy.buffer;

  ditherWorker.postMessage({
    type: 'dither',
    pixels: buffer,
    srcW, srcH, dstW, dstH,
    algorithm: S.algorithm,
    palette: flatPalette.buffer,
    paletteKey: S.paletteKey,
    brightness: S.brightness,
    contrast: S.contrast,
    gamma: S.gamma,
    redBrightness: S.redBrightness,
    greenBrightness: S.greenBrightness,
    blueBrightness: S.blueBrightness,
    diffusionStrength: S.diffusionStrength,
    serpentine: S.serpentine,
    bayerBias: S.bayerBias,
    thresholdLevel: S.thresholdLevel,
    halftoneSize: S.halftoneSize,
    halftoneAngle: S.halftoneAngle,
    downscaleMethod: S.downscaleMethod,
    frameId: S.frameId
  }, [buffer]);
}

// ─── Worker Response ───
ditherWorker.onmessage = function(e) {
  const msg = e.data;
  if (msg.type === 'result') {
    S.workerBusy = false;
    S.lastResult = new Uint8ClampedArray(msg.pixels);
    S.lastInputPixels = new Uint8ClampedArray(msg.inputPixels);
    S.lastResultW = msg.width;
    S.lastResultH = msg.height;
    renderResult();
  }
};

// ─── Render Result to Canvas ───
function renderResult() {
  if (!S.lastResult) return;

  let output = S.lastResult;
  const w = S.lastResultW;
  const h = S.lastResultH;

  // Post-processing
  if (S.transportEnabled) {
    // Transport rendering handled separately
    output = renderTransport(output, w, h);
  }

  output = Pipeline.process(output, S.lastInputPixels, w, h, {
    hueShift: S.hueShift,
    saturation: S.saturation,
    outContrast: S.outContrast,
    toneByInput: S.toneByInput,
    toneColor: S.toneColor,
    toneStrength: S.toneStrength,
    bgColor: S.bgColor
  });

  // Set canvas to working resolution (CSS scales it up with pixelated rendering)
  canvas.width = w;
  canvas.height = h;
  ctx.putImageData(new ImageData(output, w, h), 0, 0);

  // Store final output for export
  S.lastProcessedOutput = output;

  fitCanvasToViewport();
}

// ─── Fit Canvas CSS Size to Viewport ───
function fitCanvasToViewport() {
  const area = $('canvas-area');
  const areaW = area.clientWidth;
  const areaH = area.clientHeight;
  const cw = canvas.width;
  const ch = canvas.height;

  if (cw === 0 || ch === 0) return;

  const scaleX = areaW / cw;
  const scaleY = areaH / ch;
  const scale = Math.max(1, Math.floor(Math.min(scaleX, scaleY)));

  canvas.style.width = (cw * scale) + 'px';
  canvas.style.height = (ch * scale) + 'px';
}

// ─── Camera ───
let cameraStream = null;
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

async function startCamera(deviceId) {
  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: S.cameraFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
    };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = cameraStream;
    await video.play();

    S.cameraActive = true;
    S.sourceType = 'camera';

    // Wait for video dimensions
    await new Promise(resolve => {
      if (video.videoWidth > 0) return resolve();
      video.onloadedmetadata = resolve;
    });

    S.sourceWidth = video.videoWidth;
    S.sourceHeight = video.videoHeight;
    captureCanvas.width = S.sourceWidth;
    captureCanvas.height = S.sourceHeight;

    $('btn-camera').classList.add('active');
    $('snap-btn-wrap').classList.add('visible');
    S.needsRedraw = true;

    // Enumerate cameras after permission granted
    enumerateCameras();

  } catch (err) {
    console.error('Camera access failed:', err);
    S.cameraActive = false;
  }
}

async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const sel = $('camera-select');
    if (cameras.length <= 1) { sel.classList.remove('visible'); return; }

    sel.innerHTML = '';
    cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${sel.options.length + 1}`;
      sel.appendChild(opt);
    });

    // Select current camera
    if (S.cameraDeviceId) sel.value = S.cameraDeviceId;
    sel.classList.add('visible');
  } catch (e) {
    console.warn('Could not enumerate cameras:', e);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  S.cameraActive = false;
  S.sourceType = S.sourceImage ? 'image' : 'none';
  $('btn-camera').classList.remove('active');
  $('snap-btn-wrap').classList.remove('visible');
}

function captureFrame() {
  if (!S.cameraActive || video.videoWidth === 0) return null;
  captureCtx.drawImage(video, 0, 0);
  return captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
}

// ─── Image Source ───
const imageCanvas = document.createElement('canvas');
const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true });

function loadImageSource(img) {
  S.sourceImage = img;
  S.sourceWidth = img.naturalWidth || img.width;
  S.sourceHeight = img.naturalHeight || img.height;
  S.sourceType = 'image';

  imageCanvas.width = S.sourceWidth;
  imageCanvas.height = S.sourceHeight;
  imageCtx.drawImage(img, 0, 0);

  if (S.cameraActive) stopCamera();
  S.needsRedraw = true;
}

function loadImageFromFile(file) {
  const img = new Image();
  img.onload = () => {
    loadImageSource(img);
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}

function loadImageFromUrl(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => loadImageSource(img);
  img.src = url;
}

function getSourcePixels() {
  if (S.sourceType === 'camera') {
    const frame = captureFrame();
    return frame ? frame.data : null;
  }
  if (S.sourceType === 'image' && S.sourceImage) {
    return imageCtx.getImageData(0, 0, S.sourceWidth, S.sourceHeight).data;
  }
  return null;
}

// ─── Transport System (placeholder — simple pass-through until transport-worker.js) ───
let transportWorker = null;
let transportParticles = null;
let transportTargets = null;

function renderTransport(ditheredPixels, w, h) {
  // For now, transport is a visual placeholder
  // Full implementation comes with transport-worker.js
  if (!S.transportEnabled) return ditheredPixels;

  // Extract "on" pixel targets (non-background pixels)
  if (!transportParticles || transportParticles.w !== w || transportParticles.h !== h) {
    initTransportParticles(ditheredPixels, w, h);
  } else {
    updateTransportTargets(ditheredPixels, w, h);
    stepTransportPhysics(w, h);
  }

  return renderTransportPixels(w, h, ditheredPixels);
}

function initTransportParticles(pixels, w, h) {
  // Find "on" pixels (darker than midpoint)
  const targets = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = pixels[i] * 0.299 + pixels[i+1] * 0.587 + pixels[i+2] * 0.114;
      if (lum < 128) {
        targets.push(x, y);
      }
    }
  }

  const count = targets.length / 2;
  const positions = new Float32Array(count * 2);
  const velocities = new Float32Array(count * 2);

  // Initialize positions based on init mode
  for (let i = 0; i < count; i++) {
    switch (S.transportInit) {
      case 'random':
        positions[i*2] = Math.random() * w;
        positions[i*2+1] = Math.random() * h;
        break;
      case 'center':
        positions[i*2] = w / 2 + (Math.random() - 0.5) * 2;
        positions[i*2+1] = h / 2 + (Math.random() - 0.5) * 2;
        break;
      case 'rain':
        positions[i*2] = Math.random() * w;
        positions[i*2+1] = 0;
        break;
      default: // 'previous' or 'dither'
        positions[i*2] = targets[i*2];
        positions[i*2+1] = targets[i*2+1];
    }
  }

  transportParticles = {
    positions,
    velocities,
    count,
    targets: new Float32Array(targets),
    targetCount: count,
    w, h,
    trailHistory: S.transportTrails ? [] : null
  };
}

function updateTransportTargets(pixels, w, h) {
  const targets = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = pixels[i] * 0.299 + pixels[i+1] * 0.587 + pixels[i+2] * 0.114;
      if (lum < 128) {
        targets.push(x, y);
      }
    }
  }

  const newCount = targets.length / 2;
  const oldCount = transportParticles.count;

  // Resize particles if needed
  if (newCount !== oldCount) {
    const newPos = new Float32Array(newCount * 2);
    const newVel = new Float32Array(newCount * 2);

    const copyCount = Math.min(oldCount, newCount);
    for (let i = 0; i < copyCount * 2; i++) {
      newPos[i] = transportParticles.positions[i];
      newVel[i] = transportParticles.velocities[i];
    }

    // New particles start at random target positions
    for (let i = copyCount; i < newCount; i++) {
      const ti = Math.floor(Math.random() * newCount);
      newPos[i*2] = targets[ti*2];
      newPos[i*2+1] = targets[ti*2+1];
    }

    transportParticles.positions = newPos;
    transportParticles.velocities = newVel;
    transportParticles.count = newCount;
  }

  transportParticles.targets = new Float32Array(targets);
  transportParticles.targetCount = newCount;

  // Greedy nearest assignment (simple version)
  assignTargets();
}

function assignTargets() {
  const p = transportParticles;
  if (!p || p.count === 0) return;

  const assigned = new Float32Array(p.count * 2);
  const used = new Uint8Array(p.targetCount);

  if (S.transportAssignment === 'random') {
    // Random assignment
    const indices = Array.from({length: p.targetCount}, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let i = 0; i < p.count && i < p.targetCount; i++) {
      assigned[i*2] = p.targets[indices[i]*2];
      assigned[i*2+1] = p.targets[indices[i]*2+1];
    }
  } else {
    // Greedy nearest
    for (let i = 0; i < p.count; i++) {
      const px = p.positions[i*2];
      const py = p.positions[i*2+1];
      let bestDist = Infinity;
      let bestJ = 0;

      for (let j = 0; j < p.targetCount; j++) {
        if (used[j]) continue;
        const dx = px - p.targets[j*2];
        const dy = py - p.targets[j*2+1];
        const dist = dx*dx + dy*dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestJ = j;
        }
      }

      used[bestJ] = 1;
      assigned[i*2] = p.targets[bestJ*2];
      assigned[i*2+1] = p.targets[bestJ*2+1];
    }
  }

  p.assignedTargets = assigned;
}

function stepTransportPhysics(w, h) {
  const p = transportParticles;
  if (!p || p.count === 0 || !p.assignedTargets) return;

  const dt = 1.0;
  const k = S.transportSpring;
  const damping = S.transportDamping;
  const maxVel = S.transportMaxVel;
  const mass = S.transportMass;

  // Save trail history
  if (S.transportTrails) {
    if (!p.trailHistory) p.trailHistory = [];
    p.trailHistory.push(new Float32Array(p.positions));
    if (p.trailHistory.length > S.transportTrailLen) p.trailHistory.shift();
  }

  for (let i = 0; i < p.count; i++) {
    const px = p.positions[i*2];
    const py = p.positions[i*2+1];
    const tx = p.assignedTargets[i*2];
    const ty = p.assignedTargets[i*2+1];

    let fx = 0, fy = 0;

    switch (S.transportMode) {
      case 'overdamped':
        // Smooth slide toward target
        fx = (tx - px) * k;
        fy = (ty - py) * k;
        p.velocities[i*2] = fx * (1 - damping);
        p.velocities[i*2+1] = fy * (1 - damping);
        break;

      case 'underdamped':
        // Spring-mass with low damping
        fx = (tx - px) * k;
        fy = (ty - py) * k;
        p.velocities[i*2] += (fx / mass) * dt;
        p.velocities[i*2+1] += (fy / mass) * dt;
        p.velocities[i*2] *= (1.0 - damping * 0.3 * dt);
        p.velocities[i*2+1] *= (1.0 - damping * 0.3 * dt);
        break;

      case 'ballistic':
        // Launch toward target, then decelerate
        if (Math.abs(p.velocities[i*2]) < 0.01 && Math.abs(p.velocities[i*2+1]) < 0.01) {
          const dx = tx - px;
          const dy = ty - py;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist > 0.5) {
            p.velocities[i*2] = (dx / dist) * maxVel;
            p.velocities[i*2+1] = (dy / dist) * maxVel;
          }
        }
        p.velocities[i*2] *= (1.0 - damping * dt);
        p.velocities[i*2+1] *= (1.0 - damping * dt);
        break;

      case 'diffusion':
        // Random walk biased toward target
        const dx = tx - px;
        const dy = ty - py;
        p.velocities[i*2] = dx * k * 0.1 + (Math.random() - 0.5) * maxVel * 0.5;
        p.velocities[i*2+1] = dy * k * 0.1 + (Math.random() - 0.5) * maxVel * 0.5;
        break;
    }

    // Clamp velocity
    const vx = Math.max(-maxVel, Math.min(maxVel, p.velocities[i*2]));
    const vy = Math.max(-maxVel, Math.min(maxVel, p.velocities[i*2+1]));
    p.velocities[i*2] = vx;
    p.velocities[i*2+1] = vy;

    // Update position
    p.positions[i*2] = Math.max(0, Math.min(w - 1, px + vx * dt));
    p.positions[i*2+1] = Math.max(0, Math.min(h - 1, py + vy * dt));
  }
}

function renderTransportPixels(w, h, ditheredPixels) {
  const p = transportParticles;
  if (!p || p.count === 0) return ditheredPixels;

  // Find the background color (lightest in palette)
  let bgR = 255, bgG = 255, bgB = 255;
  let maxLum = -1;
  for (const c of S.paletteColors) {
    const lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    if (lum > maxLum) { maxLum = lum; bgR = c[0]; bgG = c[1]; bgB = c[2]; }
  }

  // Find the foreground color (darkest in palette)
  let fgR = 0, fgG = 0, fgB = 0;
  let minLum = Infinity;
  for (const c of S.paletteColors) {
    const lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    if (lum < minLum) { minLum = lum; fgR = c[0]; fgG = c[1]; fgB = c[2]; }
  }

  const result = new Uint8ClampedArray(w * h * 4);

  // Fill with background
  for (let i = 0; i < w * h; i++) {
    result[i*4] = bgR;
    result[i*4+1] = bgG;
    result[i*4+2] = bgB;
    result[i*4+3] = 255;
  }

  // Draw trail history (faded)
  if (S.transportTrails && p.trailHistory) {
    for (let t = 0; t < p.trailHistory.length; t++) {
      const trail = p.trailHistory[t];
      const alpha = (t + 1) / (p.trailHistory.length + 1);
      const tr = bgR + (fgR - bgR) * alpha * 0.5;
      const tg = bgG + (fgG - bgG) * alpha * 0.5;
      const tb = bgB + (fgB - bgB) * alpha * 0.5;

      for (let i = 0; i < p.count; i++) {
        const x = Math.round(trail[i*2]);
        const y = Math.round(trail[i*2+1]);
        if (x >= 0 && x < w && y >= 0 && y < h) {
          const idx = (y * w + x) * 4;
          result[idx] = tr;
          result[idx+1] = tg;
          result[idx+2] = tb;
        }
      }
    }
  }

  // Draw particles at current positions
  for (let i = 0; i < p.count; i++) {
    const x = Math.round(p.positions[i*2]);
    const y = Math.round(p.positions[i*2+1]);
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 4;
      result[idx] = fgR;
      result[idx+1] = fgG;
      result[idx+2] = fgB;
    }
  }

  return result;
}

// ─── Snap Photo ───
function snapPhoto() {
  if (!S.lastProcessedOutput || S.lastResultW === 0) return;

  const w = S.lastResultW;
  const h = S.lastResultH;
  const scale = Math.max(1, Math.ceil(256 / Math.max(w, h)));

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = w * scale;
  tmpCanvas.height = h * scale;
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.imageSmoothingEnabled = false;

  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sCtx = small.getContext('2d');
  sCtx.putImageData(new ImageData(new Uint8ClampedArray(S.lastProcessedOutput), w, h), 0, 0);

  tmpCtx.drawImage(small, 0, 0, w * scale, h * scale);

  const dataUrl = tmpCanvas.toDataURL('image/png');
  S.captures.push({ dataUrl, timestamp: Date.now(), w, h, pixels: new Uint8ClampedArray(S.lastProcessedOutput) });

  updatePhotoStack();
}

function updatePhotoStack() {
  const stack = $('photo-stack');
  if (S.captures.length === 0) {
    stack.classList.remove('visible');
    return;
  }
  stack.classList.add('visible');
  $('photo-stack-thumb').src = S.captures[S.captures.length - 1].dataUrl;
  $('photo-stack-badge').textContent = S.captures.length;
}

// ─── Gallery ───
function openGallery() {
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  S.captures.forEach((cap, i) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = cap.dataUrl;
    item.appendChild(img);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'gallery-delete';
    delBtn.innerHTML = '\u00d7';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      S.captures.splice(i, 1);
      updatePhotoStack();
      openGallery(); // refresh grid
    });
    item.appendChild(delBtn);

    item.onclick = () => {
      // Re-load as source image
      const newImg = new Image();
      newImg.onload = () => {
        loadImageSource(newImg);
        closeGallery();
      };
      newImg.src = cap.dataUrl;
    };
    grid.appendChild(item);
  });
  $('gallery-overlay').classList.add('visible');
}

function closeGallery() {
  $('gallery-overlay').classList.remove('visible');
}

// ─── Video Recording ───
let recordingCanvas = null;
let recordingCtx = null;
let activeRecorder = null;
let recordingStartTime = 0;
let recordingTimerId = null;
let recordingProgressId = null;

function startVideoRecording(targetW, targetH, maxDuration) {
  if (activeRecorder) return;

  const w = S.lastResultW || 40;
  const h = S.lastResultH || 30;
  const outW = targetW || w * (S.exportScale === 'source' ? S.pixelScale : (typeof S.exportScale === 'number' ? S.exportScale : 4));
  const outH = targetH || h * (S.exportScale === 'source' ? S.pixelScale : (typeof S.exportScale === 'number' ? S.exportScale : 4));

  recordingCanvas = document.createElement('canvas');
  recordingCanvas.width = outW;
  recordingCanvas.height = outH;
  recordingCtx = recordingCanvas.getContext('2d');
  recordingCtx.imageSmoothingEnabled = false;

  const duration = maxDuration || parseInt($('video-duration').value) || 3;
  const format = $('video-format').value;

  activeRecorder = Exporter.startRecording(recordingCanvas, format, duration, () => {
    cleanupRecording();
  });

  recordingStartTime = Date.now();
  S.recording = true;

  $('snap-btn').classList.add('recording');
  $('rec-indicator').classList.add('visible');

  // Update progress ring and timer
  recordingProgressId = setInterval(() => {
    const elapsed = (Date.now() - recordingStartTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    $('snap-btn').style.setProperty('--rec-progress', progress);
    $('rec-timer').textContent = elapsed.toFixed(1) + 's';
  }, 50);
}

function stopVideoRecording() {
  if (activeRecorder && activeRecorder.state === 'recording') {
    activeRecorder.stop();
  }
}

function cleanupRecording() {
  activeRecorder = null;
  recordingCanvas = null;
  recordingCtx = null;
  S.recording = false;
  $('snap-btn').classList.remove('recording');
  $('snap-btn').style.removeProperty('--rec-progress');
  $('rec-indicator').classList.remove('visible');
  if (recordingProgressId) { clearInterval(recordingProgressId); recordingProgressId = null; }
  if (recordingTimerId) { clearTimeout(recordingTimerId); recordingTimerId = null; }
}

function updateRecordingFrame() {
  if (!recordingCanvas || !recordingCtx) return;
  recordingCtx.drawImage(canvas, 0, 0, recordingCanvas.width, recordingCanvas.height);
}

// ─── Built-in Presets ───
const BUILT_IN_PRESETS = {
  'Classic Mac': {
    algorithm: 'atkinson', paletteName: 'Black & White',
    pixelScale: 16, serpentine: true, diffusionStrength: 1.0,
  },
  'Game Boy Photo': {
    algorithm: 'atkinson', paletteName: 'Game Boy (DMG)',
    pixelScale: 8, diffusionStrength: 0.8,
  },
  '1-Bit Noir': {
    algorithm: 'floyd-steinberg', paletteName: 'Black & White',
    pixelScale: 8, contrast: 30, brightness: -10,
  },
  'Newspaper': {
    algorithm: 'halftone', paletteName: 'Black & White',
    pixelScale: 4, halftoneSize: 6, halftoneAngle: 45,
  },
  'Matrix': {
    algorithm: 'floyd-steinberg', paletteName: 'Black & White',
    pixelScale: 12, toneStrength: 80, toneByInput: false,
    toneColor: [0, 255, 65], bgColor: [0, 0, 0],
  },
  'Thermal Camera': {
    algorithm: 'bayer8', paletteName: 'Sweetie 16',
    pixelScale: 8, hueShift: 0,
  },
  'CRT Retro': {
    algorithm: 'sierra', paletteName: 'EGA',
    pixelScale: 6, serpentine: true,
  },
};

// Keys to save/load in presets and URL state
const PRESET_KEYS = [
  'algorithm', 'diffusionStrength', 'serpentine', 'bayerBias', 'thresholdLevel',
  'halftoneSize', 'halftoneAngle', 'paletteName', 'brightness', 'contrast', 'gamma',
  'redBrightness', 'greenBrightness', 'blueBrightness', 'hueShift', 'saturation',
  'outContrast', 'toneByInput', 'toneStrength', 'pixelScale', 'customWidth', 'customHeight',
  'downscaleMethod', 'transportEnabled', 'transportMode', 'transportSpring', 'transportDamping',
  'transportRepulsion', 'transportMass', 'transportMaxVel',
];

function getStateSnapshot() {
  const snap = {};
  for (const k of PRESET_KEYS) snap[k] = S[k];
  // Also save color-based settings
  snap.toneColor = [...S.toneColor];
  snap.bgColor = S.bgColor ? [...S.bgColor] : null;
  return snap;
}

function applyPreset(preset) {
  saveUndoState();
  // Apply only keys that exist in the preset
  for (const k of PRESET_KEYS) {
    if (k in preset) S[k] = preset[k];
  }
  if (preset.toneColor) S.toneColor = [...preset.toneColor];
  if (preset.bgColor !== undefined) S.bgColor = preset.bgColor ? [...preset.bgColor] : null;
  if (preset.toneByInput !== undefined) S.toneByInput = preset.toneByInput;
  setPalette(S.paletteName);
  transportParticles = null;
  syncUIFromState();
}

function getUserPresets() {
  try {
    return JSON.parse(localStorage.getItem('dither-presets') || '{}');
  } catch { return {}; }
}

function saveUserPreset(name) {
  const presets = getUserPresets();
  presets[name] = getStateSnapshot();
  localStorage.setItem('dither-presets', JSON.stringify(presets));
  populatePresetList();
}

function deleteUserPreset(name) {
  const presets = getUserPresets();
  delete presets[name];
  localStorage.setItem('dither-presets', JSON.stringify(presets));
  populatePresetList();
}

function populatePresetList() {
  const list = $('preset-list');
  if (!list) return;
  list.innerHTML = '';

  // Built-in presets
  for (const [name, preset] of Object.entries(BUILT_IN_PRESETS)) {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `<span class="preset-item-name">${name}</span><span class="preset-item-badge">built-in</span>`;
    item.addEventListener('click', () => applyPreset(preset));
    list.appendChild(item);
  }

  // User presets
  const userPresets = getUserPresets();
  for (const [name, preset] of Object.entries(userPresets)) {
    const item = document.createElement('div');
    item.className = 'preset-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'preset-item-name';
    nameSpan.textContent = name;
    const delBtn = document.createElement('button');
    delBtn.className = 'preset-item-delete';
    delBtn.innerHTML = '\u00d7';
    delBtn.title = 'Delete preset';
    delBtn.addEventListener('click', e => { e.stopPropagation(); deleteUserPreset(name); });
    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    item.addEventListener('click', () => applyPreset(preset));
    list.appendChild(item);
  }
}

// ─── URL State Encoding ───
const URL_KEY_MAP = {
  a: 'algorithm', p: 'paletteName', s: 'pixelScale',
  b: 'brightness', c: 'contrast', g: 'gamma',
  rb: 'redBrightness', gb: 'greenBrightness', bb: 'blueBrightness',
  ds: 'diffusionStrength', se: 'serpentine', bi: 'bayerBias',
  th: 'thresholdLevel', hs: 'halftoneSize', ha: 'halftoneAngle',
  hu: 'hueShift', sa: 'saturation', oc: 'outContrast',
  ts: 'toneStrength', te: 'transportEnabled', tm: 'transportMode',
  cw: 'customWidth', ch: 'customHeight', dm: 'downscaleMethod',
};
const URL_KEY_REV = {};
for (const [k, v] of Object.entries(URL_KEY_MAP)) URL_KEY_REV[v] = k;

// Default values for comparison (only encode non-defaults)
const DEFAULTS = {
  algorithm: 'floyd-steinberg', paletteName: 'Black & White', pixelScale: 16,
  brightness: 0, contrast: 0, gamma: 1.0,
  redBrightness: 0, greenBrightness: 0, blueBrightness: 0,
  diffusionStrength: 1.0, serpentine: false, bayerBias: 0,
  thresholdLevel: 128, halftoneSize: 4, halftoneAngle: 45,
  hueShift: 0, saturation: 100, outContrast: 0,
  toneStrength: 0, transportEnabled: false, transportMode: 'overdamped',
  customWidth: 0, customHeight: 0, downscaleMethod: 'average',
};

function encodeStateToURL() {
  const params = [];
  for (const [short, key] of Object.entries(URL_KEY_MAP)) {
    const val = S[key];
    const def = DEFAULTS[key];
    if (val === def) continue;
    // Encode booleans as 0/1
    if (typeof val === 'boolean') {
      params.push(`${short}=${val ? 1 : 0}`);
    } else {
      params.push(`${short}=${encodeURIComponent(val)}`);
    }
  }
  const hash = params.length > 0 ? '#' + params.join('&') : '';
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash || window.location.pathname);
  }
}

function loadStateFromURL() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return false;

  const params = hash.slice(1).split('&');
  let applied = false;

  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const short = param.slice(0, eq);
    const rawVal = decodeURIComponent(param.slice(eq + 1));
    const key = URL_KEY_MAP[short];
    if (!key) continue;

    const def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      S[key] = rawVal === '1' || rawVal === 'true';
    } else if (typeof def === 'number') {
      S[key] = parseFloat(rawVal);
    } else {
      S[key] = rawVal;
    }
    applied = true;
  }

  if (applied) {
    setPalette(S.paletteName);
    syncUIFromState();
  }
  return applied;
}

// ─── Main Render Loop ───
let lastFrameTime = 0;
let fpsCounter = 0;
let fpsTimer = 0;

function renderLoop(timestamp) {
  requestAnimationFrame(renderLoop);

  // FPS counter
  fpsCounter++;
  if (timestamp - fpsTimer >= 1000) {
    $('fps-display').textContent = fpsCounter + ' fps';
    fpsCounter = 0;
    fpsTimer = timestamp;
  }

  if (S.sourceType === 'none') return;

  // Camera mode: capture every frame
  if (S.sourceType === 'camera') {
    const pixels = getSourcePixels();
    if (pixels) {
      sendFrameToWorker(pixels, S.sourceWidth, S.sourceHeight);
    }
    // Transport step even if worker didn't return new frame
    if (S.transportEnabled && transportParticles) {
      stepTransportPhysics(S.lastResultW, S.lastResultH);
      renderResult();
    }
    if (S.recording) updateRecordingFrame();
    return;
  }

  // Static image: only re-process when something changed
  if (S.needsRedraw) {
    S.needsRedraw = false;
    const pixels = getSourcePixels();
    if (pixels) {
      sendFrameToWorker(pixels, S.sourceWidth, S.sourceHeight);
    }
  }

  // Transport animation continues even with static image
  if (S.transportEnabled && transportParticles) {
    stepTransportPhysics(S.lastResultW, S.lastResultH);
    renderResult();
  }

  if (S.recording) updateRecordingFrame();
}

// ─── UI Event Binding ───
function initUI() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Algorithm buttons
  document.querySelectorAll('.algo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      saveUndoState();
      document.querySelectorAll('.algo-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.algorithm = btn.dataset.algo;
      S.needsRedraw = true;
      transportParticles = null;
      encodeStateToURL();
    });
  });

  // Palette select
  populatePaletteSelect();
  $('palette-select').addEventListener('change', e => {
    saveUndoState();
    setPalette(e.target.value);
    encodeStateToURL();
  });
  setPalette(S.paletteName);

  // Sliders
  bindSlider('brightness', v => { S.brightness = v; }, v => v.toString(), 0);
  bindSlider('contrast', v => { S.contrast = v; }, v => v.toString(), 0);
  bindSlider('gamma', v => { S.gamma = v / 100; }, v => (v / 100).toFixed(2), 100);
  bindSlider('red-brightness', v => { S.redBrightness = v; }, v => v.toString(), 0);
  bindSlider('green-brightness', v => { S.greenBrightness = v; }, v => v.toString(), 0);
  bindSlider('blue-brightness', v => { S.blueBrightness = v; }, v => v.toString(), 0);
  bindSlider('pixel-scale', v => { S.pixelScale = v; transportParticles = null; }, v => v + 'x', 16);
  bindSlider('diffusion-strength', v => { S.diffusionStrength = v / 100; }, v => (v / 100).toFixed(2), 100);
  bindSlider('bayer-bias', v => { S.bayerBias = v / 100; }, v => (v / 100).toFixed(2), 0);
  bindSlider('threshold-level', v => { S.thresholdLevel = v; }, v => v.toString(), 128);
  bindSlider('halftone-size', v => { S.halftoneSize = v; }, v => v.toString(), 4);
  bindSlider('halftone-angle', v => { S.halftoneAngle = v; }, v => v.toString(), 45);
  bindSlider('hue-shift', v => { S.hueShift = v; }, v => v.toString(), 0);
  bindSlider('out-saturation', v => { S.saturation = v; }, v => v + '%', 100);
  bindSlider('out-contrast', v => { S.outContrast = v; }, v => v.toString(), 0);
  bindSlider('tone-strength', v => { S.toneStrength = v; }, v => v + '%', 0);

  // Transport sliders
  bindSlider('transport-spring', v => { S.transportSpring = v / 100; }, v => (v / 100).toFixed(2), 50);
  bindSlider('transport-damping', v => { S.transportDamping = v / 100; }, v => (v / 100).toFixed(2), 80);
  bindSlider('transport-repulsion', v => { S.transportRepulsion = v / 100; }, v => (v / 100).toFixed(2), 100);
  bindSlider('transport-mass', v => { S.transportMass = v / 100; }, v => (v / 100).toFixed(2), 100);
  bindSlider('transport-maxvel', v => { S.transportMaxVel = v; }, v => v.toString(), 5);
  bindSlider('transport-trail-len', v => { S.transportTrailLen = v; }, v => v.toString(), 5);
  bindSlider('video-duration', v => {}, v => v + 's', 3);

  // Toggles
  bindToggle('serpentine-toggle', v => { S.serpentine = v; });
  bindToggle('tone-input-toggle', v => { S.toneByInput = v; });
  bindToggle('transport-enable', v => {
    S.transportEnabled = v;
    if (!v) transportParticles = null;
    S.needsRedraw = true;
  });
  bindToggle('transport-trails', v => {
    S.transportTrails = v;
    if (transportParticles) {
      transportParticles.trailHistory = v ? [] : null;
    }
  });
  bindToggle('transport-masslock', v => { S.transportMassLock = v; });
  bindToggle('export-transparent', v => { S.exportTransparent = v; });

  // Selects
  $('transport-mode').addEventListener('change', e => {
    saveUndoState();
    S.transportMode = e.target.value;
  });
  $('transport-assignment').addEventListener('change', e => {
    S.transportAssignment = e.target.value;
    if (transportParticles) assignTargets();
  });
  $('transport-init').addEventListener('change', e => {
    S.transportInit = e.target.value;
  });
  $('downscale-method').addEventListener('change', e => {
    saveUndoState();
    S.downscaleMethod = e.target.value;
    S.needsRedraw = true;
  });
  $('export-scale').addEventListener('change', e => {
    S.exportScale = e.target.value === 'source' ? 'source' : parseInt(e.target.value);
  });
  $('export-format').addEventListener('change', e => {
    S.exportFormat = e.target.value;
  });

  // Color pickers
  $('tone-color').addEventListener('input', e => {
    const hex = e.target.value;
    S.toneColor = [parseInt(hex.substr(1,2),16), parseInt(hex.substr(3,2),16), parseInt(hex.substr(5,2),16)];
    S.needsRedraw = true;
  });
  $('bg-color').addEventListener('input', e => {
    const hex = e.target.value;
    S.bgColor = [parseInt(hex.substr(1,2),16), parseInt(hex.substr(3,2),16), parseInt(hex.substr(5,2),16)];
    S.needsRedraw = true;
  });

  // Resolution presets
  document.querySelectorAll('.preset-btn[data-w]').forEach(btn => {
    btn.addEventListener('click', () => {
      saveUndoState();
      S.customWidth = parseInt(btn.dataset.w);
      S.customHeight = parseInt(btn.dataset.h);
      S.pixelScale = 1; // presets set exact resolution
      transportParticles = null;
      S.needsRedraw = true;
      syncUIFromState();
    });
  });

  // Toolbar buttons
  $('btn-camera').addEventListener('click', () => {
    if (S.cameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  $('btn-upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    if (e.target.files.length > 0) loadImageFromFile(e.target.files[0]);
    e.target.value = '';
  });

  $('btn-paste').addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          loadImageFromFile(blob);
          return;
        }
      }
    } catch (e) {
      console.warn('Paste failed:', e);
    }
  });

  $('btn-fullscreen').addEventListener('click', toggleFullscreen);

  $('btn-export').addEventListener('click', () => {
    // Switch to export tab and trigger download
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab[data-tab="export"]').classList.add('active');
    $('panel-export').classList.add('active');
  });

  // Export buttons
  $('btn-download').addEventListener('click', () => {
    if (!S.lastProcessedOutput) return;
    const scale = S.exportScale === 'source' ? S.pixelScale : S.exportScale;
    Exporter.downloadImage(
      S.lastProcessedOutput, S.lastResultW, S.lastResultH,
      scale, S.exportFormat, S.exportTransparent,
      S.bgColor || [255,255,255]
    );
  });

  $('btn-copy-clipboard').addEventListener('click', async () => {
    if (!S.lastProcessedOutput) return;
    const scale = S.exportScale === 'source' ? S.pixelScale : S.exportScale;
    const ok = await Exporter.copyToClipboard(S.lastProcessedOutput, S.lastResultW, S.lastResultH, scale);
    if (ok) {
      $('btn-copy-clipboard').textContent = 'Copied!';
      setTimeout(() => { $('btn-copy-clipboard').textContent = 'Copy to Clipboard'; }, 1500);
    }
  });

  // Snap button — tap to snap, long-press (500ms) to record
  {
    let pressTimer = null;
    let pressed = false;

    $('snap-btn').addEventListener('pointerdown', e => {
      pressed = true;
      pressTimer = setTimeout(() => {
        if (!pressed) return;
        // Long press — start recording
        const duration = parseInt($('video-duration').value) || 3;
        startVideoRecording(null, null, duration);
      }, 500);
      e.preventDefault();
    });

    const endPress = () => {
      if (!pressed) return;
      pressed = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (S.recording) {
        stopVideoRecording();
      } else {
        snapPhoto();
      }
    };

    $('snap-btn').addEventListener('pointerup', endPress);
    $('snap-btn').addEventListener('pointercancel', endPress);
    $('snap-btn').addEventListener('pointerleave', endPress);
  }

  // Camera device selector
  $('camera-select').addEventListener('change', e => {
    const deviceId = e.target.value;
    S.cameraDeviceId = deviceId;
    startCamera(deviceId);
  });

  // Photo stack
  $('photo-stack').addEventListener('click', openGallery);
  $('gallery-close').addEventListener('click', closeGallery);
  $('gallery-export-all').addEventListener('click', () => {
    S.captures.forEach((cap, i) => {
      Exporter.downloadImage(cap.pixels, cap.w, cap.h, 4, 'png', false, [255,255,255],
        `dither-${i+1}.png`);
    });
  });

  // Record Video button in export panel
  $('btn-record-video').addEventListener('click', () => {
    if (S.recording) {
      stopVideoRecording();
    } else {
      const duration = parseInt($('video-duration').value) || 3;
      startVideoRecording(null, null, duration);
      $('btn-record-video').textContent = 'Stop Recording';
      const restore = () => { $('btn-record-video').textContent = 'Record Video'; };
      // Restore button text when recording ends
      const check = setInterval(() => {
        if (!S.recording) { clearInterval(check); restore(); }
      }, 200);
    }
  });

  // Platform export presets
  $('export-twitter').addEventListener('click', () => {
    if (!S.lastProcessedOutput) return;
    if (S.sourceType === 'camera' || S.recording) {
      // Video: record 1080x1080 MP4
      startVideoRecording(1080, 1080, parseInt($('video-duration').value) || 3);
    } else {
      // Still: export PNG at scale to produce ~1080 width
      const w = S.lastResultW || 40;
      const scale = Math.max(1, Math.round(1080 / w));
      Exporter.downloadImage(S.lastProcessedOutput, S.lastResultW, S.lastResultH,
        scale, 'png', false, S.bgColor || [255,255,255], `dither-twitter-${Date.now()}.png`);
    }
  });

  $('export-instagram').addEventListener('click', () => {
    if (!S.lastProcessedOutput) return;
    if (S.sourceType === 'camera' || S.recording) {
      startVideoRecording(1080, 1350, parseInt($('video-duration').value) || 3);
    } else {
      const w = S.lastResultW || 40;
      const scale = Math.max(1, Math.round(1080 / w));
      Exporter.downloadImage(S.lastProcessedOutput, S.lastResultW, S.lastResultH,
        scale, 'png', false, S.bgColor || [255,255,255], `dither-instagram-${Date.now()}.png`);
    }
  });

  $('export-discord').addEventListener('click', () => {
    if (!S.lastProcessedOutput) return;
    // Discord: export at 4x scale, PNG (usually well under 8MB for dithered images)
    Exporter.downloadImage(S.lastProcessedOutput, S.lastResultW, S.lastResultH,
      4, 'png', false, S.bgColor || [255,255,255], `dither-discord-${Date.now()}.png`);
  });

  // Presets
  populatePresetList();

  $('btn-save-preset').addEventListener('click', () => {
    const name = prompt('Preset name:');
    if (name && name.trim()) {
      saveUserPreset(name.trim());
    }
  });

  $('btn-export-presets').addEventListener('click', () => {
    const presets = getUserPresets();
    const json = JSON.stringify(presets, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dither-presets.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('btn-import-presets').addEventListener('click', () => {
    $('preset-file-input').click();
  });

  $('preset-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        const existing = getUserPresets();
        Object.assign(existing, imported);
        localStorage.setItem('dither-presets', JSON.stringify(existing));
        populatePresetList();
      } catch (err) {
        console.warn('Invalid preset file:', err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Drag and drop
  document.addEventListener('dragover', e => {
    e.preventDefault();
    $('drop-overlay').classList.add('visible');
  });
  document.addEventListener('dragleave', e => {
    if (e.relatedTarget === null || !document.contains(e.relatedTarget)) {
      $('drop-overlay').classList.remove('visible');
    }
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    $('drop-overlay').classList.remove('visible');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadImageFromFile(file);
    }
  });

  // Paste from clipboard
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        loadImageFromFile(item.getAsFile());
        return;
      }
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Don't capture when input is focused
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;

    if (key === '?' || (key === '/' && e.shiftKey)) {
      $('shortcuts-overlay').classList.toggle('visible');
      e.preventDefault();
      return;
    }

    // Close overlays on Escape
    if (key === 'Escape') {
      $('shortcuts-overlay').classList.remove('visible');
      $('gallery-overlay').classList.remove('visible');
      return;
    }

    if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (ctrl && key === 'Z') { e.preventDefault(); redo(); return; }
    if (ctrl && key === 's') {
      e.preventDefault();
      if (S.lastProcessedOutput) {
        const scale = S.exportScale === 'source' ? S.pixelScale : S.exportScale;
        Exporter.downloadImage(S.lastProcessedOutput, S.lastResultW, S.lastResultH, scale, S.exportFormat, false, [255,255,255]);
      }
      return;
    }
    if (ctrl && key === 'c') {
      e.preventDefault();
      if (S.lastProcessedOutput) {
        const scale = S.exportScale === 'source' ? S.pixelScale : S.exportScale;
        Exporter.copyToClipboard(S.lastProcessedOutput, S.lastResultW, S.lastResultH, scale);
      }
      return;
    }

    if (key === ' ') { e.preventDefault(); snapPhoto(); return; }
    if (key === 'f' || key === 'F') { toggleFullscreen(); return; }
    if (key === 'b' || key === 'B') {
      saveUndoState();
      setPalette('Black & White');
      $('palette-select').value = 'Black & White';
      return;
    }
    if (key === 't' || key === 'T') {
      S.transportEnabled = !S.transportEnabled;
      if (!S.transportEnabled) transportParticles = null;
      $('transport-enable').classList.toggle('on', S.transportEnabled);
      S.needsRedraw = true;
      return;
    }
    if (key === '[') {
      saveUndoState();
      S.pixelScale = Math.max(1, S.pixelScale - 1);
      $('pixel-scale').value = S.pixelScale;
      updateSliderValue('pixel-scale', S.pixelScale + 'x');
      transportParticles = null;
      S.needsRedraw = true;
      return;
    }
    if (key === ']') {
      saveUndoState();
      S.pixelScale = Math.min(64, S.pixelScale + 1);
      $('pixel-scale').value = S.pixelScale;
      updateSliderValue('pixel-scale', S.pixelScale + 'x');
      transportParticles = null;
      S.needsRedraw = true;
      return;
    }

    // Number keys 1-8 for algorithms
    const algoMap = ['floyd-steinberg', 'atkinson', 'burkes', 'jarvis', 'stucki', 'sierra', 'bayer4', 'bayer8'];
    const num = parseInt(key);
    if (num >= 1 && num <= 8) {
      saveUndoState();
      S.algorithm = algoMap[num - 1];
      document.querySelectorAll('.algo-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.algo === S.algorithm);
      });
      S.needsRedraw = true;
      transportParticles = null;
    }
  });

  // Drawer drag handle
  initDrawerDrag();

  // Window resize
  window.addEventListener('resize', () => {
    fitCanvasToViewport();
  });
}

// ─── Slider Helper ───
function bindSlider(id, setter, formatter, defaultVal) {
  const slider = $(id);
  if (!slider) return;
  const valEl = document.querySelector(`[data-for="${id}"]`);
  let undoSaved = false;

  const update = () => {
    const v = parseInt(slider.value);
    setter(v);
    if (valEl) valEl.textContent = formatter(v);
    S.needsRedraw = true;
    encodeStateToURL();
  };

  // Save undo once at start of drag, not on every input tick
  slider.addEventListener('pointerdown', () => { undoSaved = false; });
  slider.addEventListener('input', () => {
    if (!undoSaved) { saveUndoState(); undoSaved = true; }
    update();
  });

  // Reset button
  const resetBtn = document.querySelector(`[data-reset="${id}"]`);
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      saveUndoState();
      slider.value = defaultVal;
      update();
    });
  }

  // Initialize display
  if (valEl) valEl.textContent = formatter(parseInt(slider.value));
}

function updateSliderValue(id, text) {
  const valEl = document.querySelector(`[data-for="${id}"]`);
  if (valEl) valEl.textContent = text;
}

// ─── Toggle Helper ───
function bindToggle(id, setter) {
  const btn = $(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    saveUndoState();
    btn.classList.toggle('on');
    setter(btn.classList.contains('on'));
    S.needsRedraw = true;
    encodeStateToURL();
  });
}

// ─── Sync UI from State (after undo/redo/preset load) ───
function syncUIFromState() {
  $('brightness').value = S.brightness;
  $('contrast').value = S.contrast;
  $('gamma').value = S.gamma * 100;
  $('red-brightness').value = S.redBrightness;
  $('green-brightness').value = S.greenBrightness;
  $('blue-brightness').value = S.blueBrightness;
  $('pixel-scale').value = S.pixelScale;
  $('diffusion-strength').value = S.diffusionStrength * 100;
  $('bayer-bias').value = S.bayerBias * 100;
  $('threshold-level').value = S.thresholdLevel;
  $('halftone-size').value = S.halftoneSize;
  $('halftone-angle').value = S.halftoneAngle;
  $('hue-shift').value = S.hueShift;
  $('out-saturation').value = S.saturation;
  $('out-contrast').value = S.outContrast;
  $('tone-strength').value = S.toneStrength;

  // Update all value displays
  updateSliderValue('brightness', S.brightness.toString());
  updateSliderValue('contrast', S.contrast.toString());
  updateSliderValue('gamma', S.gamma.toFixed(2));
  updateSliderValue('red-brightness', S.redBrightness.toString());
  updateSliderValue('green-brightness', S.greenBrightness.toString());
  updateSliderValue('blue-brightness', S.blueBrightness.toString());
  updateSliderValue('pixel-scale', S.pixelScale + 'x');
  updateSliderValue('diffusion-strength', S.diffusionStrength.toFixed(2));
  updateSliderValue('bayer-bias', S.bayerBias.toFixed(2));
  updateSliderValue('threshold-level', S.thresholdLevel.toString());
  updateSliderValue('halftone-size', S.halftoneSize.toString());
  updateSliderValue('halftone-angle', S.halftoneAngle.toString());
  updateSliderValue('hue-shift', S.hueShift.toString());
  updateSliderValue('out-saturation', S.saturation + '%');
  updateSliderValue('out-contrast', S.outContrast.toString());
  updateSliderValue('tone-strength', S.toneStrength + '%');

  // Algorithm buttons
  document.querySelectorAll('.algo-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.algo === S.algorithm);
  });

  // Palette
  $('palette-select').value = S.paletteName;
  setPalette(S.paletteName);

  // Transport sliders
  $('transport-spring').value = S.transportSpring * 100;
  $('transport-damping').value = S.transportDamping * 100;
  $('transport-repulsion').value = S.transportRepulsion * 100;
  $('transport-mass').value = S.transportMass * 100;
  $('transport-maxvel').value = S.transportMaxVel;
  $('transport-trail-len').value = S.transportTrailLen;
  updateSliderValue('transport-spring', S.transportSpring.toFixed(2));
  updateSliderValue('transport-damping', S.transportDamping.toFixed(2));
  updateSliderValue('transport-repulsion', S.transportRepulsion.toFixed(2));
  updateSliderValue('transport-mass', S.transportMass.toFixed(2));
  updateSliderValue('transport-maxvel', S.transportMaxVel.toString());
  updateSliderValue('transport-trail-len', S.transportTrailLen.toString());

  // Transport toggles
  $('transport-enable').classList.toggle('on', S.transportEnabled);
  $('transport-trails').classList.toggle('on', S.transportTrails);
  $('transport-masslock').classList.toggle('on', S.transportMassLock);
  $('transport-mode').value = S.transportMode;
  $('transport-assignment').value = S.transportAssignment;
  $('transport-init').value = S.transportInit;

  // Toggles
  $('serpentine-toggle').classList.toggle('on', S.serpentine);
  $('tone-input-toggle').classList.toggle('on', S.toneByInput);

  // Selects
  $('downscale-method').value = S.downscaleMethod;

  // Tone color
  if (S.toneColor) {
    $('tone-color').value = '#' + S.toneColor.map(c => c.toString(16).padStart(2,'0')).join('');
  }
  if (S.bgColor) {
    $('bg-color').value = '#' + S.bgColor.map(c => c.toString(16).padStart(2,'0')).join('');
  }

  // Update URL
  encodeStateToURL();

  S.needsRedraw = true;
}

// ─── Drawer Drag ───
function initDrawerDrag() {
  const handle = $('drag-handle');
  const drawer = $('drawer');
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  // Check if in desktop side-panel mode
  const isDesktop = () => window.innerWidth >= 900 && window.innerHeight >= 500;

  const setDrawerHeight = h => {
    if (isDesktop()) return; // Desktop uses fixed width
    const maxH = window.innerHeight * 0.8;
    const minH = 80;
    drawer.style.height = Math.max(minH, Math.min(maxH, h)) + 'px';
    fitCanvasToViewport();
  };

  handle.addEventListener('pointerdown', e => {
    if (isDesktop()) return;
    dragging = true;
    startY = e.clientY;
    startHeight = drawer.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    setDrawerHeight(startHeight + dy);
  });

  handle.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('pointercancel', () => { dragging = false; });

  // Set initial drawer height
  if (!isDesktop()) {
    const initialH = window.innerHeight * 0.38;
    drawer.style.height = initialH + 'px';
  }
}

// ─── Fullscreen ───
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

// ─── Load Default Test Pattern ───
function loadDefaultPattern() {
  // Generate a gradient test pattern so the app has something to show immediately
  const w = 640, h = 480;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');

  // Horizontal gradient
  const grad = cx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, '#fff');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, w, h);

  // Vertical color bars overlay
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
  const barH = h / 3;
  cx.globalAlpha = 0.3;
  colors.forEach((color, i) => {
    const x = (i / colors.length) * w;
    const bw = w / colors.length;
    cx.fillStyle = color;
    cx.fillRect(x, barH, bw, barH);
  });
  cx.globalAlpha = 1;

  // Circle gradient
  const radGrad = cx.createRadialGradient(w/2, h/2, 0, w/2, h/2, h/2);
  radGrad.addColorStop(0, 'rgba(255,255,255,0.5)');
  radGrad.addColorStop(1, 'rgba(0,0,0,0)');
  cx.fillStyle = radGrad;
  cx.fillRect(0, 0, w, h);

  const img = new Image();
  img.onload = () => loadImageSource(img);
  img.src = c.toDataURL();
}

// ─── Init ───
function init() {
  initUI();

  // Load URL state if present, otherwise load default pattern
  if (!loadStateFromURL()) {
    loadDefaultPattern();
  } else {
    loadDefaultPattern();
  }

  requestAnimationFrame(renderLoop);
}

init();
