import * as THREE from 'three';
import { DEFAULT_SEED, ENV } from './constants.js';
import { initTextures, getTexture } from './textures.js';

const shared = new Map(), issued = new Set();
let environment = null, envTarget = null;
const definitions = {};
function define(name, options = {}, texture = null, variant = 0, kind = 'standard') { definitions[name] = { options, texture, variant, kind }; }
for (const name of ['tileWhite', 'tileBase', 'mosaicName', 'mosaicStair', 'concretePainted', 'concreteLeak', 'concreteRaw', 'floorSlab', 'tactile', 'trackbed', 'nosing']) define(name, { vertexColors: true }, name);
define('tileWhiteB', { vertexColors: true }, 'tileWhite', 1);
for (const name of ['steelRust', 'steelGalv', 'ironGreen', 'wood', 'woodWorn', 'tieWood', 'tieConcrete']) define(name, { vertexColors: true, metalness: name.startsWith('steel') ? 0.65 : name === 'ironGreen' ? 0.45 : 0 }, name);
define('rail', { color: 0xb8b8ab, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.2 }, 'rail');
define('railRust', { color: 0x62432c, metalness: 0.55, roughness: 0.8 }, 'steelRust');
define('chrome', { color: 0xc0c5c2, metalness: 0.95, roughness: 0.2, envMapIntensity: 1.2 });
define('steelPainted', { color: 0x343a39, metalness: 0.45, roughness: 0.65 });
const glass = { transmission: 0, roughness: 0.05, transparent: true, opacity: 0.25, envMapIntensity: 1.5, depthWrite: false };
define('glass', glass, null, 0, 'physical');
define('glassDirty', { ...glass, opacity: 0.35 }, 'glassGrime', 0, 'physical');
define('trainGlass', { ...glass, color: 0x2a3038, opacity: 0.5 }, null, 0, 'physical');
define('trainSteel', { metalness: 0.85, roughness: 0.5, envMapIntensity: 1.2 }, 'trainSide');
define('trainInterior', { roughness: 0.65 }, 'trainInterior');
define('trainFloor', { roughness: 0.9 }, 'trainFloor');
define('trainSeatOrange', { color: 0xf28c28, roughness: 0.4 }, 'trainSeat');
define('trainSeatYellow', { color: 0xf5c02a, roughness: 0.4 }, 'trainSeat');
define('tubeLit', { color: new THREE.Color(2.4, 2.9, 2.6), toneMapped: false }, null, 0, 'basic');
define('tubeDead', { color: 0xb9bdb5, roughness: 0.6 });
for (const [name, color, power] of [['emissiveWarm', 0xfff2cc, 2.5], ['emissiveExit', 0x6dff90, 2], ['emissiveExitBlue', 0x527aff, 2], ['emergencyRed', 0xff2a1a, 3], ['sodiumLamp', 0xffa33a, 6], ['headlight', 0xffffff, 6], ['tailLight', 0xff2424, 4], ['led', 0x66ee88, 2]]) {
  define(name, { color: new THREE.Color(color).multiplyScalar(power), toneMapped: false }, null, 0, 'basic');
}
define('puddle', { color: 0x202020, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }, null, 0, 'physical');
define('puddleEdge', { color: 0x5e5a52, roughness: 0.35, transparent: true, opacity: 0.6, depthWrite: false });
define('aoStrip', { color: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }, 'shaftGradient', 0, 'basic');
define('blobShadow', { color: 0, transparent: true, depthWrite: false }, 'blobShadow', 0, 'basic');
define('additive', { color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }, null, 0, 'basic');
define('tracer', { color: 0xffd9a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }, null, 0, 'basic');
define('casingBrass', { color: new THREE.Color(0.85, 0.65, 0.3), metalness: 0.9, roughness: 0.35 });
define('casingHull', { color: 0x9b2923, roughness: 0.6 });
for (const [name, texture] of [['decalHole', 'decalHoles'], ['decalBlood', 'decalBlood'], ['decalPool', 'decalPool']]) define(name, { transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false, roughness: name === 'decalPool' ? 0.3 : 0.8 }, texture);
for (const variant of ['commuter', 'worker', 'nurse', 'hoodie', 'brute']) define(`enemy-${variant}`, { roughness: 0.85, vertexColors: true }, 'enemyAtlas', variant);
define('eyeGlow', { color: 0x596b2f, emissive: 0xb7c95a, emissiveIntensity: 1.5 });
define('skinHands', { roughness: 0.65 }, 'skin');
define('gunmetal', { color: 0x52575b, metalness: 0.85, roughness: 0.4 }, 'gunMetalRough');
define('polymer', { color: 0x1c1c1e, roughness: 0.7 }, 'polymerNormal');
define('brass', { color: 0xc4a052, metalness: 0.9, roughness: 0.3 });
define('gunWood', { roughness: 0.45 }, 'gunWood');
define('sightGlow', { color: 0x7b994a, emissive: 0xaaff68, emissiveIntensity: 2 });
define('chainlink', { alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5, color: 0x8a8d90 }, 'chainlink');
define('paper', { color: 0xebe2ca, roughness: 0.8, side: THREE.DoubleSide });
define('posterBacklit', { roughness: 0.8, emissive: 0xffffff, emissiveIntensity: 0.6 }, 'posters');
define('signBlack', { color: 0x111214, roughness: 0.3 });
define('signEnamel', { color: 0xe4dec9, roughness: 0.25, metalness: 0.2 });
define('plastic', { color: 0xd4b329, roughness: 0.6 });
define('rubber', { color: 0x171a19, roughness: 0.9 });
export const MATERIAL_NAMES = Object.keys(definitions);
export function initMaterials(renderer, seed = DEFAULT_SEED) { initTextures(renderer, seed); }
function track(material) {
  issued.add(material);
  if (environment && material.isMeshStandardMaterial) { material.envMap = environment; material.needsUpdate = true; }
  return material;
}
export function getMaterial(name) {
  if (shared.has(name)) return shared.get(name);
  const def = definitions[name];
  if (!def) throw Error(`Unknown material: ${name}`);
  const options = { ...def.options };
  if (def.texture) Object.assign(options, getTexture(def.texture, def.variant));
  if (def.kind !== 'basic') options.envMapIntensity ??= 0.6;
  const Constructor = def.kind === 'basic' ? THREE.MeshBasicMaterial : def.kind === 'physical' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const material = track(new Constructor(options)); material.name = name;
  if (name === 'tactile') { material.polygonOffset = true; material.polygonOffsetFactor = -1; material.polygonOffsetUnits = -2; }
  shared.set(name, material); return material;
}
export function cloneMaterial(name, overrides = {}) {
  const material = getMaterial(name).clone(); material.setValues(overrides); return track(material);
}
export const MAT = new Proxy({}, { get: (_, name) => getMaterial(name) });
export function makeAoStrip(length, width = 0.35, alpha = 0.55) {
  const material = cloneMaterial('aoStrip', { opacity: alpha });
  return new THREE.Mesh(new THREE.PlaneGeometry(length, width), material);
}
export function makeBlobShadowMaterial() { return cloneMaterial('blobShadow'); }
export function applyEnvironment(texture) {
  environment = texture;
  // Basic FX, decals used for AO, and emissive tubes are authored unlit.
  // MeshBasicMaterial also exposes envMap, but assigning it makes smoke and
  // flashes reflective and multiplies their procedural colours by the cube.
  // Only physical/Standard surfaces participate in environment lighting.
  for (const material of issued) if (material.isMeshStandardMaterial && material.envMap !== texture) {
    // Release obsolete pre-environment capture programs before the final warm-up.
    // Material disposal releases renderer state, not its textures; the same material
    // is uploaded again with the final environment on its next render.
    material.dispose(); material.envMap = texture; material.needsUpdate = true;
  }
}
export function getEnvironment() { return environment; }
export function captureEnvironment(G) {
  const target = new THREE.WebGLCubeRenderTarget(ENV.size, { type: THREE.HalfFloatType });
  const camera = new THREE.CubeCamera(0.1, 200, target); camera.position.fromArray(ENV.capturePos);
  camera.layers.set(0); for (const child of camera.children) child.layers.set(0);
  G.scene.updateMatrixWorld(true); camera.update(G.renderer, G.scene);
  const pmrem = new THREE.PMREMGenerator(G.renderer);
  envTarget?.dispose(); envTarget = pmrem.fromCubemap(target.texture);
  applyEnvironment(envTarget.texture);
  G.scene.environment = environment; G.scene.environmentIntensity = ENV.intensity; G.envMap = environment;
  target.dispose(); pmrem.dispose(); return environment;
}
export function disposeAllMaterials() {
  for (const material of issued) material.dispose();
  issued.clear(); shared.clear(); envTarget?.dispose(); envTarget = null; environment = null;
}
