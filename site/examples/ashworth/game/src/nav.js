// DESIGN NOTE: NAV_KEEP_CLEAR rect A overlaps the mandatory stair walls at
// x=37.8..39, z=±1.2..1.5. Preserve those exact structural colliders and
// exempt only their specified bounds from the dressing-intrusion assertion.
// They remain blocked in the grid; the route goes around their east ends.
import * as THREE from 'three';
import { NAV, MASK, NAV_KEEP_CLEAR, PLAYER_SPAWN, TRAIN, trainCarCenterX } from './constants.js';

const _nearest = new THREE.Vector2();
const OFFSETS = [-1, 0, 1];
export class Nav {
  constructor(G) { this.G = G; }
  init() {
    this.cols = NAV.cols; this.rows = NAV.rows; this.cell = NAV.cell;
    this.size = this.cols * this.rows;
    this.blocked = new Uint8Array(this.size); this.floorY = new Float32Array(this.size);
    this.dist = new Float32Array(this.size); this.dirX = new Float32Array(this.size); this.dirZ = new Float32Array(this.size);
    this.heap = new Int32Array(this.size); this.heapPos = new Int32Array(this.size);
    this.target = -1; this.cooldown = 0; this.heapCount = 0;
    this.build();
  }
  index(x, z) {
    const i = Math.floor((x - NAV.xMin) / this.cell), j = Math.floor((z - NAV.zMin) / this.cell);
    return i < 0 || j < 0 || i >= this.cols || j >= this.rows ? -1 : j * this.cols + i;
  }
  xOf(i) { return NAV.xMin + (i % this.cols + 0.5) * this.cell; }
  zOf(i) { return NAV.zMin + (Math.floor(i / this.cols) + 0.5) * this.cell; }
  overlaps(c, x0, x1, z0, z1, radius = 0) {
    if (c.type === 'box') return c.min[0] - radius < x1 && c.max[0] + radius > x0 && c.min[2] - radius < z1 && c.max[2] + radius > z0;
    const dx = Math.max(x0 - c.x, 0, c.x - x1), dz = Math.max(z0 - c.z, 0, c.z - z1);
    return dx * dx + dz * dz < (c.r + radius) ** 2;
  }
  build() {
    const colliders = this.G.colliders.statics;
    for (const c of colliders) {
      if (!(c.mask & MASK.NAV) || c.tag === 'turnstile' || c.tag === 'fare-rail') continue;
      const structuralStairWall = c.tag === 'stair-wall' && c.type === 'box'
        && c.min[0] === 30 && c.max[0] === 39 && c.min[1] === 0 && c.max[1] === 8.2
        && ((Math.abs(c.min[2] - 1.2) < 1e-9 && Math.abs(c.max[2] - 1.5) < 1e-9)
          || (Math.abs(c.min[2] + 1.5) < 1e-9 && Math.abs(c.max[2] + 1.2) < 1e-9));
      if (structuralStairWall) continue;
      const y0 = c.type === 'box' ? c.min[1] : c.y0, y1 = c.type === 'box' ? c.max[1] : c.y1;
      if (y0 >= 5.8 || y1 <= 4.85) continue;
      for (const r of NAV_KEEP_CLEAR) if (this.overlaps(c, r.xMin, r.xMax, r.zMin, r.zMax)) throw Error(`nav: keep-clear intrusion ${c.tag}`);
    }
    for (const c of colliders) {
      if (!(c.mask & MASK.WALKERS) || c.tag === 'door') continue;
      if (!this.G.colliders.vertical(c, 4.8, 1)) continue;
      if (this.overlaps(c, 44, 44, 4.75, 6.55, 0.35)) throw Error(`nav: service exit obstructed by ${c.tag}`);
    }
    for (let k = 0; k < this.size; k++) {
      const x = this.xOf(k), z = this.zOf(k), y = this.G.station.floorHeightAt(x, z);
      this.floorY[k] = y ?? 0; this.blocked[k] = y === null ? 1 : 0;
      if (y === null) continue;
      for (const c of colliders) {
        if (!(c.mask & MASK.NAV) || !this.G.colliders.vertical(c, y, 1)) continue;
        if (this.overlaps(c, x - 0.25, x + 0.25, z - 0.25, z + 0.25, NAV.agentRadius)) { this.blocked[k] = 1; break; }
      }
    }
    this.compute(this.index(PLAYER_SPAWN.pos[0], PLAYER_SPAWN.pos[2]));
    const required = NAV.mustReach.slice();
    for (let car = 0; car < TRAIN.cars; car++) for (const dx of TRAIN.doorLocalX) for (const z of [-4, 4]) required.push([trainCarCenterX(car) + dx, z]);
    for (const [x, z] of required) if (!Number.isFinite(this.distanceAt(x, z))) throw Error(`nav: unreachable ${x},${z}`);
  }
  heapSwap(a, b) {
    const va = this.heap[a], vb = this.heap[b];
    this.heap[a] = vb; this.heap[b] = va; this.heapPos[va] = b; this.heapPos[vb] = a;
  }
  pushOrDecrease(k) {
    let p = this.heapPos[k];
    if (p < 0) { p = this.heapCount++; this.heap[p] = k; this.heapPos[k] = p; }
    while (p > 0) {
      const parent = (p - 1) >> 1;
      if (this.dist[this.heap[parent]] <= this.dist[k]) break;
      this.heapSwap(p, parent); p = parent;
    }
  }
  pop() {
    const result = this.heap[0]; this.heapPos[result] = -1;
    this.heapCount--;
    if (this.heapCount) {
      this.heap[0] = this.heap[this.heapCount]; this.heapPos[this.heap[0]] = 0;
      let p = 0;
      while (true) {
        const left = p * 2 + 1, right = left + 1;
        if (left >= this.heapCount) break;
        const child = right < this.heapCount && this.dist[this.heap[right]] < this.dist[this.heap[left]] ? right : left;
        if (this.dist[this.heap[p]] <= this.dist[this.heap[child]]) break;
        this.heapSwap(p, child); p = child;
      }
    }
    return result;
  }
  compute(target) {
    this.dist.fill(Infinity); this.dirX.fill(0); this.dirZ.fill(0); this.heapPos.fill(-1); this.heapCount = 0;
    if (target < 0 || this.blocked[target]) { this.target = -1; return; }
    this.target = target; this.dist[target] = 0; this.pushOrDecrease(target);
    while (this.heapCount) {
      const k = this.pop(), x = k % this.cols, z = Math.floor(k / this.cols);
      for (const dz of OFFSETS) for (const dx of OFFSETS) {
        if ((!dx && !dz) || x + dx < 0 || x + dx >= this.cols || z + dz < 0 || z + dz >= this.rows) continue;
        const next = k + dx + dz * this.cols;
        if (this.blocked[next] || (dx && dz && (this.blocked[k + dx] || this.blocked[k + dz * this.cols]))) continue;
        const length = dx && dz ? Math.SQRT2 : 1, distance = this.dist[k] + length * this.cell;
        if (distance + 1e-5 >= this.dist[next]) continue;
        this.dist[next] = distance; this.dirX[next] = -dx / length; this.dirZ[next] = -dz / length;
        this.pushOrDecrease(next);
      }
    }
  }
  setTarget(x, z) {
    let k = this.index(x, z);
    if (k < 0 || this.blocked[k]) { this.nearestWalkable(x, z, _nearest); k = this.index(_nearest.x, _nearest.y); }
    if (k !== this.target && this.cooldown <= 0) { this.compute(k); this.cooldown = NAV.recompute; }
  }
  update(dt) { this.cooldown -= dt; this.setTarget(this.G.player.pos.x, this.G.player.pos.z); }
  isWalkable(x, z) { const k = this.index(x, z); return k >= 0 && !this.blocked[k]; }
  distanceAt(x, z) {
    const k = this.index(x, z);
    if (k < 0) return Infinity;
    if (!this.blocked[k]) return this.dist[k];
    // DESIGN NOTE: conservative whole-cell rasterization blocks the cell
    // [-27.5,-27] × [-4,-3.5] near a column, although the specified door
    // exit (-27.15,-4) itself is clear. Point queries may connect locally
    // to a reachable cell, but only through a radius-clear sampled segment.
    // Never unblock raster cells or bridge an obstacle/unreachable region.
    const y = this.G.station.floorHeightAt(x, z);
    if (y === null || this.G.colliders.overlapsCircle(x, z, NAV.agentRadius, MASK.NAV, y)) return Infinity;
    let best = Infinity;
    const ix = k % this.cols, iz = Math.floor(k / this.cols);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cz = iz + dz;
      if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
      const next = cz * this.cols + cx;
      if (this.blocked[next] || !Number.isFinite(this.dist[next])) continue;
      const tx = this.xOf(next), tz = this.zOf(next);
      let clear = true;
      for (let sample = 1; sample <= 16; sample++) {
        const sx = x + (tx - x) * sample / 16, sz = z + (tz - z) * sample / 16;
        const sy = this.G.station.floorHeightAt(sx, sz);
        if (sy === null || this.G.colliders.overlapsCircle(sx, sz, NAV.agentRadius, MASK.NAV, sy)) { clear = false; break; }
      }
      if (clear) best = Math.min(best, this.dist[next] + Math.hypot(tx - x, tz - z));
    }
    return best;
  }
  nearestWalkable(x, z, out) {
    let best = Infinity, selected = -1;
    for (let k = 0; k < this.size; k++) if (!this.blocked[k]) {
      const d = (this.xOf(k) - x) ** 2 + (this.zOf(k) - z) ** 2;
      if (d < best) { best = d; selected = k; }
    }
    return selected < 0 ? out.set(x, z) : out.set(this.xOf(selected), this.zOf(selected));
  }
  flowAt(x, z, out) {
    if (this.index(x, z) === this.target) return out.set(0, 0);
    const fx = (x - NAV.xMin) / this.cell - 0.5, fz = (z - NAV.zMin) / this.cell - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    let sx = 0, sz = 0, weight = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const cx = ix + i, cz = iz + j;
      if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
      const k = cz * this.cols + cx;
      if (this.blocked[k] || !Number.isFinite(this.dist[k])) continue;
      const w = (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
      sx += this.dirX[k] * w; sz += this.dirZ[k] * w; weight += w;
    }
    if (!weight) { this.nearestWalkable(x, z, out); return out.set(out.x - x, out.y - z).normalize(); }
    return out.set(sx / weight, sz / weight).normalize();
  }
  randomWalkable(minDistFromTarget, out) {
    const start = this.G.rng.int(this.size);
    for (let i = 0; i < this.size; i++) {
      const k = (start + i) % this.size;
      if (!this.blocked[k] && Number.isFinite(this.dist[k]) && this.dist[k] >= minDistFromTarget) return out.set(this.xOf(k), this.zOf(k));
    }
    return out.set(this.xOf(this.target), this.zOf(this.target));
  }
  reset() { this.cooldown = 0; this.compute(this.index(PLAYER_SPAWN.pos[0], PLAYER_SPAWN.pos[2])); }
  debugMesh() {
    const g = new THREE.BufferGeometry(), points = [];
    for (let k = 0; k < this.size; k++) if (!this.blocked[k]) points.push(this.xOf(k), this.floorY[k] + 0.03, this.zOf(k));
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x22ff99, size: 0.12 }));
  }
  dispose() {}
}
