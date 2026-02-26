// Dither Studio — Transport Worker
// Mass-preserving particle physics system
// Operates on Float32Array positions/velocities with spatial hash grid

'use strict';

// ─── Spatial Hash Grid ───
class SpatialHash {
  constructor(cellSize, width, height) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cells = new Array(this.cols * this.rows);
    this.clear();
  }

  clear() {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = [];
    }
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
        for (let i = 0; i < cell.length; i++) {
          results.push(cell[i]);
        }
      }
    }
    return results;
  }
}

// ─── KD-Tree for target assignment ───
class KDNode {
  constructor(point, id, left, right, axis) {
    this.point = point;
    this.id = id;
    this.left = left;
    this.right = right;
    this.axis = axis;
  }
}

function buildKDTree(points, ids, depth) {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const id = ids[0];
    return new KDNode([points[id*2], points[id*2+1]], id, null, null, depth % 2);
  }

  const axis = depth % 2;
  ids.sort((a, b) => points[a*2+axis] - points[b*2+axis]);
  const mid = ids.length >> 1;

  return new KDNode(
    [points[ids[mid]*2], points[ids[mid]*2+1]],
    ids[mid],
    buildKDTree(points, ids.slice(0, mid), depth + 1),
    buildKDTree(points, ids.slice(mid + 1), depth + 1),
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
function assignGreedy(positions, targets, count, targetCount) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const used = new Uint8Array(targetCount);

  for (let i = 0; i < count; i++) {
    const px = positions[i*2];
    const py = positions[i*2+1];
    let bestDist = Infinity;
    let bestJ = 0;

    for (let j = 0; j < targetCount; j++) {
      if (used[j] && i < targetCount) continue;
      const dx = px - targets[j*2];
      const dy = py - targets[j*2+1];
      const dist = dx*dx + dy*dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }

    if (i < targetCount) used[bestJ] = 1;
    assigned[i*2] = targets[bestJ*2];
    assigned[i*2+1] = targets[bestJ*2+1];
    mapping[i] = bestJ;
  }

  return { assigned, mapping };
}

function assignKDTree(positions, targets, count, targetCount) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const ids = Array.from({length: targetCount}, (_, i) => i);
  const tree = buildKDTree(targets, ids, 0);
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

function assignRandom(targets, count, targetCount) {
  const assigned = new Float32Array(count * 2);
  const mapping = new Int32Array(count);
  const indices = Array.from({length: targetCount}, (_, i) => i);

  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  for (let i = 0; i < count; i++) {
    const ti = indices[i % indices.length];
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
      const neighbors = spatialHash.query(px, py, repulsionRadius);
      for (const ni of neighbors) {
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
        result = assignGreedy(positions, targets, count, targetCount);
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
