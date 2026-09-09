import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const easeInCubic = t => t * t * t;
export const easeOutCubic = t => 1 - (1 - t) ** 3;
export const easeInOutCubic = t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
export const wrapAngle = x => Math.atan2(Math.sin(x), Math.cos(x));
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const degToRad = x => x * Math.PI / 180;
export const yawFromDir = (x, z) => Math.atan2(-x, -z);
export function dirFromYaw(yaw, out) { return out.set(-Math.sin(yaw), 0, -Math.cos(yaw)); }

export function mulberry32(seed) {
  let state = seed >>> 0;
  function rng() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = n => Math.floor(rng() * n);
  rng.pick = a => a[rng.int(a.length)];
  rng.sign = () => rng() < 0.5 ? -1 : 1;
  rng.gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
  rng.seed = n => { state = n >>> 0; };
  rng.state = () => state;
  return rng;
}

export class Pool {
  constructor(n, factory) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('Pool capacity must be positive');
    this.items = Array.from({ length: n }, (_, i) => factory(i));
    this.flags = new Uint8Array(n);
    this.ages = new Float64Array(n);
    this.serial = 0;
    this.count = 0;
  }
  get active() { return this.count; }
  activate(i) { this.flags[i] = 1; this.ages[i] = ++this.serial; this.count++; return this.items[i]; }
  tryAcquire() { for (let i = 0; i < this.items.length; i++) if (!this.flags[i]) return this.activate(i); return null; }
  acquire() {
    const free = this.tryAcquire();
    if (free !== null) return free;
    let oldest = 0;
    for (let i = 1; i < this.items.length; i++) if (this.ages[i] < this.ages[oldest]) oldest = i;
    this.release(this.items[oldest]);
    return this.activate(oldest);
  }
  release(item) { const i = this.items.indexOf(item); if (i >= 0 && this.flags[i]) { this.flags[i] = 0; this.count--; item.onRelease?.(); } }
  forEachActive(fn) { for (let i = 0; i < this.items.length; i++) if (this.flags[i]) fn(this.items[i], i); }
  reset() { for (let i = 0; i < this.items.length; i++) if (this.flags[i]) this.release(this.items[i]); this.serial = 0; }
}

export class SpatialHash {
  constructor(cell = 2) { this.cell = cell; this.buckets = new Map(); }
  clear() { for (const bucket of this.buckets.values()) bucket.length = 0; }
  key(x, z) { return (x + 32768) * 65536 + z + 32768; }
  insert(obj, x, z) {
    const key = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = []; this.buckets.set(key, bucket); }
    bucket.push(obj);
  }
  query(x, z, r, out) {
    out.length = 0;
    for (let i = Math.floor((x - r) / this.cell); i <= Math.floor((x + r) / this.cell); i++) {
      for (let j = Math.floor((z - r) / this.cell); j <= Math.floor((z + r) / this.cell); j++) {
        const bucket = this.buckets.get(this.key(i, j));
        if (bucket) for (let k = 0; k < bucket.length; k++) out.push(bucket[k]);
      }
    }
    return out;
  }
}
export class Spring {
  constructor(k = 220, d = 18) { this.k = k; this.d = d; this.value = 0; this.velocity = 0; this.target = 0; }
  update(dt) {
    const n = Math.ceil(dt / (1 / 120)), h = dt / n;
    for (let i = 0; i < n; i++) { this.velocity += ((this.target - this.value) * this.k - this.velocity * this.d) * h; this.value += this.velocity * h; }
    return this.value;
  }
  impulse(v) { this.velocity += v; }
  reset() { this.value = this.velocity = this.target = 0; }
}
export class Spring3 {
  constructor(k = 220, d = 18) { this.k = k; this.d = d; this.value = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.target = new THREE.Vector3(); }
  update(dt) {
    const n = Math.ceil(dt * 120), h = dt / n;
    for (let i = 0; i < n; i++) for (const axis of ['x', 'y', 'z']) {
      this.velocity[axis] += ((this.target[axis] - this.value[axis]) * this.k - this.velocity[axis] * this.d) * h;
      this.value[axis] += this.velocity[axis] * h;
    }
    return this.value;
  }
  impulse(v) { this.velocity.add(v); }
  reset() { this.value.setScalar(0); this.velocity.setScalar(0); this.target.setScalar(0); }
}
export const TMP = { v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(), q1: new THREE.Quaternion(), m1: new THREE.Matrix4(), e1: new THREE.Euler(), c1: new THREE.Color() };
export function makeBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const face = Math.floor(i / 4); uv.setXY(i, uv.getX(i) * (face < 2 ? d : w), uv.getY(i) * (face < 2 || face > 3 ? h : d)); }
  return g;
}
export function makePlane(w, h, widthSegments = 1, heightSegments = 1) {
  const g = new THREE.PlaneGeometry(w, h, widthSegments, heightSegments), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}
export function transformGeo(g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  TMP.e1.set(rx, ry, rz); TMP.q1.setFromEuler(TMP.e1);
  TMP.m1.compose(TMP.v1.set(x, y, z), TMP.q1, TMP.v2.set(sx, sy, sz));
  return g.applyMatrix4(TMP.m1);
}
export function ensureColorAttr(g, r = 1, bG = 1, b = 1) {
  if (!g.attributes.color) {
    const a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = r; a[i + 1] = bG; a[i + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  return g;
}
export function mergeGeos(list, useGroups = false) {
  for (const g of list) {
    ensureColorAttr(g); g.deleteAttribute('uv1'); g.deleteAttribute('tangent');
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return mergeGeometries(list, useGroups);
}
export function bakeVertexAO(g, occluders, { radius = 0.5, strength = 0.45, floorY = null } = {}) {
  ensureColorAttr(g);
  const p = g.attributes.position, c = g.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let dist = floorY === null ? radius : Math.abs(y - floorY);
    for (const o of occluders) {
      let d;
      if (o.type === 'cyl') d = Math.hypot(Math.max(0, Math.hypot(x - o.x, z - o.z) - o.r), Math.max(o.y0 - y, 0, y - o.y1));
      else d = Math.hypot(Math.max(o.min[0] - x, 0, x - o.max[0]), Math.max(o.min[1] - y, 0, y - o.max[1]), Math.max(o.min[2] - z, 0, z - o.max[2]));
      dist = Math.min(dist, d);
    }
    const f = 1 - strength * (1 - clamp(dist / radius, 0, 1));
    c.setXYZ(i, c.getX(i) * f, c.getY(i) * f, c.getZ(i) * f);
  }
  c.needsUpdate = true;
  return g;
}
export function setInstance(mesh, i, pos, quat, scale) { TMP.m1.compose(pos, quat, scale); mesh.setMatrixAt(i, TMP.m1); }
export function hideInstance(mesh, i) { TMP.m1.makeScale(0, 0, 0); mesh.setMatrixAt(i, TMP.m1); }
export function closestPointSegment(p, a, b, out) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const length2 = dx * dx + dy * dy + dz * dz;
  const t = length2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / length2, 0, 1) : 0;
  return out.set(a.x + dx * t, a.y + dy * t, a.z + dz * t);
}
export function raySphere(o, d, c, r, maxDist) {
  const x = o.x - c.x, y = o.y - c.y, z = o.z - c.z;
  const b = x * d.x + y * d.y + z * d.z, q = x * x + y * y + z * z - r * r;
  const h = b * b - q;
  if (h < 0) return -1;
  const t = q <= 0 ? 0 : -b - Math.sqrt(h);
  return t >= 0 && t <= maxDist ? t : -1;
}
export function rayCapsule(o, d, a, b, r, maxDist) {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const ox = o.x - a.x, oy = o.y - a.y, oz = o.z - a.z;
  const bb = bx * bx + by * by + bz * bz;
  if (bb < 1e-12) return raySphere(o, d, a, r, maxDist);
  const bd = bx * d.x + by * d.y + bz * d.z, bo = bx * ox + by * oy + bz * oz;
  const od = ox * d.x + oy * d.y + oz * d.z, oo = ox * ox + oy * oy + oz * oz;
  const u = clamp(bo / bb, 0, 1);
  if ((ox - bx * u) ** 2 + (oy - by * u) ** 2 + (oz - bz * u) ** 2 <= r * r) return 0;
  const aa = bb - bd * bd, ab = bb * od - bo * bd, ac = bb * oo - bo * bo - r * r * bb;
  const h = ab * ab - aa * ac;
  let best = Infinity;
  if (h >= 0 && aa > 1e-12) {
    const t = (-ab - Math.sqrt(h)) / aa, y = bo + t * bd;
    if (t >= 0 && y >= 0 && y <= bb) best = t;
  }
  const ta = raySphere(o, d, a, r, maxDist), tb = raySphere(o, d, b, r, maxDist);
  if (ta >= 0) best = Math.min(best, ta);
  if (tb >= 0) best = Math.min(best, tb);
  return best <= maxDist ? best : -1;
}
export function rayBox(o, d, min, max, maxDist, normal) {
  let near = 0, far = maxDist, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const key = i === 0 ? 'x' : i === 1 ? 'y' : 'z';
    if (Math.abs(d[key]) < 1e-12) { if (o[key] < min[i] || o[key] > max[i]) return -1; continue; }
    let a = (min[i] - o[key]) / d[key], b = (max[i] - o[key]) / d[key];
    const s = d[key] > 0 ? -1 : 1;
    if (a > b) { const temp = a; a = b; b = temp; }
    if (a > near) { near = a; axis = i; sign = s; }
    far = Math.min(far, b);
    if (near > far) return -1;
  }
  if (normal) { normal.set(0, 0, 0); if (axis >= 0) normal.setComponent(axis, sign); else normal.copy(d).negate(); }
  return near;
}
export function rayCylinderY(o, d, x, z, r, y0, y1, maxDist, normal) {
  const ox = o.x - x, oz = o.z - z, a = d.x * d.x + d.z * d.z;
  if (ox * ox + oz * oz <= r * r && o.y >= y0 && o.y <= y1) { normal?.copy(d).negate(); return 0; }
  const b = ox * d.x + oz * d.z, c = ox * ox + oz * oz - r * r, h = b * b - a * c;
  let best = Infinity, cap = 0;
  if (a > 1e-12 && h >= 0) {
    for (let s = -1; s <= 1; s += 2) {
      const t = (-b + s * Math.sqrt(h)) / a, y = o.y + t * d.y;
      if (t >= 0 && y >= y0 && y <= y1) best = Math.min(best, t);
    }
  }
  if (Math.abs(d.y) > 1e-12) for (let i = 0; i < 2; i++) {
    const t = ((i ? y1 : y0) - o.y) / d.y;
    if (t >= 0 && t < best && (ox + d.x * t) ** 2 + (oz + d.z * t) ** 2 <= r * r) { best = t; cap = i ? 1 : -1; }
  }
  if (best > maxDist) return -1;
  if (normal) { if (cap) normal.set(0, cap, 0); else normal.set(ox + d.x * best, 0, oz + d.z * best).normalize(); }
  return best;
}
export function circleVsBox(px, pz, r, min, max, out) {
  const qx = clamp(px, min[0], max[0]), qz = clamp(pz, min[2], max[2]);
  const dx = px - qx, dz = pz - qz, d2 = dx * dx + dz * dz;
  out.x = px; out.z = pz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-14) { const f = r / Math.sqrt(d2); out.x = qx + dx * f; out.z = qz + dz * f; }
  else {
    const left = px - min[0], right = max[0] - px, bottom = pz - min[2], top = max[2] - pz;
    const m = Math.min(left, right, bottom, top);
    if (m === left) out.x = min[0] - r;
    else if (m === right) out.x = max[0] + r;
    else if (m === bottom) out.z = min[2] - r;
    else out.z = max[2] + r;
  }
  return true;
}
export function circleVsCircle(px, pz, r, cx, cz, cr, out) {
  const dx = px - cx, dz = pz - cz, dist = Math.hypot(dx, dz), sum = r + cr;
  out.x = px; out.z = pz;
  if (dist >= sum) return false;
  out.x = cx + (dist ? dx / dist : 1) * sum; out.z = cz + (dist ? dz / dist : 0) * sum;
  return true;
}
