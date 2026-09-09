import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getMaterial, cloneMaterial } from './materials.js';
import { transformGeo, mergeGeos, clamp, smoothstep, degToRad } from './utils.js';
import { LAYERS, VIEWMODEL } from './constants.js';

// Rigid binding batches independently animated parts by physical material.
// At most six material groups retain polymer, wood, skin and luminous sights.
export function buildViewmodel(id) {
  const group = new THREE.Group(), parts = {}, bones = [], geometry = Array.from({ length: 6 }, () => []);
  group.name = `viewmodel:${id}`;
  const materials = ['gunmetal', 'skinHands', 'polymer', 'gunWood', 'sightGlow', 'brass'].map(name => cloneMaterial(name, { vertexColors: true }));
  // DESIGN NOTE: finite near-field illumination on the viewmodel avoids the
  // singular point-source hotspot at the muzzle. World lighting, all shared
  // light intensities and the four-tick envelope remain unchanged. A 0.5 m
  // minimum shading distance keeps the gun lit without bleaching the hands.
  for (const material of materials) {
    material.onBeforeCompile = shader => {
      const lights = THREE.ShaderChunk.lights_pars_begin.replace(
        'getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay )',
        'getDistanceAttenuation( max(lightDistance, 0.5), pointLight.distance, pointLight.decay )');
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_pars_begin>', lights);
    };
    material.customProgramCacheKey = () => 'viewmodel-finite-point-v1';
  }
  const bone = name => { const b = new THREE.Bone(); b.name = name; parts[name] = b; bones.push(b); return b; };
  for (const name of ['frame', 'slide', 'bolt', 'charging', 'foreend', 'mag', 'hammer', 'trigger', 'handL', 'handR', 'shell']) bone(name);
  function add(name, geo, color = 0x999999, skin = false) {
    if (geo.index) { const indexed = geo; geo = indexed.toNonIndexed(); indexed.dispose(); }
    const index = bones.indexOf(parts[name]), n = geo.attributes.position.count;
    const bucket = skin ? 1 : color === 0xa87847 ? 3 : [0xb0db70, 0xff7e32].includes(color) ? 4 : color === 0xd0aa52 ? 5 : [0x303238, 0x3d473f, 0x050505, 0x070707, 0x111111].includes(color) ? 2 : 0;
    const tint = bucket === 3 || bucket === 1 || bucket === 4 || bucket === 5 || color === 0x303238 ? 0xffffff : color;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), colors = new Float32Array(n * 3), c = new THREE.Color(tint);
    for (let i = 0; i < n; i++) { si[i * 4] = index; sw[i * 4] = 1; colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry[bucket].push(geo);
  }
  const box = (name, x, y, z, w, h, d, color = 0x999999, rx = 0) => add(name, transformGeo(new RoundedBoxGeometry(w, h, d, 1, Math.min(w, h, d) * 0.12), x, y, z, rx), color);
  const tube = (name, x, y, z, r, len, color = 0x999999) => add(name, transformGeo(new THREE.CylinderGeometry(r, r, len, 10), x, y, z, Math.PI / 2), color);
  const dark = 0x303238, steel = 0xb4bbc0, wood = 0xa87847;
  if (id === 'pistol') {
    box('frame', 0, 0, 0, 0.03, 0.035, 0.19, dark);
    box('frame', 0, -0.065, 0.055, 0.032, 0.11, 0.055, dark, degToRad(18));
    box('slide', 0, 0.031, 0, 0.032, 0.03, 0.19, steel);
    box('slide', 0.0165, 0.032, -0.02, 0.001, 0.018, 0.029, 0x111111);
    for (let i = 0; i < 8; i++) for (const side of [-1, 1]) box('slide', side * 0.0165, 0.032, 0.05 + i * 0.004, 0.001, 0.024, 0.001, dark);
    box('slide', 0, 0.052, 0.075, 0.029, 0.014, 0.007, dark);
    box('slide', 0, 0.05, -0.075, 0.006, 0.01, 0.006, 0xb0db70);
    tube('frame', 0, 0.02, -0.098, 0.006, 0.026, steel);
    tube('frame', 0, 0.02, -0.112, 0.004, 0.001, 0x050505);
    box('mag', 0, -0.125, 0.069, 0.038, 0.01, 0.057, dark);
    box('hammer', 0, 0.026, 0.104, 0.013, 0.024, 0.014, steel);
  } else {
    const shotgun = id === 'shotgun';
    box('frame', 0, 0.02, -0.08, shotgun ? 0.045 : 0.06, shotgun ? 0.055 : 0.07, shotgun ? 0.2 : 0.25, steel);
    tube('frame', 0, 0.04, shotgun ? -0.37 : -0.33, shotgun ? 0.012 : 0.009, shotgun ? 0.5 : 0.3, steel);
    tube('frame', 0, 0.04, shotgun ? -0.622 : -0.482, 0.008, 0.002, 0x070707);
    box('frame', 0, -0.019, 0.07, 0.046, 0.065, 0.16, shotgun ? wood : dark);
    box('frame', 0, -0.035, 0.14, 0.055, 0.085, 0.025, dark);
    box('frame', 0, -0.055, -0.01, 0.033, 0.1, 0.045, dark, 0.25);
    box('bolt', 0.031, 0.035, -0.1, 0.006, 0.022, 0.07, steel);
    if (shotgun) {
      tube('frame', 0, 0.012, -0.35, 0.011, 0.44, steel);
      box('foreend', 0, 0.006, -0.3, 0.057, 0.052, 0.16, wood);
      for (let i = 0; i < 12; i++) box('foreend', 0, 0.006, -0.37 + i * 0.013, 0.06, 0.055, 0.003, dark);
      for (let i = 0; i < 4; i++) tube('frame', -0.03, 0.025, -0.045 - i * 0.024, 0.008, 0.04, 0x8f3028);
      tube('shell', 0.02, -0.035, -0.09, 0.009, 0.055, 0xb52a20);
      tube('frame', 0, 0.054, -0.59, 0.003, 0.005, 0xd0aa52);
    } else {
      box('frame', 0, 0.017, -0.245, 0.045, 0.058, 0.18, dark);
      for (let i = 0; i < 12; i++) box('frame', 0, 0.05, -0.32 + i * 0.014, 0.052, 0.007, 0.006, steel);
      for (let i = 0; i < 3; i++) box('mag', 0, -0.045 - i * 0.04, -0.105 + i * 0.006, 0.035, 0.045, 0.065, dark, i * 0.07);
      box('charging', 0, 0.06, 0.024, 0.07, 0.013, 0.012, dark);
      tube('frame', 0, 0.087, -0.065, 0.022, 0.045, dark);
      tube('frame', 0, 0.087, -0.041, 0.015, 0.001, 0x304948);
      box('frame', 0, 0.087, -0.039, 0.002, 0.002, 0.001, 0xff7e32);
      for (const z of [-0.43, 0.008]) box('frame', 0, 0.065, z, 0.01, 0.03, 0.012, dark);
      for (let i = 0; i < 5; i++) tube('frame', 0, 0.04, -0.46 + i * 0.006, 0.012, 0.003, dark);
    }
  }
  box('trigger', 0, -0.034, id === 'pistol' ? 0.008 : -0.035, 0.007, 0.023, 0.006, steel, 0.3);
  const guard = new THREE.TorusGeometry(0.024, 0.003, 5, 12, Math.PI * 1.5); guard.rotateY(Math.PI / 2);
  add('frame', transformGeo(guard, 0, -0.035, id === 'pistol' ? 0.008 : -0.035), dark);
  for (const side of ['handL', 'handR']) {
    const left = side === 'handL', z = left ? id === 'pistol' ? 0.024 : -0.28 : 0.057, x = left ? -0.018 : 0.014;
    add(side, transformGeo(new RoundedBoxGeometry(0.055, 0.033, 0.09, 1, 0.009), x, -0.063, z), 0xffffff, true);
    for (let i = 0; i < 4; i++) {
      const fz = z - 0.034 + i * 0.017, reach = 0.024 - Math.abs(i - 1) * 0.002;
      const points = [new THREE.Vector3(x - 0.022, -0.057, fz), new THREE.Vector3(x - 0.03, -0.04, fz), new THREE.Vector3(x - 0.018, -0.023, fz), new THREE.Vector3(x + reach, -0.024, fz), new THREE.Vector3(x + reach + 0.003, -0.037, fz)];
      add(side, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 9, i === 3 ? 0.006 : 0.007, 6, false), 0xffffff, true);
      add(side, transformGeo(new THREE.SphereGeometry(0.0075, 6, 4), x - 0.025, -0.035, fz), 0xffffff, true);
    }
    const thumb = [new THREE.Vector3(x + 0.023, -0.062, z + 0.025), new THREE.Vector3(x + 0.034, -0.042, z + 0.015), new THREE.Vector3(x + 0.024, -0.025, z - 0.006)];
    add(side, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(thumb), 8, 0.009, 6, false), 0xffffff, true);
    box(side, x, -0.086, z + 0.065, 0.06, 0.045, 0.085, 0x3d473f);
  }
  const usedMaterials = [], chunks = [];
  geometry.forEach((list, i) => { if (list.length) { chunks.push(mergeGeos(list)); usedMaterials.push(materials[i]); } });
  const merged = mergeGeos(chunks, true), mesh = new THREE.SkinnedMesh(merged, usedMaterials);
  for (const b of bones) mesh.add(b);
  mesh.bind(new THREE.Skeleton(bones)); mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.layers.set(LAYERS.VIEWMODEL); group.add(mesh);
  for (const list of geometry) for (const geo of list) geo.dispose(); for (const geo of chunks) geo.dispose();
  const muzzle = new THREE.Object3D(), ejectPort = new THREE.Object3D();
  muzzle.position.fromArray(id === 'pistol' ? [0, 0.02, -0.11] : id === 'rifle' ? [0, 0.045, -0.48] : [0, 0.04, -0.62]);
  ejectPort.position.fromArray(id === 'pistol' ? [0.012, 0.03, -0.02] : [0.02, 0.04, -0.1]); group.add(muzzle, ejectPort);
  const rest = { pos: id === 'pistol' ? [0.17, -0.15, -0.30] : id === 'rifle' ? [0.13, -0.14, -0.34] : [0.12, -0.15, -0.38], rot: [0, id === 'shotgun' ? 0.05 : 0.04, 0] };
  const vm = { group, parts, muzzle, ejectPort, rest, ads: { pos: [0, -0.085, -0.28], rot: [0, 0, 0] }, sprint: { pos: [rest.pos[0] - 0.03, rest.pos[1] - 0.05, rest.pos[2] + 0.02], rot: [-0.2, rest.rot[1], 0.15] }, lowered: { pos: [rest.pos[0], rest.pos[1] - 0.25, rest.pos[2]], rot: [-degToRad(35), rest.rot[1], 0] }, drawCalls: usedMaterials.length, mesh, locked: false };
  resetPose(vm); return vm;
}
export function resetPose(vm) {
  for (const part of Object.values(vm.parts)) { part.position.setScalar(0); part.rotation.set(0, 0, 0); part.scale.setScalar(1); }
  vm.parts.shell.scale.setScalar(0); vm.group.position.fromArray(vm.rest.pos); vm.group.rotation.set(vm.rest.rot[0], vm.rest.rot[1], vm.rest.rot[2]); vm.group.scale.setScalar(VIEWMODEL.scale);
  if (vm.locked) vm.parts.slide.position.z = 0.04;
}
export function setSlideLocked(vm, locked) { vm.locked = locked; vm.parts.slide.position.z = locked ? 0.04 : 0; }
export function poseFire(vm, id, t) {
  const kick = Math.sin(clamp(t, 0, 1) * Math.PI);
  vm.parts[id === 'pistol' ? 'slide' : 'bolt'].position.z = vm.locked ? 0.04 : 0.04 * kick;
  vm.parts.hammer.rotation.x = -0.5 * kick; vm.parts.trigger.rotation.x = -0.18 * kick;
}
export function poseReload(vm, id, t, empty) {
  const tilt = smoothstep(0, 0.2, t) * (1 - smoothstep(0.85, 1, t));
  vm.group.rotation.z = degToRad(id === 'pistol' ? -25 : 20) * tilt;
  vm.group.rotation.x = -degToRad(10) * tilt; vm.group.position.y -= 0.03 * tilt;
  vm.parts.mag.position.y = -0.15 * (smoothstep(0.2, 0.3, t) - smoothstep(0.75, 0.85, t));
  vm.parts.mag.scale.setScalar(t > 0.3 && t < 0.7 ? 0 : 1);
  vm.parts.handL.position.y = -0.24 * Math.sin(Math.PI * clamp((t - 0.2) / 0.6, 0, 1));
  if (empty) vm.parts[id === 'pistol' ? 'slide' : 'charging'].position.z = 0.06 * Math.sin(Math.PI * clamp((t - 0.85) / 0.12, 0, 1));
}
export function poseShotgunReload(vm, phase, t) {
  vm.group.rotation.z = degToRad(30) * (phase === 'start' ? t : phase === 'end' ? 1 - t : 1);
  if (phase === 'shell') { vm.parts.shell.scale.setScalar(t < 0.65 ? 1 : 0); vm.parts.shell.position.y = -0.15 * (1 - smoothstep(0, 0.6, t)); vm.parts.handL.position.y = vm.parts.shell.position.y; }
}
export function posePump(vm, t) {
  const stroke = smoothstep(0.1, 0.3, t) * (1 - smoothstep(0.45, 0.65, t));
  vm.parts.foreend.position.z = vm.parts.handL.position.z = 0.085 * stroke;
  vm.group.position.y -= 0.01 * stroke; vm.group.rotation.z += degToRad(3) * stroke;
}
export function poseSwitch(vm, t, lowering) {
  const a = lowering ? t ** 3 : (1 - t) ** 3;
  vm.group.position.y -= 0.25 * a; vm.group.rotation.x -= degToRad(35) * a;
}
