import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, RIFLE_PATTERN, PLAYER, RECOIL, BALLISTICS, MASK, damageMultiplier } from './constants.js';
import { clamp, degToRad, Spring3 } from './utils.js';
import { buildViewmodel, resetPose, poseFire, poseReload, posePump, poseSwitch, poseShotgunReload, setSlideLocked } from './viewmodels.js';
const _origin = new THREE.Vector3(), _base = new THREE.Vector3(), _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3(), _end = new THREE.Vector3(), _eject = new THREE.Vector3(), _vel = new THREE.Vector3(), _ang = new THREE.Vector3();
const _world = { point: new THREE.Vector3(), normal: new THREE.Vector3() }, _enemy = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
export class Weapons {
  constructor(G) { this.G = G; }
  init() {
    this.list = WEAPON_ORDER.map(id => {
      const vm = buildViewmodel(id); this.G.player.viewRoot.add(vm.group);
      return { id, def: WEAPONS[id], vm, kick: new Spring3(RECOIL.vmSpringK, RECOIL.vmSpringD), rotationKick: new Spring3(RECOIL.vmRotK, RECOIL.vmRotD) };
    });
    this.infiniteAmmo = false; this.reset();
  }
  getAmmo() { return { mag: this.current.mag, reserve: this.current.reserve }; }
  getAmmoAll() { return Object.fromEntries(this.list.map(w => [w.id, { mag: w.mag, reserve: w.reserve }])); }
  getName() { return this.current.def.name; }
  getState() { return this.current.state; }
  getSpreadDeg() { const w = this.current; return w.def.spreadDeg + w.def.moveSpreadDeg * clamp(this.G.player.vel.length() / PLAYER.walkSpeed, 0, 1.4) + w.bloomDeg; }
  addAmmo(id, rounds) { const w = this.list.find(w => w.id === id); if (w && rounds > 0) w.reserve = Math.min(w.def.maxReserve, w.reserve + Math.floor(rounds)); }
  resupplyAll() { for (const w of this.list) w.reserve = w.def.maxReserve; }
  canFire() { return this.G.started && !this.G.paused && !this.G.player.dead && !this.G.player.sprinting && this.raiseDelay <= 0 && this.current.state === 'ready' && this.current.nextShotTime <= 1e-8 && this.current.mag > 0; }
  switchTo(indexOrId) {
    const index = typeof indexOrId === 'string' ? WEAPON_ORDER.indexOf(indexOrId) : indexOrId;
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new RangeError('Unknown weapon');
    if (index === this.index) return this.current.id;
    if (this.current.id === 'shotgun' && this.current.state === 'reloading' && this.current.reloadPhase === 'shell') {
      this.pendingSwitch = index; this.current.cancel = true; return WEAPON_ORDER[index];
    }
    const prev = this.current;
    if (prev.state !== 'lowering') { this.outgoing = prev; this.switchT = prev.def.lower; }
    prev.state = 'holstered'; this.lastIndex = this.index; this.index = index; this.current = this.list[index];
    this.current.state = 'lowering'; this.buffer = 0; this.G.bus.emit('weapon-switch', { weapon: this.current.id, prev: prev.id });
    return this.current.id;
  }
  switchLast() { return this.switchTo(this.lastIndex); }
  setTrigger(value) { const down = !!value; if (down && !this.triggerDown) this.buffer = 0.08; this.triggerDown = down; }
  fire() {
    if (this.current.state === 'reloading' && this.current.id === 'shotgun' && this.current.mag) this.current.cancel = true;
    if (!this.canFire()) { if (!this.current.mag) this.empty(); else this.buffer = 0.08; return false; }
    this.shoot(); return true;
  }
  empty() {
    if (this.dryT > 0 || this.current.state !== 'ready') return;
    this.dryT = 0.25; this.autoReload = this.current.reserve > 0 ? 0.25 : -1;
    this.G.bus.emit('weapon-empty', { weapon: this.current.id });
  }
  reload() {
    const w = this.current;
    if (this.G.player.dead || !['ready', 'pumping'].includes(w.state) || w.mag >= w.def.mag || !w.reserve) return false;
    w.state = 'reloading'; w.reloadT = 0; w.reloadEmpty = w.mag === 0; w.transferred = false; w.cancel = false; w.cue = 0;
    w.reloadPhase = w.id === 'shotgun' ? 'start' : 'mag';
    w.duration = w.id === 'shotgun' ? w.def.reloadStart : w.reloadEmpty ? w.def.reloadEmpty : w.def.reload;
    this.G.bus.emit('weapon-reload-start', { weapon: w.id, duration: w.duration, empty: w.reloadEmpty }); return true;
  }
  endReload(w) { w.state = 'ready'; w.reloadT = 0; setSlideLocked(w.vm, false); this.G.bus.emit('weapon-reload-end', { weapon: w.id }); }
  sound(name) { this.G.audio?.play?.(name); }
  reloadTick(w, dt) {
    const previous = w.reloadT; w.reloadT += dt;
    if (w.id !== 'shotgun') {
      const t = w.reloadT / w.duration;
      if (!w.transferred && t >= w.def.reloadTransfer) { const n = Math.min(w.def.mag - w.mag, w.reserve); w.mag += n; w.reserve -= n; w.transferred = true; }
      if (previous / w.duration < 0.22 && t >= 0.22) { w.vm.parts.mag.getWorldPosition(_eject); _vel.set(0, -0.7, 0); this.G.particles.dropMag(_eject, _vel, w.id); this.sound('magOut'); }
      if (previous / w.duration < 0.83 && t >= 0.83) this.sound('magIn');
      if (w.reloadEmpty && previous / w.duration < 0.95 && t >= 0.95) this.sound(w.id === 'pistol' ? 'slideRack' : 'boltRack');
      if (w.reloadT >= w.duration) this.endReload(w);
      return;
    }
    if (w.reloadPhase === 'shell' && !w.transferred && w.reloadT >= w.def.reloadShell * w.def.reloadShellTransfer) { w.mag++; w.reserve--; w.transferred = true; this.sound('shellInsert'); }
    if (w.reloadT + 1e-8 < w.duration) return;
    w.reloadT -= w.duration;
    if (w.reloadPhase === 'end') { this.endReload(w); return; }
    if (this.pendingSwitch >= 0 && w.reloadPhase === 'shell') { w.state = 'ready'; const target = this.pendingSwitch; this.pendingSwitch = -1; this.switchTo(target); return; }
    w.reloadPhase = w.mag >= w.def.mag || w.reserve <= 0 || w.cancel ? 'end' : 'shell';
    w.duration = w.reloadPhase === 'end' ? w.def.reloadEnd : w.def.reloadShell; w.transferred = false;
  }
  eject(w) {
    w.vm.group.updateWorldMatrix(true, true); w.vm.ejectPort.getWorldPosition(_eject);
    this.G.player.getRight(_right); _vel.copy(_right).multiplyScalar(this.G.rng.range(1.8, 2.8)); _vel.y += this.G.rng.range(1.2, 2); _vel.add(this.G.player.vel);
    _ang.set(this.G.rng.range(20, 40), this.G.rng.range(20, 40), this.G.rng.range(20, 40));
    this.G.particles.ejectCasing(w.def.casing, _eject, _vel, _ang);
  }
  shoot() {
    const w = this.current, d = w.def, rng = this.G.rng;
    this.G.player.getAimRay(_origin, _base); this.render(); w.vm.group.updateWorldMatrix(true, true); w.vm.muzzle.getWorldPosition(_muzzle);
    _right.crossVectors(_base, _up.set(0, 1, 0)).normalize(); _up.crossVectors(_right, _base).normalize();
    const angle = rng() * Math.PI * 2, radius = Math.tan(degToRad(this.getSpreadDeg())) * Math.sqrt(rng());
    const aimX = Math.cos(angle) * radius, aimY = Math.sin(angle) * radius, rotation = rng() * Math.PI * 2;
    let anyHit = false;
    for (let i = 0; i < d.pellets; i++) {
      let x = aimX, y = aimY;
      if (w.id === 'shotgun') {
        if (i > 0) { const inner = i <= 3, a = rotation + (inner ? (i - 1) * Math.PI * 2 / 3 : Math.PI / 5 + (i - 4) * Math.PI * 2 / 5), r = Math.tan(degToRad(d.patternRingDeg[inner ? 0 : 1])); x += Math.cos(a) * r; y += Math.sin(a) * r; }
        const a = rng() * Math.PI * 2, r = Math.tan(degToRad(d.patternJitterDeg)) * Math.sqrt(rng()); x += Math.cos(a) * r; y += Math.sin(a) * r;
      }
      _dir.copy(_base).addScaledVector(_right, x).addScaledVector(_up, y).normalize();
      const world = this.G.colliders.raycast(_origin, _dir, BALLISTICS.maxDist, MASK.BULLET, _world);
      const hit = this.G.enemies.raycast(_origin, _dir, world ? world.dist : BALLISTICS.maxDist, _enemy);
      if (hit) {
        const falloff = 1 + (d.minFactor - 1) * clamp((hit.dist - d.fullRange) / (d.minRange - d.fullRange), 0, 1);
        const damage = d.damage * damageMultiplier(hit.group, w.id, hit.enemy.type) * falloff;
        this.G.enemies.applyDamage(hit.enemy, hit.part, damage, hit.point, _dir, w.id); _end.copy(hit.point); anyHit = true;
      } else if (world) { _end.copy(world.point); this.G.bus.emit('shot-hit-world', { pos: world.point, normal: world.normal, surface: world.surface, tag: world.tag, weapon: w.id }); }
      else _end.copy(_origin).addScaledVector(_dir, BALLISTICS.maxDist);
      _eject.copy(_muzzle).addScaledVector(_dir, 0.15); this.G.particles.tracer(_eject, _end, d.tracerRadius, d.tracerLen);
    }
    if (!this.infiniteAmmo) w.mag--;
    w.nextShotTime = 60 / d.rpm; w.sinceLastShot = 0; w.fireT = 0; w.state = 'firing'; w.pumpEjected = false; w.cue = 0;
    w.bloomDeg = Math.min(d.maxBloomDeg, w.bloomDeg + d.bloomDeg); this.buffer = 0;
    const recoil = this.G.player.recoilTarget;
    if (w.id === 'rifle') { const row = RIFLE_PATTERN[Math.min(w.recoilIndex, 11)]; recoil.pitch += degToRad(row[0] * rng.range(0.9, 1.1)); recoil.yaw += degToRad(row[1] + rng.range(-0.08, 0.08) + (w.recoilIndex >= 12 ? rng.range(-0.35, 0.35) : 0)); }
    else { recoil.pitch += degToRad(d.kickPitchDeg * rng.range(0.95, 1.1)); recoil.yaw += degToRad(rng.range(-d.kickYawDeg, d.kickYawDeg)); recoil.roll += degToRad(rng.range(-(d.kickRollDeg || 0), d.kickRollDeg || 0)); }
    this.G.player.recoilHold = RECOIL.holdTime; w.recoilIndex++;
    w.kick.velocity.z += d.vmKickBack * 30; w.rotationKick.velocity.x += degToRad(d.vmKickUpDeg) * 30;
    this.G.particles.muzzleFlash(_muzzle, _base, d.flashScale * rng.range(0.8, 1.2), rng.int(4)); this.G.lighting.flashMuzzle(_muzzle, d.flashLight);
    if (w.id !== 'shotgun') this.eject(w);
    setSlideLocked(w.vm, w.id === 'pistol' && !w.mag);
    this.G.stats.shotsFired++; if (anyHit) this.G.stats.shotsHit++;
    this.G.bus.emit('shot-fired', { weapon: w.id, origin: _origin, dir: _base, muzzle: _muzzle, pellets: d.pellets }); this.G.hud.onShot();
  }
  update(dt) {
    if (!this.G.started || this.G.paused || this.G.player.dead) return;
    const input = this.G.input;
    this.dryT -= dt; this.raiseDelay = Math.max(0, this.raiseDelay - dt);
    if (this.wasSprinting && !this.G.player.sprinting) this.raiseDelay = this.current.def.raiseAfterSprint;
    this.wasSprinting = this.G.player.sprinting;
    for (const w of this.list) { w.nextShotTime -= dt; w.sinceLastShot += dt; w.fireT += dt; w.kick.update(dt); w.rotationKick.update(dt); if (w.sinceLastShot > 0.35) w.recoilIndex = 0; if (w.sinceLastShot > w.def.bloomDelay) w.bloomDeg = Math.max(0, w.bloomDeg - dt * w.def.bloomRecoverDegPerS); }
    if (input.switchTo >= 0) this.switchTo(input.switchTo); else if (input.cycle) this.switchTo((this.index + input.cycle + 3) % 3); else if (input.lastWeapon) this.switchLast();
    let w = this.current;
    if (w.state === 'lowering' || w.state === 'raising') {
      this.switchT -= dt;
      if (this.switchT <= 0) { if (w.state === 'lowering') { this.outgoing.state = 'holstered'; w.state = 'raising'; this.switchT += w.def.raise; } else { w.state = 'ready'; this.outgoing = null; } }
    } else if (w.state === 'firing') {
      if (w.id !== 'shotgun') w.state = 'ready'; else if (w.fireT >= w.def.shotTime) { w.state = 'pumping'; w.pumpT = w.fireT - w.def.shotTime; }
    } else if (w.state === 'pumping') {
      const old = w.pumpT; w.pumpT += dt;
      if (old < 0.12 && w.pumpT >= 0.12) this.sound('pumpBack');
      if (!w.pumpEjected && w.pumpT >= w.def.pumpEjectAt) { this.eject(w); w.pumpEjected = true; }
      if (old < 0.55 && w.pumpT >= 0.55) this.sound('pumpForward');
      if (w.pumpT >= w.def.pumpTime) w.state = 'ready';
    }
    if (input.reload) this.reload();
    if (input.fireJustPressed) this.buffer = 0.08;
    const held = input.fire || this.triggerDown;
    if (w.state === 'reloading') { if (w.id === 'shotgun' && ((held && w.mag) || this.G.player.sprinting)) w.cancel = true; this.reloadTick(w, dt); }
    if (this.autoReload >= 0) { this.autoReload -= dt; if (this.autoReload <= 0) { this.autoReload = -1; this.reload(); } }
    w = this.current;
    if ((w.def.mode === 'auto' ? held || this.buffer > 0 : w.def.mode === 'pump' ? held || this.buffer > 0 : this.buffer > 0)) {
      if (this.canFire()) this.shoot(); else if (!w.mag) this.empty();
    }
    this.buffer = Math.max(0, this.buffer - dt);
  }
  render() {
    for (const w of this.list) {
      resetPose(w.vm);
      const showing = w === this.current && w.state !== 'lowering' || w === this.outgoing && this.current.state === 'lowering';
      if (!showing) { w.vm.group.scale.setScalar(0); continue; }
      if (this.current.state === 'lowering') poseSwitch(w.vm, clamp(1 - this.switchT / w.def.lower, 0, 1), true);
      else if (w.state === 'raising') poseSwitch(w.vm, clamp(1 - this.switchT / w.def.raise, 0, 1), false);
      else if (w.state === 'reloading') { if (w.id === 'shotgun') poseShotgunReload(w.vm, w.reloadPhase, clamp(w.reloadT / w.duration, 0, 1)); else poseReload(w.vm, w.id, clamp(w.reloadT / w.duration, 0, 1), w.reloadEmpty); }
      else if (w.state === 'pumping') posePump(w.vm, w.pumpT / w.def.pumpTime);
      else if (w.fireT < 0.12) poseFire(w.vm, w.id, w.fireT / 0.12);
      if (this.G.player.sprinting) { w.vm.group.position.fromArray(w.vm.sprint.pos); w.vm.group.rotation.set(...w.vm.sprint.rot); }
      w.vm.group.position.add(w.kick.value); w.vm.group.rotation.x += w.rotationKick.value.x; w.vm.group.rotation.z += w.rotationKick.value.z;
    }
  }
  reset() {
    this.index = 0; this.lastIndex = 1; this.current = this.list[0]; this.outgoing = null;
    this.triggerDown = this.wasSprinting = false; this.buffer = this.raiseDelay = this.dryT = this.switchT = 0; this.autoReload = this.pendingSwitch = -1;
    for (const w of this.list) { Object.assign(w, { mag: w.def.mag, reserve: w.def.reserve, state: w === this.current ? 'ready' : 'holstered', nextShotTime: 0, bloomDeg: 0, recoilIndex: 0, sinceLastShot: 1, fireT: 1, pumpT: 0, reloadT: 0, reloadPhase: '', reloadEmpty: false, cancel: false }); w.kick.reset(); w.rotationKick.reset(); setSlideLocked(w.vm, false); resetPose(w.vm); }
    this.render();
  }
  dispose() { for (const w of this.list) { this.G.player.viewRoot.remove(w.vm.group); w.vm.mesh.geometry.dispose(); w.vm.mesh.skeleton.dispose(); for (const m of w.vm.mesh.material) m.dispose(); } }
}
