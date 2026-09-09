import * as THREE from 'three';
import { MASK } from './constants.js';
import { rayBox, rayCylinderY, circleVsBox, circleVsCircle } from './utils.js';

const _normal = new THREE.Vector3();
const _push = { x: 0, z: 0 };
export class Colliders {
  constructor(G) {
    this.G = G;
    this.statics = [];
    this.dynamics = new Map();
    this.buckets = new Map();
    this.dirty = true;
    this.nextId = 1;
    this.queryStamp = 0;
  }
  addStatic(c) { c.id = this.nextId++; this.statics.push(c); this.dirty = true; return c; }
  addStaticBox(min, max, tag, surface, mask = MASK.SOLID) { return this.addStatic({ type: 'box', min, max, tag, surface, mask }); }
  addStaticCyl(x, z, r, y0, y1, tag, surface, mask = MASK.SOLID) { return this.addStatic({ type: 'cyl', x, z, r, y0, y1, tag, surface, mask }); }
  removeStatic(c) { const i = this.statics.indexOf(c); if (i >= 0) this.statics.splice(i, 1); this.dirty = true; }
  setDynamic(key, list) { for (const c of list) if (!c.id) c.id = this.nextId++; this.dynamics.set(key, list); }
  clearDynamic(key) { this.dynamics.delete(key); }
  rebuild() {
    this.buckets.clear();
    for (const c of this.statics) {
      const min = c.type === 'box' ? c.min[0] : c.x - c.r;
      const max = c.type === 'box' ? c.max[0] : c.x + c.r;
      for (let i = Math.floor(min / 8); i <= Math.floor(max / 8); i++) {
        let bucket = this.buckets.get(i);
        if (!bucket) { bucket = []; this.buckets.set(i, bucket); }
        bucket.push(c);
      }
    }
    this.dirty = false;
  }
  forEachInRange(xMin, xMax, mask, fn) {
    if (this.dirty) this.rebuild();
    const stamp = ++this.queryStamp;
    for (let i = Math.floor(xMin / 8); i <= Math.floor(xMax / 8); i++) {
      const bucket = this.buckets.get(i);
      if (!bucket) continue;
      for (const c of bucket) if ((c.mask & mask) && c._stamp !== stamp) { c._stamp = stamp; fn(c); }
    }
    for (const list of this.dynamics.values()) for (const c of list) {
      const min = c.type === 'box' ? c.min[0] : c.x - c.r;
      const max = c.type === 'box' ? c.max[0] : c.x + c.r;
      if ((c.mask & mask) && min <= xMax && max >= xMin) fn(c);
    }
  }
  raycast(origin, dir, maxDist, mask, out) {
    let best = maxDist, found = false;
    this.forEachInRange(Math.min(origin.x, origin.x + dir.x * maxDist), Math.max(origin.x, origin.x + dir.x * maxDist), mask, c => {
      const t = c.type === 'box' ? rayBox(origin, dir, c.min, c.max, best, _normal)
        : rayCylinderY(origin, dir, c.x, c.z, c.r, c.y0, c.y1, best, _normal);
      if (t < 0 || (found && t >= best)) return;
      found = true; best = t;
      out.dist = t; out.collider = c; out.surface = c.surface; out.tag = c.tag;
      out.normal.copy(_normal); out.point.copy(dir).multiplyScalar(t).add(origin);
    });
    return found ? out : null;
  }
  vertical(c, feet, height) {
    const lo = c.type === 'box' ? c.min[1] : c.y0, hi = c.type === 'box' ? c.max[1] : c.y1;
    return lo < feet + height && hi > feet + 0.05;
  }
  resolveCircle(pos, radius, mask, yFeet = pos.y, height = 1, ignoreTags = null) {
    for (let pass = 0; pass < 3; pass++) this.forEachInRange(pos.x - radius, pos.x + radius, mask, c => {
      if (!this.vertical(c, yFeet, height) || (ignoreTags && (ignoreTags.has ? ignoreTags.has(c.tag) : ignoreTags.includes(c.tag)))) return;
      const hit = c.type === 'box' ? circleVsBox(pos.x, pos.z, radius, c.min, c.max, _push)
        : circleVsCircle(pos.x, pos.z, radius, c.x, c.z, c.r, _push);
      if (hit) { pos.x = _push.x; pos.z = _push.z; }
    });
    return pos;
  }
  overlapsCircle(x, z, r, mask, yFeet = 0, height = 1) {
    let hit = false;
    this.forEachInRange(x - r, x + r, mask, c => {
      if (hit || !this.vertical(c, yFeet, height)) return;
      hit = c.type === 'box' ? circleVsBox(x, z, r, c.min, c.max, _push) : circleVsCircle(x, z, r, c.x, c.z, c.r, _push);
    });
    return hit;
  }
  debugGroup() {
    const group = new THREE.Group(), material = new THREE.MeshBasicMaterial({ color: 0x40ffa0, wireframe: true, depthTest: false });
    for (const c of this.statics) {
      let mesh;
      if (c.type === 'box') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]), material);
        mesh.position.set((c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (c.min[2] + c.max[2]) / 2);
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, c.y1 - c.y0, 12), material);
        mesh.position.set(c.x, (c.y0 + c.y1) / 2, c.z);
      }
      group.add(mesh);
    }
    return group;
  }
}
