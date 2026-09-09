import * as THREE from 'three';
import { WEAPONS } from './constants.js';
import { Pool, clamp } from './utils.js';
import { RECIPES, LOOP_RECIPES, createVoiceGraph } from './audio-recipes.js';
export { RECIPES } from './audio-recipes.js';
const _forward = new THREE.Vector3(), _up = new THREE.Vector3(), _pos = new THREE.Vector3();
const UI = new Set(['hitMarker', 'killMarker', 'uiClick', 'waveClear', 'ammoPickup']);
const VOCALS = new Set(['moan', 'shriek', 'grumble', 'growl', 'attackShriek', 'bruteRoar', 'spawnGroan', 'hurtGrunt', 'deathMoan']);
export class Audio {
  constructor(G) { this.G = G; this.ctx = null; this.enabled = false; this.state = 'locked'; }
  init() {
    this.enabled = false; this.state = this.G.opts.audio === false ? 'disabled' : 'locked';
    this.voices = []; this.loops = new Set(); this.last = new Map(); this.off = []; this.serial = 0; this.masterGain = 0.8;
    this.trainLoops = []; this.ambientLoops = []; this.beatPhase = 0; this.dripT = 6; this.heartbeat = null;
    const on = (event, fn) => this.off.push(this.G.bus.on(event, fn));
    on('shot-fired', e => this.play(WEAPONS[e.weapon].sfx));
    on('weapon-empty', () => this.play('dryFire'));
    on('weapon-reload-start', () => this.play('reloadStart'));
    on('weapon-switch', e => { this.play('holster'); this.play(e.weapon === 'pistol' ? 'drawPistol' : e.weapon === 'rifle' ? 'drawRifle' : 'drawShotgun', { delay: 0.22 }); });
    on('shot-hit-world', e => { const name = { metal: 'impactMetal', tile: 'impactTile', glass: 'impactGlass', wood: 'impactWood', paper: 'impactSoft', plastic: 'impactSoft', concrete: 'impactConcrete' }[e.surface]; if (name) this.play(name, { pos: e.pos }); });
    on('enemy-hit', e => { this.play(e.headshot ? 'headshot' : 'hitFlesh', { pos: e.pos }); this.play(e.killed ? 'killMarker' : 'hitMarker'); });
    on('enemy-landed', e => this.play('bodyThud', { pos: e.pos }));
    on('enemy-vocal', e => { const name = e.kind === 'death' ? 'deathMoan' : e.kind === 'hurt' ? 'hurtGrunt' : e.kind === 'spawn' ? 'spawnGroan' : e.enemy.type === 'runner' ? 'shriek' : e.enemy.type === 'brute' ? 'grumble' : 'moan'; this.play(name, { pos: e.pos, rate: e.enemy.type === 'runner' ? 1.4 : e.enemy.type === 'brute' ? 0.6 : 1 }); });
    on('enemy-attack', e => this.play(e.enemy.type === 'brute' ? 'bruteRoar' : e.enemy.type === 'runner' ? 'attackShriek' : 'growl', { pos: e.pos }));
    // Hurt vocals arrive through the per-enemy rate-limited vocal event;
    // stagger must not duplicate the same hit's grunt.
    on('enemy-footstep', e => this.play(e.heavy ? 'enemyStepHeavy' : e.drag ? 'enemyDrag' : 'enemyStepLight', { pos: e.pos }));
    on('player-hit', () => this.play('playerHurt'));
    on('player-footstep', e => this.play(e.surface === 'metal' ? 'footstepMetal' : 'footstep', { gain: e.sprinting ? 1.3 : 1 }));
    on('game-start', () => this.startAmbience());
    on('game-over', () => { this.play('gameOver'); for (const l of [...this.loops]) this.stopLoop(l); this.setDuck(600); });
    on('wave-start', () => this.play('waveSting')); on('wave-clear', () => this.play('waveClear'));
    on('train-called', () => this.play('alarmChime'));
    on('train-approach', () => { this.play('trainHorn', { pos: this.trainPos() }); this.trainLoops.push(this.startLoop('trainRumble', { pos: this.trainPos(), gain: 0.1 })); });
    on('train-brake', () => this.trainLoops.push(this.startLoop('brakeScreech', { pos: this.trainPos(), gain: 0 })));
    on('train-stop', () => { this.stopTrainLoops(); this.play('trainStopHiss', { pos: this.trainPos() }); });
    on('train-chime', () => { this.play('doorChime'); this.play('paVoice', { delay: 0.6 }); });
    on('train-doors-open', () => this.play('doorHiss', { pos: this.trainPos() }));
    on('train-doors-close', () => { this.play('doorHiss', { pos: this.trainPos() }); this.play('doorThunk', { pos: this.trainPos(), delay: 0.1 }); });
    on('train-depart', () => { for (const name of ['trainRumble', 'motorWhine']) this.trainLoops.push(this.startLoop(name, { pos: this.trainPos() })); });
    on('train-gone', () => this.stopTrainLoops());
    on('spawn-door-open', e => { this.play('hingeCreak', { pos: e.pos }); if (e.id === 'west-gate') this.play('gateClang', { pos: e.pos }); });
    on('light-flicker', e => this.play('buzzTick', { pos: e.pos }));
    on('resupply', () => this.play('crateOpen')); on('ammo-pickup', () => this.play('ammoPickup'));
    this.visibility = () => { if (!this.ctx || this.G.opts.headless) return; if (document.hidden) this.ctx.suspend(); else if (this.enabled) this.ctx.resume(); };
    document.addEventListener('visibilitychange', this.visibility);
  }
  trainPos() { return _pos.set(this.G.train?.noseX || 0, 0, this.G.train?.track === 'B' ? 6.65 : -6.65); }
  buildContext() {
    const ctx = this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const gain = value => { const n = ctx.createGain(); n.gain.value = value; return n; };
    this.master = gain(this.masterGain); this.sfxBus = gain(1); this.ambBus = gain(0.7); this.uiBus = gain(0.6);
    this.duckFilter = ctx.createBiquadFilter(); this.duckFilter.type = 'lowpass'; this.duckFilter.frequency.value = 20000;
    this.compressor = ctx.createDynamicsCompressor(); Object.assign(this.compressor.threshold, { value: -14 }); this.compressor.knee.value = 20; this.compressor.ratio.value = 4; this.compressor.attack.value = 0.004; this.compressor.release.value = 0.25;
    this.reverbSend = gain(0.25); this.reverbReturn = gain(1); this.reverb = ctx.createConvolver();
    this.sfxBus.connect(this.duckFilter); this.ambBus.connect(this.duckFilter); this.sfxBus.connect(this.reverbSend); this.ambBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb); this.reverb.connect(this.reverbReturn); this.reverbReturn.connect(this.duckFilter); this.duckFilter.connect(this.master); this.uiBus.connect(this.master); this.master.connect(this.compressor); this.compressor.connect(ctx.destination);
    this.noise = {};
    for (const kind of ['white', 'pink', 'brown']) {
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), data = buffer.getChannelData(0); let low = 0, mid = 0, brown = 0;
      for (let i = 0; i < data.length; i++) { const n = Math.random() * 2 - 1; low = 0.997 * low + n * 0.04; mid = 0.95 * mid + n * 0.15; brown = (brown + 0.02 * n) / 1.02; data[i] = kind === 'white' ? n : kind === 'brown' ? brown * 3.5 : (low + mid + n * 0.2) * 0.65; }
      this.noise[kind] = buffer;
    }
    const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 2.2), ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) { const data = impulse.getChannelData(channel); let filtered = 0;
      for (let i = Math.floor(ctx.sampleRate * 0.015); i < data.length; i++) { const t = i / ctx.sampleRate, cutoff = 7000 * Math.pow(900 / 7000, t / 2.2), alpha = 1 - Math.exp(-2 * Math.PI * cutoff / ctx.sampleRate); filtered += alpha * (Math.random() * 2 - 1 - filtered); data[i] = filtered * Math.exp(-3.2 * t); }
      [11, 17, 23, 31, 39, 48].forEach((ms, i) => { data[Math.floor((ms + channel * 0.7) / 1000 * ctx.sampleRate)] += 0.5 * Math.pow(0.7, i); });
    }
    this.reverb.buffer = impulse;
    this.panners = new Pool(24, () => { const node = ctx.createPanner(); node.panningModel = 'equalpower'; node.distanceModel = 'inverse'; node.refDistance = 2; node.maxDistance = 60; node.rolloffFactor = 1.3; return { node, owner: null }; });
  }
  async unlock() {
    if (this.G.opts.audio === false) return;
    if (!this.ctx) this.buildContext();
    await this.ctx.resume(); this.enabled = true; this.state = 'enabled'; if (this.G.started && !this.G.gameOver) this.startAmbience();
  }
  async enable() { this.G.opts.audio = true; return this.unlock(); }
  async disable() { this.G.opts.audio = false; this.enabled = false; this.state = 'disabled'; if (this.ctx) await this.ctx.suspend(); }
  get voicesActive() { return this.voices.length; }
  priority(name) { return /Shot$/.test(name) ? 7 : name === 'playerHurt' ? 6 : /train|brake|door|motor/i.test(name) ? 5 : /growl|Roar|attack/.test(name) ? 4 : /impact|hit|headshot/.test(name) ? 3 : /step/i.test(name) ? 2 : 1; }
  allocate(name, pos, loop = false) {
    const priority = this.priority(name), candidates = this.voices.filter(v => !v.loop);
    if (VOCALS.has(name)) {
      const vocals = candidates.filter(v => VOCALS.has(v.name));
      if (vocals.length >= 6) { const distance = pos ? pos.distanceToSquared(this.G.player.pos) : 0; vocals.sort((a, b) => b.distance - a.distance); if (vocals[0].distance <= distance) return null; this.release(vocals[0]); }
    }
    if (!loop && candidates.length >= 32) { candidates.sort((a, b) => a.priority - b.priority || a.serial - b.serial); if (candidates[0].priority > priority) return null; this.release(candidates[0]); }
    let panner = null;
    if (pos) {
      panner = this.panners.tryAcquire();
      if (!panner) { const oldest = [...this.voices, ...this.loops].filter(v => v.panner).sort((a, b) => a.serial - b.serial)[0]; if (oldest) this.release(oldest); panner = this.panners.tryAcquire(); }
      if (!panner) return null;
    }
    const voice = { name, serial: ++this.serial, priority, loop, panner, nodes: [], sources: [], active: true, distance: pos ? pos.distanceToSquared(this.G.player.pos) : 0 };
    voice.gain = this.ctx.createGain(); voice.nodes.push(voice.gain);
    const bus = loop ? this.ambBus : UI.has(name) ? this.uiBus : this.sfxBus;
    if (panner) { panner.owner = voice; this.position(panner.node, pos); voice.gain.connect(panner.node); panner.node.connect(bus); } else voice.gain.connect(bus);
    if (loop) this.loops.add(voice); else this.voices.push(voice); return voice;
  }
  position(panner, pos) { panner.positionX.value = pos.x; panner.positionY.value = pos.y; panner.positionZ.value = pos.z; }
  play(name, { pos, gain = 1, rate = 1, delay = 0 } = {}) {
    if (!this.enabled || this.G.opts.audio === false || !this.ctx || !RECIPES[name]) return null;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(name) ?? -Infinity) < 0.025) return null;
    const voice = this.allocate(name, pos); if (!voice) return null; this.last.set(name, now);
    voice.gain.gain.value = gain;
    const graph = createVoiceGraph(this.ctx, voice.gain, { at: now + delay, rate, noise: this.noise });
    RECIPES[name](graph, this.ctx); voice.nodes.push(...graph.nodes); voice.sources.push(...graph.sources); voice.end = graph.end;
    const last = voice.sources.reduce((a, b) => b, null);
    if (last) last.onended = () => { if (this.ctx.currentTime + 0.01 >= voice.end) this.release(voice); };
    return voice;
  }
  startLoop(name, { pos, gain = 1 } = {}) {
    if (!this.enabled || this.G.opts.audio === false || !LOOP_RECIPES[name]) return null;
    const voice = this.allocate(name, pos, true); if (!voice) return null;
    voice.gain.gain.value = gain; voice.filters = []; voice.oscillators = [];
    for (const [kind, frequency, level, cutoff] of LOOP_RECIPES[name]) {
      const source = kind in this.noise ? this.ctx.createBufferSource() : this.ctx.createOscillator();
      if (kind in this.noise) { source.buffer = this.noise[kind]; source.loop = true; } else { source.type = kind; source.frequency.value = frequency; voice.oscillators.push(source); }
      const filter = this.ctx.createBiquadFilter(); filter.type = name === 'brakeScreech' ? 'bandpass' : 'lowpass'; filter.frequency.value = cutoff; filter.Q.value = name === 'brakeScreech' ? 8 : 0.7;
      const amp = this.ctx.createGain(); amp.gain.value = level; source.connect(filter); filter.connect(amp); amp.connect(voice.gain); source.start();
      voice.sources.push(source); voice.nodes.push(source, filter, amp); voice.filters.push(filter);
    }
    return voice;
  }
  stopLoop(handle, fadeTime = 0.3) {
    if (!handle?.active) return;
    handle.gain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.001, fadeTime / 3)); handle.end = this.ctx.currentTime + fadeTime;
    for (const s of handle.sources) { try { s.stop(handle.end); } catch {} }
    handle.sources[0].onended = () => this.release(handle);
  }
  setLoopParam(handle, param, value) {
    if (!handle?.active) return;
    if (param === 'gain') handle.gain.gain.setTargetAtTime(Math.max(0, value), this.ctx.currentTime, 0.05);
    else if (param === 'frequency') for (const s of handle.oscillators) s.frequency.setTargetAtTime(Math.max(1, value), this.ctx.currentTime, 0.1);
    else if (param === 'lowpass') for (const f of handle.filters) f.frequency.setTargetAtTime(clamp(value, 20, 20000), this.ctx.currentTime, 0.1);
    else if (param === 'pos' && handle.panner) this.position(handle.panner.node, value);
  }
  release(voice) {
    if (!voice?.active) return; voice.active = false;
    for (const source of voice.sources) { source.onended = null; try { source.stop(); } catch {} }
    for (const node of voice.nodes) node.disconnect();
    if (voice.panner) { voice.panner.node.disconnect(); voice.panner.owner = null; this.panners.release(voice.panner); voice.panner = null; }
    if (voice.loop) this.loops.delete(voice); else { const i = this.voices.indexOf(voice); if (i >= 0) this.voices.splice(i, 1); }
  }
  setListener(pos, forward, up) {
    if (!this.ctx) return; const l = this.ctx.listener;
    for (const [prefix, v] of [['position', pos], ['forward', forward], ['up', up]]) { l[`${prefix}X`].value = v.x; l[`${prefix}Y`].value = v.y; l[`${prefix}Z`].value = v.z; }
  }
  setDuck(hz) { if (this.ctx) this.duckFilter.frequency.setTargetAtTime(hz ?? 20000, this.ctx.currentTime, 0.08); }
  setMasterGain(value) { this.masterGain = clamp(value, 0, 1); if (this.master) this.master.gain.setTargetAtTime(this.masterGain, this.ctx.currentTime, 0.03); }
  startAmbience() {
    if (!this.enabled || this.ambientLoops.some(l => l?.active)) return;
    this.ambientLoops = [this.startLoop('ambience')];
    for (const source of this.G.props?.getHumSources() || []) this.ambientLoops.push(this.startLoop('vendingHum', { pos: source.pos || source }));
  }
  stopTrainLoops() { for (const loop of this.trainLoops) this.stopLoop(loop); this.trainLoops.length = 0; }
  update(dt) {
    if (!this.enabled || !this.ctx) return;
    for (const v of [...this.voices, ...this.loops]) if (v.end !== undefined && this.ctx.currentTime >= v.end) this.release(v);
    this.G.camera.getWorldDirection(_forward); _up.set(0, 1, 0).applyQuaternion(this.G.camera.quaternion); this.setListener(this.G.camera.position, _forward, _up);
    const train = this.G.train;
    if (train) for (const loop of this.trainLoops) {
      this.setLoopParam(loop, 'pos', this.trainPos());
      this.setLoopParam(loop, 'gain', loop?.name === 'brakeScreech' ? train.speed < 9.8 ? Math.min(1, train.speed / 3) : 0 : Math.min(1, train.speed / 10));
      if (loop?.name === 'motorWhine') this.setLoopParam(loop, 'frequency', 80 + train.speed * 25);
    }
    const low = !this.G.player.dead && this.G.player.health < 30;
    if (low && !this.heartbeat?.active) this.heartbeat = this.startLoop('heartbeat', { gain: 0 });
    if (this.heartbeat?.active) { if (!low) this.stopLoop(this.heartbeat); else { this.beatPhase = (this.beatPhase + dt * (110 - this.G.player.health * 40 / 30) / 60) % 1; const pulse = Math.exp(-this.beatPhase * 35) + (this.beatPhase > 0.2 ? 0.6 * Math.exp(-(this.beatPhase - 0.2) * 45) : 0); this.setLoopParam(this.heartbeat, 'gain', pulse * (1 - this.G.player.health / 30)); } }
    this.dripT -= dt; if (this.dripT <= 0 && this.G.started) { this.dripT = 4 + Math.random() * 8; _pos.set(Math.random() * 50 - 25, 0.1, Math.random() < 0.5 ? -2.5 : 2.5); this.play('drip', { pos: _pos }); }
  }
  reset() { for (const v of [...this.voices, ...this.loops]) this.release(v); this.last.clear(); this.trainLoops.length = this.ambientLoops.length = 0; this.heartbeat = null; this.setDuck(null); this.beatPhase = 0; this.dripT = 6; }
  async dispose() { this.reset(); for (const off of this.off) off(); document.removeEventListener('visibilitychange', this.visibility); if (this.ctx) await this.ctx.close(); this.enabled = false; }
}
