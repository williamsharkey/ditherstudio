# Dither Studio

**Realtime dithering in your browser.** Point your camera at the world, upload an image, or paste from clipboard — watch it transform through classic algorithms, retro palettes, and experimental particle physics.

**[Launch Dither Studio](https://williamsharkey.github.io/ditherstudio/)** | **[Read the Manual](https://williamsharkey.github.io/ditherstudio/docs/manual.html)**

---

## What It Does

Dither Studio takes any image or live camera feed and processes it through a real-time dithering pipeline:

**Input** &rarr; Brightness/Contrast/Gamma &rarr; Downscale &rarr; Dither Algorithm + Palette &rarr; Post-Processing &rarr; Pixelated Output

Everything updates instantly as you drag sliders. No loading spinners. No server.

## Features

### 16 Dithering Algorithms

| Error Diffusion | Ordered | Other |
|---|---|---|
| Floyd-Steinberg | Bayer 2x2 | Threshold |
| Atkinson | Bayer 4x4 | Random Noise |
| Burkes | Bayer 8x8 | Blue Noise |
| Jarvis-Judice-Ninke | Bayer 16x16 | Halftone |
| Stucki | | |
| Sierra (3 variants) | | |

Each algorithm has tunable parameters — diffusion strength, serpentine scanning, Bayer bias, dot size & angle for halftone.

### 20+ Retro Palettes

Game Boy (DMG) &middot; Game Boy Pocket &middot; NES &middot; SEGA Master System &middot; CGA (4 modes) &middot; EGA &middot; Commodore 64 &middot; Apple II &middot; ZX Spectrum &middot; Teletext &middot; PICO-8 &middot; Sweetie 16 &middot; Endesga 32 &middot; Grayscale 4/8/16 &middot; Custom (build your own)

### Live Camera Dithering

- 30fps realtime processing through the full pipeline
- Front/rear camera toggle with device selector
- Tap to snap a photo, **long-press to record video loops**
- Photo gallery with delete, re-edit, batch export

### Mass-Preserving Particle Transport

An experimental mode where dithered pixels become **physical particles** that flow to their target positions. Four physics modes:

- **Overdamped** — smooth, fluid motion like iron filings
- **Underdamped** — bouncy, springy oscillation
- **Ballistic** — explosive scatter then settle
- **Diffusion** — organic Brownian motion

With configurable spring constant, damping, repulsion, mass, velocity, trail rendering, and multiple assignment methods (greedy nearest, KD-tree, random).

### Full Processing Pipeline

**Pre-processing:** Brightness, contrast, gamma, per-channel (R/G/B) brightness

**Post-processing:** Hue shift, saturation, output contrast, color toning (by input image or single color), background color override

### Export Everywhere

| Format | Use Case |
|---|---|
| PNG 1x/2x/4x/8x | Pixel-perfect nearest-neighbor upscale |
| WebP | Smaller file size |
| MP4 / WebM | Video loops from camera or transport animations |
| Clipboard | Ctrl+C to copy output directly |

**Platform presets:** Twitter 1080x1080, Instagram 1080x1350, Discord <8MB — one click.

### Presets & Sharing

- **7 built-in presets:** Classic Mac, Game Boy Photo, 1-Bit Noir, Newspaper, Matrix, Thermal Camera, CRT Retro
- Save/load your own presets (stored in localStorage)
- Import/export presets as JSON
- **URL state:** every setting encoded in the URL hash — share a link, get the exact same look

### Resolution Presets

Quick buttons for classic resolutions: Game Boy 160x144 &middot; NES 256x240 &middot; SMS 256x192 &middot; C64/CGA 320x200 &middot; Apple II 280x192 &middot; PICO-8 128x128 &middot; Mac 128K 512x342

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Snap photo (hold to record) |
| `1`-`8` | Switch algorithm |
| `[` / `]` | Decrease / increase pixel scale |
| `B` | Black & White palette |
| `T` | Toggle transport system |
| `F` | Fullscreen |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+S` | Export image |
| `Ctrl+V` | Paste image |
| `Ctrl+C` | Copy output to clipboard |
| `?` | Show shortcuts overlay |

## Tech

- **Zero dependencies.** Vanilla HTML + CSS + JS. No framework, no build step.
- **Web Worker** dithering keeps the UI thread free for 60fps interaction.
- **Transferable ArrayBuffers** for zero-copy frame passing to workers.
- **32x32x32 RGB LUT** precomputed per palette for O(1) nearest-color lookup.
- **PWA** — works offline after first load via service worker.
- Runs entirely client-side. No server, no tracking, no data leaves your device.

## Quick Start

```
git clone https://github.com/williamsharkey/ditherstudio.git
cd ditherstudio
# Open in any browser — no build needed
open index.html
```

Or just visit **[williamsharkey.github.io/ditherstudio](https://williamsharkey.github.io/ditherstudio/)**

## File Structure

```
index.html           App shell, all CSS embedded
app.js               Main thread — UI, camera, render loop, state, presets, URL encoding
dither-worker.js     Web Worker — all 16 dithering algorithms
transport-worker.js  Web Worker — particle physics (KD-tree, spatial hash)
palettes.js          20+ palette definitions with exact RGB values
pipeline.js          Post-processing — hue shift, saturation, contrast, toning
export.js            PNG/WebP/video export, clipboard, platform presets
manifest.json        PWA manifest
sw.js                Service worker for offline caching
docs/manual.html     Interactive manual
```

## Browser Support

Chrome, Edge, Firefox, Safari (desktop & mobile). Camera features require HTTPS or localhost.

## License

MIT
