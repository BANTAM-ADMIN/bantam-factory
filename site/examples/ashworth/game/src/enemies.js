import * as THREE from 'three';
import { ENEMY, ENEMY_TYPES, MASK, LAYERS } from './constants.js';
import { Pool, SpatialHash, Spring3, clamp, wrapAngle, yawFromDir, rayCapsule, closestPointSegment } from './utils.js';
import { getMaterial } from './materials.js';
import { BONE_NAMES, PART_NAMES, PART_GROUP, HIT_CAPSULES, buildRigGeometry, createSkeleton, applyScaleParams, makeVariantMaterial, PoseBuffer, CLIPS, applyPose, blendPoses } from './rig.js';
const VARIANTS = ['commuter', 'worker', 'nurse', 'hoodie', 'brute'];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3(), _scale = new THREE.Vector3();
const _flow = new THREE.Vector2(), _near = new THREE.Vector2();
export class Enemies {
  constructor(G) { this.G = G; }
  init() {
    this.aiEnabled = true; this.speedScale = 1; this.alive = []; this.all = []; this.nextId = 1; this.totalKilled = 0;
    this.hash = new SpatialHash(2); this.neighbors = []; this.tick = 0; this.streak = 0; this.streakT = 0;
    // Preallocate every world bucket used by normal and scripted routes.
    const marker = {}; for (let x = -44; x <= 50; x += 2) for (let z = -10; z <= 10; z += 2) this.hash.insert(marker, x, z); this.hash.clear();
    this.geometries = Object.fromEntries(VARIANTS.map(v => [v, buildRigGeometry(v === 'brute' ? 'brute' : v === 'hoodie' ? 'runner' : 'shambler', v)]));
    this.pool = new Pool(ENEMY.poolSize, slot => {
      const sk = createSkeleton('shambler'), mats = Object.fromEntries(VARIANTS.map(v => [v, makeVariantMaterial(v)]));
      const mesh = new THREE.SkinnedMesh(this.geometries.commuter, [mats.commuter, getMaterial('eyeGlow')]); mesh.add(sk.root); mesh.bind(sk.skeleton); mesh.frustumCulled = false; mesh.layers.set(LAYERS.NO_ENV);
      const root = new THREE.Group(); root.add(mesh); this.G.scene.add(root); root.position.y = -50;
      const e = { slot, id: 0, state: 'inactive', type: 'shambler', variant: 'commuter', def: ENEMY_TYPES.shambler, root, mesh, bones: sk.byName, mats,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), old: new THREE.Vector3(), stuckPos: new THREE.Vector3(), deathOrigin: new THREE.Vector3(), deathDir: new THREE.Vector3(),
        capsules: new Float32Array(17 * 7), pose: new PoseBuffer(), targetPose: new PoseBuffer(), flinch: new Spring3(140, 15),
        limbFlinch: new Spring3(140, 15), legFlinch: new Spring3(140, 15), baseTint: 1,
        cooldowns: { attack: 0, stagger: 0, lunge: 0, charge: 0, vocal: 0, hurt: 0 }, blobIndex: slot + 1, scale: 1, radius: 0.35, phase: 0,
        context: { time: 0, phase: 0, type: 'shambler', speedRatio: 0, limpSide: 0 }, result: { killed: false, headshot: false, staggered: false },
        hitPayload: { enemy: null, pos: new THREE.Vector3(), normal: new THREE.Vector3(), dir: new THREE.Vector3() },
      };
      e.hitPayload.enemy = e; e.onRelease = () => { e.state = 'inactive'; e.root.position.set(0, -50, 0); this.G.particles.setBlob(e.blobIndex, e.root.position, 0, 0); };
      return e;
    });
    for (let i = 0; i < VARIANTS.length; i++) { const e = this.pool.items[i]; e.mesh.geometry = this.geometries[VARIANTS[i]]; e.mesh.material[0] = e.mats[VARIANTS[i]]; }
  }
  get aliveCount() { return this.alive.length; }
  get corpseCount() { let n = 0; for (const e of this.pool.items) if (['dead', 'corpse', 'sinking'].includes(e.state)) n++; return n; }
  rebuildLists() { this.alive.length = this.all.length = 0; for (const e of this.pool.items) if (e.state !== 'inactive') { this.all.push(e); if (!['dead', 'corpse', 'sinking'].includes(e.state)) this.alive.push(e); } }
  oldestCorpse() { let best = null; for (const e of this.pool.items) if (['dead', 'corpse', 'sinking'].includes(e.state) && (!best || e.deathSerial < best.deathSerial)) best = e; return best; }
  spawn(type, spawnPoint = null, mods = {}, opts = {}) {
    const def = ENEMY_TYPES[type]; if (!def) throw new RangeError('Unknown enemy type');
    let e = this.pool.tryAcquire(); if (!e) { const corpse = this.oldestCorpse(); if (corpse) { this.pool.release(corpse); e = this.pool.tryAcquire(); } } if (!e) return null;
    const rng = this.G.rng;
    e.id = this.nextId++; e.type = type; e.def = def; e.variant = rng.pick(def.variants); e.mesh.geometry = this.geometries[e.variant]; e.mesh.material[0] = e.mats[e.variant];
    e.pos.copy(opts.pos || spawnPoint?.pos || this.G.player.pos); e.old.copy(e.pos); e.vel.setScalar(0);
    e.yaw = opts.yaw ?? (opts.state === 'idle' || !spawnPoint ? yawFromDir(this.G.player.pos.x - e.pos.x, this.G.player.pos.z - e.pos.z) : spawnPoint.yaw);
    e.scale = def.scale * rng.range(...ENEMY.heightVar); e.radius = def.radius; e.maxHp = def.hp * (mods.hpMult ?? 1); e.hp = opts.hp ?? e.maxHp;
    e.speed = def.speed * rng.range(1 - def.speedVar, 1 + def.speedVar) * (mods.speedMult ?? 1); e.dmgMult = mods.dmgMult ?? 1;
    e.spawnPoint = spawnPoint; e.exitTravelled = 0; e.state = opts.state || (spawnPoint ? spawnPoint.kind === 'train' ? 'waiting' : 'spawning' : 'chase');
    e.t = rng.range(...ENEMY.spawnTime); e.spawnDuration = e.t; e.phase = rng() * Math.PI * 2; e.limpSide = rng.int(2); e.legScale = rng.range(0.92, 1.08);
    applyScaleParams(e.bones, { legScale: e.legScale, torsoW: rng.range(0.9, 1.15) * (type === 'brute' ? 1.15 : 1), headScale: rng.range(0.96, 1.04) });
    e.baseTint = rng.range(0.9, 1.1); e.mesh.material[0].color.setScalar(e.baseTint); e.mesh.material[0].emissive.setHex(0);
    e.limbFlinch.reset(); e.legFlinch.reset();
    for (const key in e.cooldowns) e.cooldowns[key] = 0; e.cooldowns.vocal = rng.range(3, 9);
    e.attackPhase = ''; e.attackSide = rng.int(2); e.hitApplied = false; e.hitFlash = 0; e.corpseT = 0; e.deathAge = 0; e.stuckT = 0; e.stuckPos.copy(e.pos); e.flinch.reset();
    e.pose.reset(); e.targetPose.reset(); e.root.scale.setScalar(e.scale); e.root.visible = true;
    this.poseEnemy(e, 0, true); this.rebuildLists();
    this.G.bus.emit('enemy-spawn', { enemy: e, type, spawnId: spawnPoint?.id || 'debug' });
    this.G.bus.emit('enemy-vocal', { enemy: e, pos: e.pos, kind: 'spawn' }); return e;
  }
  forceExit(e) {
    if (!e.spawnPoint || !['waiting', 'exiting'].includes(e.state)) return;
    e.exitTravelled = Math.max(e.exitTravelled, e.spawnPoint.exitDist - 0.9); e.pos.copy(e.spawnPoint.pos).addScaledVector(e.spawnPoint.exitDir, e.exitTravelled); e.state = 'exiting'; this.poseEnemy(e, 0, true);
  }
  forEachAlive(fn) { for (const e of this.alive) fn(e); }
  byId(id) { for (const e of this.all) if (e.id === id) return e; return null; }
  getAll() { return this.all; }
  nearestTo(pos) { let best = null, dist = Infinity; for (const e of this.alive) { const d = e.pos.distanceToSquared(pos); if (d < dist) { dist = d; best = e; } } return best; }
  hitVolumeCenter(e, group, out) { const i = (group === 'head' ? 0 : 2) * 7, a = e.capsules; return out.set((a[i] + a[i + 3]) / 2, (a[i + 1] + a[i + 4]) / 2, (a[i + 2] + a[i + 5]) / 2); }
  raycast(origin, dir, maxDist, out) {
    if (!out) throw new TypeError('Enemy raycast requires caller-owned output');
    let best = maxDist, target = null, part = -1;
    for (const e of this.alive) {
      const data = e.capsules;
      for (let i = 0; i < 17; i++) { const j = i * 7; _a.fromArray(data, j); _b.fromArray(data, j + 3); const t = rayCapsule(origin, dir, _a, _b, data[j + 6], best); if (t >= 0 && (t < best || !target)) { best = t; target = e; part = i; } }
    }
    if (!target) return null;
    out.enemy = target; out.part = PART_NAMES[part]; out.group = PART_GROUP[out.part]; out.dist = best; out.point.copy(origin).addScaledVector(dir, best);
    _a.fromArray(target.capsules, part * 7); _b.fromArray(target.capsules, part * 7 + 3); closestPointSegment(out.point, _a, _b, _p); out.normal.copy(out.point).sub(_p).normalize(); return out;
  }
  applyDamage(e, part, damage, point, dir, weaponId) {
    const r = e.result; r.killed = r.headshot = r.staggered = false;
    if (!this.alive.includes(e) || damage <= 0 || !Number.isFinite(damage)) return r;
    const headshot = PART_GROUP[part] === 'head'; e.hp -= damage; e.hitFlash = ENEMY.hitFlashTime;
    this.G.stats.damageDealt += damage; r.headshot = headshot; r.killed = e.hp <= 0;
    const front = (-Math.sin(e.yaw) * dir.x - Math.cos(e.yaw) * dir.z) < 0;
    const left = (point.x - e.pos.x) * Math.cos(e.yaw) - (point.z - e.pos.z) * Math.sin(e.yaw) < 0;
    const magnitude = clamp(damage / 40, 0.5, 1.5);
    e.flinch.velocity.x += (front ? -1 : 1) * magnitude * 5;
    e.flinch.velocity.z += (left ? 1 : -1) * 3;
    if (headshot) { e.flinch.velocity.y -= 8; e.limbFlinch.velocity.z += (left ? 1 : -1) * 6; }
    if (PART_GROUP[part] === 'arm') e.limbFlinch.velocity[part.endsWith('L') ? 'x' : 'y'] -= 10;
    if (PART_GROUP[part] === 'leg') { e.legFlinch.velocity[part.endsWith('L') ? 'x' : 'y'] += 5; e.legFlinch.velocity.z -= 0.8; }
    const payload = e.hitPayload; payload.part = part; payload.group = PART_GROUP[part]; payload.damage = damage; payload.weapon = weaponId; payload.killed = r.killed; payload.headshot = headshot; payload.pos.copy(point); payload.dir.copy(dir); payload.normal.copy(dir).negate();
    this.G.bus.emit('enemy-hit', payload);
    if (!r.killed && e.cooldowns.hurt <= 0) {
      e.cooldowns.hurt = ENEMY.hurtRateLimit;
      this.G.bus.emit('enemy-vocal', { enemy: e, pos: e.pos, kind: 'hurt' });
    }
    if (r.killed) this.kill(e, weaponId, part, dir, damage);
    else if (e.cooldowns.stagger <= 0 && (damage >= e.def.staggerThreshold || headshot && (e.type !== 'brute' || damage >= 60))) {
      // Debug idle targets may flinch, but never enter steering or collision states.
      if (e.state !== 'idle') { e.state = 'stagger'; e.t = e.def.staggerTime; e.vel.copy(dir).multiplyScalar(0.25 / e.def.staggerTime); }
      e.flinch.velocity.multiplyScalar(1.8); e.limbFlinch.velocity.multiplyScalar(1.8); e.legFlinch.velocity.multiplyScalar(1.8);
      e.cooldowns.stagger = e.def.staggerCooldown; r.staggered = true; this.G.bus.emit('enemy-stagger', { enemy: e });
    }
    return r;
  }
  kill(e, weaponId = 'debug', part = 'chest', dir = _d.set(0, 0, 1), damage = 100) {
    if (!this.alive.includes(e)) return;
    e.hp = 0; e.state = 'dead'; e.t = ENEMY.deathFallTime; e.deathAge = 0; e.landed = false; e.deathSerial = ++this.totalKilled; e.killedBy = weaponId;
    e.deathOrigin.copy(e.pos); e.deathDir.copy(dir); e.deathDir.y = 0; e.deathDir.normalize();
    const facingDot = -Math.sin(e.yaw) * dir.x - Math.cos(e.yaw) * dir.z;
    e.deathKind = facingDot < -0.3 && (damage >= 40 || weaponId === 'shotgun') ? 'back' : e.vel.length() > e.speed * 0.5 ? 'forward' : 'crumple'; e.deathSide = this.G.rng.sign(); e.vel.setScalar(0);
    const headshot = PART_GROUP[part] === 'head'; this.G.stats.kills++; if (headshot) this.G.stats.headshots++;
    this.G.stats.score = (this.G.stats.score || 0) + e.def.points * (headshot ? 2 : 1);
    this.G.stats.killsByType[e.type] = (this.G.stats.killsByType[e.type] || 0) + 1;
    this.streak = this.streakT > 0 ? this.streak + 1 : 1; this.streakT = 3; this.G.stats.bestStreak = Math.max(this.G.stats.bestStreak, this.streak);
    this.rebuildLists(); this.G.bus.emit('enemy-killed', { enemy: e, type: e.type, part, weapon: weaponId, headshot, pos: e.pos, dir: e.deathDir }); this.G.bus.emit('enemy-vocal', { enemy: e, pos: e.pos, kind: 'death' });
    if (this.corpseCount > ENEMY.corpseCap) { const oldest = this.oldestCorpse(); if (oldest) { oldest.state = 'sinking'; oldest.t = ENEMY.sinkTime; } }
  }
  killAll({ silent = false } = {}) {
    const count = this.alive.length;
    for (let i = this.alive.length - 1; i >= 0; i--) { const e = this.alive[i]; if (silent) this.pool.release(e); else this.kill(e); }
    this.rebuildLists(); return count;
  }
  steer(e, dt) {
    e.old.copy(e.pos); const player = this.G.player.pos, dx = player.x - e.pos.x, dz = player.z - e.pos.z, distance = Math.hypot(dx, dz);
    this.G.nav.flowAt(e.pos.x, e.pos.z, _flow); let sx = _flow.x, sz = _flow.y;
    this.hash.query(e.pos.x, e.pos.z, 2, this.neighbors);
    for (const other of this.neighbors) if (other !== e && other.state !== 'idle') { const x = e.pos.x - other.pos.x, z = e.pos.z - other.pos.z, d = Math.hypot(x, z), r = e.radius + other.radius + ENEMY.separationExtra; if (d > 0.001 && d < r) { sx += x / d * (1 - d / r) * 1.6; sz += z / d * (1 - d / r) * 1.6; } }
    let slots = 0; for (const other of this.alive) if (other !== e && (other.state === 'attack' || other.type === 'brute' && other.pos.distanceToSquared(player) < 9)) slots++;
    const orbit = e.type !== 'brute' && slots >= ENEMY.attackRing && distance < ENEMY.orbitDist + 0.6;
    if (orbit && distance > 0.001) { const side = e.id % 2 ? 1 : -1; sx = -dz / distance * side * 0.6 + dx / distance * clamp(distance - ENEMY.orbitDist, -1, 1); sz = dx / distance * side * 0.6 + dz / distance * clamp(distance - ENEMY.orbitDist, -1, 1); }
    const length = Math.hypot(sx, sz), speed = e.speed * this.speedScale;
    e.vel.x += ((length ? sx / length * speed : 0) - e.vel.x) * Math.min(1, 8 * dt); e.vel.z += ((length ? sz / length * speed : 0) - e.vel.z) * Math.min(1, 8 * dt);
    e.pos.addScaledVector(e.vel, dt); const y = this.G.station.floorHeightAt(e.pos.x, e.pos.z); if (y === null) e.pos.copy(e.old); else e.pos.y = y;
    this.G.colliders.resolveCircle(e.pos, e.radius, MASK.ENEMY, e.pos.y);
    if (this.G.station.floorHeightAt(e.pos.x, e.pos.z) === null) e.pos.copy(e.old);
    else e.pos.y = this.G.station.floorHeightAt(e.pos.x, e.pos.z);
    const desiredYaw = distance < e.def.attackRange + 0.5 ? yawFromDir(dx, dz) : yawFromDir(e.vel.x, e.vel.z);
    e.yaw += clamp(wrapAngle(desiredYaw - e.yaw), -e.def.turnRateDeg * Math.PI / 180 * dt, e.def.turnRateDeg * Math.PI / 180 * dt);
    e.stuckT += dt; if (e.stuckT >= 1.5) { if (e.pos.distanceToSquared(e.stuckPos) < 0.04) { e.vel.x += this.G.rng.range(-1, 1); e.vel.z += this.G.rng.range(-1, 1); } e.stuckPos.copy(e.pos); e.stuckT = 0; }
    if (!orbit && distance <= e.def.attackRange && Math.abs(wrapAngle(yawFromDir(dx, dz) - e.yaw)) <= 35 * Math.PI / 180 && e.cooldowns.attack <= 0 && !this.G.player.dead) {
      e.state = 'attack'; e.attackPhase = 'windup'; e.t = e.def.windup; e.hitApplied = false; e.attackSide = 1 - e.attackSide; e.vel.setScalar(0);
      this.G.bus.emit('enemy-attack', { enemy: e, pos: e.pos, kind: e.type === 'brute' ? 'slam' : 'swipe' });
    }
  }
  attackTick(e, dt) {
    const player = this.G.player.pos, dx = player.x - e.pos.x, dz = player.z - e.pos.z, distance = Math.hypot(dx, dz), target = yawFromDir(dx, dz);
    if (e.attackPhase === 'windup') e.yaw += clamp(wrapAngle(target - e.yaw), -e.def.turnRateDeg * Math.PI / 360 * dt, e.def.turnRateDeg * Math.PI / 360 * dt);
    e.t -= dt;
    if (e.t <= 0) {
      if (e.attackPhase === 'windup') { e.attackPhase = 'active'; e.t += e.def.active; if (e.type === 'brute') { this.G.particles.groundRing(e.pos, 1.2); if (distance < 6) this.G.player.shake(Math.PI / 300, 0.3); } }
      else if (e.attackPhase === 'active') { e.attackPhase = 'recover'; e.t += e.def.recover; }
      else { e.state = 'chase'; e.cooldowns.attack = e.def.cooldown; }
    }
    if (e.attackPhase === 'active' && !e.hitApplied && distance <= e.def.attackRange + 0.2 && Math.abs(player.y - e.pos.y) < 1.5 && Math.abs(wrapAngle(target - e.yaw)) <= Math.PI / 3) {
      e.hitApplied = true; this.G.player.applyDamage(e.def.damage * e.dmgMult, e.pos, e, { knockback: e.def.knockback || 0, heavy: e.type === 'brute' });
    }
  }
  poseEnemy(e, dt, immediate = false) {
    const c = e.context; c.time = this.G.time; c.phase = e.phase; c.type = e.type; c.speedRatio = e.vel.length() / e.def.speed; c.limpSide = e.limpSide;
    c.attackPhase = e.attackPhase; c.attackSide = e.attackSide; c.attackWeight = e.attackPhase === 'recover' ? e.t / e.def.recover : 1;
    c.spawnProgress = 1 - e.t / e.spawnDuration; c.deathProgress = clamp(e.deathAge / ENEMY.deathFallTime, 0, 1); c.deathKind = e.deathKind; c.deathSide = e.deathSide;
    const dead = ['dead', 'corpse', 'sinking'].includes(e.state);
    if (dead) c.time = 0; // Corpses must not inherit idle breathing/head drift.
    const clip = dead ? CLIPS.death : e.state === 'attack' ? CLIPS.attack : e.state === 'spawning' ? CLIPS.spawn : e.state === 'waiting' ? CLIPS.waiting : e.state === 'stagger' ? CLIPS.stagger : e.state === 'idle' || c.speedRatio < 0.1 ? CLIPS.idle : CLIPS.walk;
    // LOD decisions use simulation-time camera state, never the number of
    // renders. Roots, flinches and hit capsules still refresh on every tick.
    let evaluate = true;
    if (!immediate && !dead && this.G.camera) {
      this.G.camera.getWorldDirection(_d);
      const dx = e.pos.x - this.G.camera.position.x, dz = e.pos.z - this.G.camera.position.z;
      const distance = Math.hypot(dx, dz);
      const behind = distance > 15 && (dx * _d.x + dz * _d.z) / distance < -0.3;
      evaluate = !behind && (distance <= ENEMY.lodDistance || (this.tick + e.slot) % 2 === 0);
    }
    e.poseEvaluated = evaluate;
    if (evaluate) {
      clip(e.targetPose, e.targetPose.extras, c);
      if (immediate) blendPoses(e.pose, e.pose, e.targetPose, 1);
      else blendPoses(e.pose, e.pose, e.targetPose, Math.min(1, 8 * dt));
    }
    const twitchAge = e.deathAge - ENEMY.deathFallTime;
    if (dead && twitchAge >= 0 && twitchAge < ENEMY.restTwitchTime) {
      const interval = Math.floor(twitchAge / 0.1);
      const chance = Math.abs(Math.sin(e.id * 127.1 + interval * 311.7));
      if (chance < 0.3) {
        const pulse = Math.sin((twitchAge % 0.1) * Math.PI / 0.1) * 0.05;
        e.targetPose.data[BONE_NAMES.indexOf('handL') * 3] += pulse;
        e.targetPose.data[BONE_NAMES.indexOf('head') * 3 + 2] -= pulse;
        blendPoses(e.pose, e.pose, e.targetPose, Math.min(1, 20 * dt));
      }
    }
    e.mesh.morphTargetInfluences[0] = clamp(e.pose.extras.jaw / 0.55, 0, 1);
    applyPose(e.bones, e.pose); e.bones.spine.rotation.x += e.flinch.value.x; e.bones.spine.rotation.z += e.flinch.value.z; e.bones.head.rotation.x += e.flinch.value.y;
    e.bones.head.rotation.y += e.limbFlinch.value.z;
    e.bones.upperArmL.rotation.x += e.limbFlinch.value.x; e.bones.upperArmR.rotation.x += e.limbFlinch.value.y;
    e.bones.upperLegL.rotation.x += e.legFlinch.value.x; e.bones.upperLegR.rotation.x += e.legFlinch.value.y;
    e.root.position.copy(e.pos); e.root.position.y += e.pose.extras.rootY + clamp(e.legFlinch.value.z, -0.06, 0); e.root.rotation.set(0, e.yaw + Math.PI, 0);
    e.mesh.rotation.set(e.pose.extras.rootTiltX, 0, e.pose.extras.rootZ);
    if (dead && e.deathKind !== 'crumple') {
      // Fall about the horizontal axis perpendicular to the killing shot,
      // expressed in the enemy root's local coordinates, not always local X.
      const yaw = e.yaw + Math.PI, cos = Math.cos(yaw), sin = Math.sin(yaw);
      const dx = cos * e.deathDir.x - sin * e.deathDir.z;
      const dz = sin * e.deathDir.x + cos * e.deathDir.z;
      _a.set(dz, 0, -dx);
      if (_a.lengthSq() < 1e-8) _a.set(1, 0, 0); else _a.normalize();
      e.mesh.quaternion.setFromAxisAngle(_a, Math.abs(e.pose.extras.rootTiltX));
    }
    if (dead && e.state === 'sinking') e.root.position.y -= ENEMY.sinkDepth * (1 - e.t / ENEMY.sinkTime);
    e.root.updateMatrixWorld(true);
    e.footPlantOffset = 0;
    if (!dead) {
      // Compare the soles in world space to the floor at each foot, including
      // stair risers. Correction is visual only: navigation stays on e.pos.
      let clearance = Infinity;
      for (const foot of [e.bones.footL, e.bones.footR]) {
        _p.set(0, -0.04, 0.07).applyMatrix4(foot.matrixWorld);
        const floor = this.G.station.floorHeightAt(_p.x, _p.z);
        if (floor !== null) clearance = Math.min(clearance, _p.y - floor);
      }
      if (Number.isFinite(clearance)) {
        e.footPlantOffset = -clamp(clearance, -0.06, 0.06);
        e.root.position.y += e.footPlantOffset;
        e.root.updateMatrixWorld(true);
      }
    }
    for (let i = 0; i < 17; i++) { const part = PART_NAMES[i], cap = HIT_CAPSULES[part], bone = e.bones[part]; _a.fromArray(cap.a).applyMatrix4(bone.matrixWorld); _b.fromArray(cap.b).applyMatrix4(bone.matrixWorld); _scale.setFromMatrixScale(bone.matrixWorld); const j = i * 7; _a.toArray(e.capsules, j); _b.toArray(e.capsules, j + 3); e.capsules[j + 6] = (part === 'head' ? e.def.headR : cap.r) * Math.max(_scale.x, _scale.y, _scale.z); }
    this.G.particles.setBlob(e.blobIndex, e.pos, 0.45 * e.scale, e.state === 'sinking' ? 0.5 * e.t / ENEMY.sinkTime : 0.5);
  }
  update(dt) {
    this.tick++; this.streakT -= dt; this.hash.clear(); for (const e of this.alive) if (e.state !== 'idle') this.hash.insert(e, e.pos.x, e.pos.z);
    const frozen = this.G.player.dead && this.G.player.deathT >= 1.5;
    for (const e of this.pool.items) {
      if (e.state === 'inactive') continue;
      e.hitFlash = Math.max(0, e.hitFlash - dt); e.flinch.update(dt); e.limbFlinch.update(dt); e.legFlinch.update(dt);
      for (const key in e.cooldowns) e.cooldowns[key] = Math.max(0, e.cooldowns[key] - dt);
      if (['dead', 'corpse', 'sinking'].includes(e.state)) {
        e.deathAge += dt; e.t -= dt;
        if (!e.landed && e.deathAge + 1e-8 >= ENEMY.deathFallTime) {
          e.landed = true;
          this.G.bus.emit('enemy-landed', { enemy: e, pos: e.pos });
        }
        if (e.state === 'dead' && e.t <= -ENEMY.restTwitchTime) { e.state = 'corpse'; e.t = e.type === 'brute' ? ENEMY.corpseTimeBrute : ENEMY.corpseTime; this.poseEnemy(e, dt, true); this.hitVolumeCenter(e, 'torso', _p); this.G.bus.emit('enemy-rest', { enemy: e, pos: _p }); }
        else if (e.state === 'corpse' && e.t <= 0) { e.state = 'sinking'; e.t = ENEMY.sinkTime; }
        else if (e.state === 'sinking' && e.t <= 0) { this.pool.release(e); continue; }
        if (e.state === 'dead') e.pos.copy(e.deathOrigin).addScaledVector(e.deathDir, 0.5 * clamp(e.deathAge / ENEMY.deathFallTime, 0, 1));
      } else if (!frozen && this.aiEnabled && e.state !== 'idle') {
        if (e.state === 'spawning') { e.t -= dt; if (e.t <= 0) e.state = 'exiting'; }
        else if (e.state === 'exiting') { const s = e.spawnPoint, travel = Math.min(s.exitDist - e.exitTravelled, ENEMY.exitSpeed * dt); e.exitTravelled += travel; e.pos.copy(s.pos).addScaledVector(s.exitDir, e.exitTravelled); e.vel.copy(s.exitDir).multiplyScalar(ENEMY.exitSpeed); if (e.exitTravelled >= s.exitDist - 1e-8) { const y = this.G.station.floorHeightAt(e.pos.x, e.pos.z); if (y !== null) e.pos.y = y; e.state = 'chase'; this.G.bus.emit('enemy-exited', { enemy: e, spawnId: s.id }); } }
        else if (e.state === 'chase') this.steer(e, dt);
        else if (e.state === 'attack') this.attackTick(e, dt);
        else if (e.state === 'stagger') { e.pos.addScaledVector(e.vel, dt); this.G.colliders.resolveCircle(e.pos, e.radius, MASK.ENEMY, e.pos.y); e.t -= dt; if (e.t <= 0) { e.state = 'chase'; e.vel.setScalar(0); } }
        if (e.cooldowns.vocal <= 0 && e.pos.distanceToSquared(this.G.player.pos) < 625) { e.cooldowns.vocal = this.G.rng.range(3, 9); this.G.bus.emit('enemy-vocal', { enemy: e, pos: e.pos, kind: e.type === 'runner' ? 'shriek' : 'moan' }); }
      }
      const oldPhase = e.phase; e.phase += Math.PI * 2 * e.vel.length() / e.def.stride * dt * (frozen ? 0.3 : 1);
      if (Math.floor(oldPhase / Math.PI) !== Math.floor(e.phase / Math.PI) && e.pos.distanceToSquared(this.G.player.pos) < 196) this.G.bus.emit('enemy-footstep', { enemy: e, pos: e.pos, heavy: e.type === 'brute', drag: e.type === 'shambler' });
      this.poseEnemy(e, dt);
    }
    this.rebuildLists();
  }
  render() {
    for (const e of this.all) {
      const material = e.mesh.material[0];
      material.emissive.setHex(e.hitFlash > 0 ? 0x5a1111 : 0);
      material.color.setRGB(e.baseTint, e.baseTint, e.baseTint);
      if (e.hp <= e.maxHp * 0.6) material.color.setRGB(e.baseTint * 0.82, e.baseTint * 0.61, e.baseTint * 0.57);
    }
  }
  warmupDone() { for (const e of this.pool.items) if (e.state === 'inactive') e.root.position.set(0, -50, 0); }
  reset() { this.pool.reset(); this.alive.length = this.all.length = 0; this.nextId = 1; this.totalKilled = this.tick = this.streak = this.streakT = 0; }
  dispose() { for (const e of this.pool.items) { this.G.scene.remove(e.root); e.mesh.skeleton.dispose(); for (const v of VARIANTS) e.mats[v].dispose(); } }
}
