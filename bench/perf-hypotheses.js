// Dither Studio — Performance Hypothesis Testing
// A/B benchmarks: current implementation vs optimized alternatives
// Each section measures a specific hypothesis, prints speedup factor

'use strict';

const output = document.getElementById('output');
const lines = [];

function log(text) {
  lines.push(text);
  output.textContent = lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════

function makeRandomPositions(count, w, h) {
  const pos = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos[i * 2] = Math.random() * w;
    pos[i * 2 + 1] = Math.random() * h;
  }
  return pos;
}

function makeClusteredPositions(count, w, h) {
  // Clustered positions (more realistic — particles near their targets)
  const pos = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const cx = Math.random() * w;
    const cy = Math.random() * h;
    pos[i * 2] = Math.max(0, Math.min(w - 1, cx + (Math.random() - 0.5) * 10));
    pos[i * 2 + 1] = Math.max(0, Math.min(h - 1, cy + (Math.random() - 0.5) * 10));
  }
  return pos;
}

function makePalette(nColors) {
  const pal = new Uint8Array(nColors * 3);
  for (let i = 0; i < nColors; i++) {
    pal[i * 3] = (i * 255 / (nColors - 1)) | 0;
    pal[i * 3 + 1] = (i * 255 / (nColors - 1)) | 0;
    pal[i * 3 + 2] = (i * 255 / (nColors - 1)) | 0;
  }
  return pal;
}

function makeGradientImage(w, h) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      pixels[i] = (x * 255 / w) | 0;
      pixels[i + 1] = (y * 255 / h) | 0;
      pixels[i + 2] = ((x + y) * 128 / (w + h)) | 0;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function bench(name, fn, iterations = 100) {
  for (let i = 0; i < 5; i++) fn(); // warmup
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const min = times[0];
  return { name, median, p95, min, iterations };
}

function pad(s, n) { return (s + '').padEnd(n); }
function padL(s, n) { return (s + '').padStart(n); }

function printComparison(baseline, optimized) {
  const speedup = baseline.median / optimized.median;
  const marker = speedup > 1.1 ? ' ✓ FASTER' : speedup < 0.95 ? ' ✗ SLOWER' : ' ─ SAME';
  log(
    '  ' + pad(baseline.name, 28) +
    padL(baseline.median.toFixed(3) + 'ms', 12) +
    padL(optimized.median.toFixed(3) + 'ms', 12) +
    padL(speedup.toFixed(2) + 'x', 8) +
    marker
  );
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 1: KD-Tree build — sort+slice vs quickselect+indices
// ═══════════════════════════════════════════════════════════════

// Current: sort + slice at each level
class KDNode {
  constructor(point, id, left, right, axis) {
    this.point = point; this.id = id;
    this.left = left; this.right = right; this.axis = axis;
  }
}

function buildKDTree_current(points, ids, depth) {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const id = ids[0];
    return new KDNode([points[id * 2], points[id * 2 + 1]], id, null, null, depth % 2);
  }
  const axis = depth % 2;
  ids.sort((a, b) => points[a * 2 + axis] - points[b * 2 + axis]);
  const mid = ids.length >> 1;
  return new KDNode(
    [points[ids[mid] * 2], points[ids[mid] * 2 + 1]], ids[mid],
    buildKDTree_current(points, ids.slice(0, mid), depth + 1),
    buildKDTree_current(points, ids.slice(mid + 1), depth + 1),
    axis
  );
}

// Optimized: quickselect (nth_element) with index-range recursion, no allocation
function quickselect(ids, points, axis, lo, hi, k) {
  while (lo < hi) {
    // Median-of-three pivot
    const mid = (lo + hi) >> 1;
    let a = lo, b = mid, c = hi;
    const va = points[ids[a] * 2 + axis];
    const vb = points[ids[b] * 2 + axis];
    const vc = points[ids[c] * 2 + axis];
    let pivot;
    if (va <= vb) {
      pivot = vb <= vc ? b : (va <= vc ? c : a);
    } else {
      pivot = va <= vc ? a : (vb <= vc ? c : b);
    }

    // Move pivot to end
    let tmp = ids[pivot]; ids[pivot] = ids[hi]; ids[hi] = tmp;
    const pivotVal = points[tmp * 2 + axis];

    let store = lo;
    for (let i = lo; i < hi; i++) {
      if (points[ids[i] * 2 + axis] < pivotVal) {
        tmp = ids[store]; ids[store] = ids[i]; ids[i] = tmp;
        store++;
      }
    }
    tmp = ids[store]; ids[store] = ids[hi]; ids[hi] = tmp;

    if (store === k) return;
    if (store < k) lo = store + 1;
    else hi = store - 1;
  }
}

function buildKDTree_optimized(points, ids, lo, hi, depth) {
  if (lo > hi) return null;
  if (lo === hi) {
    const id = ids[lo];
    return new KDNode([points[id * 2], points[id * 2 + 1]], id, null, null, depth % 2);
  }
  const axis = depth % 2;
  const mid = (lo + hi) >> 1;
  quickselect(ids, points, axis, lo, hi, mid);
  const id = ids[mid];
  return new KDNode(
    [points[id * 2], points[id * 2 + 1]], id,
    buildKDTree_optimized(points, ids, lo, mid - 1, depth + 1),
    buildKDTree_optimized(points, ids, mid + 1, hi, depth + 1),
    axis
  );
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 2: SpatialHash.query — array alloc vs reusable buffer
// ═══════════════════════════════════════════════════════════════

// Current: allocates new array per query
class SpatialHash_current {
  constructor(cellSize, width, height) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cells = new Array(this.cols * this.rows);
    this.clear();
  }
  clear() {
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }
  insert(id, x, y) {
    const col = Math.max(0, Math.min(this.cols - 1, (x / this.cellSize) | 0));
    const row = Math.max(0, Math.min(this.rows - 1, (y / this.cellSize) | 0));
    this.cells[row * this.cols + col].push(id);
  }
  query(x, y, radius) {
    const results = [];
    const minCol = Math.max(0, ((x - radius) / this.cellSize) | 0);
    const maxCol = Math.min(this.cols - 1, ((x + radius) / this.cellSize) | 0);
    const minRow = Math.max(0, ((y - radius) / this.cellSize) | 0);
    const maxRow = Math.min(this.rows - 1, ((y + radius) / this.cellSize) | 0);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = this.cells[row * this.cols + col];
        for (let i = 0; i < cell.length; i++) results.push(cell[i]);
      }
    }
    return results;
  }
}

// Optimized: flat Int32Array cells with count-based indexing, reusable query buffer
class SpatialHash_flat {
  constructor(cellSize, width, height, maxParticles) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    const totalCells = this.cols * this.rows;
    this.counts = new Int32Array(totalCells);
    // Each cell can hold up to maxPerCell particles; use flat array
    this.maxPerCell = 32;
    this.data = new Int32Array(totalCells * this.maxPerCell);
    // Reusable query result buffer
    this._queryBuf = new Int32Array(256);
    this._queryCount = 0;
  }
  clear() {
    this.counts.fill(0);
  }
  insert(id, x, y) {
    const col = Math.max(0, Math.min(this.cols - 1, (x / this.cellSize) | 0));
    const row = Math.max(0, Math.min(this.rows - 1, (y / this.cellSize) | 0));
    const ci = row * this.cols + col;
    const c = this.counts[ci];
    if (c < this.maxPerCell) {
      this.data[ci * this.maxPerCell + c] = id;
      this.counts[ci] = c + 1;
    }
  }
  query(x, y, radius) {
    let qc = 0;
    let buf = this._queryBuf;
    const minCol = Math.max(0, ((x - radius) / this.cellSize) | 0);
    const maxCol = Math.min(this.cols - 1, ((x + radius) / this.cellSize) | 0);
    const minRow = Math.max(0, ((y - radius) / this.cellSize) | 0);
    const maxRow = Math.min(this.rows - 1, ((y + radius) / this.cellSize) | 0);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const ci = row * this.cols + col;
        const cnt = this.counts[ci];
        const base = ci * this.maxPerCell;
        if (qc + cnt > buf.length) {
          const newBuf = new Int32Array(buf.length * 2);
          newBuf.set(buf);
          buf = newBuf;
          this._queryBuf = buf;
        }
        for (let i = 0; i < cnt; i++) {
          buf[qc++] = this.data[base + i];
        }
      }
    }
    this._queryCount = qc;
    return qc; // return count, caller reads from _queryBuf
  }
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 3: Greedy assignment — brute force vs spatial-hash-accelerated
// ═══════════════════════════════════════════════════════════════

function assignGreedy_current(positions, targets, count, targetCount) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const used = new Uint8Array(targetCount);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    let bestDist = Infinity, bestJ = 0;
    for (let j = 0; j < targetCount; j++) {
      if (used[j] && i < targetCount) continue;
      const dx = px - targets[j * 2], dy = py - targets[j * 2 + 1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; bestJ = j; }
    }
    if (i < targetCount) used[bestJ] = 1;
    assigned[i * 2] = targets[bestJ * 2];
    assigned[i * 2 + 1] = targets[bestJ * 2 + 1];
    mapping[i] = bestJ;
  }
  return { assigned, mapping };
}

// Optimized greedy: use spatial hash on targets for O(n*k) instead of O(n*m)
function assignGreedy_spatial(positions, targets, count, targetCount, w, h) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const used = new Uint8Array(targetCount);

  // Build spatial hash of targets
  const cellSize = Math.max(4, Math.sqrt((w * h) / targetCount) * 2);
  const cols = Math.ceil(w / cellSize);
  const rows = Math.ceil(h / cellSize);
  const totalCells = cols * rows;
  const cellCounts = new Int32Array(totalCells);
  const maxPerCell = 64;
  const cellData = new Int32Array(totalCells * maxPerCell);

  for (let j = 0; j < targetCount; j++) {
    const col = Math.max(0, Math.min(cols - 1, (targets[j * 2] / cellSize) | 0));
    const row = Math.max(0, Math.min(rows - 1, (targets[j * 2 + 1] / cellSize) | 0));
    const ci = row * cols + col;
    const c = cellCounts[ci];
    if (c < maxPerCell) {
      cellData[ci * maxPerCell + c] = j;
      cellCounts[ci] = c + 1;
    }
  }

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    let bestDist = Infinity, bestJ = 0;

    // Search expanding rings of cells
    const pcol = Math.max(0, Math.min(cols - 1, (px / cellSize) | 0));
    const prow = Math.max(0, Math.min(rows - 1, (py / cellSize) | 0));

    for (let radius = 0; radius <= Math.max(cols, rows); radius++) {
      const rMin = Math.max(0, prow - radius);
      const rMax = Math.min(rows - 1, prow + radius);
      const cMin = Math.max(0, pcol - radius);
      const cMax = Math.min(cols - 1, pcol + radius);

      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          // Only process ring cells (border of the square)
          if (radius > 0 && r > rMin && r < rMax && c > cMin && c < cMax) continue;
          const ci = r * cols + c;
          const cnt = cellCounts[ci];
          const base = ci * maxPerCell;
          for (let k = 0; k < cnt; k++) {
            const j = cellData[base + k];
            if (used[j] && i < targetCount) continue;
            const dx = px - targets[j * 2], dy = py - targets[j * 2 + 1];
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; bestJ = j; }
          }
        }
      }

      // If we found something and the next ring can't be closer, break
      if (bestDist < Infinity) {
        const minRingDist = (radius * cellSize - cellSize) ** 2;
        if (minRingDist > bestDist) break;
      }
    }

    if (i < targetCount) used[bestJ] = 1;
    assigned[i * 2] = targets[bestJ * 2];
    assigned[i * 2 + 1] = targets[bestJ * 2 + 1];
    mapping[i] = bestJ;
  }
  return { assigned, mapping };
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 4: Physics repulsion — sqrt vs fast inverse sqrt
// ═══════════════════════════════════════════════════════════════

function physicsStep_current(positions, velocities, assigned, count, repRadius, repulsion, w, h) {
  const hash = new SpatialHash_current(repRadius * 2, w, h);
  for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    const tx = assigned[i * 2], ty = assigned[i * 2 + 1];
    let vx = (tx - px) * 0.32;
    let vy = (ty - py) * 0.32;

    const neighbors = hash.query(px, py, repRadius);
    for (const ni of neighbors) {
      if (ni === i) continue;
      const ndx = px - positions[ni * 2];
      const ndy = py - positions[ni * 2 + 1];
      const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
      if (ndist > 0 && ndist < repRadius) {
        const force = repulsion / (ndist * ndist + 0.01);
        vx += (ndx / ndist) * force;
        vy += (ndy / ndist) * force;
      }
    }

    vx = Math.max(-5, Math.min(5, vx));
    vy = Math.max(-5, Math.min(5, vy));
    positions[i * 2] = Math.max(0, Math.min(w - 1, px + vx));
    positions[i * 2 + 1] = Math.max(0, Math.min(h - 1, py + vy));
  }
}

// Optimized: eliminate sqrt, use dist² directly, skip normalize
function physicsStep_nosqrt(positions, velocities, assigned, count, repRadius, repulsion, w, h) {
  const hash = new SpatialHash_current(repRadius * 2, w, h);
  for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);

  const repRadius2 = repRadius * repRadius;

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    const tx = assigned[i * 2], ty = assigned[i * 2 + 1];
    let vx = (tx - px) * 0.32;
    let vy = (ty - py) * 0.32;

    const neighbors = hash.query(px, py, repRadius);
    for (const ni of neighbors) {
      if (ni === i) continue;
      const ndx = px - positions[ni * 2];
      const ndy = py - positions[ni * 2 + 1];
      const dist2 = ndx * ndx + ndy * ndy;
      if (dist2 > 0 && dist2 < repRadius2) {
        // force ∝ 1/dist², direction ∝ (ndx,ndy)/dist → combined: (ndx,ndy)/dist³ = (ndx,ndy)/(dist²*dist)
        // But we can approximate: just push proportional to 1/dist² in the (ndx,ndy) direction
        // This changes the force profile but is visually similar
        const invDist2 = 1.0 / (dist2 + 0.01);
        const force = repulsion * invDist2;
        vx += ndx * force;
        vy += ndy * force;
      }
    }

    vx = Math.max(-5, Math.min(5, vx));
    vy = Math.max(-5, Math.min(5, vy));
    positions[i * 2] = Math.max(0, Math.min(w - 1, px + vx));
    positions[i * 2 + 1] = Math.max(0, Math.min(h - 1, py + vy));
  }
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 5: resolveOverlaps — current spiral vs grid-walk
// ═══════════════════════════════════════════════════════════════

const SPIRAL_OFFSETS = (() => {
  const offsets = [];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r || Math.abs(dy) === r) offsets.push([dx, dy]);
      }
    }
  }
  offsets.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
  return offsets;
})();

// Precompute flat spiral offsets (avoid array-of-arrays)
const SPIRAL_DX = new Int8Array(SPIRAL_OFFSETS.length);
const SPIRAL_DY = new Int8Array(SPIRAL_OFFSETS.length);
for (let i = 0; i < SPIRAL_OFFSETS.length; i++) {
  SPIRAL_DX[i] = SPIRAL_OFFSETS[i][0];
  SPIRAL_DY[i] = SPIRAL_OFFSETS[i][1];
}

function resolveOverlaps_current(positions, count, w, h) {
  const grid = new Int32Array(w * h);
  grid.fill(-1);
  for (let i = 0; i < count; i++) {
    let rx = Math.round(positions[i * 2]);
    let ry = Math.round(positions[i * 2 + 1]);
    rx = Math.max(0, Math.min(w - 1, rx));
    ry = Math.max(0, Math.min(h - 1, ry));
    const ci = ry * w + rx;
    if (grid[ci] === -1) {
      grid[ci] = i;
      positions[i * 2] = rx;
      positions[i * 2 + 1] = ry;
    } else {
      for (let s = 0; s < SPIRAL_OFFSETS.length; s++) {
        const nx = rx + SPIRAL_OFFSETS[s][0];
        const ny = ry + SPIRAL_OFFSETS[s][1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (grid[ni] === -1) {
          grid[ni] = i;
          positions[i * 2] = nx;
          positions[i * 2 + 1] = ny;
          break;
        }
      }
    }
  }
}

// Optimized: flat spiral offsets (typed arrays instead of [dx,dy] pairs)
function resolveOverlaps_flat(positions, count, w, h) {
  const grid = new Int32Array(w * h);
  grid.fill(-1);
  for (let i = 0; i < count; i++) {
    let rx = (positions[i * 2] + 0.5) | 0; // faster rounding for positive numbers
    let ry = (positions[i * 2 + 1] + 0.5) | 0;
    if (rx < 0) rx = 0; else if (rx >= w) rx = w - 1;
    if (ry < 0) ry = 0; else if (ry >= h) ry = h - 1;
    const ci = ry * w + rx;
    if (grid[ci] === -1) {
      grid[ci] = i;
      positions[i * 2] = rx;
      positions[i * 2 + 1] = ry;
    } else {
      const slen = SPIRAL_DX.length;
      for (let s = 0; s < slen; s++) {
        const nx = rx + SPIRAL_DX[s];
        const ny = ry + SPIRAL_DY[s];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const ni = ny * w + nx;
          if (grid[ni] === -1) {
            grid[ni] = i;
            positions[i * 2] = nx;
            positions[i * 2 + 1] = ny;
            break;
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 6: swapOptimize — current (alloc per query) vs flat hash
// ═══════════════════════════════════════════════════════════════

function swapOptimize_current(positions, assigned, mapping, count, w, h) {
  const hash = new SpatialHash_current(6, w, h);
  for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    const neighbors = hash.query(px, py, 6);
    for (let n = 0; n < neighbors.length; n++) {
      const j = neighbors[n];
      if (j <= i) continue;
      const ax = assigned[i * 2], ay = assigned[i * 2 + 1];
      const bx = assigned[j * 2], by = assigned[j * 2 + 1];
      const jpx = positions[j * 2], jpy = positions[j * 2 + 1];
      const curCost = (px - ax) * (px - ax) + (py - ay) * (py - ay)
                    + (jpx - bx) * (jpx - bx) + (jpy - by) * (jpy - by);
      const swpCost = (px - bx) * (px - bx) + (py - by) * (py - by)
                    + (jpx - ax) * (jpx - ax) + (jpy - ay) * (jpy - ay);
      if (swpCost < curCost) {
        assigned[i * 2] = bx; assigned[i * 2 + 1] = by;
        assigned[j * 2] = ax; assigned[j * 2 + 1] = ay;
        const tmp = mapping[i]; mapping[i] = mapping[j]; mapping[j] = tmp;
      }
    }
  }
}

function swapOptimize_flat(positions, assigned, mapping, count, w, h) {
  const hash = new SpatialHash_flat(6, w, h, count);
  for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    const qc = hash.query(px, py, 6);
    const buf = hash._queryBuf;
    for (let n = 0; n < qc; n++) {
      const j = buf[n];
      if (j <= i) continue;
      const ax = assigned[i * 2], ay = assigned[i * 2 + 1];
      const bx = assigned[j * 2], by = assigned[j * 2 + 1];
      const jpx = positions[j * 2], jpy = positions[j * 2 + 1];
      const curCost = (px - ax) * (px - ax) + (py - ay) * (py - ay)
                    + (jpx - bx) * (jpx - bx) + (jpy - by) * (jpy - by);
      const swpCost = (px - bx) * (px - bx) + (py - by) * (py - by)
                    + (jpx - ax) * (jpx - ax) + (jpy - ay) * (jpy - ay);
      if (swpCost < curCost) {
        assigned[i * 2] = bx; assigned[i * 2 + 1] = by;
        assigned[j * 2] = ax; assigned[j * 2 + 1] = ay;
        const tmp = mapping[i]; mapping[i] = mapping[j]; mapping[j] = tmp;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 7: Pipeline lightest-color scan — per-frame vs cached
// ═══════════════════════════════════════════════════════════════

function pipelineBgScan_current(dithered, w, h) {
  let maxLum = -1;
  let lightestR = 255, lightestG = 255, lightestB = 255;
  const colorSet = new Map();
  for (let i = 0; i < w * h * 4; i += 4) {
    const key = (dithered[i] << 16) | (dithered[i + 1] << 8) | dithered[i + 2];
    if (!colorSet.has(key)) {
      const lum = dithered[i] * 0.299 + dithered[i + 1] * 0.587 + dithered[i + 2] * 0.114;
      colorSet.set(key, lum);
      if (lum > maxLum) {
        maxLum = lum;
        lightestR = dithered[i]; lightestG = dithered[i + 1]; lightestB = dithered[i + 2];
      }
    }
  }
  return [lightestR, lightestG, lightestB];
}

// Optimized: compute from palette directly (O(palette_size) instead of O(w*h))
function pipelineBgScan_fromPalette(palette) {
  let maxLum = -1;
  let lightestR = 255, lightestG = 255, lightestB = 255;
  for (let i = 0; i < palette.length; i += 3) {
    const lum = palette[i] * 0.299 + palette[i + 1] * 0.587 + palette[i + 2] * 0.114;
    if (lum > maxLum) {
      maxLum = lum;
      lightestR = palette[i]; lightestG = palette[i + 1]; lightestB = palette[i + 2];
    }
  }
  return [lightestR, lightestG, lightestB];
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 8: Error diffusion result buffer — alloc vs pooled
// ═══════════════════════════════════════════════════════════════

const FLOYD_STEINBERG = {
  offsets: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
};

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
        let bestDist = Infinity, bestIdx = 0;
        for (let i = 0; i < n; i++) {
          const cr = palette[i * 3], cg = palette[i * 3 + 1], cb = palette[i * 3 + 2];
          const dr = r - cr, dg = g - cg, db = b - cb;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
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

function ditherFS_alloc(pixels, w, h, lut) {
  const offsets = FLOYD_STEINBERG.offsets;
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    buf[j] = pixels[i]; buf[j + 1] = pixels[i + 1]; buf[j + 2] = pixels[i + 2];
  }
  const result = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 3;
      const r = Math.max(0, Math.min(255, buf[j]));
      const g = Math.max(0, Math.min(255, buf[j + 1]));
      const b = Math.max(0, Math.min(255, buf[j + 2]));
      const ri = (r * 31 / 255 + 0.5) | 0;
      const gi = (g * 31 / 255 + 0.5) | 0;
      const bi = (b * 31 / 255 + 0.5) | 0;
      const li = (ri * 1024 + gi * 32 + bi) * 3;
      const nr = lut[li], ng = lut[li + 1], nb = lut[li + 2];
      const pi = (y * w + x) * 4;
      result[pi] = nr; result[pi + 1] = ng; result[pi + 2] = nb; result[pi + 3] = 255;
      const er = (r - nr) * 1.0;
      const eg = (g - ng) * 1.0;
      const eb = (b - nb) * 1.0;
      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0], ny = y + offsets[k][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nj = (ny * w + nx) * 3;
          buf[nj] += er * offsets[k][2]; buf[nj + 1] += eg * offsets[k][2]; buf[nj + 2] += eb * offsets[k][2];
        }
      }
    }
  }
  return result;
}

let _pooledResult = null;
let _pooledResultSize = 0;
let _pooledErr = null;
let _pooledErrSize = 0;

function ditherFS_pooled(pixels, w, h, lut) {
  const offsets = FLOYD_STEINBERG.offsets;
  const errSize = w * h * 3;
  if (!_pooledErr || _pooledErrSize < errSize) {
    _pooledErr = new Float32Array(errSize);
    _pooledErrSize = errSize;
  } else {
    _pooledErr.fill(0);
  }
  const buf = _pooledErr;
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    buf[j] = pixels[i]; buf[j + 1] = pixels[i + 1]; buf[j + 2] = pixels[i + 2];
  }
  const resSize = w * h * 4;
  if (!_pooledResult || _pooledResultSize < resSize) {
    _pooledResult = new Uint8ClampedArray(resSize);
    _pooledResultSize = resSize;
  }
  const result = _pooledResult;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 3;
      const r = Math.max(0, Math.min(255, buf[j]));
      const g = Math.max(0, Math.min(255, buf[j + 1]));
      const b = Math.max(0, Math.min(255, buf[j + 2]));
      const ri = (r * 31 / 255 + 0.5) | 0;
      const gi = (g * 31 / 255 + 0.5) | 0;
      const bi = (b * 31 / 255 + 0.5) | 0;
      const li = (ri * 1024 + gi * 32 + bi) * 3;
      const nr = lut[li], ng = lut[li + 1], nb = lut[li + 2];
      const pi = (y * w + x) * 4;
      result[pi] = nr; result[pi + 1] = ng; result[pi + 2] = nb; result[pi + 3] = 255;
      const er = (r - nr) * 1.0;
      const eg = (g - ng) * 1.0;
      const eb = (b - nb) * 1.0;
      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0], ny = y + offsets[k][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nj = (ny * w + nx) * 3;
          buf[nj] += er * offsets[k][2]; buf[nj + 1] += eg * offsets[k][2]; buf[nj + 2] += eb * offsets[k][2];
        }
      }
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// HYPOTHESIS 9: kdNearest — object allocation {best, bestDist} vs mutable state
// ═══════════════════════════════════════════════════════════════

function kdNearest_current(node, target, best, bestDist, used) {
  if (!node) return { best, bestDist };
  const dist = (node.point[0] - target[0]) ** 2 + (node.point[1] - target[1]) ** 2;
  if (dist < bestDist && !used.has(node.id)) { bestDist = dist; best = node.id; }
  const diff = target[node.axis] - node.point[node.axis];
  const first = diff < 0 ? node.left : node.right;
  const second = diff < 0 ? node.right : node.left;
  const r1 = kdNearest_current(first, target, best, bestDist, used);
  best = r1.best; bestDist = r1.bestDist;
  if (diff * diff < bestDist) {
    const r2 = kdNearest_current(second, target, best, bestDist, used);
    best = r2.best; bestDist = r2.bestDist;
  }
  return { best, bestDist };
}

// Optimized: use mutable array to avoid object allocation per recursion
const _kdResult = [0, 0]; // [best, bestDist]
function kdNearest_mutable(node, target, best, bestDist, used) {
  if (!node) { _kdResult[0] = best; _kdResult[1] = bestDist; return; }
  const dist = (node.point[0] - target[0]) ** 2 + (node.point[1] - target[1]) ** 2;
  if (dist < bestDist && !used.has(node.id)) { bestDist = dist; best = node.id; }
  const diff = target[node.axis] - node.point[node.axis];
  const first = diff < 0 ? node.left : node.right;
  const second = diff < 0 ? node.right : node.left;
  kdNearest_mutable(first, target, best, bestDist, used);
  best = _kdResult[0]; bestDist = _kdResult[1];
  if (diff * diff < bestDist) {
    kdNearest_mutable(second, target, best, bestDist, used);
    best = _kdResult[0]; bestDist = _kdResult[1];
  }
  _kdResult[0] = best; _kdResult[1] = bestDist;
}

// ═══════════════════════════════════════════════════════════════
// RUN ALL HYPOTHESIS TESTS
// ═══════════════════════════════════════════════════════════════

async function runAll() {
  log('Dither Studio — Performance Hypothesis Testing');
  log('═'.repeat(80));
  log('  Each test compares CURRENT vs OPTIMIZED implementation');
  log('  ' + pad('Test', 28) + padL('Current', 12) + padL('Optimized', 12) + padL('Speedup', 8));
  log('─'.repeat(80));

  // yield to browser
  await new Promise(r => setTimeout(r, 10));

  // ── H1: KD-Tree Build ──
  log('');
  log('▸ H1: KD-Tree Build (sort+slice vs quickselect+indices)');
  for (const count of [1000, 3000, 5000]) {
    const targets = makeRandomPositions(count, 100, 100);
    const iters = count > 3000 ? 30 : 50;
    const baseline = bench(`KDTree build ${count}`, () => {
      const ids = Array.from({ length: count }, (_, i) => i);
      buildKDTree_current(targets, ids, 0);
    }, iters);
    const optimized = bench(`KDTree build ${count}`, () => {
      const ids = new Int32Array(count);
      for (let i = 0; i < count; i++) ids[i] = i;
      buildKDTree_optimized(targets, ids, 0, count - 1, 0);
    }, iters);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H2: Spatial Hash query allocation ──
  log('');
  log('▸ H2: Spatial Hash (Array-of-Arrays vs Flat Int32Array)');
  for (const count of [2000, 5000]) {
    const w = 100, h = 100;
    const positions = makeRandomPositions(count, w, h);

    const baseline = bench(`SpatialHash ${count}`, () => {
      const hash = new SpatialHash_current(4, w, h);
      for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);
      for (let i = 0; i < count; i++) hash.query(positions[i * 2], positions[i * 2 + 1], 4);
    }, 50);
    const optimized = bench(`SpatialHash ${count}`, () => {
      const hash = new SpatialHash_flat(4, w, h, count);
      hash.clear();
      for (let i = 0; i < count; i++) hash.insert(i, positions[i * 2], positions[i * 2 + 1]);
      for (let i = 0; i < count; i++) hash.query(positions[i * 2], positions[i * 2 + 1], 4);
    }, 50);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H3: Greedy assignment spatial acceleration ──
  log('');
  log('▸ H3: Greedy Assignment (brute O(n²) vs spatial-hash O(n·k))');
  for (const count of [1000, 3000, 5000]) {
    const w = 100, h = 100;
    const positions = makeRandomPositions(count, w, h);
    const targets = makeRandomPositions(count, w, h);
    const iters = count > 3000 ? 10 : 20;
    const baseline = bench(`Greedy ${count}`, () => {
      assignGreedy_current(positions, targets, count, count);
    }, iters);
    const optimized = bench(`Greedy ${count}`, () => {
      assignGreedy_spatial(positions, targets, count, count, w, h);
    }, iters);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H4: Physics sqrt elimination ──
  log('');
  log('▸ H4: Physics Repulsion (sqrt vs no-sqrt approximation)');
  for (const count of [2000, 5000]) {
    const w = 100, h = 100;
    const positions = makeRandomPositions(count, w, h);
    const velocities = new Float32Array(count * 2);
    const assigned = makeRandomPositions(count, w, h);

    const baseline = bench(`Physics ${count}`, () => {
      const p = new Float32Array(positions);
      physicsStep_current(p, velocities, assigned, count, 2, 1.0, w, h);
    }, 30);
    const optimized = bench(`Physics ${count}`, () => {
      const p = new Float32Array(positions);
      physicsStep_nosqrt(p, velocities, assigned, count, 2, 1.0, w, h);
    }, 30);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H5: resolveOverlaps spiral offsets ──
  log('');
  log('▸ H5: resolveOverlaps (array-of-arrays spiral vs flat Int8Array spiral)');
  for (const [count, w, h] of [[2000, 60, 60], [5000, 100, 100]]) {
    const positions = makeRandomPositions(count, w, h);

    const baseline = bench(`Overlaps ${count}`, () => {
      const p = new Float32Array(positions);
      resolveOverlaps_current(p, count, w, h);
    }, 50);
    const optimized = bench(`Overlaps ${count}`, () => {
      const p = new Float32Array(positions);
      resolveOverlaps_flat(p, count, w, h);
    }, 50);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H6: swapOptimize hash type ──
  log('');
  log('▸ H6: swapOptimize (Array hash vs Flat hash)');
  for (const count of [2000, 5000]) {
    const w = 100, h = 100;
    const positions = makeRandomPositions(count, w, h);
    const assigned = makeRandomPositions(count, w, h);
    const mapping = new Int32Array(count);
    for (let i = 0; i < count; i++) mapping[i] = i;

    const baseline = bench(`Swap ${count}`, () => {
      const a = new Float32Array(assigned);
      const m = new Int32Array(mapping);
      swapOptimize_current(positions, a, m, count, w, h);
    }, 30);
    const optimized = bench(`Swap ${count}`, () => {
      const a = new Float32Array(assigned);
      const m = new Int32Array(mapping);
      swapOptimize_flat(positions, a, m, count, w, h);
    }, 30);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H7: Pipeline lightest-color ──
  log('');
  log('▸ H7: Pipeline BG Scan (per-frame pixel scan vs palette scan)');
  for (const [w, h] of [[91, 68], [160, 144]]) {
    const dithered = new Uint8ClampedArray(w * h * 4);
    // Simulate dithered output with 4 colors
    for (let i = 0; i < w * h * 4; i += 4) {
      const v = [0, 85, 170, 255][(Math.random() * 4) | 0];
      dithered[i] = v; dithered[i + 1] = v; dithered[i + 2] = v; dithered[i + 3] = 255;
    }
    const palette = new Uint8Array([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255]);

    const baseline = bench(`BG scan ${w}×${h}`, () => {
      pipelineBgScan_current(dithered, w, h);
    }, 200);
    const optimized = bench(`BG scan ${w}×${h}`, () => {
      pipelineBgScan_fromPalette(palette);
    }, 200);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H8: Error diffusion buffer pooling ──
  log('');
  log('▸ H8: Floyd-Steinberg (alloc per frame vs pooled buffers)');
  for (const [w, h] of [[91, 68], [160, 144]]) {
    const pixels = makeGradientImage(w, h);
    const lut = buildColorLUT(makePalette(4));

    const baseline = bench(`F-S alloc ${w}×${h}`, () => {
      ditherFS_alloc(new Uint8ClampedArray(pixels), w, h, lut);
    }, 100);
    const optimized = bench(`F-S pooled ${w}×${h}`, () => {
      ditherFS_pooled(new Uint8ClampedArray(pixels), w, h, lut);
    }, 100);
    printComparison(baseline, optimized);
  }
  await new Promise(r => setTimeout(r, 10));

  // ── H9: kdNearest object alloc vs mutable ──
  log('');
  log('▸ H9: kdNearest (object alloc per recursion vs mutable array)');
  for (const count of [1000, 3000, 5000]) {
    const targets = makeRandomPositions(count, 100, 100);
    const ids = Array.from({ length: count }, (_, i) => i);
    const tree = buildKDTree_current(targets, [...ids], 0);
    const queries = makeRandomPositions(100, 100, 100);
    const iters = 50;

    const baseline = bench(`kdNearest ${count}t`, () => {
      for (let q = 0; q < 100; q++) {
        kdNearest_current(tree, [queries[q * 2], queries[q * 2 + 1]], -1, Infinity, new Set());
      }
    }, iters);
    const optimized = bench(`kdNearest ${count}t`, () => {
      for (let q = 0; q < 100; q++) {
        kdNearest_mutable(tree, [queries[q * 2], queries[q * 2 + 1]], -1, Infinity, new Set());
      }
    }, iters);
    printComparison(baseline, optimized);
  }

  // ── Summary ──
  log('');
  log('═'.repeat(80));
  log('Done. Apply optimizations with ✓ FASTER results to production code.');
}

setTimeout(runAll, 100);
