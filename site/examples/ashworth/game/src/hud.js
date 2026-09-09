import * as THREE from 'three';
import { clamp, wrapAngle } from './utils.js';
export class Hud {
  constructor(G) { this.G = G; }
  init() {
    this.el = {}; for (const element of document.querySelectorAll('[id]')) this.el[element.id] = element;
    this.pips = [...this.el['ammo-pips'].children];
    this.arcs = [...this.el['damage-arcs'].children].map(el => ({ el, life: 0, pos: new THREE.Vector3() }));
    this.off = []; this.cache = new Map(); this.hidden = false;
    const on = (name, fn) => this.off.push(this.G.bus.on(name, fn));
    on('wave-start', e => this.banner(`WAVE ${e.wave}`, e.wave === 1 ? 'KEEP MOVING · AIM FOR THE HEAD · R TO RELOAD' : 'STAND CLEAR OF THE CLOSING DOORS', 3));
    on('wave-clear', e => this.banner(`WAVE ${e.wave} CLEARED`, 'STATION SECURE · RESUPPLY BEFORE THE NEXT TRAIN', 3));
    on('train-called', e => this.banner('INCOMING TRAIN', `WAVE ${e.wave} · TRACK ${e.track}`, 3));
    on('enemy-hit', e => this.hitMarker(e.killed ? 'kill' : e.headshot ? 'head' : 'hit'));
    on('enemy-killed', () => { this.killT = 0.15; });
    on('player-hit', e => { this.hurtT = 0.5; if (e.from) this.damageFrom(e.from); });
    on('game-over', e => this.showGameOver(this.G.stats, this.G.gameOverReason || this.deathReason || 'The station claimed another passenger.'));
    on('player-death', e => { this.deathReason = e.reason; });
    on('debug-message', e => this.toast(e.text || e.message || ''));
    on('resupply', () => this.toast('RESUPPLIED · RESERVES FULL · +50 HEALTH'));
    this.reset(); this.showStart(); this.el.fps.classList.toggle('hidden', !this.G.opts.debug);
  }
  text(id, value) { const text = String(value); if (this.cache.get(id) !== text) { this.el[id].textContent = text; this.cache.set(id, text); } }
  style(id, property, value) { const key = `${id}:${property}`; if (this.cache.get(key) !== value) { this.el[id].style[property] = value; this.cache.set(key, value); } }
  showStart() { this.el.start.classList.remove('hidden'); this.el.pause.classList.add('hidden'); this.el.gameover.classList.add('hidden'); }
  hideStart() { this.el.start.classList.add('hidden'); }
  showPause() { if (!this.G.gameOver) this.el.pause.classList.remove('hidden'); }
  hidePause() { this.el.pause.classList.add('hidden'); }
  setHint(text) { this.text('start-hint', text || 'CLICK TO ENTER'); this.text('pause-hint', text || 'Your station is waiting.'); }
  showGameOver(stats, reason) {
    this.hidePause(); this.hideStart(); this.el.gameover.classList.remove('hidden');
    this.text('go-title', /train/i.test(reason || '') ? 'HIT BY TRAIN' : 'YOU DIED'); this.text('go-reason', reason || 'END OF SERVICE');
    const types = stats.killsByType || {};
    const seconds = Math.floor(stats.timeSurvived ?? this.G.time);
    const values = { wave: this.G.waves.wave, types: `${types.shambler || 0} / ${types.runner || 0} / ${types.brute || 0}`, headshots: stats.headshots || 0, accuracy: `${Math.round(100 * (stats.shotsHit || 0) / Math.max(1, stats.shotsFired || 0))}%`, damage: Math.round(stats.damageDealt || 0), time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, shots: stats.shotsFired || 0, streak: stats.bestStreak || 0, score: stats.score || 0 };
    for (const [id, value] of Object.entries(values)) this.text(`stat-${id}`, value);
  }
  banner(text, sub = '', seconds = 2) { this.text('banner-text', text); this.text('banner-sub', sub); this.bannerT = this.bannerDuration = seconds; }
  prompt(text) { this.promptText = text || ''; this.text('prompt', this.promptText); this.style('prompt', 'opacity', this.promptText ? '1' : '0'); }
  toast(text, seconds = 2) { this.text('toast', text); this.toastT = seconds; }
  hitMarker(kind) { this.el.hitmarker.className = kind; this.markerT = this.markerDuration = kind === 'kill' ? 0.2 : 0.12; this.contractT = 0.1; }
  onShot() { this.contractT = 0.1; }
  damageFrom(pos) {
    let arc = this.arcs.find(a => a.life > 0 && a.pos.distanceToSquared(pos) < 0.25) || this.arcs.find(a => a.life <= 0);
    if (!arc) arc = this.arcs.reduce((a, b) => a.life < b.life ? a : b);
    arc.pos.copy(pos); arc.life = 1.2;
  }
  setFps(fps) { this.text('fps', `${Math.round(fps)} FPS`); }
  setHidden(value) { this.hidden = !!value; this.el.hud.classList.toggle('hidden', this.hidden); }
  update(dt) {
    const G = this.G, player = G.player, waves = G.waves, weapons = G.weapons;
    for (const key of ['bannerT', 'toastT', 'markerT', 'contractT', 'hurtT', 'killT']) this[key] = Math.max(0, this[key] - dt);
    this.style('banner', 'opacity', String(Math.min(1, (this.bannerDuration - this.bannerT) / 0.2, this.bannerT / 0.4)));
    this.style('toast', 'opacity', String(Math.min(1, this.toastT / 0.3)));
    this.style('hitmarker', 'opacity', String(this.markerT / this.markerDuration));
    this.style('hitmarker', 'transform', `scale(${(this.el.hitmarker.className === 'kill' ? 1.3 : 1) + 0.3 * this.markerT / this.markerDuration})`);
    this.style('kills-num', 'transform', `scale(${1 + this.killT * 2})`);
    const ammo = weapons.getAmmo(), w = weapons.current, reloading = weapons.getState() === 'reloading';
    this.text('ammo-name', weapons.getName()); this.text('ammo-mag', ammo.mag); this.text('ammo-reserve', ammo.reserve);
    this.el['ammo-mag'].classList.toggle('low', ammo.mag > 0 && ammo.mag <= w.def.mag * 0.3); this.el['ammo-mag'].classList.toggle('empty', ammo.mag === 0);
    this.el['reload-label'].classList.toggle('hidden', ammo.mag !== 0 || reloading);
    this.style('ammo-line', 'opacity', reloading ? '0' : '1'); this.style('reload-bar', 'opacity', reloading ? '1' : '0');
    this.style('reload-fill', 'transform', `scaleX(${reloading ? clamp(w.reloadT / w.duration, 0, 1) : 0})`);
    if (this.lastMag !== ammo.mag || this.lastCapacity !== w.def.mag) { this.pips.forEach((pip, i) => { pip.classList.toggle('hidden', i >= w.def.mag); pip.classList.toggle('off', i >= ammo.mag); }); this.lastMag = ammo.mag; this.lastCapacity = w.def.mag; }
    const health = clamp(player.health, 0, 100); this.ghost += (health - this.ghost) * Math.min(1, dt / 0.6);
    if (Math.abs(this.ghost - health) < 0.01) this.ghost = health;
    this.text('health-num', Math.ceil(health)); this.style('health-fill', 'transform', `scaleX(${health / 100})`); this.style('health-ghost', 'transform', `scaleX(${this.ghost / 100})`);
    this.el['health-box'].classList.toggle('low', health <= 50); this.el['health-box'].classList.toggle('critical', health <= 30);
    this.text('kills-num', G.stats.kills); this.text('wave-label', `WAVE ${waves.wave}`);
    const sub = waves.state === 'breather' ? `NEXT TRAIN IN 0:${String(Math.ceil(waves.breatherRemaining)).padStart(2, '0')}` : waves.state === 'train' ? 'INCOMING TRAIN' : waves.state === 'cleared' ? 'WAVE CLEARED — STATION SECURE' : waves.state === 'intro' ? 'SURVIVE THE NIGHT' : `${G.enemies.aliveCount + waves.queue.length} LEFT`;
    this.text('wave-sub', sub); this.el['wave-sub'].classList.toggle('pulse', ['train', 'breather', 'cleared'].includes(waves.state));
    this.el.crosshair.classList.toggle('hidden', player.sprinting || G.input.ads || player.dead || !G.started); this.el['sprint-glyph'].classList.toggle('hidden', !player.sprinting || player.dead);
    const gap = (6 + Math.tan(weapons.getSpreadDeg() * Math.PI / 180) * innerHeight / 2 / Math.tan(G.camera.fov * Math.PI / 360)) * (this.contractT > 0 ? 0.85 : 1);
    const gapText = `${gap.toFixed(2)}px`; if (this.lastGap !== gapText) { this.el.crosshair.style.setProperty('--gap', gapText); this.lastGap = gapText; }
    const low = clamp(1 - health / 30, 0, 1), flash = this.hurtT * 1.1;
    this.style('vignette', 'opacity', String(clamp(flash + (health <= 30 ? 0.15 + low * 0.3 + 0.12 * Math.max(0, Math.sin(G.time * 10)) : 0), 0, 1)));
    G.post.setHurt(flash); G.post.setLowHealth(low); G.post.setDead(player.dead ? clamp(player.deathT / 0.8, 0, 1) : 0);
    for (const arc of this.arcs) if (arc.life > 0) { arc.life = Math.max(0, arc.life - dt); const bearing = Math.atan2(-(arc.pos.x - player.pos.x), -(arc.pos.z - player.pos.z)); arc.el.style.transform = `rotate(${-wrapAngle(bearing - player.yaw)}rad)`; arc.el.style.opacity = String(Math.min(1, arc.life / 0.4)); }
  }
  reset() {
    this.bannerT = this.toastT = this.markerT = this.contractT = this.hurtT = this.killT = 0; this.bannerDuration = this.markerDuration = 1; this.ghost = 100;
    this.lastMag = this.lastCapacity = -1; this.lastGap = ''; this.deathReason = ''; this.prompt(null);
    for (const arc of this.arcs) { arc.life = 0; arc.el.style.opacity = '0'; }
    this.el.gameover.classList.add('hidden'); this.hidePause(); this.style('banner', 'opacity', '0'); this.style('toast', 'opacity', '0'); this.style('hitmarker', 'opacity', '0');
  }
  dispose() { for (const off of this.off) off(); }
}
