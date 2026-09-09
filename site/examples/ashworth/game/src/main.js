import * as THREE from 'three';
import { FIXED_DT, MAX_SUBSTEPS, DEFAULT_SEED, PLAYER, POST } from './constants.js';
import { Bus } from './bus.js';
import { Colliders } from './collision.js';
import { mulberry32, clamp } from './utils.js';
import { initMaterials, disposeAllMaterials } from './materials.js';
import { disposeAllTextures } from './textures.js';
import { installDebugApi } from './debug.js';
export function parseOpts(search) {
  const p = new URLSearchParams(search), headless = p.get('headless') === '1' || navigator.webdriver === true && p.get('headless') !== '0';
  const lowfx = p.get('lowfx') === '1', nopost = p.get('nopost') === '1' || p.get('post') === '0';
  return { headless, manual: headless, lowfx, nopost, post: !nopost, audio: p.get('audio') === '0' ? false : !headless, debug: p.get('debug') === '1', seed: parseInt(p.get('seed'), 10) || DEFAULT_SEED, viewer: p.get('viewer') === '1', wave: parseInt(p.get('wave'), 10) || 0, quality: lowfx ? 'low' : 'high' };
}
export function createRenderer(canvas, opts) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = POST.exposure; r.outputColorSpace = THREE.SRGBColorSpace; r.shadowMap.enabled = false; r.info.autoReset = false;
  r.setPixelRatio(opts.lowfx || opts.headless || innerWidth * devicePixelRatio > POST.maxPixelWidth ? 1 : Math.min(devicePixelRatio, POST.maxPixelRatio)); r.setSize(innerWidth, innerHeight); return r;
}
function freshStats() { return { shotsFired: 0, shotsHit: 0, headshots: 0, kills: 0, killsByType: {}, damageDealt: 0, damageTaken: 0, wavesCleared: 0, bestStreak: 0, timeSurvived: 0, score: 0 }; }
export function createContext(canvas, opts) {
  const G = { opts, canvas, renderer: createRenderer(canvas, opts), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(PLAYER.fov, innerWidth / innerHeight, PLAYER.near, PLAYER.far), bus: new Bus(), rng: mulberry32(opts.seed), rngBuild: mulberry32(opts.seed), time: 0, frame: 0, stats: freshStats(), started: false, paused: false, gameOver: false, gameOverReason: null, manual: opts.manual, lowHealth: 0, renderDirty: false, envMap: null, hudRoot: document.getElementById('hud'), overlayRoot: document.getElementById('overlay'), timings: { total: 0, aoBake: 0, envCapture: 0, compile: 0 }, perf: { renders: 0, renderMs: 0, stepMs: 0, fps: 0, initMs: 0, programsBaseline: 0 } };
  G.camera.layers.enable(1); G.camera.layers.enable(2); G.scene.add(G.camera); G.colliders = new Colliders(G);
  G.hooks = { start: o => start(G, o), restart: () => restart(G), stepOnce: dt => stepOnce(G, dt), renderOnce: () => renderOnce(G) }; return G;
}
const systems = ['input', 'station', 'props', 'particles', 'decals', 'lighting', 'post', 'nav', 'player', 'weapons', 'enemies', 'train', 'waves', 'audio', 'hud'];
class NullSystem { constructor(G) { this.G = G; } init() {} update() {} render() {} reset() {} dispose() {} }
export async function boot() {
  const begin = performance.now(), G = createContext(document.getElementById('c'), parseOpts(location.search));
  G.debug = installDebugApi(G);
  initMaterials(G.renderer, G.opts.seed);
  for (const name of systems) {
    try { const module = await import(`./${name}.js`), Class = module[name[0].toUpperCase() + name.slice(1)]; G[name] = new Class(G); }
    catch (error) { console.warn(`Unable to load ${name}: ${error.message}`); G.debug.nullSystems.push(name); G[name] = new NullSystem(G); }
  }
  G.bus.on('player-death', e => { G.gameOverReason = e.reason; });
  G.bus.on('game-over', () => { G.gameOver = true; });
  G.bus.on('wave-clear', () => { G.stats.wavesCleared++; });
  for (const name of systems) { const t = performance.now(); await G[name].init(); G.timings[name] = performance.now() - t; }
  if (G.opts.viewer) { const { OrbitControls } = await import('three/addons/controls/OrbitControls.js'); G.orbit = new OrbitControls(G.camera, G.canvas); G.orbit.target.set(10, 1.5, 0); G.camera.position.set(-16, 3, 1); G.orbit.update(); G.hud.hideStart(); }
  // Parked geometry must participate in the real composer warm-up, including off-camera train batches.
  const culled = []; G.scene.traverse(o => { if (o.isMesh || o.isPoints || o.isSprite) { culled.push([o, o.frustumCulled]); o.frustumCulled = false; } });
  const compile = performance.now(); renderOnce(G); G.post.sampleLuminance(); G.timings.compile = performance.now() - compile;
  G.debug.setProgramsBaseline(G.renderer.info.programs.length);
  for (const [object, value] of culled) object.frustumCulled = value;
  for (const name of systems) G[name].warmupDone?.();
  G.perf.initMs = G.timings.total = performance.now() - begin;
  const button = document.getElementById('start-hint'); button.disabled = false; G.hud.setHint(null);
  if (new URLSearchParams(location.search).get('dispose-test') === '1') {
    const memory = () => ({ geometries: G.renderer.info.memory.geometries, textures: G.renderer.info.memory.textures });
    const baseline = memory();
    // Run before installing the main DOM listeners or RAF so there is only
    // one application loop. Each system detaches its own subscriptions.
    const geometry = new Set();
    G.scene.traverse(o => { if (o.geometry) geometry.add(o.geometry); });
    for (const name of [...systems].reverse()) await G[name].dispose();
    for (const g of geometry) g.dispose();
    disposeAllMaterials(); disposeAllTextures(); G.renderer.renderLists.dispose();
    G.scene.clear(); G.scene.environment = null; G.envMap = null; G.scene.add(G.camera);
    G.colliders = new Colliders(G); G.rng.seed(G.opts.seed); G.rngBuild.seed(G.opts.seed); G.bus.clear();
    initMaterials(G.renderer, G.opts.seed);
    for (const name of systems) await G[name].init();
    const restore = [];
    G.scene.traverse(o => { if (o.isMesh || o.isPoints || o.isSprite) { restore.push([o, o.frustumCulled]); o.frustumCulled = false; } });
    renderOnce(G); G.post.sampleLuminance();
    for (const [o, value] of restore) o.frustumCulled = value;
    for (const name of systems) G[name].warmupDone?.();
    G.debug.setProgramsBaseline(G.renderer.info.programs.length);
    const rebuilt = memory();
    G.debug.disposeReport = { baseline, rebuilt, passed: Object.keys(baseline).every(k => Math.abs(rebuilt[k] - baseline[k]) <= Math.max(1, baseline[k] * 0.05)) };
    if (!G.debug.disposeReport.passed) throw Error(`Dispose/rebuild resource drift: ${JSON.stringify(G.debug.disposeReport)}`);
    G.hud.setHint(null);
  }
  G.debug.setReady();
  window.addEventListener('resize', () => { G.renderer.setSize(innerWidth, innerHeight); G.camera.aspect = innerWidth / innerHeight; G.camera.updateProjectionMatrix(); G.post.resize(innerWidth, innerHeight); G.renderDirty = true; });
  const click = () => { if (!G.debug.ready) return; if (G.gameOver) restart(G); else if (!G.started) start(G, { manual: false }); else { G.paused = false; G.hud.hidePause(); } if (!G.manual && !G.opts.headless) requestLock(G); };
  G.overlayRoot.addEventListener('click', click);
  window.addEventListener('keydown', e => { if (G.gameOver && (e.code === 'KeyR' || e.code === 'Enter')) { restart(G); if (!G.manual && !G.opts.headless) requestLock(G); } });
  document.addEventListener('pointerlockchange', () => { if (G.opts.headless || G.manual || !G.started || G.gameOver) return; G.paused = document.pointerLockElement !== G.canvas; if (G.paused) { G.input.reset(); G.hud.showPause(); } else G.hud.hidePause(); });
  document.addEventListener('pointerlockerror', () => G.hud.setHint('CLICK AGAIN TO RESUME'));
  document.addEventListener('visibilitychange', () => { if (!G.opts.headless && !G.manual && G.started && document.hidden) { G.paused = true; G.input.reset(); G.hud.showPause(); } });
  let previous = performance.now(), accumulator = 0;
  function frame(now) {
    const real = clamp((now - previous) / 1000, 0, 0.1); previous = now;
    // Manual mode is demand-driven even after resize or quality changes.
    // Dirty buffers are refreshed by the next explicit renderOnce/step call.
    if (!G.manual) {
      if (G.started && !G.paused && !G.opts.viewer) { accumulator += real; let n = 0; while (accumulator >= FIXED_DT && n < MAX_SUBSTEPS) { stepOnce(G); accumulator -= FIXED_DT; n++; } if (n === MAX_SUBSTEPS) accumulator = 0; }
      else if (!G.started && !G.opts.viewer) { G.player.setLook(-Math.PI / 2 + Math.sin(now * 0.00012) * 0.07, -0.015 + Math.sin(now * 0.00018) * 0.018); }
      G.orbit?.update(); G.perf.fps += ((real > 0 ? 1 / real : 60) - G.perf.fps) / 30; renderOnce(G);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame); return G;
}
function requestLock(G) { try { const p = G.canvas.requestPointerLock(); p?.catch(() => G.hud.setHint('CLICK AGAIN TO RESUME')); } catch { G.hud.setHint('CLICK AGAIN TO RESUME'); } }
export function start(G, { manual = G.opts.manual } = {}) {
  if (G.started) return;
  G.started = true; G.manual = manual; G.paused = false; G.hud.hideStart(); G.player.reset(); G.hud.banner('WAVE 1', 'LAST STOP · STAY ALIVE', 2);
  if (G.opts.audio) G.audio.unlock().catch(e => console.warn(`Audio unlock: ${e.message}`));
  G.bus.emit('game-start'); if (!G.opts.viewer) G.waves.begin();
  if (G.opts.wave >= 2) G.waves.skipToWave(G.opts.wave);
}
export function restart(G) {
  G.time = G.frame = 0; G.bus.clear(); G.bus.time = 0; G.gameOver = G.paused = false; G.gameOverReason = null; G.started = true;
  G.input.reset();
  for (const name of ['waves', 'enemies', 'train', 'player', 'weapons', 'particles', 'decals', 'lighting', 'station', 'props', 'hud', 'audio', 'nav']) G[name].reset();
  Object.assign(G.stats, freshStats()); G.hud.hideStart(); G.bus.clear(); G.bus.time = 0; G.bus.emit('game-restart'); G.waves.begin(); G.audio.startAmbience();
}
export function stepOnce(G, dt = FIXED_DT) {
  const begin = performance.now();
  try {
    G.time += dt; G.frame++; G.bus.time = G.time;
    for (const name of ['input', 'player', 'nav', 'weapons', 'enemies', 'train', 'waves', 'particles', 'decals', 'lighting', 'station', 'props', 'audio', 'hud']) G[name].update(dt);
    G.lowHealth = clamp(1 - G.player.health / 30, 0, 1); if (!G.player.dead) G.stats.timeSurvived = G.time;
    G.perf.stepMs += (performance.now() - begin - G.perf.stepMs) / Math.min(60, G.frame); G.debug.recordTick();
  } catch (error) { G.debug.errors.push(String(error.stack || error)); throw error; }
}
export function renderOnce(G) {
  const begin = performance.now();
  for (const name of ['player', 'train', 'enemies', 'weapons', 'particles', 'lighting']) G[name].render();
  G.post.render(); G.perf.renders++; G.perf.renderMs += (Math.max(0.001, performance.now() - begin) - G.perf.renderMs) / Math.min(30, G.perf.renders);
  if (G.manual) G.perf.fps = 1000 / G.perf.renderMs; G.hud.setFps(G.perf.fps); G.renderDirty = false;
}
if (!window.__NO_AUTOBOOT) boot().catch(error => { console.error(error); const hint = document.getElementById('start-hint'); if (hint) hint.textContent = 'STATION FAILED TO INITIALIZE — SEE CONSOLE'; });
