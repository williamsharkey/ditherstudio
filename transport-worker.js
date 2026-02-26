// Dither Studio — Transport Worker
// Mass-preserving particle physics system
// Operates on Float32Array positions/velocities with spatial hash grid

'use strict';

// ─── Flat Spatial Hash Grid (H2/H6: ~1.5-2x faster than Array-of-Arrays) ───
class SpatialHash {
  constructor(cellSize, width, height) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    const totalCells = this.cols * this.rows;
    this.counts = new Int32Array(totalCells);
    this.maxPerCell = 32;
    this.data = new Int32Array(totalCells * this.maxPerCell);
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

  // Returns count of results. Caller reads from this._queryBuf[0..count-1].
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
    return qc;
  }
}

// ─── KD-Tree for target assignment (H1: ~10x faster with quickselect) ───
class KDNode {
  constructor(point, id, left, right, axis) {
    this.point = point;
    this.id = id;
    this.left = left;
    this.right = right;
    this.axis = axis;
  }
}

function quickselect(ids, points, axis, lo, hi, k) {
  while (lo < hi) {
    // Median-of-three pivot selection
    const mid = (lo + hi) >> 1;
    const va = points[ids[lo] * 2 + axis];
    const vb = points[ids[mid] * 2 + axis];
    const vc = points[ids[hi] * 2 + axis];
    let pivot;
    if (va <= vb) {
      pivot = vb <= vc ? mid : (va <= vc ? hi : lo);
    } else {
      pivot = va <= vc ? lo : (vb <= vc ? hi : mid);
    }
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

function buildKDTree(points, ids, lo, hi, depth) {
  if (lo > hi) return null;
  if (lo === hi) {
    const id = ids[lo];
    return new KDNode([points[id*2], points[id*2+1]], id, null, null, depth % 2);
  }

  const axis = depth % 2;
  const mid = (lo + hi) >> 1;
  quickselect(ids, points, axis, lo, hi, mid);
  const id = ids[mid];

  return new KDNode(
    [points[id*2], points[id*2+1]],
    id,
    buildKDTree(points, ids, lo, mid - 1, depth + 1),
    buildKDTree(points, ids, mid + 1, hi, depth + 1),
    axis
  );
}

function kdNearest(node, target, best, bestDist, used) {
  if (!node) return { best, bestDist };

  const dist = (node.point[0] - target[0]) ** 2 + (node.point[1] - target[1]) ** 2;
  if (dist < bestDist && !used.has(node.id)) {
    bestDist = dist;
    best = node.id;
  }

  const axis = node.axis;
  const diff = target[axis] - node.point[axis];
  const first = diff < 0 ? node.left : node.right;
  const second = diff < 0 ? node.right : node.left;

  const result1 = kdNearest(first, target, best, bestDist, used);
  best = result1.best;
  bestDist = result1.bestDist;

  if (diff * diff < bestDist) {
    const result2 = kdNearest(second, target, best, bestDist, used);
    best = result2.best;
    bestDist = result2.bestDist;
  }

  return { best, bestDist };
}

// ─── Assignment Methods ───
// All return { assigned: Float32Array(count*2), mapping: Int32Array(count) }
// mapping[i] = target index assigned to particle i (for color lookup)

// H3: Spatial-hash accelerated greedy (~2.5-10x faster than brute O(n²))
function assignGreedy(positions, targets, count, targetCount, w, h) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const used = new Uint8Array(targetCount);

  // Build spatial hash of targets for fast nearest-neighbor queries
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

  const maxRadius = Math.max(cols, rows);

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2];
    const py = positions[i * 2 + 1];
    let bestDist = Infinity;
    let bestJ = 0;

    const pcol = Math.max(0, Math.min(cols - 1, (px / cellSize) | 0));
    const prow = Math.max(0, Math.min(rows - 1, (py / cellSize) | 0));

    for (let radius = 0; radius <= maxRadius; radius++) {
      const rMin = Math.max(0, prow - radius);
      const rMax = Math.min(rows - 1, prow + radius);
      const cMin = Math.max(0, pcol - radius);
      const cMax = Math.min(cols - 1, pcol + radius);

      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          // Only process border cells of expanding ring
          if (radius > 0 && r > rMin && r < rMax && c > cMin && c < cMax) continue;
          const ci = r * cols + c;
          const cnt = cellCounts[ci];
          const base = ci * maxPerCell;
          for (let k = 0; k < cnt; k++) {
            const j = cellData[base + k];
            if (used[j] && i < targetCount) continue;
            const dx = px - targets[j * 2];
            const dy = py - targets[j * 2 + 1];
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; bestJ = j; }
          }
        }
      }

      // Early exit: if nearest found is closer than any point in the next ring
      if (bestDist < Infinity) {
        const minRingDist = (radius * cellSize - cellSize);
        if (minRingDist * minRingDist > bestDist) break;
      }
    }

    if (i < targetCount) used[bestJ] = 1;
    assigned[i * 2] = targets[bestJ * 2];
    assigned[i * 2 + 1] = targets[bestJ * 2 + 1];
    mapping[i] = bestJ;
  }

  return { assigned, mapping };
}

function assignKDTree(positions, targets, count, targetCount) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const ids = new Int32Array(targetCount);
  for (let i = 0; i < targetCount; i++) ids[i] = i;
  const tree = buildKDTree(targets, ids, 0, targetCount - 1, 0);
  const used = new Set();

  for (let i = 0; i < count; i++) {
    const target = [positions[i*2], positions[i*2+1]];
    const searchUsed = count <= targetCount ? used : new Set();
    const { best } = kdNearest(tree, target, -1, Infinity, searchUsed);

    if (best >= 0) {
      if (count <= targetCount) used.add(best);
      assigned[i*2] = targets[best*2];
      assigned[i*2+1] = targets[best*2+1];
      mapping[i] = best;
    } else {
      assigned[i*2] = positions[i*2];
      assigned[i*2+1] = positions[i*2+1];
      mapping[i] = 0;
    }
  }

  return { assigned, mapping };
}

// Cached random permutation — stable across frames to prevent center-blob convergence.
// Without caching, each frame gets a new shuffle, and particles converge to the centroid
// (the time-average of uniformly random positions).
let _randomPerm = null;
let _randomPermSize = 0;

function assignRandom(targets, count, targetCount) {
  const needed = Math.max(count, targetCount);
  if (!_randomPerm || _randomPermSize < needed) {
    _randomPermSize = needed;
    _randomPerm = new Int32Array(needed);
    for (let i = 0; i < needed; i++) _randomPerm[i] = i;
    for (let i = needed - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = _randomPerm[i];
      _randomPerm[i] = _randomPerm[j];
      _randomPerm[j] = tmp;
    }
  }

  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const ti = _randomPerm[i] % targetCount;
    assigned[i*2] = targets[ti*2];
    assigned[i*2+1] = targets[ti*2+1];
    mapping[i] = ti;
  }

  return { assigned, mapping };
}

// ─── Physics Step ───
function physicsStep(params) {
  const {
    positions, velocities, assignedTargets, count,
    mode, spring, damping, repulsion, repulsionRadius,
    mass, maxVel, width, height
  } = params;

  const dt = 1.0;
  let spatialHash = null;

  // Build spatial hash for repulsion
  if (repulsion > 0 && repulsionRadius > 0) {
    spatialHash = new SpatialHash(repulsionRadius * 2, width, height);
    for (let i = 0; i < count; i++) {
      spatialHash.insert(i, positions[i*2], positions[i*2+1]);
    }
  }

  for (let i = 0; i < count; i++) {
    const px = positions[i*2];
    const py = positions[i*2+1];
    const tx = assignedTargets[i*2];
    const ty = assignedTargets[i*2+1];

    let fx = 0, fy = 0;

    // Spring force toward target
    switch (mode) {
      case 'overdamped':
        fx = (tx - px) * spring;
        fy = (ty - py) * spring;
        velocities[i*2] = fx * (1 - damping);
        velocities[i*2+1] = fy * (1 - damping);
        break;

      case 'underdamped':
        fx = (tx - px) * spring;
        fy = (ty - py) * spring;
        velocities[i*2] += (fx / mass) * dt;
        velocities[i*2+1] += (fy / mass) * dt;
        velocities[i*2] *= (1.0 - damping * 0.3 * dt);
        velocities[i*2+1] *= (1.0 - damping * 0.3 * dt);
        break;

      case 'ballistic':
        if (Math.abs(velocities[i*2]) < 0.01 && Math.abs(velocities[i*2+1]) < 0.01) {
          const dx = tx - px;
          const dy = ty - py;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist > 0.5) {
            velocities[i*2] = (dx / dist) * maxVel;
            velocities[i*2+1] = (dy / dist) * maxVel;
          }
        }
        velocities[i*2] *= (1.0 - damping * dt);
        velocities[i*2+1] *= (1.0 - damping * dt);
        break;

      case 'diffusion':
        const ddx = tx - px;
        const ddy = ty - py;
        velocities[i*2] = ddx * spring * 0.1 + (Math.random() - 0.5) * maxVel * 0.5;
        velocities[i*2+1] = ddy * spring * 0.1 + (Math.random() - 0.5) * maxVel * 0.5;
        break;
    }

    // Repulsion from neighbors
    if (spatialHash && repulsion > 0) {
      const qc = spatialHash.query(px, py, repulsionRadius);
      const buf = spatialHash._queryBuf;
      for (let n = 0; n < qc; n++) {
        const ni = buf[n];
        if (ni === i) continue;
        const ndx = px - positions[ni*2];
        const ndy = py - positions[ni*2+1];
        const ndist = Math.sqrt(ndx*ndx + ndy*ndy);
        if (ndist > 0 && ndist < repulsionRadius) {
          const force = repulsion / (ndist * ndist + 0.01);
          velocities[i*2] += (ndx / ndist) * force * dt;
          velocities[i*2+1] += (ndy / ndist) * force * dt;
        }
      }
    }

    // Clamp velocity
    velocities[i*2] = Math.max(-maxVel, Math.min(maxVel, velocities[i*2]));
    velocities[i*2+1] = Math.max(-maxVel, Math.min(maxVel, velocities[i*2+1]));

    // Update position
    positions[i*2] = Math.max(0, Math.min(width - 1, px + velocities[i*2] * dt));
    positions[i*2+1] = Math.max(0, Math.min(height - 1, py + velocities[i*2+1] * dt));
  }
}

// ─── Overlap Resolution ───
// Precomputed spiral offsets for neighbor search (radius ~4)
const SPIRAL_OFFSETS = (() => {
  const offsets = [];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r || Math.abs(dy) === r) {
          offsets.push([dx, dy]);
        }
      }
    }
  }
  // Sort by distance for true spiral order
  offsets.sort((a, b) => (a[0]*a[0] + a[1]*a[1]) - (b[0]*b[0] + b[1]*b[1]));
  return offsets;
})();

let _overlapGrid = null;
let _overlapGridSize = 0;

function resolveOverlaps(positions, count, w, h) {
  const gridSize = w * h;
  if (!_overlapGrid || _overlapGridSize < gridSize) {
    _overlapGrid = new Int32Array(gridSize);
    _overlapGridSize = gridSize;
  }
  _overlapGrid.fill(-1);

  for (let i = 0; i < count; i++) {
    let rx = Math.round(positions[i * 2]);
    let ry = Math.round(positions[i * 2 + 1]);
    rx = Math.max(0, Math.min(w - 1, rx));
    ry = Math.max(0, Math.min(h - 1, ry));
    const ci = ry * w + rx;

    if (_overlapGrid[ci] === -1) {
      _overlapGrid[ci] = i;
      positions[i * 2] = rx;
      positions[i * 2 + 1] = ry;
    } else {
      // Spiral outward to find empty cell
      for (let s = 0; s < SPIRAL_OFFSETS.length; s++) {
        const nx = rx + SPIRAL_OFFSETS[s][0];
        const ny = ry + SPIRAL_OFFSETS[s][1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (_overlapGrid[ni] === -1) {
          _overlapGrid[ni] = i;
          positions[i * 2] = nx;
          positions[i * 2 + 1] = ny;
          break;
        }
      }
      // If nothing found within radius, leave position unchanged
    }
  }
}

// ─── Swap Optimization (H6: uses flat spatial hash) ───
function swapOptimize(positions, assigned, mapping, count, w, h) {
  const hash = new SpatialHash(6, w, h);
  for (let i = 0; i < count; i++) {
    hash.insert(i, positions[i * 2], positions[i * 2 + 1]);
  }

  for (let i = 0; i < count; i++) {
    const px = positions[i * 2];
    const py = positions[i * 2 + 1];
    const qc = hash.query(px, py, 6);
    const buf = hash._queryBuf;

    for (let n = 0; n < qc; n++) {
      const j = buf[n];
      if (j <= i) continue; // avoid double-checking

      const ax = assigned[i * 2], ay = assigned[i * 2 + 1];
      const bx = assigned[j * 2], by = assigned[j * 2 + 1];
      const jpx = positions[j * 2], jpy = positions[j * 2 + 1];

      const curCost = (px - ax) * (px - ax) + (py - ay) * (py - ay)
                    + (jpx - bx) * (jpx - bx) + (jpy - by) * (jpy - by);
      const swpCost = (px - bx) * (px - bx) + (py - by) * (py - by)
                    + (jpx - ax) * (jpx - ax) + (jpy - ay) * (jpy - ay);

      if (swpCost < curCost) {
        // Swap assigned positions
        assigned[i * 2] = bx; assigned[i * 2 + 1] = by;
        assigned[j * 2] = ax; assigned[j * 2 + 1] = ay;
        // Swap mapping indices
        const tmp = mapping[i];
        mapping[i] = mapping[j];
        mapping[j] = tmp;
      }
    }
  }
}

// ─── Message Handler ───
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'step') {
    const positions = new Float32Array(msg.positions);
    const velocities = new Float32Array(msg.velocities);
    const targets = new Float32Array(msg.targets);
    const count = msg.count;
    const targetCount = msg.targetCount;
    const targetColors = msg.targetColors ? new Uint8Array(msg.targetColors) : null;

    // Assign targets (returns { assigned, mapping })
    let result;
    switch (msg.assignment) {
      case 'kdtree':
        result = assignKDTree(positions, targets, count, targetCount);
        break;
      case 'random':
        result = assignRandom(targets, count, targetCount);
        break;
      default:
        result = assignGreedy(positions, targets, count, targetCount, msg.width, msg.height);
    }

    // Swap optimization (before physics, after assignment)
    if (msg.swap) {
      swapOptimize(positions, result.assigned, result.mapping, count, msg.width, msg.height);
    }

    // Build per-particle colors from assignment mapping
    let colors = null;
    if (targetColors) {
      colors = new Uint8Array(count * 3);
      for (let i = 0; i < count; i++) {
        const ti = result.mapping[i];
        colors[i*3]     = targetColors[ti*3];
        colors[i*3 + 1] = targetColors[ti*3 + 1];
        colors[i*3 + 2] = targetColors[ti*3 + 2];
      }
    }

    // Physics step
    physicsStep({
      positions, velocities, assignedTargets: result.assigned, count,
      mode: msg.mode,
      spring: msg.spring,
      damping: msg.damping,
      repulsion: msg.repulsion,
      repulsionRadius: msg.repulsionRadius || 2,
      mass: msg.mass,
      maxVel: msg.maxVel,
      width: msg.width,
      height: msg.height
    });

    // Overlap resolution (after physics, before rendering)
    if (msg.noOverlap) {
      resolveOverlaps(positions, count, msg.width, msg.height);
    }

    // Transfer back
    const transferList = [positions.buffer, velocities.buffer];
    const response = {
      type: 'stepResult',
      positions: positions.buffer,
      velocities: velocities.buffer,
      frameId: msg.frameId
    };
    if (colors) {
      response.colors = colors.buffer;
      transferList.push(colors.buffer);
    }
    self.postMessage(response, transferList);
  }
};
