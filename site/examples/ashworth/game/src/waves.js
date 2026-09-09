import * as THREE from 'three';
import { WAVES, CRATE, waveConfig, trackForWave } from './constants.js';
const _forward = new THREE.Vector3(), _toward = new THREE.Vector3();
// DESIGN NOTE: §4.6.2 specifies a 25 s hard door-open limit, omitted from the constants table.
const DOORS_OPEN_MAX = 25;
export class Waves {
  constructor(G) { this.G = G; }
  init() {
    this.off = []; this.queue = []; this.deliveries = []; this.closing = [];
    this.off.push(this.G.bus.on('train-stop', () => { if (this.state === 'train') this.dock(); }));
    this.off.push(this.G.bus.on('train-doors-open', () => {
      if (this.state !== 'train') return;
      this.state = 'active'; this.openTime = 0;
      this.deliveries.forEach((d, i) => { d.delay = i * this.config.trainCadence; });
      this.G.bus.emit('wave-start', { wave: this.wave, source: 'train' });
    }));
    this.off.push(this.G.bus.on('train-gone', () => { this.lateDelay = WAVES.lateArrivalDelay; }));
    this.off.push(this.G.bus.on('enemy-exited', event => this.releaseDoor(event.enemy, false)));
    this.off.push(this.G.bus.on('enemy-killed', event => { this.killsThisWave++; this.releaseDoor(event.enemy, true); }));
    this.off.push(this.G.bus.on('shot-fired', () => { this.shotsThisWave++; }));
    this.off.push(this.G.bus.on('enemy-hit', () => { this.hitsThisWave = this.G.stats.shotsHit; }));
    this.off.push(this.G.bus.on('player-death', () => { if (this.state !== 'gameover') { this.state = 'gameover'; this.G.bus.emit('game-over', { wave: this.wave, ...this.G.stats }); } }));
    this.reset();
  }
  prepare(n) {
    this.wave = n; this.config = waveConfig(n); this.nextTrack = trackForWave(n + 1);
    this.queue.length = this.deliveries.length = this.closing.length = 0;
    this.spawnedThisWave = this.killsThisWave = this.shotsThisWave = this.hitsThisWave = 0;
    this.totalThisWave = this.config.count; this.built = false; this.doorIndex = 0;
    this.spawnTimer = WAVES.wave1FirstSpawn; this.lateDelay = Infinity;
    this.openTime = this.holdTime = 0; this.drainTime = -1;
  }
  buildQueue() {
    if (this.built) return; this.built = true;
    const c = this.config, remaining = { shambler: c.shamblers, runner: c.runners, brute: c.brutes };
    for (let i = 0; i < c.count; i++) {
      const allowed = Object.keys(remaining).filter(type => remaining[type] > 0 && (type !== 'brute' || i >= Math.ceil(c.count * 0.25)) && (type !== 'runner' || !(this.queue[i - 1]?.type === 'runner' && this.queue[i - 2]?.type === 'runner')));
      // Weight by remaining counts, reserving non-runners to separate the remaining runners.
      const viable = allowed.filter(type => { const runners = remaining.runner - Number(type === 'runner'), others = remaining.shambler + remaining.brute - Number(type !== 'runner'); return runners <= 2 * (others + 1); });
      const choices = viable.length ? viable : allowed;
      if (!choices.length) throw Error('Wave composition cannot satisfy ordering constraints');
      let pick = this.G.rng() * choices.reduce((sum, type) => sum + remaining[type], 0), type = choices[0];
      for (const candidate of choices) { pick -= remaining[candidate]; if (pick < 0) { type = candidate; break; } }
      remaining[type]--; this.queue.push({ type, source: i < c.trainBatch ? 'train' : 'door' });
    }
  }
  begin() {
    if (this.state !== 'idle') return;
    this.prepare(1); this.state = 'intro'; this.timer = WAVES.introTime;
    this.G.station.crate.setArmed(true); this.G.station.crate.setOpen(false);
  }
  skipToWave(n) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('Wave must be a positive integer');
    this.G.enemies.killAll({ silent: true }); this.G.train.reset(); this.G.lighting.endEmergency(); this.clearDoors(); this.prepare(n);
    this.G.station.crate.setArmed(true); this.G.station.crate.setOpen(false);
    if (n === 1) { this.state = 'intro'; this.timer = WAVES.introTime; }
    else { this.state = 'train'; this.G.train.callTrain(trackForWave(n)); }
  }
  skipBreather() { if (this.state === 'breather') this.callTrainNow(); }
  callTrainNow() {
    if (this.state !== 'breather') return;
    this.prepare(this.wave + 1); this.state = 'train'; this.G.train.callTrain(trackForWave(this.wave));
  }
  spawnEntry(index, sp, state) {
    if (index < 0 || this.G.enemies.aliveCount >= this.config.maxAlive) return null;
    const entry = this.queue[index], e = this.G.enemies.spawn(entry.type, sp, this.config, { state });
    if (!e) return null;
    this.queue.splice(index, 1); this.spawnedThisWave++; sp.busy = true;
    if (this.wave === 1) e.speed = e.def.speed * this.G.rng.range(0.85, 1.05);
    if (sp.kind !== 'train') sp.open(); return e;
  }
  dock() {
    this.buildQueue(); const points = this.G.train.getDoorSpawnPoints().slice();
    for (let i = points.length - 1; i > 0; i--) { const j = this.G.rng.int(i + 1); [points[i], points[j]] = [points[j], points[i]]; }
    this.deliveries = points.map(sp => ({ sp, enemyId: null, delay: 0, first: true }));
    for (const delivery of this.deliveries) this.fillDoor(delivery);
  }
  fillDoor(d) {
    if (d.enemyId !== null || d.sp.busy) return;
    const index = this.queue.findIndex(entry => entry.source === 'train'); if (index < 0) return;
    for (const e of this.G.enemies.alive) if (e.pos.distanceToSquared(d.sp.pos) < 1.44) return;
    const e = this.spawnEntry(index, d.sp, 'waiting');
    if (e) { d.enemyId = e.id; d.delay = this.config.trainCadence; }
  }
  releaseDoor(e, killed) {
    const sp = e.spawnPoint; if (!sp) return;
    sp.busy = false;
    if (sp.kind === 'train') {
      const d = this.deliveries.find(item => item.enemyId === e.id);
      if (d) { d.enemyId = null; d.delay = this.config.trainCadence; d.first = false; }
    } else if (killed) sp.close();
    else this.closing.push({ sp, time: 1.5 });
  }
  closeTrain() {
    for (const entry of this.queue) if (entry.source === 'train') entry.source = 'door';
    for (const e of this.G.enemies.getAll()) if (e.spawnPoint?.kind === 'train' && ['waiting', 'exiting'].includes(e.state)) this.G.enemies.forceExit(e);
    this.G.train.closeDoors(); this.spawnTimer = 0;
  }
  trainDelivery(dt) {
    if (this.G.train.state !== 'doorsOpen') return;
    this.openTime += dt;
    this.holdTime = this.G.enemies.aliveCount >= this.config.maxAlive ? this.holdTime + dt : 0;
    if (this.openTime >= DOORS_OPEN_MAX || this.holdTime >= WAVES.maxAliveHoldToClose) { this.closeTrain(); return; }
    for (const d of this.deliveries) {
      if (d.enemyId !== null && !this.G.enemies.byId(d.enemyId)) { d.enemyId = null; d.sp.busy = false; }
      if (d.enemyId === null) this.fillDoor(d);
      else {
        const e = this.G.enemies.byId(d.enemyId);
        d.delay -= dt;
        if (e?.state === 'waiting' && d.delay <= 0) {
          e.state = 'exiting'; e.vel.setScalar(0);
          // First passenger hesitates inside the doorway before crossing the sill.
          if (d.first) { e.state = 'waiting'; d.first = false; d.delay = 0.4; }
        }
      }
    }
    const pending = this.queue.some(entry => entry.source === 'train') || this.deliveries.some(d => d.enemyId !== null);
    if (!pending) { if (this.drainTime < 0) this.drainTime = WAVES.doorsCloseAfterBatch; this.drainTime -= dt; if (this.drainTime <= 0) this.closeTrain(); }
  }
  resupply() {
    if (!this.G.station.crate.armed || this.state === 'idle' || this.state === 'gameover') return false;
    this.G.weapons.resupplyAll(); this.G.player.heal(50); this.G.station.crate.setArmed(false); this.G.station.crate.setOpen(true);
    this.G.bus.emit('resupply', { wave: this.wave }); return true;
  }
  interact() {
    const crate = this.G.station.crate, p = this.G.player.pos;
    _toward.copy(crate.pos).sub(p); _toward.y = 0; const distance = _toward.length();
    this.G.player.getForward(_forward); _forward.y = 0; _forward.normalize();
    const near = distance <= CRATE.interactDist && (distance < 0.001 || _forward.dot(_toward.divideScalar(distance)) >= CRATE.interactCosAngle);
    const text = near && crate.armed ? 'E — RESUPPLY' : near && this.state === 'breather' ? 'E — CALL TRAIN' : '';
    this.G.hud.prompt(text);
    if (this.G.input.interact && text) { if (crate.armed) this.resupply(); else this.skipBreather(); }
  }
  update(dt) {
    if (this.state === 'idle' || this.state === 'gameover') return;
    this.interact();
    for (let i = this.closing.length - 1; i >= 0; i--) { const c = this.closing[i]; c.time -= dt; if (c.time <= 0) { if (!c.sp.busy) c.sp.close(); this.closing.splice(i, 1); } }
    if (this.state === 'intro') {
      this.timer -= dt; if (this.timer <= 1e-8) { this.buildQueue(); this.state = 'active'; this.G.bus.emit('wave-start', { wave: this.wave, source: 'doors' }); } return;
    }
    if (this.state === 'cleared') { this.timer -= dt; if (this.timer <= 0) { this.state = 'breather'; this.breatherRemaining = this.config.breather; } return; }
    if (this.state === 'breather') { this.breatherRemaining = Math.max(0, this.breatherRemaining - dt); if (!this.breatherRemaining) this.callTrainNow(); return; }
    if (this.state !== 'active') return;
    this.trainDelivery(dt);
    if (Number.isFinite(this.lateDelay)) this.lateDelay -= dt;
    if (this.wave === 1 || this.G.train.state === 'idle' && this.lateDelay <= 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 1e-8) {
        const sp = this.G.station.spawnPoints[this.doorIndex % 2 ? 'west-gate' : 'mezz-door'];
        if (!sp.busy) {
          const e = this.spawnEntry(this.queue.findIndex(entry => entry.source === 'door'), sp, 'spawning');
          if (e) { this.doorIndex++; this.spawnTimer += this.config.cadence + (this.wave > 1 && this.doorIndex % 2 ? WAVES.sideStagger : 0); }
        }
      }
    }
    if (!this.queue.length && this.G.enemies.aliveCount === 0 && this.G.train.state === 'idle') {
      this.state = 'cleared'; this.timer = WAVES.clearedTime;
      this.G.station.crate.setArmed(true); this.G.station.crate.setOpen(false);
      this.G.bus.emit('wave-clear', { wave: this.wave, kills: this.killsThisWave, shots: this.shotsThisWave, hits: this.hitsThisWave });
    }
  }
  clearDoors() {
    for (const sp of Object.values(this.G.station.spawnPoints)) { sp.busy = false; sp.close(); }
    for (const sp of this.G.train.getDoorSpawnPoints()) sp.busy = false;
  }
  reset() {
    this.state = 'idle'; this.wave = 1; this.config = null; this.nextTrack = 'A'; this.queue.length = this.deliveries.length = this.closing.length = 0;
    this.spawnedThisWave = this.totalThisWave = this.killsThisWave = this.shotsThisWave = this.hitsThisWave = this.breatherRemaining = 0;
    this.timer = 0; this.built = false; this.clearDoors(); this.G.station.crate.setArmed(false); this.G.station.crate.setOpen(false);
  }
  dispose() { for (const off of this.off) off(); }
}
