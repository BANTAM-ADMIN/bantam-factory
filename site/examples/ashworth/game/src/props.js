import * as THREE from 'three';
import * as C from './constants.js';
import { getMaterial, cloneMaterial } from './materials.js';
import { getTexture } from './textures.js';
import { makeBox, transformGeo, mergeGeos, ensureColorAttr } from './utils.js';

export class Props {
  constructor(G) { this.G = G; }
  init() {
    this.group = new THREE.Group(); this.group.name = 'station dressing'; this.G.scene.add(this.group);
    this.batches = new Map(); this.signs = []; this.humSources = []; this.displays = []; this.dripT = 7;
    this.labelMaterials = new Map();
    this.dripPos = new THREE.Vector3(6, 3.8, -1); this.dripDir = new THREE.Vector3(0, -1, 0);
    for (const x of C.BENCHES.xs) this.bench(x, 0, 0, 'bench');
    for (const p of C.MEZZ_PROPS.benches) this.bench(p.x, 4.8, p.z, 'bench-mezz');
    C.TRASH_CANS.xs.forEach((x, i) => this.can(x, 0, (i % 2 ? -1 : 1) * C.TRASH_CANS.zAbs));
    for (const p of C.MEZZ_PROPS.cans) this.can(p.x, 4.8, p.z);
    this.fixtures(); this.posters(); this.hangingSigns(); this.services(); this.puddles();
    this.vending(C.VENDING.x, 0, C.VENDING.z, 0);
    for (const p of C.MEZZ_PROPS.vending) this.vending(p.x, 4.8, p.z, -Math.PI / 2);
    this.mezzanineDressing();
    this.flush();
  }
  add(material, geometry) {
    const mat = typeof material === 'string' ? getMaterial(material) : material;
    if (!this.batches.has(mat)) this.batches.set(mat, []);
    ensureColorAttr(geometry); this.batches.get(mat).push(geometry); return geometry;
  }
  box(mat, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) { return this.add(mat, transformGeo(makeBox(w, h, d), x, y, z, rx, ry, rz)); }
  cylinder(mat, x, y, z, r, h, segments = 8, rz = 0) { return this.add(mat, transformGeo(new THREE.CylinderGeometry(r, r, h, segments), x, y, z, 0, 0, rz)); }
  label(name, variant = 0, emissive = false) {
    const key = `${name}:${variant}:${emissive}`;
    if (!this.labelMaterials.has(key)) {
      const map = getTexture(name, variant).map;
      this.labelMaterials.set(key, cloneMaterial('paper', { color: 0xffffff, map, emissive: emissive ? 0xffffff : 0, emissiveMap: emissive ? map : null, emissiveIntensity: emissive ? 0.6 : 0 }));
    }
    return this.labelMaterials.get(key);
  }
  plane(mat, x, y, z, w, h, ry = 0, rx = 0) { return this.add(mat, transformGeo(new THREE.PlaneGeometry(w, h), x, y, z, rx, ry)); }
  collider(x, y, z, w, h, d, tag, surface = 'metal', mask = C.MASK.SOLID) { return this.G.colliders.addStaticBox([x - w / 2, y, z - d / 2], [x + w / 2, y + h, z + d / 2], tag, surface, mask); }
  flush() {
    for (const [material, geometries] of this.batches) {
      const mesh = new THREE.Mesh(mergeGeos(geometries), material); mesh.name = `props:${material.name}`;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix(); this.group.add(mesh);
      for (const geometry of geometries) geometry.dispose();
    }
    this.batches.clear();
  }
  bench(x, y, z, tag) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) this.box('woodWorn', x, y + 0.46, z + side * (0.13 + i * 0.075), 1.8, 0.03, 0.07);
      for (let i = 0; i < 4; i++) this.box('woodWorn', x, y + 0.59 + i * 0.075, z + side * 0.08, 1.8, 0.07, 0.03, side * 0.12);
      for (const dx of [-0.8, 0, 0.8]) {
        this.box('ironGreen', x + dx, y + 0.23, z + side * 0.35, 0.055, 0.46, 0.06, side * 0.1);
        this.box('ironGreen', x + dx, y + 0.43, z + side * 0.25, 0.055, 0.05, 0.45);
        this.box('ironGreen', x + dx, y + 0.65, z + side * 0.07, 0.055, 0.45, 0.04);
        for (let i = 0; i < 4; i++) this.add('chrome', transformGeo(new THREE.SphereGeometry(0.008, 4, 3), x + dx, y + 0.59 + i * 0.075, z + side * 0.101));
      }
    }
    this.collider(x, y, z, 1.9, 0.85, 1.1, tag, 'wood');
  }
  can(x, y, z) {
    this.cylinder('chainlink', x, y + 0.44, z, 0.3, 0.85, 16);
    this.cylinder('steelRust', x, y + 0.04, z, 0.31, 0.08, 16);
    // Structural ribs connect the lid and base even where alpha-tested mesh recedes.
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      this.cylinder('steelGalv', x + Math.cos(a) * 0.3, y + 0.46, z + Math.sin(a) * 0.3, 0.007, 0.84, 5);
    }
    const bag = new THREE.SphereGeometry(0.27, 12, 8); bag.scale(1, 1.25, 1); this.add('rubber', transformGeo(bag, x, y + 0.47, z));
    const points = [new THREE.Vector2(0.29, 0), new THREE.Vector2(0.32, 0.02), new THREE.Vector2(0.3, 0.07), new THREE.Vector2(0.19, 0.13)];
    this.add('steelGalv', transformGeo(new THREE.LatheGeometry(points, 16), x, y + 0.85, z));
    this.G.colliders.addStaticCyl(x, z, 0.32, y, y + 0.98, 'can', 'metal');
  }
  fixtures() {
    const anchors = this.G.station.getLightAnchors();
    for (const { pos } of anchors.troffers) {
      this.box('signEnamel', pos.x, pos.y + 0.07, pos.z, 1.25, 0.1, 0.3);
      for (const side of [-1, 1]) {
        this.box('steelGalv', pos.x, pos.y + 0.005, pos.z + side * 0.15, 1.3, 0.025, 0.02);
        this.box('signEnamel', pos.x + side * 0.61, pos.y - 0.02, pos.z, 0.035, 0.06, 0.29);
        this.cylinder('steelGalv', pos.x + side * 0.45, pos.y + 0.32, pos.z, 0.009, 0.5, 6);
      }
    }
    for (const p of anchors.wallLamps) {
      this.box('ironGreen', p.x, p.y, p.z + Math.sign(p.z) * 0.06, 0.23, 0.3, 0.12);
      for (const dx of [-0.08, 0, 0.08]) this.cylinder('steelGalv', p.x + dx, p.y, p.z - Math.sign(p.z) * 0.07, 0.008, 0.23, 5);
    }
    for (const { pos: p } of anchors.sodium) this.box('steelRust', p.x, p.y + 0.08, p.z, 0.3, 0.06, 0.3);
    for (const { pos: p, side } of anchors.signals) {
      this.box('rubber', p.x - side * 0.08, p.y, p.z, 0.12, 0.58, 0.22);
      for (let i = -1; i <= 1; i++) this.box('steelPainted', p.x - side * 0.02, p.y + i * 0.15 + 0.075, p.z, 0.2, 0.018, 0.17);
    }
    for (const { pos: p, rotY } of anchors.exitSigns) this.box('steelPainted', p.x, p.y, p.z, 0.72, 0.38, 0.08, 0, rotY);
  }
  posters() {
    this.G.station.getPosterSlots().forEach((slot, i) => {
      const p = slot.pos, side = Math.cos(slot.rotY);
      this.box('ironGreen', p.x, p.y, p.z - side * 0.012, slot.w + 0.1, slot.h + 0.1, 0.025);
      this.plane(this.label('posters', i % 8, slot.backlit), p.x, p.y, p.z + side * 0.01, slot.w, slot.h, slot.rotY);
      for (const dx of [-1, 1]) this.box('steelPainted', p.x + dx * (slot.w / 2 + 0.025), p.y, p.z + side * 0.03, 0.035, slot.h + 0.1, 0.04);
      for (const dy of [-1, 1]) this.box('steelPainted', p.x, p.y + dy * (slot.h / 2 + 0.025), p.z + side * 0.03, slot.w + 0.1, 0.035, 0.04);
    });
    for (let i = 0; i < 6; i++) this.plane(this.label('flyers', i % 3), -22.5 + i * 9, 1.45, -2.821, 0.21, 0.28);
  }
  hangingSigns() {
    for (const x of C.HANGING_SIGNS.xs) for (const z of C.HANGING_SIGNS.zs) {
      const group = new THREE.Group(); group.position.set(x, 3.1, z);
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.03), getMaterial('signBlack')));
      for (const side of [-1, 1]) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 0.38), this.label('signHanging', side < 0 ? 'B' : 'A'));
        mesh.position.z = side * 0.017; mesh.rotation.y = side < 0 ? Math.PI : 0; group.add(mesh);
      }
      this.group.add(group); this.signs.push(group);
      for (const dx of [-0.45, 0.45]) this.cylinder('steelGalv', x + dx, 3.55, z, 0.012, 0.5, 6);
      this.collider(x, 2.9, z, 1.2, 0.4, 0.04, 'sign-hanging', 'metal', C.MASK.BULLET);
    }
  }
  services() {
    for (const z of [-4.5, 4.5]) {
      const w = z < 0 ? 0.6 : 0.4, h = z < 0 ? 0.4 : 0.3;
      this.box('steelGalv', 0, 3.65, z, 60, h, w);
      this.collider(0, 3.65 - h / 2, z, 60, h, w, 'duct', 'metal', C.MASK.BULLET);
      for (let x = -30; x <= 30; x += 1.5) this.box('steelRust', x, 3.65, z, 0.035, h + 0.03, w + 0.03);
      for (let x = -27; x <= 27; x += 9) for (let i = 0; i < 10; i++) this.box('rubber', x - 0.25 + i * 0.05, 3.65 - h / 2 - 0.003, z, 0.022, 0.005, w * 0.8);
    }
    for (let i = 0; i < 3; i++) this.cylinder('steelGalv', 0, 3.88, -0.9 + i * 0.1, 0.035, 60, 8, Math.PI / 2);
    for (const z of [0.65, 1.15]) this.box('steelRust', 0, 3.8, z, 60, 0.12, 0.03);
    for (let x = -30; x <= 30; x += 0.5) this.box('steelRust', x, 3.75, 0.9, 0.025, 0.025, 0.5);
    for (let cable = 0; cable < 6; cable++) for (let x = -30; x < 30; x += 3) {
      const z = 0.71 + cable * 0.075;
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 3.81, z), new THREE.Vector3(x + 1.5, 3.77, z), new THREE.Vector3(x + 3, 3.81, z)]);
      this.add('rubber', new THREE.TubeGeometry(curve, 6, 0.018, 5, false));
    }
    this.cylinder('steelRust', 0, 3.7, 6, 0.09, 60, 10, Math.PI / 2);
    for (const z of [-2.5, 2.5]) {
      this.cylinder('steelGalv', 0, 3.9, z, 0.03, 60, 6, Math.PI / 2);
      for (let x = -27; x <= 27; x += 3) { this.cylinder('chrome', x, 3.82, z, 0.016, 0.15, 6); this.cylinder('chrome', x, 3.73, z, 0.038, 0.015, 8); }
    }
    for (const side of [-1, 1]) for (let i = 0; i < 8; i++) {
      const x = -28 + i * 8;
      this.box('steelPainted', x, 3.1, side * 8.86, 0.3, 0.4, 0.15);
      this.cylinder('steelGalv', x, 2.1, side * 8.83, 0.025, 1.6, 6);
    }
  }
  puddles() {
    const placements = [[-15, 0, -2.5], [-15, 0, 2.5], [15, 0, -2.5], [15, 0, 2.5], [6, 0, -1], [-18, -1.1, -6.65], [20, -1.1, 6.65], [46, 4.8, 0], [29, 0, 0], [-28, 0, 1]];
    const rng = this.G.rngBuild;
    for (const [x, y, z] of placements) {
      const shape = new THREE.Shape(), radius = rng.range(0.4, 1.1);
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6, r = radius * rng.range(0.7, 1); if (!i) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      shape.closePath();
      // A wet perimeter is a ring, not a second transparent polygon covering
      // the water. Merged transparent batches can otherwise composite the matte
      // edge material over the entire reflective surface as the camera moves.
      const contour = shape.getPoints(), rim = new THREE.Shape();
      contour.forEach((p, i) => i ? rim.lineTo(p.x * 1.04, p.y * 1.04) : rim.moveTo(p.x * 1.04, p.y * 1.04));
      rim.closePath();
      const hole = new THREE.Path();
      [...contour].reverse().forEach((p, i) => i ? hole.lineTo(p.x, p.y) : hole.moveTo(p.x, p.y));
      hole.closePath(); rim.holes.push(hole);
      this.add('puddleEdge', transformGeo(new THREE.ShapeGeometry(rim), x, y + 0.002, z, -Math.PI / 2));
      this.add('puddle', transformGeo(new THREE.ShapeGeometry(shape), x, y + 0.003, z, -Math.PI / 2));
    }
  }
  vending(x, y, z, yaw) {
    const parts = new Map();
    const box = (mat, px, py, pz, w, h, d) => {
      const material = typeof mat === 'string' ? getMaterial(mat) : mat;
      if (!parts.has(material)) parts.set(material, []);
      parts.get(material).push(transformGeo(makeBox(w, h, d), px, py, pz));
    };
    const face = (mat, px, py, pz, w, h) => {
      if (!parts.has(mat)) parts.set(mat, []);
      parts.get(mat).push(transformGeo(new THREE.PlaneGeometry(w, h), px, py, pz));
    };
    const red = this.vendingBodyMaterial ||= cloneMaterial('steelPainted', { color: 0xa82830 });
    box(red, 0, 0.925, 0, 0.95, 1.85, 0.8);
    box('rubber', 0, 0.06, 0, 0.91, 0.12, 0.75);
    box('rubber', -0.08, 1.12, 0.405, 0.63, 1.17, 0.02);
    face(this.label('vendingShelf', 0, true), -0.08, 1.12, 0.419, 0.57, 1.1);
    face(getMaterial('glassDirty'), -0.08, 1.12, 0.425, 0.58, 1.12);
    face(this.label('vendingFront'), 0.35, 1.02, 0.412, 0.15, 1.53);
    face(this.label('vendingDisplay', 0, true), -0.08, 1.77, 0.417, 0.62, 0.1);
    box('steelPainted', -0.08, 0.3, 0.42, 0.59, 0.23, 0.03);
    box('chrome', 0.35, 0.63, 0.425, 0.095, 0.025, 0.014);
    for (let i = 0; i < 6; i++) box('chrome', 0.35, 1.42 - i * 0.095, 0.425, 0.065, 0.04, 0.018);
    for (const [mat, geos] of parts) {
      const merged = mergeGeos(geos); merged.rotateY(yaw); merged.translate(x, y, z); this.add(mat, merged);
      for (const geo of geos) geo.dispose();
    }
    this.humSources.push(new THREE.Vector3(x, y + 0.9, z));
    const rotated = Math.abs(Math.sin(yaw)) > 0.5;
    this.collider(x, y, z, rotated ? 0.8 : 0.95, 1.85, rotated ? 0.95 : 0.8, 'vending');
  }
  mezzanineDressing() {
    const b = C.MEZZ_PROPS.booth;
    this.box('ironGreen', b.x, 5.15, b.z, b.w, 0.7, b.d);
    this.box('steelPainted', b.x, 7.17, b.z, b.w + 0.08, 0.08, b.d + 0.08);
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) this.box('ironGreen', b.x + dx * (b.w / 2 - 0.03), 6, b.z + dz * (b.d / 2 - 0.03), 0.06, 2.4, 0.06);
    for (const side of [-1, 1]) {
      this.plane('glassDirty', b.x, 6.3, b.z + side * b.d / 2, b.w - 0.1, 1.6, side < 0 ? Math.PI : 0);
      this.box('chrome', b.x, 5.6, b.z + side * b.d / 2, b.w, 0.06, 0.18);
    }
    this.box('wood', b.x, 5.65, b.z, 1.6, 0.07, 0.65);
    this.plane(this.label('signBoothClosed'), b.x, 6.05, b.z + b.d / 2 + 0.015, 0.75, 0.35);
    this.collider(b.x, 4.8, b.z, b.w, b.h, b.d, 'booth');
    this.collider(b.x, 5.7, b.z + b.d / 2, b.w, 1.4, 0.015, 'booth-glass', 'glass', C.MASK.BULLET);
    this.fan = new THREE.Group(); this.fan.position.set(b.x - 0.45, 6.08, b.z + 0.2);
    this.cylinder('steelPainted', b.x - 0.45, 5.87, b.z + 0.2, 0.018, 0.4, 6);
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.014), getMaterial('steelGalv'));
      blade.position.set(Math.sin(i * Math.PI * 2 / 3) * 0.08, Math.cos(i * Math.PI * 2 / 3) * 0.08, 0); blade.rotation.z = -i * Math.PI * 2 / 3;
      this.fan.add(blade);
    }
    this.group.add(this.fan);
    for (const p of C.MEZZ_PROPS.fareMachines) {
      this.box('steelPainted', p.x, 5.6, p.z, 0.6, 1.6, 0.6);
      this.plane(this.label('fareScreen', 0, true), p.x - 0.306, 5.98, p.z, 0.43, 0.4, -Math.PI / 2);
      this.box('chrome', p.x - 0.31, 5.48, p.z, 0.02, 0.04, 0.25);
      this.box('rubber', p.x - 0.315, 5.14, p.z, 0.015, 0.13, 0.38);
      this.collider(p.x, 4.8, p.z, 0.6, 1.6, 0.6, 'fare-machine');
    }
    for (let i = 0; i < 3; i++) this.payphone(36.4 + i * 0.6, 5.9, -5.84, 0);
    this.payphone(-4.5, 1.1, 2.82, Math.PI);
    for (const [x, z] of C.MEZZ_PROPS.stanchions) {
      this.cylinder('chrome', x, 4.83, z, 0.15, 0.06, 12);
      this.cylinder('chrome', x, 5.3, z, 0.026, 0.94, 8);
      this.cylinder('rubber', x, 5.77, z, 0.05, 0.08, 8);
      this.G.colliders.addStaticCyl(x, z, C.MEZZ_PROPS.stanchionR, 4.8, 5.8, 'stanchion', 'metal');
    }
    for (const z of [-1.2, -2.4]) this.box('rubber', 43.6, 5.72, z, 1.2, 0.08, 0.014);
    const [bx, bz] = C.MEZZ_PROPS.mopBucket;
    this.cylinder('plastic', bx, 5.01, bz, 0.2, 0.4, 12);
    this.cylinder('rubber', bx, 5.21, bz, 0.17, 0.005, 12);
    this.cylinder('wood', bx + 0.08, 5.64, bz, 0.012, 1.2, 6);
    this.G.colliders.addStaticCyl(bx, bz, 0.2, 4.8, 5.25, 'bucket', 'plastic');
    const [mx, mz] = C.MEZZ_PROPS.manhole;
    this.cylinder('steelRust', mx, 4.803, mz, 0.35, 0.006, 24);
    for (let i = -3; i <= 3; i++) this.box('steelPainted', mx, 4.81, mz + i * 0.065, 0.5, 0.006, 0.016);
    for (const [x, y, z, fallen] of [[15, 0, 2.5, false], [47, 4.8, 4, true]]) {
      for (const side of [-1, 1]) {
        const geo = new THREE.PlaneGeometry(0.3, 0.6);
        this.add(this.label('signWetFloor'), transformGeo(geo, x, y + (fallen ? 0.08 : 0.3), z + side * 0.06, fallen ? -Math.PI / 2 : side * 0.22, side < 0 ? Math.PI : 0));
      }
      this.collider(x, y, z, 0.3, fallen ? 0.15 : 0.6, 0.2, 'wet-floor', 'plastic', C.MASK.BULLET);
    }
  }
  payphone(x, y, z, yaw) {
    this.box('steelGalv', x, y + 0.45, z, 0.42, 0.9, 0.24);
    const front = z + Math.cos(yaw) * 0.126;
    this.plane(this.label('payphoneKeypad'), x + 0.04, y + 0.4, front, 0.2, 0.25, yaw);
    this.box('rubber', x - 0.12, y + 0.55, front, 0.065, 0.32, 0.06);
    this.box('chrome', x + 0.05, y + 0.77, front, 0.2, 0.025, 0.01);
    const points = [];
    for (let i = 0; i < 25; i++) points.push(new THREE.Vector3(x - 0.12 + Math.sin(i * 2) * 0.018, y + 0.38 - i * 0.01, front + 0.02));
    this.add('rubber', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, 0.007, 4, false));
    this.collider(x, y, z, 0.42, 0.9, 0.3, 'payphone', 'metal', C.MASK.BULLET);
  }
  getHumSources() { return this.humSources; }
  update(dt) {
    if (this.fan) this.fan.rotation.z += dt * 12;
    for (let i = 0; i < this.signs.length; i++) this.signs[i].rotation.z = Math.sin(this.G.time * Math.PI * 2 / 3 + i) * Math.PI / 360;
    this.dripT -= dt;
    if (this.dripT <= 0) { this.dripT = this.G.rng.range(4, 12); if (this.G.particles?.smoke) this.G.particles.smoke(this.dripPos, this.dripDir, { count: 1, size: 0.025, sizeEnd: 0.035, life: 0.9, alpha: 0.6 }); }
  }
  reset() { this.dripT = 7; for (const sign of this.signs) sign.rotation.z = 0; }
  dispose() { this.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); this.G.scene.remove(this.group); }
}
