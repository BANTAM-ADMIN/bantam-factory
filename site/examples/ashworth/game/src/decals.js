import * as THREE from 'three';
import { FX, LAYERS } from './constants.js';
import { cloneMaterial } from './materials.js';
import { clamp } from './utils.js';
const _matrix = new THREE.Matrix4(), _roll = new THREE.Quaternion();
const _pos = new THREE.Vector3(), _scale = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(0, 1, 0);
export class Decals {
  constructor(G) { this.G = G; }
  init() {
    this.off = []; this.batches = []; this.pending = Array.from({ length: 24 }, () => ({ active: false, t: 0, pos: new THREE.Vector3() })); this.pendingHead = 0;
    const specs = [['decalHole', FX.decalsHoles, 2], ['decalBlood', FX.decalsSplats, 4], ['decalPool', FX.decalsPools, 1]];
    for (const [name, capacity, grid] of specs) {
      const geo = new THREE.PlaneGeometry(1, 1), tile = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1), alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      geo.setAttribute('aTile', tile); geo.setAttribute('aFade', alpha);
      const material = cloneMaterial(name); material.onBeforeCompile = shader => {
        shader.vertexShader = 'attribute float aTile; attribute float aFade; varying float vTile; varying float vFade;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTile=aTile; vFade=aFade;');
        shader.fragmentShader = 'varying float vTile; varying float vFade;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `vec2 atlasUV=(vMapUv+vec2(mod(vTile,${grid}.0),${grid - 1}.0-floor(vTile/${grid}.0)))/${grid}.0; diffuseColor*=texture2D(map,atlasUV);`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', 'diffuseColor.a*=texture2D(alphaMap,atlasUV).g*vFade;');
      };
      material.customProgramCacheKey = () => `decal-atlas-${grid}`;
      const mesh = new THREE.InstancedMesh(geo, material, capacity); mesh.layers.set(LAYERS.NO_ENV); mesh.frustumCulled = false; mesh.renderOrder = 1;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = capacity;
      const items = Array.from({ length: capacity }, () => ({ active: false, age: 0, size: 0, pos: new THREE.Vector3(), q: new THREE.Quaternion() }));
      const batch = { mesh, items, tile, alpha, head: 0, grid }; this.batches.push(batch); this.G.scene.add(mesh);
      for (let i = 0; i < capacity; i++) { _matrix.makeScale(0, 0, 0); mesh.setMatrixAt(i, _matrix); }
    }
    this.off.push(this.G.bus.on('shot-hit-world', e => this.addBulletHole(e.pos, e.normal, e.surface)));
    this.off.push(this.G.bus.on('enemy-hit', e => {
      const y = this.G.station.floorHeightAt(e.pos.x, e.pos.z);
      if (y !== null && e.pos.y >= y && e.pos.y - y <= 2) { _pos.set(e.pos.x, y, e.pos.z); this.addBloodSplat(_pos, _up, this.G.rng.range(0.25, 0.5)); }
    }));
    this.off.push(this.G.bus.on('enemy-rest', e => { const p = this.pending[this.pendingHead++ % this.pending.length]; p.active = true; p.t = FX.poolDelay; p.pos.copy(e.pos); }));
  }
  add(batchIndex, pos, normal, size, tile) {
    const b = this.batches[batchIndex], i = b.head++ % b.items.length, item = b.items[i];
    item.active = true; item.age = 0; item.size = size; item.pos.copy(pos).addScaledVector(normal, FX.decalOffset);
    item.q.setFromUnitVectors(_z, normal); _roll.setFromAxisAngle(_z, this.G.rng() * Math.PI * 2); item.q.multiply(_roll);
    b.tile.setX(i, tile); b.tile.needsUpdate = true; this.write(b, i, item, batchIndex); return item;
  }
  write(b, i, item, kind) {
    const size = kind === 2 ? 0.2 + (item.size - 0.2) * clamp(item.age / 3, 0, 1) : item.size;
    _matrix.compose(item.pos, item.q, _scale.set(size, size, size)); b.mesh.setMatrixAt(i, _matrix);
    b.alpha.setX(i, clamp((FX.decalLife - item.age) / 5, 0, 1)); b.alpha.needsUpdate = true; b.mesh.instanceMatrix.needsUpdate = true;
  }
  addBulletHole(pos, normal, surface) {
    if (surface === 'none') return;
    const index = surface === 'tile' ? 0 : surface === 'metal' ? 2 : surface === 'wood' ? 3 : 1;
    this.add(0, pos, normal, surface === 'metal' ? 0.04 : surface === 'glass' ? 0.12 : 0.06, index);
  }
  addBloodSplat(pos, normal, size = 0.35) { this.add(1, pos, normal, size, this.G.rng.int(8)); }
  addBloodPool(pos, size = 1.2) {
    const y = this.G.station.floorHeightAt(pos.x, pos.z); if (y === null) return;
    _pos.set(pos.x, y, pos.z); this.add(2, _pos, _up, size, 0);
  }
  addScorch(pos, normal, size = 0.3) { this.add(0, pos, normal, size, 1); }
  update(dt) {
    for (const p of this.pending) if (p.active) { p.t -= dt; if (p.t <= 1e-8) { p.active = false; this.addBloodPool(p.pos); } }
    for (let k = 0; k < this.batches.length; k++) {
      const b = this.batches[k];
      for (let i = 0; i < b.items.length; i++) {
        const item = b.items[i]; if (!item.active) continue; item.age += dt;
        if (item.age >= FX.decalLife) { item.active = false; _matrix.makeScale(0, 0, 0); b.mesh.setMatrixAt(i, _matrix); b.mesh.instanceMatrix.needsUpdate = true; }
        else this.write(b, i, item, k);
      }
    }
  }
  warmupDone() { this.reset(); }
  reset() {
    for (const p of this.pending) p.active = false; this.pendingHead = 0;
    for (const b of this.batches) { b.head = 0; for (let i = 0; i < b.items.length; i++) { b.items[i].active = false; b.alpha.setX(i, 0); _matrix.makeScale(0, 0, 0); b.mesh.setMatrixAt(i, _matrix); } b.alpha.needsUpdate = true; b.mesh.instanceMatrix.needsUpdate = true; }
  }
  dispose() { for (const off of this.off) off(); for (const b of this.batches) { this.G.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); } }
}
