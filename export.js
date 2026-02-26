// Dither Studio — Export System
// PNG/WebP export, clipboard copy, MP4 recording, platform presets

'use strict';

const Exporter = {
  // Export current dithered image as downloadable file
  downloadImage(pixels, w, h, scale, format, transparent, bgColor, filename) {
    let data = pixels;
    let outW = w, outH = h;

    if (transparent) {
      data = Pipeline.makeTransparent(data, w, h, bgColor);
    }

    if (scale > 1) {
      const up = Pipeline.upscale(data, w, h, scale);
      data = up.data;
      outW = up.width;
      outH = up.height;
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(data, outW, outH);
    ctx.putImageData(imgData, 0, 0);

    const mimeType = format === 'webp' ? 'image/webp' : 'image/png';
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `dither-${Date.now()}.${format || 'png'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, mimeType);
  },

  // Copy to clipboard
  async copyToClipboard(pixels, w, h, scale) {
    let data = pixels;
    let outW = w, outH = h;

    if (scale > 1) {
      const up = Pipeline.upscale(data, w, h, scale);
      data = up.data;
      outW = up.width;
      outH = up.height;
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(data, outW, outH), 0, 0);

    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      return true;
    } catch (e) {
      console.warn('Clipboard copy failed:', e);
      return false;
    }
  },

  // Start recording canvas as video.
  // Returns the MediaRecorder. Auto-downloads on stop.
  // If duration is provided, auto-stops after that many seconds.
  startRecording(canvas, format, duration, onDone) {
    const mimeType = format === 'webm' ? 'video/webm;codecs=vp9' :
                     (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4'))
                       ? 'video/mp4' : 'video/webm;codecs=vp9';

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    const chunks = [];

    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    recorder.onstop = () => {
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dither-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (onDone) onDone(blob, ext);
    };

    recorder.start();

    if (duration) {
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, duration * 1000);
    }

    return recorder;
  },

  // Web Share API
  async share(pixels, w, h, scale, title) {
    if (!navigator.share || !navigator.canShare) return false;

    let data = pixels;
    let outW = w, outH = h;
    if (scale > 1) {
      const up = Pipeline.upscale(data, w, h, scale);
      data = up.data;
      outW = up.width;
      outH = up.height;
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(data, outW, outH), 0, 0);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const file = new File([blob], 'dither.png', { type: 'image/png' });

    try {
      await navigator.share({ title: title || 'Dither Studio', files: [file] });
      return true;
    } catch (e) {
      return false;
    }
  }
};
