import * as THREE from 'three';
import * as C from './constants.js';
import { clamp } from './utils.js';
import { getTextureStats } from './textures.js';
const point = new THREE.Vector3();
export function installDebugApi(G) {
  const requireStarted = () => { if (!G.started) throw Error('game not started'); };
  let eventSerial = 0, lastRingHead = 0, history = [];
  const originalEmit = G.bus.emit.bind(G.bus);
  G.bus.emit = (name, payload = {}) => {
    // Record before dispatch: listeners may synchronously emit nested events.
    // Reading the ring's newest slot after dispatch duplicates the nested event
    // and loses the original enemy-hit/player-death event.
    const data = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) data[key] = value;
      else if (value && value.id !== undefined) data[`${key}Id`] = value.id;
    }
    history.push({ i: eventSerial++, t: G.bus.time, type: name, data });
    if (history.length > 512) history.shift();
    originalEmit(name, payload);
  };
  const originalClear = G.bus.clear.bind(G.bus); G.bus.clear = () => { originalClear(); history = []; eventSerial = 0; };
  const api = {
    G, ready: false, version: C.VERSION, errors: [], nullSystems: [],
    setReady() { api.ready = true; }, setProgramsBaseline(n) { G.perf.programsBaseline = n; }, recordTick() {},
    disableAudio() { G.opts.audio = false; G.audio?.disable?.(); }, enableAudio() { G.opts.audio = true; G.audio?.enable?.(); },
    seed(n) { G.rng.seed(n); },
    start(opts = {}) { G.hooks.start({ manual: true, ...opts }); return api.getState(); },
    restart() { G.hooks.restart(); return api.getState(); },
    pause() { G.paused = true; G.hud.showPause(); }, resume() { G.paused = false; G.hud.hidePause(); },
    setManualStepping(value) { G.manual = !!value; },
    step(dt = C.FIXED_DT, n = 1) { requireStarted(); if (!Number.isFinite(dt) || !Number.isInteger(n) || n < 0 || n > 36000) throw new RangeError('Invalid step'); for (let i = 0; i < n; i++) G.hooks.stepOnce(clamp(dt, 1 / 240, 0.1)); G.hooks.renderOnce(); return api.getState(); },
    setTime(t) { requireStarted(); if (!Number.isFinite(t)) throw new RangeError('Invalid time'); let n = 0; while (G.time < t && n++ < 36000) G.hooks.stepOnce(); G.hooks.renderOnce(); return api.getState(); },
    fastForward(seconds) { return api.setTime(G.time + seconds); }, renderOnce() { G.hooks.renderOnce(); },
    setTrainTimeScale(k) { G.train.timeScale = Math.max(0, k); },
    setLook(yaw, pitch) { requireStarted(); G.player.setLook(yaw, pitch); },
    look(yaw, pitch) { requireStarted(); G.player.setLook(G.player.yaw + yaw, G.player.pitch + pitch); },
    lookAt(x, y, z) { requireStarted(); const e = G.player.eye; G.player.setLook(Math.atan2(e.x - x, e.z - z), Math.atan2(y - e.y, Math.hypot(x - e.x, z - e.z))); },
    aimAt(x, y, z) { requireStarted(); G.player.aimAt(x, y, z); },
    aimAtEnemy(id, group = 'torso') { requireStarted(); const e = G.enemies.byId(id); if (!e || !G.enemies.alive.includes(e)) return false; G.enemies.hitVolumeCenter(e, group, point); G.player.aimAt(point.x, point.y, point.z); return true; },
    move(dir, dz) { requireStarted(); let x = 0, z = 0; if (typeof dir === 'number') { x = dir; z = dz ?? 0; } else if (Array.isArray(dir)) { x = dir[0]; z = dir.length === 3 ? dir[2] : dir[1]; } else if (dir) { x = dir.x; z = dir.z; } G.input.setMoveWorld(x || 0, z || 0); },
    moveWorld(x, z) { api.move(x, z); }, moveLocal(x, z) { requireStarted(); G.input.setMove(x, z); },
    setSprint(value) { G.input.setSprint(value); }, setAds(value) { G.input.setAds(value); },
    fire() { requireStarted(); return G.weapons.fire(); }, setTrigger(value) { requireStarted(); G.input.holdFire(value); G.weapons.setTrigger(value); },
    reload() { requireStarted(); return G.weapons.reload(); },
    switchWeapon(value) { requireStarted(); const i = typeof value === 'string' ? C.WEAPON_ORDER.indexOf(value) : value - 1; if (!Number.isInteger(i) || i < 0 || i > 2) { console.warn('switchWeapon is 1-based (1 pistol, 2 rifle, 3 shotgun)'); return null; } return G.weapons.switchTo(i); },
    interact() { requireStarted(); G.input.pressInteract(); }, teleport(x, z, yaw, pitch) { requireStarted(); G.player.teleport(x, z, yaw, pitch); },
    killAllEnemies() { requireStarted(); const n = G.enemies.killAll(); G.waves.queue.length = 0; return n; },
    killEnemy(id) { requireStarted(); const e = G.enemies.byId(id); if (e) G.enemies.kill(e); },
    spawnEnemy(type, x, z, opts = {}) { requireStarted(); const y = G.station.floorHeightAt(x, z); if (y === null) throw new RangeError('Enemy spawn must be walkable'); return G.enemies.spawn(type, null, G.waves.config || {}, { ...opts, pos: point.set(x, y, z), state: opts.state || 'chase' })?.id ?? null; },
    skipToWave(n) { requireStarted(); if (G.gameOver) G.hooks.restart(); G.waves.skipToWave(n); return api.getState(); },
    skipBreather() { requireStarted(); G.waves.skipBreather(); }, callTrain() { requireStarted(); G.waves.callTrainNow(); },
    setGodMode(value) { G.player.god = !!value; }, setInfiniteAmmo(value) { G.weapons.infiniteAmmo = !!value; },
    setEnemySpeedScale(k) { G.enemies.speedScale = Math.max(0, k); }, setEnemyAI(value) { G.enemies.aiEnabled = !!value; },
    resupply() { requireStarted(); return G.waves.resupply(); }, setHealth(h) { requireStarted(); G.player.setHealth(h); }, giveAmmo() { requireStarted(); G.weapons.resupplyAll(); },
    setQuality(value) { G.post.setQuality(value); }, hideHud(value) { G.hud.setHidden(value); }, showFps(value) { G.hud.el.fps.classList.toggle('hidden', !value); },
    screenshotHint() { api.teleport(-24, 0.4); api.setLook(-Math.PI / 2, -0.05); return 'Platform length: tactile strip, columns, signs, stairs and warm/cool lighting.'; },
    setTuning(path, value) { if (!Number.isFinite(value)) throw new TypeError('Tuning must be numeric'); const keys = path.split('.'); let obj = C; for (const key of keys.slice(0, -1)) { if (!Object.hasOwn(obj, key)) throw Error('Unknown tuning path'); obj = obj[key]; } const key = keys.at(-1); if (typeof obj[key] !== 'number') throw Error('Unknown numeric tuning'); obj[key] = value; },
    getTuning() { return JSON.parse(JSON.stringify({ WEAPONS: C.WEAPONS, PLAYER: C.PLAYER, ENEMY: C.ENEMY, ENEMY_TYPES: C.ENEMY_TYPES, TRAIN: C.TRAIN, POST: C.POST })); },
    getState() {
      const p = G.player, w = G.waves, t = G.train, weapons = G.weapons;
      return { mode: !G.started ? 'menu' : G.gameOver ? 'gameover' : 'playing', started: G.started, paused: G.paused, manual: G.manual, audio: G.audio?.state || (G.opts.audio ? 'locked' : 'disabled'), time: G.time, frame: G.frame, ...G.perf, wave: w?.wave || 1, waveState: w?.state || 'idle', enemiesAlive: G.enemies?.aliveCount || 0, enemiesQueued: w?.queue?.length || 0, enemiesTotalThisWave: w?.totalThisWave || 0, enemiesSpawned: w?.spawnedThisWave || 0, corpses: G.enemies?.corpseCount || 0, breatherRemaining: w?.breatherRemaining || 0, playerHealth: p?.health ?? 100, playerPos: p?.pos?.toArray() || [0, 0, 0], playerYaw: p?.yaw || 0, playerPitch: p?.pitch || 0, playerAlive: !p?.dead, weapon: weapons?.current?.id || 'pistol', weaponState: weapons?.current?.state || 'ready', ammo: weapons?.current ? weapons.getAmmo() : { mag: 15, reserve: 90 }, ammoAll: weapons?.current ? weapons.getAmmoAll() : {}, spread: weapons?.current ? weapons.getSpreadDeg() : 0, recoil: [p?.recoil?.pitch || 0, p?.recoil?.yaw || 0], trainState: t?.state || 'idle', trainTrack: t?.track || null, trainNoseX: t?.noseX || 0, trainCenterX: t?.centerX || 0, trainSpeed: t?.speed || 0, trainT: t?.T || 0, trainDoors: t?.doorOpenAmount || 0, gameOver: G.gameOver, gameOverReason: G.gameOverReason, kills: G.stats.kills, score: G.stats.score, crateArmed: !!G.station?.crate?.armed, lowHealth: G.lowHealth, emergency: !!G.lighting?.emergency, drawCalls: G.post?.info?.calls || 0, errors: api.errors.length };
    },
    getEnemies() { return G.enemies.getAll().map(e => { G.enemies.hitVolumeCenter(e, 'head', point); return { id: e.id, type: e.type, variant: e.variant, state: e.state, hp: e.hp, maxHp: e.maxHp, pos: e.pos.toArray(), yaw: e.yaw, headPos: point.toArray(), distToPlayer: e.pos.distanceTo(G.player.pos), alive: G.enemies.alive.includes(e) }; }); },
    getEnemy(id) { return api.getEnemies().find(e => e.id === id) || null; }, getStats() { return { ...G.stats, killsByType: { ...G.stats.killsByType }, accuracy: G.stats.shotsHit / Math.max(1, G.stats.shotsFired) }; },
    getEvents(since = 0) { return { next: eventSerial, events: history.filter(e => e.i >= since).map(e => ({ ...e, data: { ...e.data } })) }; },
    getWaveConfig(n) { return C.waveConfig(n); },
    getPerf() { const textures = getTextureStats(); let lights = 0; G.scene.traverse(o => { if (o.isLight) lights++; }); return { ...(G.post?.renderInfo?.() || {}), textures: G.renderer.info.memory.textures, programs: G.renderer.info.programs.length, canvasTextures: textures.gpuTextures, textureMB: textures.estimatedBytes / 1048576, lights, ...G.perf }; },
    getRenderInfo() { return api.getPerf(); }, getInitTimings() { return { ...G.timings, textures: getTextureStats().timings }; },
    getPools() { const fx = G.particles, count = items => items.filter(i => i.active).length; return { tracers: { live: count(fx.tracerItems), cap: C.FX.tracers }, casings: { live: count(fx.casings.items), cap: C.FX.casings }, particles: { live: fx.points.reduce((n, p) => n + [...p.expiry].filter(t => t > fx.clock).length, 0), cap: C.FX.particles }, smoke: { live: count(fx.smokeItems), cap: C.FX.smoke }, decals: Object.fromEntries(['holes', 'splats', 'pools'].map((name, i) => [name, { live: count(G.decals.batches[i].items), cap: G.decals.batches[i].items.length }])), enemies: { alive: G.enemies.aliveCount, corpses: G.enemies.corpseCount, free: C.ENEMY.poolSize - G.enemies.pool.active }, voices: { live: G.audio.voicesActive, cap: 32 } }; },
    getLevelInfo() { return { bounds: C.PLATFORM, playerSpawn: C.PLAYER_SPAWN, cratePos: C.CRATE.pos, spawnPoints: Object.keys(C.SPAWN_POINTS), train: { centerX: 0, parkX: 300, doorXs: Array.from({ length: 4 }, (_, i) => C.TRAIN.doorLocalX.map(x => C.trainCarCenterX(i) + x)).flat(), tracks: { A: -6.65, B: 6.65 } }, mezz: { turnstileX: 41.5, gateZ: C.TURNSTILES.gateZ, keepClear: C.NAV_KEEP_CLEAR }, nav: { cell: C.NAV.cell, agentRadius: C.NAV.agentRadius }, api: { move: 'world-xz {x,z}|{x,y,z}|[x,z]|[x,y,z]|(dx,dz)', moveLocal: '(strafe, forward); forward = camera -Z', switchWeapon: '1-based: 1 pistol, 2 rifle, 3 shotgun', yaw: '0 = -Z, -pi/2 = +X (stairs)', wave: 'increments at train-called; skipToWave(n) sets it synchronously' } }; },
    floorHeightAt(x, z) { return G.station.floorHeightAt(x, z); }, navDistanceAt(x, z) { const d = G.nav.distanceAt(x, z); return Number.isFinite(d) ? d : -1; }, sampleLuminance() { return G.post.sampleLuminance(); }, sampleLuminanceLinear() { return G.post.sampleLuminanceLinear(); },
  };
  window.addEventListener('error', e => api.errors.push(e.message)); window.addEventListener('unhandledrejection', e => api.errors.push(String(e.reason)));
  const error = console.error.bind(console); console.error = (...args) => { api.errors.push(args.map(String).join(' ')); error(...args); };
  window.__game = api; return api;
}
