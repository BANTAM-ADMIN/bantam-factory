import * as THREE from 'three';

export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 4;
export const DEFAULT_SEED = 1337;
export const VERSION = '1.0.0';

// ---- World layout (metres) -------------------------------------------------------------------
export const PLATFORM = { xMin: -30, xMax: 30, zMin: -5, zMax: 5, y: 0, thickness: 0.30 };
export const TACTILE = { inner: 4.4, outer: 5.0 };
export const EDGE_BARRIER = { zInner: 4.95, zOuter: 5.30, yMin: -1.2, yMax: 2.5, xMin: -30.5, xMax: 30.5 };
export const TRACK = { centerZ: 6.65, gauge: 1.435, bedY: -1.10, railTopY: -0.95, thirdRailZ: 8.35, thirdRailY: -0.85,
  zMin: 5.0, zMax: 9.0, xMin: -160, xMax: 160, tieSpacing: 0.6, troughW: 0.4, troughD: 0.25 };
export const WALLS = { z: 9.0, xMin: -32, xMax: 32, yMin: -1.10, yMax: 4.20 };
export const WALL_BANDS = [ // [yFrom, yTo, materialName]
  [-1.10, 0.00, 'concreteRaw'], [0.00, 0.45, 'tileBase'], [0.45, 2.40, 'tileWhite'],
  [2.40, 2.95, 'mosaicName'], [2.95, 3.40, 'tileWhite'], [3.40, 4.20, 'concretePainted'] ];
export const CEILING_Y = 4.20;
export const BEAMS = { x0: -27, pitch: 4.5, count: 13, w: 0.5, y0: 3.80, y1: 4.20 };
export const COLUMNS = { x0: -27, pitch: 4.5, count: 13, z: 3.0, r: 0.17, plinth: 0.55, plinthH: 0.25, top: 3.80, colliderR: 0.28 };
export const TROFFERS = { x0: -24.75, pitch: 4.5, count: 12, z: 1.8, y: 3.55, w: 1.25, h: 0.10, d: 0.30 };   // 24 platform fixtures, indices 0..23
export const MEZZ_TROFFERS = { xs: [38.5, 44.5], zs: [-3.0, 3.0], y: 7.55, count: 4, firstIndex: 24 };      // 4 mezzanine fixtures, indices 24..27 (§3.6.3); same w/h/d
export const BENCHES = { xs: [-24.75, -15.75, -6.75, 6.75, 15.75, 24.75], z: 0, len: 1.8, w: 1.0, h: 0.85 };
export const TRASH_CANS = { xs: [-22.5, -13.5, -4.5, 4.5, 13.5, 22.5], zAbs: 2.35, r: 0.30, colliderR: 0.32 };
export const VENDING = { x: 9.0, z: -2.30, w: 0.95, h: 1.85, d: 0.80 };
export const CRATE = { pos: [0, 0, -2.45], w: 0.8, h: 1.7, d: 0.45, interactDist: 1.6, interactCosAngle: 0.766 };
export const HANGING_SIGNS = { xs: [-13.5, 13.5], zs: [-2.0, 2.0], yBottom: 2.90, w: 1.2, h: 0.4 };
export const POSTERS = { x0: -24, pitch: 8, count: 7, yBottom: 0.45, w: 1.4, h: 1.9 };
export const DRAINS = { xs: [-15, 15], zs: [-2.5, 2.5] };
export const STAIR = { xLanding0: 30, xRun0: 30.6, xRun1: 37.8, xTop1: 39, rise: 4.8, halfW: 1.2, wallHalfW: 1.35, wallT: 0.30, risers: 24 };
export const MEZZ = { xMin: 30, xMax: 48, zMin: -6, zMax: 6, y: 4.8, slabT: 0.30, ceilY: 8.2, wellZ: 1.5 };
export const TURNSTILES = { x: 41.5, zs: [-3, -2, -1, 0, 1], housingW: 0.9, housingH: 1.0, housingT: 0.2, gateZ: [1.2, 3.4],
  railZ: [[3.4, 6], [-6, -3.1]], railT: 0.05, railH: 1.0 };
// Mezzanine dressing positions (props.js) — all outside NAV_KEEP_CLEAR (see §1.2); [x, z] on the mezzanine floor (y 4.8)
export const MEZZ_PROPS = {
  booth: { x: 44.5, z: -4.2, w: 2.2, d: 1.6, h: 2.4 },
  fareMachines: [{ x: 47.5, z: 2.2 }, { x: 47.5, z: 3.2 }], fareMachine: { w: 0.6, d: 0.6, h: 1.6 },   // face -X
  vending: [{ x: 47.5, z: -4.0 }, { x: 47.5, z: -2.8 }],                                                // face -X
  benches: [{ x: 34.0, z: 4.5 }, { x: 34.0, z: -4.5 }],
  cans: [{ x: 37.0, z: 5.4 }, { x: 37.0, z: -5.4 }],
  stanchions: [[43.0, -1.2], [43.0, -2.4], [44.2, -1.2], [44.2, -2.4]], stanchionR: 0.15,
  map: { x: 34.5, z: 5.92, size: 1.6, yBottom: 5.6 }, payphones: { x: 37.0, z: -5.85, count: 3 },
  mopBucket: [47.2, 5.2], wetFloorDown: [47.0, 4.0], manhole: [35.0, 3.5], extinguisher: [30.1, -4.0],
};
// Door -> gate -> landing route. No PLAYER/ENEMY/NAV collider may intrude (turnstile line excepted); asserted by nav.build().
export const NAV_KEEP_CLEAR = [ { xMin: 37.8, xMax: 42.5, zMin: -0.6, zMax: 3.4 }, { xMin: 42.0, xMax: 46.0, zMin: 1.0, zMax: 5.7 } ];
export const SHUTTER = { x: 48, zMin: -1.5, zMax: 1.5, yMin: 4.8, yMax: 7.2 };
export const MEZZ_DOOR = { x: 44, z: 6.0, w: 1.2, h: 2.2, recess: 0.8 };   // recess floor x ∈ [43.4, 44.6], z ∈ (6, 6.8] is walkable at MEZZ.y (§1.3); leaf + recess walls are colliders tagged 'door' (§3.4)
export const WEST_FENCE = { x: -30, h: 2.2, gateZ: [-0.6, 0.6], hingeZ: 0.6 };
export const CATWALK = { xMin: -42, xMax: -30, halfW: 0.6, doorX: -42 };
export const TUNNEL = { segLen: 6, count: 21, xStart: 32, ceilY: 3.9, columnPitch: 1.5, columnFromX: 44, columnSize: 0.25,
  lampX0: 38, lampPitch: 12, lampY: 3.0, signalXs: [44, 80], signalY: 3.0, endCapX: 160,
  centerFloor: { zHalf: 5.0, y: -1.10, eastX0: 30, westX1: -30 }, divider: { zHalf: 0.3, y0: -1.10, y1: -0.20, fromX: 44 } };
export const SPAWN_POINTS = {
  'mezz-door': { kind: 'door', pos: [44, 4.8, 6.55], yaw: Math.PI, exitDir: [0, 0, -1], exitDist: 1.8 },
  'west-gate': { kind: 'gate', pos: [-30.9, 0, 0], yaw: -Math.PI / 2, exitDir: [1, 0, 0], exitDist: 2.0 },
};
export const PLAYER_SPAWN = { pos: [0, 0, 0], yaw: -Math.PI / 2, pitch: 0 };

// ---- Lighting / atmosphere ---------------------------------------------------------------------
export const LIGHTS = {
  hemi: { sky: 0xa9c4b0, ground: 0x2a1e14, intensity: 0.25 },
  platform: { xs: [-22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30], y: 3.40, z: 0, color: 0xd6f0d9, intensity: 30, distance: 14, decay: 2 },
  mezz: { x: 41, y: 7.60, z: 0, color: 0xd6f0d9, intensity: 28, distance: 14, decay: 2 },   // the 17th light: upper treads, top landing, turnstile line, mezzanine floor (§3.6.2)
  wallLamps: [{ x: -9, y: 3.40, z: -8.7 }, { x: 9, y: 3.40, z: 8.7 }],
  wallLamp: { color: 0xffe2b8, intensity: 8, distance: 7, decay: 2 },
  sodium: [{ x: -38, y: 3.0, z: -8.8 }, { x: 38, y: 3.0, z: 8.8 }],
  sodiumLamp: { color: 0xff9a2a, intensity: 14, distance: 12, decay: 2 },
  emergency: { xs: [-15, 15], y: 3.40, z: 0, color: 0xff2a1a, intensity: 18, hz: 1.0, onTime: 0.2 },
  muzzle: { color: 0xffb050, distance: 10, decay: 2 },
  trainSpot: { color: 0xe6f0ff, intensity: 3000, angle: 0.35, penumbra: 0.6, distance: 90, decay: 2 },
  total: 17,   // hemi 1 + platform 8 + mezz 1 + wall 2 + sodium 2 + train spots 2 + muzzle 1 (§3.6.2)
};
export const FIXTURE_STATES = { steady: 16, flicker: 3, dead: 3, dying: 2 };  // of the 24 PLATFORM troffers (0..23), assigned by G.rngBuild; mezz fixtures 24..27 are steady except 26 = flicker (§3.6.3)
export const FOG = { color: 0x05070b, density: 0.018 };
export const ENV = { size: 128, intensity: 0.6, capturePos: [0, 1.6, 0] };   // intensity = scene.environmentIntensity, the FALLBACK for materials without their own envMap; every registry material carries envMap + its own §3.2 envMapIntensity (default 0.6) — §2.9
export const POST = { bloomStrength: 0.45, bloomRadius: 0.4, bloomThreshold: 0.9, exposure: 1.0,
  vignette: 0.45, grain: 0.06, ca: 0.0018, saturation: 0.92, maxPixelRatio: 1.5, maxPixelWidth: 2560 };

// ---- Player --------------------------------------------------------------------------------------
export const PLAYER = { radius: 0.35, height: 1.8, eyeHeight: 1.65, walkSpeed: 4.2, sprintSpeed: 6.6, backFactor: 0.85,
  accel: 40, friction: 12, stepHeight: 0.35, maxHealth: 100, regenDelay: 6.0, regenRate: 5.0, lowHealth: 30,
  fov: 75, sprintFov: 80, adsFov: 55, near: 0.07, far: 260, mouseSens: 0.0022, maxPitch: 1.45,   // near 0.07: depth precision for the 3–6 mm surface offsets at 40–60 m (§0.3, Appendix A); the viewmodel stays ≥ 0.12 m away
  bobWalkHz: 1.9, bobSprintHz: 2.6, bobAmpWalk: 0.035, bobAmpSprint: 0.05, bobLatWalk: 0.02, bobLatSprint: 0.03,
  footstepEvery: 0.55, deathCamTime: 0.8, deathFreezeAfter: 1.5 };

// ---- Weapons -------------------------------------------------------------------------------------
export const WEAPONS = {
  pistol:  { id: 'pistol', name: 'PISTOL', mode: 'semi', damage: 34, headMult: 3.0, rpm: 420, mag: 15, reserve: 90, maxReserve: 135,
             pellets: 1, spreadDeg: 0.5, moveSpreadDeg: 0.7, bloomDeg: 0.35, maxBloomDeg: 2.5, bloomRecoverDegPerS: 5, bloomDelay: 0.08,
             fullRange: 15, minRange: 35, minFactor: 0.7, kickPitchDeg: 1.3, kickYawDeg: 0.35, kickRamp: 0.04, kickRecover: 0.14,
             vmKickBack: 0.045, vmKickUpDeg: 2.5, reload: 1.35, reloadEmpty: 1.65, reloadTransfer: 0.70, lower: 0.22, raise: 0.28,
             raiseAfterSprint: 0.12, flashScale: 0.35, flashLight: 8, tracerRadius: 0.012, tracerLen: 0.9, casing: 'brass9', sfx: 'pistolShot' },
  rifle:   { id: 'rifle', name: 'CARBINE', mode: 'auto', damage: 24, headMult: 2.0, rpm: 720, mag: 30, reserve: 150, maxReserve: 270,
             pellets: 1, spreadDeg: 1.1, moveSpreadDeg: 0.9, bloomDeg: 0.28, maxBloomDeg: 4.0, bloomRecoverDegPerS: 6, bloomDelay: 0.06,
             fullRange: 22, minRange: 45, minFactor: 0.6, kickPitchDeg: 1.1, kickYawDeg: 0.3, kickRamp: 0.03, kickRecover: 0.11,
             vmKickBack: 0.03, vmKickUpDeg: 1.6, reload: 2.1, reloadEmpty: 2.5, reloadTransfer: 0.70, lower: 0.28, raise: 0.32,
             raiseAfterSprint: 0.15, flashScale: 0.45, flashLight: 10, tracerRadius: 0.012, tracerLen: 0.9, casing: 'brass556', sfx: 'rifleShot' },
  shotgun: { id: 'shotgun', name: 'SHOTGUN', mode: 'pump', damage: 13, headMult: 1.5, rpm: 65, mag: 6, reserve: 30, maxReserve: 48,
             pellets: 9, spreadDeg: 0.8, moveSpreadDeg: 0.6, bloomDeg: 1.2, maxBloomDeg: 3.0, bloomRecoverDegPerS: 4, bloomDelay: 0.15,
             patternRingDeg: [1.6, 2.3], patternRingCount: [3, 5], patternJitterDeg: 0.3,   // 1 centre + 3 @1.6deg + 5 @2.3deg; worst case 2.6deg pattern-only
             fullRange: 6, minRange: 18, minFactor: 0.25, kickPitchDeg: 4.0, kickYawDeg: 0.8, kickRollDeg: 0.6, kickRamp: 0.06, kickRecover: 0.26,
             vmKickBack: 0.09, vmKickUpDeg: 5.0, shotTime: 0.12, pumpTime: 0.80, pumpEjectAt: 0.25,
             reloadStart: 0.35, reloadShell: 0.55, reloadShellTransfer: 0.60, reloadEnd: 0.40, lower: 0.30, raise: 0.38,
             raiseAfterSprint: 0.18, flashScale: 0.7, flashLight: 18, tracerRadius: 0.006, tracerLen: 0.5, casing: 'hull12', sfx: 'shotgunShot' },
};
export const WEAPON_ORDER = ['pistol', 'rifle', 'shotgun'];
export const VIEWMODEL = { scale: 0.9, wallPushDist: 1.2, wallPushLower: 0.18, wallPushPitchDeg: -25 };   // §3.7 wall-push pose
export const RIFLE_PATTERN = [ // [pitchDeg, yawDeg] per consecutive shot; resets after 0.35 s without firing
  [1.10, 0.00], [1.15, 0.10], [1.20, -0.15], [1.20, 0.30], [1.10, 0.40], [1.00, 0.20],
  [0.95, -0.30], [0.90, -0.50], [0.85, -0.40], [0.85, 0.10], [0.80, 0.50], [0.80, 0.60] ];
export const GROUP_MULT = { torso: 1.0, arm: 0.75, leg: 0.75 };   // limbs; the head multiplier comes from damageMultiplier() below
/** THE ONE damage-multiplier function. weapons.js calls it when it computes the FINAL damage (§4.3); enemies.applyDamage never applies
 *  any multiplier (§2.20). head = min(WEAPONS[id].headMult, ENEMY_TYPES[type].headMultCap) (brute cap 1.5); torso 1.0; arm/leg 0.75. */
export function damageMultiplier(group, weaponId, enemyType) {
  if (group === 'head') return Math.min(WEAPONS[weaponId].headMult, ENEMY_TYPES[enemyType].headMultCap);
  return GROUP_MULT[group] ?? 1.0;
}
export const RECOIL = { holdTime: 0.05, vmSpringK: 220, vmSpringD: 18, vmRotK: 260, vmRotD: 20 };
export const BALLISTICS = { maxDist: 120, tracerSpeed: 280, tracerMinDist: 1.5, tracerMinTime: 0.035, tracerMaxTime: 0.11 };

// ---- Enemies -------------------------------------------------------------------------------------
export const ENEMY_TYPES = {
  shambler: { hp: 100, speed: 1.35, speedVar: 0.15, turnRateDeg: 180, radius: 0.35, attackRange: 1.5, damage: 12,
              windup: 0.45, active: 0.15, recover: 0.60, cooldown: 0.4, staggerThreshold: 30, staggerTime: 0.40, staggerCooldown: 1.5,
              headR: 0.14, headMultCap: 99, stride: 0.85, scale: 1.0, lean: 0.15, points: 1, vocalPitch: [0.9, 1.1],
              variants: ['commuter', 'worker', 'nurse'] },
  runner:   { hp: 70, speed: 4.4, speedVar: 0.10, turnRateDeg: 420, radius: 0.32, attackRange: 1.4, damage: 8,
              windup: 0.25, active: 0.12, recover: 0.45, cooldown: 0.3, staggerThreshold: 25, staggerTime: 0.35, staggerCooldown: 1.2,
              headR: 0.13, headMultCap: 99, stride: 1.7, scale: 0.97, lean: 0.42, points: 1, vocalPitch: [1.3, 1.5],
              variants: ['hoodie'], lunge: { minDist: 2.5, maxDist: 4.0, windup: 0.30, air: 0.35, recover: 0.8, speed: 7.5, apex: 0.35, damage: 14, range: 1.2, cooldown: 4.0 } },
  brute:    { hp: 450, speed: 1.1, speedVar: 0.05, turnRateDeg: 90, radius: 0.55, attackRange: 2.1, damage: 30, knockback: 4.0,
              windup: 0.70, active: 0.15, recover: 1.00, cooldown: 0.5, staggerThreshold: 90, staggerTime: 0.55, staggerCooldown: 3.0,
              headR: 0.17, headMultCap: 1.5, stride: 1.4, scale: 1.32, torsoW: 1.15, lean: 0.30, points: 3, vocalPitch: [0.55, 0.65],
              variants: ['brute'], charge: { minDist: 5, maxDist: 12, windup: 0.6, maxRun: 2.5, recover: 0.9, speed: 4.5, damage: 20, knockback: 5.0, cooldown: 8.0 } },
};
export const ENEMY = { poolSize: 32, corpseCap: 10, corpseTime: 9, corpseTimeBrute: 12, deathFallTime: 0.9, restTwitchTime: 0.4, sinkTime: 1.5, sinkDepth: 2.2,
  separationExtra: 0.35, exitSpeed: 1.6, waitingSway: 0.03, spawnTime: [0.6, 1.2], attackRing: 3, orbitDist: 2.4,
  hitFlashTime: 0.08, boundingR: 1.6, lodDistance: 45, vocalEvery: [3, 9], maxVoices: 6, hurtRateLimit: 0.25,
  flinchK: 140, flinchD: 15, limpK: 60, limpD: 9, heightVar: [0.94, 1.06] };

// ---- Waves ---------------------------------------------------------------------------------------
/** wave: [count, shamblers, runners, brutes, hpMult, speedMult, dmgMult, cadence, trainBatch, trainCadence, maxAlive, breather] */
export const WAVE_TABLE = [
  null,
  [ 5,  5,  0, 0, 1.00, 1.00, 1.00, 3.0,  0, 0,    8, 8],
  [ 8,  7,  1, 0, 1.00, 1.00, 1.00, 2.5,  8, 0.90, 10, 8],
  [11,  8,  3, 0, 1.05, 1.03, 1.00, 2.5, 11, 0.80, 12, 8],
  [14,  9,  4, 1, 1.10, 1.06, 1.10, 2.2, 14, 0.75, 14, 6],
  [18, 11,  5, 2, 1.15, 1.09, 1.15, 2.0, 18, 0.70, 16, 6],
  [22, 12,  7, 3, 1.20, 1.12, 1.20, 1.8, 20, 0.65, 18, 6],
  [26, 13,  9, 4, 1.30, 1.15, 1.30, 1.6, 22, 0.60, 20, 4],
  [30, 14, 11, 5, 1.40, 1.18, 1.40, 1.4, 24, 0.50, 22, 4],
  [35, 16, 13, 6, 1.50, 1.21, 1.50, 1.2, 26, 0.45, 24, 4],
  [40, 17, 15, 8, 1.60, 1.24, 1.60, 1.0, 28, 0.45, 24, 4],
];
export function waveConfig(n) {
  if (n <= 10) { const r = WAVE_TABLE[n]; return { wave: n, count: r[0], shamblers: r[1], runners: r[2], brutes: r[3], hpMult: r[4],
    speedMult: r[5], dmgMult: r[6], cadence: r[7], trainBatch: r[8], trainCadence: r[9], maxAlive: r[10], breather: r[11],
    source: n === 1 ? 'doors' : 'train' }; }
  const k = n - 10, count = 40 + 5 * k, brutes = 8 + k, runners = Math.round(0.38 * count);
  return { wave: n, count, shamblers: count - brutes - runners, runners, brutes, hpMult: 1.6 + 0.10 * k,
    speedMult: Math.min(1.5, 1.24 + 0.03 * k), dmgMult: 1.6 + 0.10 * k, cadence: Math.max(0.6, 1.0 - 0.05 * k),
    trainBatch: Math.min(count, 28 + 2 * k), trainCadence: 0.45, maxAlive: 24, breather: 4, source: 'train' };
}
export const WAVES = { introTime: 2.0, clearedTime: 3.0, wave1FirstSpawn: 2.0, sideStagger: 1.5, doorsCloseAfterBatch: 2.0,
  maxAliveHoldToClose: 6.0, lateArrivalDelay: 1.0 };
/** Track the train uses to deliver wave n (n >= 2): A when n is even, B when n is odd. Used by waves.js AND debug.skipToWave. */
export function trackForWave(n) { return n % 2 === 0 ? 'A' : 'B'; }

// ---- Train ---------------------------------------------------------------------------------------
export const TRAIN = { cars: 4, carLength: 14.4, carGap: 0.5, width: 3.0, height: 3.65, floorY: 0.0, roofY: 2.70, railTopY: -0.95,
  doorLocalX: [-4.8, 0, 4.8], doorW: 1.3, leafW: 0.65, doorH: 1.95, doorOpenTime: 1.2, doorCloseTime: 1.0,
  cruiseSpeed: 14, brakeDecel: 1.4, cruiseTime: 5.0, brakeTime: 10.0, startCenterX: -140, settleTime: 0.6, settleAmp: 0.10,
  chimeDelay: 0.8, doorsDelay: 1.4, departAccel: 1.2, goneX: 100, parkX: 300, tunnelMouthX: 32, windowsPerSide: 8, bogieInset: 3.2, wheelR: 0.42,
  headlightLocal: [[29.4, 1.9, -0.9], [29.4, 1.9, 0.9]], headlightAim: 60 };   // cab lens positions (train-local, car 3 +X end); spots aim +X local, 60 m ahead
export const TRAIN_LENGTH = TRAIN.cars * TRAIN.carLength + (TRAIN.cars - 1) * TRAIN.carGap;   // 59.1
export function trainCarCenterX(i) { const p = TRAIN.carLength + TRAIN.carGap; return -(TRAIN.cars - 1) * 0.5 * p + i * p; } // -22.35,-7.45,7.45,22.35
export const TRAIN_STATES = ['idle', 'arriving', 'stopped', 'doorsOpening', 'doorsOpen', 'doorsClosing', 'departing'];

// ---- Collision / nav -----------------------------------------------------------------------------
export const MASK = { PLAYER: 1, ENEMY: 2, BULLET: 4, NAV: 8, SOLID: 15, WALKERS: 3 };
export const NAV = { cell: 0.5, xMin: -30, zMin: -6, cols: 156, rows: 24, agentRadius: 0.3, recompute: 0.25,
  // nav.build() asserts finite distanceAt from PLAYER_SPAWN at these points (plus every docked train-door exit at |z| = 4.0)
  mustReach: [[44, 4.75], [-28.9, 0]] };

// ---- Effects -------------------------------------------------------------------------------------
export const FX = { tracers: 96, casings: 64, particles: 4096, smoke: 48, decalsHoles: 256, decalsSplats: 128, decalsPools: 24,
  dustMotes: 600, shaftMotes: 150, mezzMotes: 120, casingLife: 8, decalLife: 90, flashLife: 0.055, smokeLife: 0.6,
  decalOffset: 0.006, poolDelay: 0.6 };   // decals sit 6 mm off the surface (above the 5 mm tactile strip); pool 0.6 s after enemy-rest

// ---- Budgets / misc ------------------------------------------------------------------------------
export const BUDGET = { drawCalls: 400, triangles: 1_500_000, lights: 17, programs: 64,
  textures: 260,          // renderer.info.memory.textures (incl. render targets + bone textures)
  canvasTextures: 180,    // textures.getTextureStats().gpuTextures (registry only)
  gpuMB: 250, initMsHeadless: 45000, initMsDesktop: 5000, stepMs: 8 };   // initMsHeadless is a WARNING threshold (§1.11), initMsDesktop the real budget
export const LAYERS = { DEFAULT: 0, VIEWMODEL: 1, NO_ENV: 2 };   // §1.12: main camera renders 0|1|2; viewmodel on 1 EXCLUSIVELY; effects/decals/blob shadows/enemies on 2 EXCLUSIVELY; env/luminance cameras render 0 only
export const UP = new THREE.Vector3(0, 1, 0);
export const FONTS = {
  SIGN: 'bold 64px Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif',
  MOSAIC: 'bold 200px Georgia, "Times New Roman", "DejaVu Serif", serif',
  STENCIL: '900 96px Impact, "Arial Black", "DejaVu Sans", sans-serif',
  MONO: 'bold 48px "Courier New", "DejaVu Sans Mono", monospace',
};
