import * as THREE from 'three';
import { PLAYER, PLAYER_SPAWN, MASK, VIEWMODEL } from './constants.js';
import { clamp, damp, degToRad } from './utils.js';

const _old = new THREE.Vector3(), _desired = new THREE.Vector3(), _dir = new THREE.Vector3();
const _origin = new THREE.Vector3(), _right = new THREE.Vector3();
const _near = new THREE.Vector2();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
export class Player {
  constructor(G) { this.G = G; }
  init() {
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.eye = new THREE.Vector3();
    this.recoil = { pitch: 0, yaw: 0, roll: 0 }; this.recoilTarget = { pitch: 0, yaw: 0, roll: 0 };
    this.viewRoot = new THREE.Group(); this.viewRoot.name = 'first-person hands'; this.G.camera.add(this.viewRoot);
    this.god = false;
    this.pushEnemy = enemy => {
      if (enemy.state === 'idle') return;
      const dx = this.pos.x - enemy.pos.x, dz = this.pos.z - enemy.pos.z;
      const distance = Math.hypot(dx, dz), radius = PLAYER.radius + enemy.radius;
      if (distance >= radius || Math.abs(this.pos.y - enemy.pos.y) > 1) return;
      const nx = distance > 1e-6 ? dx / distance : 1, nz = distance > 1e-6 ? dz / distance : 0;
      const overlap = radius - distance;
      this.pos.x += nx * overlap * 0.3; this.pos.z += nz * overlap * 0.3;
      const ex = enemy.pos.x - nx * overlap * 0.7, ez = enemy.pos.z - nz * overlap * 0.7;
      const ey = this.G.station.floorHeightAt(ex, ez);
      if (ey !== null) { enemy.pos.set(ex, ey, ez); }
    };
    this.reset();
  }
  getForward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  getRight(out) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  getAimRay(origin, direction) {
    const yaw = this.yaw + this.recoil.yaw, pitch = this.pitch + this.recoil.pitch;
    origin.copy(this.pos); origin.y += this.eyeHeight + this.bobY;
    this.getRight(_right); origin.addScaledVector(_right, this.bobX);
    direction.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }
  setLook(yaw, pitch) { this.yaw = yaw; this.pitch = clamp(pitch, -PLAYER.maxPitch, PLAYER.maxPitch); this.syncCamera(); }
  aimAt(x, y, z) {
    this.getAimRay(_origin, _dir);
    const dx = x - _origin.x, dy = y - _origin.y, dz = z - _origin.z;
    this.setLook(Math.atan2(-dx, -dz) - this.recoil.yaw, Math.atan2(dy, Math.hypot(dx, dz)) - this.recoil.pitch);
  }
  syncCamera() {
    this.getAimRay(this.eye, _dir);
    const camera = this.G.camera;
    camera.position.copy(this.eye);
    camera.rotation.set(this.pitch + this.recoil.pitch + this.shakePitch, this.yaw + this.recoil.yaw + this.shakeYaw, this.roll + this.recoil.roll + this.bobRoll, 'YXZ');
    camera.updateMatrixWorld(true);
  }
  teleport(x, z, yaw, pitch) {
    let y = this.G.station.floorHeightAt(x, z);
    if (y === null) { this.G.nav.nearestWalkable(x, z, _near); x = _near.x; z = _near.y; y = this.G.station.floorHeightAt(x, z); }
    this.pos.set(x, y, z); this.vel.setScalar(0); this.bobX = this.bobY = this.bobRoll = 0;
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = clamp(pitch, -PLAYER.maxPitch, PLAYER.maxPitch);
    this.syncCamera();
  }
  move(dt) {
    const input = this.G.input;
    _old.copy(this.pos);
    const speed = (this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (input.move.y <= 0 ? PLAYER.backFactor : 1);
    this.getForward(_desired).multiplyScalar(input.move.y); this.getRight(_right); _desired.addScaledVector(_right, input.move.x);
    if (_desired.lengthSq() > 0) {
      _desired.normalize().multiplyScalar(speed);
      _dir.copy(_desired).sub(this.vel); const length = _dir.length();
      if (length) this.vel.addScaledVector(_dir, Math.min(1, PLAYER.accel * dt / length));
    } else this.vel.multiplyScalar(Math.exp(-PLAYER.friction * dt));
    this.pos.addScaledVector(this.vel, dt);
    let y = this.G.station.floorHeightAt(this.pos.x, this.pos.z);
    if (y === null || Math.abs(y - _old.y) > PLAYER.stepHeight) {
      const nx = this.pos.x, nz = this.pos.z;
      y = this.G.station.floorHeightAt(nx, _old.z);
      if (y !== null && Math.abs(y - _old.y) <= PLAYER.stepHeight) this.pos.z = _old.z;
      else {
        y = this.G.station.floorHeightAt(_old.x, nz);
        if (y !== null && Math.abs(y - _old.y) <= PLAYER.stepHeight) this.pos.x = _old.x;
        else { this.pos.copy(_old); y = _old.y; }
      }
    }
    this.pos.y = y;
    this.G.colliders.resolveCircle(this.pos, PLAYER.radius, MASK.PLAYER, y);
    this.G.enemies?.forEachAlive?.(this.pushEnemy);
    y = this.G.station.floorHeightAt(this.pos.x, this.pos.z);
    if (y === null || Math.abs(y - _old.y) > PLAYER.stepHeight) this.pos.copy(_old); else this.pos.y = y;
    this.distanceMoved = Math.hypot(this.pos.x - _old.x, this.pos.z - _old.z);
    this.footDistance += this.distanceMoved;
    const interval = this.sprinting ? 0.42 : PLAYER.footstepEvery;
    if (this.footDistance >= interval) {
      this.footDistance %= interval;
      this.G.bus.emit('player-footstep', { pos: this.pos, sprinting: this.sprinting, surface: 'concrete' });
    }
  }
  update(dt) {
    if (!this.G.started || this.G.paused) return;
    const input = this.G.input;
    if (this.dead) {
      this.deathT += dt; const t = clamp(this.deathT / PLAYER.deathCamTime, 0, 1) ** 3;
      this.eyeHeight = PLAYER.eyeHeight + (0.45 - PLAYER.eyeHeight) * t;
      this.pitch = this.deathPitch + (-degToRad(35) - this.deathPitch) * t; this.roll = degToRad(20) * t;
      this.viewRoot.position.y = -0.8 * t; this.syncCamera(); return;
    }
    this.yaw -= input.lookDelta.x * PLAYER.mouseSens;
    let pitchDelta = -input.lookDelta.y * PLAYER.mouseSens;
    if (pitchDelta < 0 && this.recoilTarget.pitch > 0) {
      const consumed = Math.min(-pitchDelta, this.recoilTarget.pitch);
      this.recoilTarget.pitch -= consumed; pitchDelta += consumed;
    }
    this.pitch = clamp(this.pitch + pitchDelta, -PLAYER.maxPitch, PLAYER.maxPitch);
    this.sprinting = !!(input.sprint && input.move.y > 0.3 && !input.fire && !this.G.weapons?.triggerDown);
    this.move(dt);
    const moving = this.distanceMoved > 0.0005;
    if (moving) this.bobPhase += Math.PI * 2 * (this.sprinting ? PLAYER.bobSprintHz : PLAYER.bobWalkHz) * dt;
    else this.bobPhase = damp(this.bobPhase, Math.round(this.bobPhase / Math.PI) * Math.PI, 12, dt);
    const amount = Math.min(1, this.distanceMoved / (dt * PLAYER.walkSpeed));
    this.bobY = Math.abs(Math.sin(this.bobPhase)) * (this.sprinting ? PLAYER.bobAmpSprint : PLAYER.bobAmpWalk) * amount;
    this.bobX = Math.sin(this.bobPhase / 2) * (this.sprinting ? PLAYER.bobLatSprint : PLAYER.bobLatWalk) * amount;
    this.bobRoll = this.sprinting ? degToRad(0.6 * input.move.x + 0.35 * Math.sin(this.bobPhase / 2)) : 0;
    this.swayYaw = damp(this.swayYaw, clamp(-input.lookDelta.x * 0.0006, -0.06, 0.06), 12, dt);
    this.swayPitch = damp(this.swayPitch, clamp(-input.lookDelta.y * 0.0006, -0.06, 0.06), 12, dt);
    const def = this.G.weapons?.current?.def;
    const ramp = def?.kickRamp || 0.04, recovery = def?.kickRecover || 0.14;
    this.recoilHold = Math.max(0, this.recoilHold - dt);
    for (const axis of ['pitch', 'yaw', 'roll']) {
      this.recoil[axis] = damp(this.recoil[axis], this.recoilTarget[axis], 3 / ramp, dt);
      if (!this.recoilHold) this.recoilTarget[axis] = damp(this.recoilTarget[axis], 0, 3 / recovery, dt);
    }
    this.shakeT = Math.max(0, this.shakeT - dt);
    const shake = this.shakeDuration ? this.shakeAmount * this.shakeT / this.shakeDuration : 0;
    this.shakePitch = shake * Math.sin(this.G.time * 83); this.shakeYaw = shake * Math.sin(this.G.time * 107 + 2);
    this.lastDamage += dt;
    if (this.lastDamage >= PLAYER.regenDelay && this.health < PLAYER.maxHealth) this.heal(PLAYER.regenRate * dt);
    this.G.lowHealth = clamp((PLAYER.lowHealth - this.health) / PLAYER.lowHealth, 0, 1);
    this.G.post.setLowHealth(this.G.lowHealth);
    const camera = this.G.camera, fov = damp(camera.fov, this.sprinting ? PLAYER.sprintFov : PLAYER.fov, 15, dt);
    if (Math.abs(camera.fov - fov) > 0.0001) { camera.fov = fov; camera.updateProjectionMatrix(); }
    this.getAimRay(_origin, _dir);
    const hit = this.G.colliders.raycast(_origin, _dir, VIEWMODEL.wallPushDist, MASK.BULLET, _hit);
    this.wallPush = damp(this.wallPush, hit ? 1 - hit.dist / VIEWMODEL.wallPushDist : 0, 12, dt);
    this.viewRoot.position.set(0.001 * Math.sin(this.G.time * 1.068) + 0.006 * Math.sin(this.bobPhase / 2) * amount, 0.002 * Math.sin(this.G.time * 1.885) - 0.004 * Math.abs(Math.sin(this.bobPhase)) * amount - this.wallPush * VIEWMODEL.wallPushLower, 0.10 * this.wallPush);
    this.viewRoot.rotation.set(this.swayPitch + this.wallPush * degToRad(VIEWMODEL.wallPushPitchDeg), this.swayYaw, 0);
    this.syncCamera();
  }
  applyDamage(amount, fromPos, enemy, { knockback = 0, heavy = false } = {}) {
    if (this.dead || !Number.isFinite(amount) || amount <= 0) return;
    if (!this.god) { const previous = this.health; this.health = Math.max(0, this.health - amount); this.G.stats.damageTaken += previous - this.health; }
    this.lastDamage = 0;
    this.G.bus.emit('player-hit', { damage: amount, health: this.health, from: fromPos, enemy, heavy });
    this.shake(degToRad(heavy ? 1 : 0.5), heavy ? 0.35 : 0.2);
    if (knockback && fromPos) { _dir.copy(this.pos).sub(fromPos); _dir.y = 0; this.vel.addScaledVector(_dir.normalize(), knockback); }
    if (this.health <= 0) this.die('killed');
  }
  die(reason) {
    if (this.dead) return;
    this.alive = false; this.dead = true; this.sprinting = false; this.deathT = 0; this.deathPitch = this.pitch;
    this.vel.setScalar(0); this.G.bus.emit('player-death', { reason });
  }
  heal(amount) { if (this.dead || amount <= 0) return; this.health = Math.min(PLAYER.maxHealth, this.health + amount); this.G.bus.emit('player-heal', { health: this.health }); }
  setHealth(h) { this.health = clamp(h, 0, PLAYER.maxHealth); if (!this.health) this.die('killed'); }
  shake(amplitudeRad, time) { this.shakeAmount = amplitudeRad; this.shakeT = this.shakeDuration = time; }
  render() { this.G.particles?.setBlob?.(0, this.pos, 0.35, this.dead ? 0.1 : 0.3); }
  reset() {
    this.pos.fromArray(PLAYER_SPAWN.pos); this.vel.setScalar(0);
    this.yaw = PLAYER_SPAWN.yaw; this.pitch = this.roll = 0; this.health = PLAYER.maxHealth;
    this.alive = true; this.dead = this.sprinting = this.ads = this.crouching = false;
    this.eyeHeight = PLAYER.eyeHeight; this.bobX = this.bobY = this.bobRoll = this.bobPhase = 0;
    this.swayPitch = this.swayYaw = this.wallPush = this.deathT = this.footDistance = this.distanceMoved = 0;
    this.shakeAmount = this.shakeT = this.shakeDuration = this.shakePitch = this.shakeYaw = this.recoilHold = 0;
    this.lastDamage = PLAYER.regenDelay;
    for (const axis of ['pitch', 'yaw', 'roll']) this.recoil[axis] = this.recoilTarget[axis] = 0;
    this.viewRoot.position.setScalar(0); this.viewRoot.rotation.set(0, 0, 0);
    this.G.camera.fov = PLAYER.fov; this.G.camera.updateProjectionMatrix(); this.syncCamera();
  }
  dispose() { this.G.camera.remove(this.viewRoot); }
}
