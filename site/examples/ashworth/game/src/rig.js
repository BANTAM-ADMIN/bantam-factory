import * as THREE from 'three';
import { ENEMY, ENEMY_TYPES } from './constants.js';
import { cloneMaterial } from './materials.js';
import { mergeGeos, transformGeo, clamp } from './utils.js';

// DESIGN NOTE: The model faces +Z; the owner applies yaw+PI per §5.2.
// Foot capsules follow the visible +Z toes, correcting the stale -Z capsule endpoint.
const hierarchy = [
  ['pelvis', null, 0, 0.96, 0], ['spine', 'pelvis', 0, 0.14, 0], ['chest', 'spine', 0, 0.20, 0],
  ['neck', 'chest', 0, 0.26, 0], ['head', 'neck', 0, 0.10, 0],
  ['shoulderL', 'chest', -0.24, 0.20, 0], ['upperArmL', 'shoulderL', 0, 0, 0], ['lowerArmL', 'upperArmL', 0, -0.30, 0], ['handL', 'lowerArmL', 0, -0.28, 0],
  ['shoulderR', 'chest', 0.24, 0.20, 0], ['upperArmR', 'shoulderR', 0, 0, 0], ['lowerArmR', 'upperArmR', 0, -0.30, 0], ['handR', 'lowerArmR', 0, -0.28, 0],
  ['hipL', 'pelvis', -0.11, -0.04, 0], ['upperLegL', 'hipL', 0, 0, 0], ['lowerLegL', 'upperLegL', 0, -0.44, 0], ['footL', 'lowerLegL', 0, -0.42, 0],
  ['hipR', 'pelvis', 0.11, -0.04, 0], ['upperLegR', 'hipR', 0, 0, 0], ['lowerLegR', 'upperLegR', 0, -0.44, 0], ['footR', 'lowerLegR', 0, -0.42, 0],
];
export const BONE_NAMES = hierarchy.map(r => r[0]);
export const PART_NAMES = ['head', 'neck', 'chest', 'spine', 'pelvis', 'upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR', 'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR'];
export const PART_GROUP = Object.fromEntries(PART_NAMES.map(name => [name, name === 'head' || name === 'neck' ? 'head' : ['chest', 'spine', 'pelvis'].includes(name) ? 'torso' : /Arm|hand/.test(name) ? 'arm' : 'leg']));
const capsuleData = {
  head: [[0, 0.02, 0], [0, 0.21, 0], 0.125], neck: [[0, 0, 0], [0, 0.1, 0], 0.07], chest: [[0, 0.02, 0], [0, 0.24, 0], 0.20],
  spine: [[0, 0.02, 0], [0, 0.14, 0], 0.16], pelvis: [[-0.12, 0.02, 0], [0.12, 0.02, 0], 0.14],
  upperArm: [[0, 0, 0], [0, -0.30, 0], 0.07], lowerArm: [[0, 0, 0], [0, -0.28, 0], 0.06], hand: [[0, 0, 0], [0, -0.16, 0], 0.05],
  upperLeg: [[0, 0, 0], [0, -0.44, 0], 0.095], lowerLeg: [[0, 0, 0], [0, -0.42, 0], 0.075], foot: [[0, 0, 0], [0, 0, 0.20], 0.06],
};
export const HIT_CAPSULES = Object.fromEntries(PART_NAMES.map(name => { const r = capsuleData[name.replace(/[LR]$/, '')]; return [name, { bone: name, a: r[0], b: r[1], r: r[2] }]; }));
const indices = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
const cache = new Map();
export function createSkeleton(type, scaleParams = {}) {
  const byName = {}, bones = [];
  for (const [name, parent, x, y, z] of hierarchy) {
    const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); b.userData.rest = b.position.clone();
    byName[name] = b; bones.push(b); if (parent) byName[parent].add(b);
  }
  byName.pelvis.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones); skeleton.calculateInverses();
  applyScaleParams(byName, scaleParams);
  return { bones, byName, root: byName.pelvis, skeleton };
}
export function applyScaleParams(byName, { legScale = 1, torsoW = 1, headScale = 1, bodyScale = 1 } = {}) {
  for (const name of BONE_NAMES) { const b = byName[name]; b.position.copy(b.userData.rest); b.scale.setScalar(1); }
  byName.pelvis.position.y = 0.96 * legScale;
  byName.chest.scale.x = torsoW; byName.head.scale.setScalar(headScale);
  for (const side of ['L', 'R']) {
    byName[`shoulder${side}`].scale.x = 1 / torsoW;
    byName[`upperLeg${side}`].scale.y = legScale;
    byName[`lowerLeg${side}`].scale.y = 1;
  }
  byName.pelvis.userData.legScale = legScale; byName.pelvis.userData.bodyScale = bodyScale;
}
export function buildRigGeometry(type, variant) {
  const key = `${type}:${variant}`; if (cache.has(key)) return cache.get(key);
  const sk = createSkeleton(type), body = [], glow = [], brute = type === 'brute';
  sk.root.updateMatrixWorld(true);
  function add(part, geo, quadrant = 'skin', luminous = false, swatch = -1, jaw = false) {
    if (geo.index) { const old = geo; geo = old.toNonIndexed(); old.dispose(); }
    const n = geo.attributes.position.count, uv = geo.attributes.uv, positions = geo.attributes.position;
    const weights = new Float32Array(n * 4), bones = new Uint16Array(n * 4), ids = new Uint8Array(n), colors = new Float32Array(n * 3);
    const qx = quadrant === 'skin' || quadrant === 'bottom' ? 0.5 : 0, qy = quadrant === 'face' || quadrant === 'skin' ? 0.5 : 0;
    for (let i = 0; i < n; i++) {
      bones[i * 4] = indices[part]; weights[i * 4] = 1; ids[i] = PART_NAMES.indexOf(part);
      let u = uv.getX(i), v = uv.getY(i);
      if (quadrant === 'face') { u = 0.5 + Math.atan2(positions.getX(i), positions.getZ(i)) / (Math.PI * 2); v = clamp((positions.getY(i) + 0.057) / 0.335, 0.01, 0.99); }
      if (swatch >= 0) { u = (swatch + 0.5) / 8; v = 0.93; }
      if (/foot/.test(part)) v = 0.84 + v * 0.14;
      // Sphere pole UV offsets may extend beyond [0,1]; keep every primitive inside its atlas quadrant with a one-pixel gutter.
      uv.setXY(i, qx + clamp(u, 1 / 512, 511 / 512) * 0.5, qy + clamp(v, 1 / 512, 511 / 512) * 0.5);
      const ao = /hand|foot/.test(part) ? 0.8 : part === 'neck' ? 0.55 : 0.9;
      const bruise = 0.94 + 0.06 * Math.sin(positions.getX(i) * 47 + positions.getY(i) * 23 + positions.getZ(i) * 61);
      colors.fill(luminous ? 1 : ao * bruise, i * 3, i * 3 + 3);
    }
    geo.applyMatrix4(sk.byName[part].matrixWorld);
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(bones, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    geo.setAttribute('partId', new THREE.Uint8BufferAttribute(ids, 1)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('jawMask', new THREE.Uint8BufferAttribute(new Uint8Array(n).fill(jaw ? 1 : 0), 1));
    (luminous ? glow : body).push(geo);
  }
  const box = (part, x, y, z, w, h, d, q = 'top', swatch = -1) => add(part, transformGeo(new THREE.BoxGeometry(w, h, d), x, y, z), q, false, swatch);
  const cap = (part, x, y, z, r, len, q) => add(part, transformGeo(new THREE.CapsuleGeometry(r, len, 4, 10), x, y, z), q);
  box('pelvis', 0, 0.02, 0, 0.34, 0.24, 0.22, 'bottom'); cap('spine', 0, 0.08, 0, 0.15, 0.1, 'top');
  const chest = new THREE.BoxGeometry(0.42, 0.30, 0.26, 2, 2, 2); for (let i = 0; i < chest.attributes.position.count; i++) if (chest.attributes.position.getY(i) > 0) chest.attributes.position.setX(i, chest.attributes.position.getX(i) * 0.92);
  add('chest', transformGeo(chest, 0, 0.12, 0), 'top'); cap('neck', 0, 0.05, 0, 0.06, 0.08, 'skin');
  const head = new THREE.CapsuleGeometry(0.115, 0.06, 6, 12); head.scale(1, 1.15, 1); head.translate(0, 0.11, 0); add('head', head, 'face');
  add('head', transformGeo(new THREE.BoxGeometry(0.09, 0.05, 0.08), 0, 0.007, 0.076), 'skin', false, -1, true);
  for (const x of [-0.046, 0.046]) add('head', transformGeo(new THREE.SphereGeometry(0.016, 6, 4), x, 0.127, 0.109), 'skin', true);
  for (const side of ['L', 'R']) {
    cap(`upperArm${side}`, 0, -0.15, 0, brute ? 0.085 : 0.06, 0.28, 'top');
    cap(`lowerArm${side}`, 0, -0.14, 0, brute ? 0.075 : 0.05, 0.26, 'skin');
    box(`hand${side}`, 0, -0.08, 0, 0.08, 0.16, 0.04, 'skin');
    for (const x of [-0.025, 0.025]) cap(`hand${side}`, x, -0.17, 0.012, 0.012, 0.05, 'skin');
    cap(`upperLeg${side}`, 0, -0.22, 0, 0.085, 0.40, 'bottom'); cap(`lowerLeg${side}`, 0, -0.22, 0, 0.065, 0.40, 'bottom');
    box(`foot${side}`, 0, -0.01, 0.07, 0.10, 0.06, 0.26, 'bottom');
  }
  box('pelvis', 0, 0.10, 0, 0.36, 0.035, 0.235, 'top', 0); box('pelvis', 0, 0.10, 0.124, 0.055, 0.043, 0.01, 'top', 1);
  if (variant === 'commuter') {
    box('chest', 0, 0.12, 0.14, 0.035, 0.27, 0.015, 'top', 2);
    const strap = new THREE.BoxGeometry(0.035, 0.46, 0.018); strap.rotateZ(0.65); add('chest', transformGeo(strap, 0, 0.10, 0.146), 'top', false, 0);
    box('pelvis', -0.22, -0.03, 0, 0.12, 0.23, 0.18, 'top', 5);
    box('pelvis', -0.225, 0.045, 0.098, 0.135, 0.09, 0.02, 'top', 2);
    for (const x of [-0.265, -0.185]) box('pelvis', x, -0.018, 0.11, 0.012, 0.035, 0.008, 'top', 1);
  } else if (variant === 'worker') {
    for (const x of [-0.12, 0.12]) box('chest', x, 0.13, 0.143, 0.12, 0.29, 0.02, 'top', 3);
    for (const y of [0.04, 0.21]) add('chest', transformGeo(new THREE.BoxGeometry(0.4, 0.03, 0.014), 0, y, 0.158), 'top', true);
    add('head', transformGeo(new THREE.SphereGeometry(0.132, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.18, 0), 'top', false, 3);
    add('head', transformGeo(new THREE.CylinderGeometry(0.154, 0.154, 0.014, 12), 0, 0.184, 0.014), 'top', false, 3);
    box('head', 0, 0.295, 0, 0.019, 0.025, 0.12, 'top', 3);
  } else if (variant === 'nurse') {
    for (const x of [-0.145, 0.145]) box('chest', x, -0.01, 0.145, 0.12, 0.43, 0.025, 'top', 4);
    box('head', 0, 0.255, 0.025, 0.20, 0.07, 0.14, 'top', 4);
    box('head', 0, 0.265, 0.098, 0.042, 0.011, 0.004, 'top', 6);
    box('head', 0, 0.265, 0.101, 0.011, 0.042, 0.004, 'top', 6);
    box('chest', -0.14, 0.20, 0.162, 0.045, 0.012, 0.004, 'top', 6); box('chest', -0.14, 0.20, 0.165, 0.012, 0.045, 0.004, 'top', 6);
    add('chest', transformGeo(new THREE.TorusGeometry(0.07, 0.007, 4, 12, Math.PI), 0, 0.17, 0.155, 0, 0, Math.PI), 'top', false, 0);
  } else if (variant === 'hoodie') {
    add('head', transformGeo(new THREE.SphereGeometry(0.148, 12, 8, Math.PI, Math.PI, 0, Math.PI), 0, 0.12, -0.015), 'top');
    box('chest', 0, 0.06, -0.22, 0.30, 0.42, 0.18, 'top', 0);
    for (const x of [-0.17, 0.17]) box('chest', x, 0.12, 0.148, 0.035, 0.35, 0.02, 'top', 0);
    for (const x of [-0.045, 0.045]) box('chest', x, 0.19, 0.15, 0.007, 0.15, 0.007, 'top', 4);
  } else if (variant === 'brute') {
    for (const x of [-0.24, 0.24]) box('chest', x, 0.26, 0, 0.19, 0.17, 0.30, 'skin');
    box('head', 0, 0.18, 0.103, 0.21, 0.035, 0.04, 'skin');
    for (const x of [-0.045, 0.045]) add('head', transformGeo(new THREE.ConeGeometry(0.018, 0.09, 6), x, 0.018, 0.137), 'top', false, 4);
    cap('lowerArmL', 0, -0.14, 0.06, 0.03, 0.20, 'skin');
    for (let i = 0; i < 5; i++) box('chest', 0, 0.02 + i * 0.04, 0.139, 0.31 - i * 0.015, 0.014, 0.018, 'top', 0);
  }
  const a = mergeGeos(body), b = mergeGeos(glow), geo = mergeGeos([a, b], true);
  // One shared jaw morph rotates the rigid mandible about its head-local hinge.
  // It keeps the contractual 21 bones, 17 hit parts and two draw groups intact.
  const jawPositions = new Float32Array(geo.attributes.position.array.length);
  const jawNormals = new Float32Array(geo.attributes.normal.array.length);
  const hinge = new THREE.Vector3(0, 0.032, 0.036).applyMatrix4(sk.byName.head.matrixWorld);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.55), v = new THREE.Vector3();
  for (let i = 0; i < geo.attributes.position.count; i++) if (geo.attributes.jawMask.getX(i)) {
    v.fromBufferAttribute(geo.attributes.position, i).sub(hinge).applyQuaternion(rotation).add(hinge);
    jawPositions[i * 3] = v.x - geo.attributes.position.getX(i);
    jawPositions[i * 3 + 1] = v.y - geo.attributes.position.getY(i);
    jawPositions[i * 3 + 2] = v.z - geo.attributes.position.getZ(i);
    v.fromBufferAttribute(geo.attributes.normal, i).applyQuaternion(rotation);
    jawNormals[i * 3] = v.x - geo.attributes.normal.getX(i);
    jawNormals[i * 3 + 1] = v.y - geo.attributes.normal.getY(i);
    jawNormals[i * 3 + 2] = v.z - geo.attributes.normal.getZ(i);
  }
  geo.morphTargetsRelative = true;
  geo.morphAttributes.position = [new THREE.Float32BufferAttribute(jawPositions, 3)];
  geo.morphAttributes.position[0].name = 'jaw';
  geo.morphAttributes.normal = [new THREE.Float32BufferAttribute(jawNormals, 3)];
  geo.computeBoundingSphere(); geo.boundingSphere.radius = Math.max(geo.boundingSphere.radius, ENEMY.boundingR);
  for (const g of body) g.dispose(); for (const g of glow) g.dispose(); a.dispose(); b.dispose(); sk.skeleton.dispose();
  cache.set(key, geo); return geo;
}
export function makeVariantMaterial(variant) { return cloneMaterial(`enemy-${variant}`); }
export class PoseBuffer {
  constructor() { this.data = new Float32Array(63); this.extras = { pelvisY: 0, rootTiltX: 0, rootTwistY: 0, rootY: 0, rootZ: 0, jaw: 0 }; }
  reset() { this.data.fill(0); for (const k in this.extras) this.extras[k] = 0; }
}
function joint(p, name, x = 0, y = 0, z = 0) { const i = indices[name] * 3; p.data[i] = x; p.data[i + 1] = y; p.data[i + 2] = z; }
function idle(p, extras, c) {
  p.reset(); const t = c.time || 0, phase = c.phase || 0;
  joint(p, 'chest', 0.02 * Math.sin(t * 2.2 + phase)); joint(p, 'pelvis', 0, 0, 0.03 * Math.sin(t * 1.26 + phase));
  joint(p, 'head', -0.08, 0.08 * Math.sin(t * 0.6 + phase), c.type === 'shambler' ? 0.1 : 0);
  for (const side of ['L', 'R']) { joint(p, `upperArm${side}`, -0.2 + 0.03 * Math.sin(t * 2.2), 0, side === 'L' ? -0.12 : 0.12); joint(p, `lowerArm${side}`, -0.3); joint(p, `hand${side}`, 0.1); }
}
function walk(p, extras, c) {
  idle(p, extras, c); const phase = c.phase || 0, type = c.type || 'shambler', runner = type === 'runner', brute = type === 'brute';
  const a = clamp(c.speedRatio ?? 1, 0.35, 1), l = Math.sin(phase), bob = (1 - Math.cos(2 * phase)) / 2;
  p.extras.pelvisY = -(runner ? 0.05 : brute ? 0.04 : 0.02) * bob;
  joint(p, 'pelvis', 0, (runner ? 0.12 : 0.05) * l, (runner ? 0.04 : 0.10) * l);
  joint(p, 'spine', ENEMY_TYPES[type].lean + 0.03 * bob, 0, 0.04 * Math.sin((c.time || 0) * 3.1 + phase));
  joint(p, 'chest', 0, -(runner ? 0.16 : 0.06) * l);
  joint(p, 'head', runner ? -0.1 : brute ? 0.1 : -0.25 + 0.1 * Math.sin(phase * 0.7), 0.15 * Math.sin(phase * 0.43), type === 'shambler' ? 0.15 : 0);
  for (let i = 0; i < 2; i++) {
    const side = i ? 'R' : 'L', s = Math.sin(phase + i * Math.PI), knee = Math.max(0, Math.sin(phase + i * Math.PI + 0.6)), limp = type === 'shambler' && c.limpSide === i;
    const upper = (runner ? 0.95 : brute ? 0.5 : 0.45) * a * s * (limp ? 0.55 : 1) + (limp ? 0.25 : 0);
    joint(p, `upperLeg${side}`, upper); joint(p, `lowerLeg${side}`, (runner ? 1.25 : brute ? 0.65 : limp ? 0.35 : 0.75) * knee); joint(p, `foot${side}`, -upper * (runner ? 0.3 : 0.2));
    joint(p, `upperArm${side}`, runner ? -0.5 - 0.9 * s : brute ? -0.15 - 0.35 * s : -1.35 + 0.08 * s, 0, (i ? 1 : -1) * (brute ? 0.5 : 0.2));
    joint(p, `lowerArm${side}`, runner ? -1.2 : brute ? -0.5 : -0.3 + 0.1 * Math.sin(phase * 1.3));
  }
}
function attack(p, extras, c) {
  idle(p, extras, c); const wind = c.attackPhase === 'windup', brute = c.type === 'brute', recover = c.attackPhase === 'recover';
  const strength = recover ? clamp(c.attackWeight ?? 0.5, 0, 1) : 1;
  joint(p, 'spine', (wind ? brute ? -0.25 : -0.1 : brute ? 0.5 : 0.35) * strength);
  for (const side of ['L', 'R']) if (c.type !== 'runner' || side === (c.attackSide ? 'L' : 'R')) { joint(p, `upperArm${side}`, (wind ? brute ? -2.6 : -2 : -0.6) * strength, 0, side === 'L' ? -0.3 : 0.3); joint(p, `lowerArm${side}`, wind ? -0.3 : -0.9); }
  p.extras.jaw = wind ? 0.3 : 0.15;
}
function death(p, extras, c) {
  idle(p, extras, c); const t = clamp(c.deathProgress || 0, 0, 1), crumple = c.deathKind === 'crumple';
  p.extras.rootY = crumple ? -0.65 * t : 0;
  p.extras.rootTiltX = crumple ? 0.35 * t : (c.deathKind === 'back' ? -1 : 1) * Math.PI * 0.5 * t;
  p.extras.rootZ = crumple ? (c.deathSide || 1) * 1.4 * t : 0;
  for (const side of ['L', 'R']) { joint(p, `upperLeg${side}`, (crumple ? 1.2 : 0.3) * t); joint(p, `lowerLeg${side}`, (crumple ? 2 : 0.6) * t); joint(p, `upperArm${side}`, -0.7 * t, 0, (side === 'L' ? -1 : 1) * t); joint(p, `lowerArm${side}`, -0.6 * t); }
  joint(p, 'head', 0.4 * t, 0.2 * t); p.extras.jaw = 0.3;
}
export const CLIPS = {
  idle, walk, attack, death, corpse: death,
  waiting(p, e, c) { idle(p, e, c); joint(p, 'spine', 0.12); },
  spawn(p, e, c) { idle(p, e, c); const k = 1 - clamp(c.spawnProgress || 0, 0, 1); joint(p, 'spine', 0.6 * k); joint(p, 'head', 0.5 * k); },
  stagger(p, e, c) { idle(p, e, c); joint(p, 'spine', -0.3); },
  flinch(p, e, c) { p.data[indices.spine * 3] += c.flinchX || 0; p.data[indices.spine * 3 + 2] += c.flinchZ || 0; p.data[indices.head * 3] += c.flinchHead || 0; },
  lunge(p, e, c) { walk(p, e, c); }, charge(p, e, c) { walk(p, e, c); },
};
export function blendPoses(out, a, b, w) { for (let i = 0; i < 63; i++) out.data[i] = a.data[i] + (b.data[i] - a.data[i]) * w; for (const k in out.extras) out.extras[k] = a.extras[k] + (b.extras[k] - a.extras[k]) * w; }
export function applyPose(byName, pose, extras = pose.extras) {
  for (let i = 0; i < BONE_NAMES.length; i++) byName[BONE_NAMES[i]].rotation.set(pose.data[i * 3], pose.data[i * 3 + 1], pose.data[i * 3 + 2]);
  byName.pelvis.position.y = 0.96 * (byName.pelvis.userData.legScale || 1) + extras.pelvisY;
}
