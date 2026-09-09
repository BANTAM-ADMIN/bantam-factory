// Procedural voice graphs. All sources are stopped and disconnected by their owner.
export const RECIPES = {};
function recipe(name, build) { RECIPES[name] = build; }
export function createVoiceGraph(ctx, dest, opts) {
  const nodes = [], sources = [], at = opts.at ?? ctx.currentTime, rate = opts.rate ?? 1;
  let end = at;
  const track = node => { nodes.push(node); return node; };
  function layer(kind, frequency, duration, gain, delay = 0, filterType = 'lowpass', cutoff = 20000, finish = frequency) {
    const start = at + delay, length = duration / rate;
    const source = track(kind in opts.noise ? ctx.createBufferSource() : ctx.createOscillator());
    if (kind in opts.noise) { source.buffer = opts.noise[kind]; source.loop = true; source.playbackRate.value = rate; }
    else { source.type = kind; source.frequency.setValueAtTime(Math.max(1, frequency * rate), start); source.frequency.exponentialRampToValueAtTime(Math.max(1, finish * rate), start + length); }
    const filter = track(ctx.createBiquadFilter()); filter.type = filterType; filter.frequency.value = cutoff; filter.Q.value = filterType === 'bandpass' ? 0.9 : 0.7;
    const env = track(ctx.createGain()); env.gain.setValueAtTime(0.0001, start); env.gain.linearRampToValueAtTime(gain, start + Math.min(0.003, length / 4)); env.gain.exponentialRampToValueAtTime(0.0001, start + length);
    source.connect(filter); filter.connect(env); env.connect(dest); source.start(start); source.stop(start + length + 0.01);
    sources.push(source); end = Math.max(end, start + length + 0.01); return { source, filter, env };
  }
  return { nodes, sources, layer, at, get end() { return end; } };
}
recipe('pistolShot', g => { g.layer('white', 0, 0.13, 1, 0, 'bandpass', 1800); g.layer('sine', 180, 0.09, 0.7, 0, 'lowpass', 20000, 55); g.layer('square', 3000, 0.002, 0.18); });
recipe('rifleShot', g => { g.layer('white', 0, 0.1, 0.85, 0, 'bandpass', 1300); g.layer('sawtooth', 220, 0.06, 0.4, 0, 'lowpass', 1500, 70); g.layer('sine', 140, 0.1, 0.6, 0, 'lowpass', 20000, 45); });
recipe('shotgunShot', g => { g.layer('brown', 0, 0.28, 1, 0, 'lowpass', 900); g.layer('white', 0, 0.05, 0.8, 0, 'bandpass', 2500); g.layer('sine', 110, 0.18, 0.8, 0, 'lowpass', 20000, 35); g.layer('white', 0, 0.04, 0.25, 0.04, 'highpass', 1800); });
recipe('dryFire', g => { g.layer('white', 0, 0.006, 0.35, 0, 'highpass', 3000); g.layer('triangle', 1100, 0.012, 0.2); });
for (const [i, name] of ['reloadStart', 'magOut', 'magIn', 'slideRack', 'boltRack', 'shellInsert', 'pumpBack', 'pumpForward', 'pumpShort', 'magDrop'].entries()) recipe(name, g => {
  g.layer('white', 0, 0.025 + i * 0.003, 0.3, 0, 'bandpass', 600 + i * 190);
  if (/In|Rack|pump/.test(name)) g.layer('white', 0, 0.035, 0.2, name === 'magIn' ? 0.06 : 0.08, 'highpass', 1800);
  if (/Rack/.test(name)) for (const f of [1900, 2600, 3400]) g.layer('sine', f, 0.12, 0.04);
  if (name === 'magDrop') g.layer('sine', 100, 0.12, 0.3, 0, 'lowpass', 400, 50);
});
for (const name of ['holster', 'drawPistol', 'drawRifle', 'drawShotgun']) recipe(name, g => { g.layer('pink', 0, 0.12, 0.2, 0, 'bandpass', 1000); g.layer('sine', 1600, 0.03, 0.07, 0.07); });
recipe('casingBounce', g => { for (const f of [2900, 5100]) g.layer('sine', f * (0.85 + Math.random() * 0.3), 0.12, 0.09); });
recipe('hullBounce', g => g.layer('brown', 0, 0.03, 0.25, 0, 'lowpass', 500));
for (const name of ['footstep', 'footstepMetal', 'enemyStepLight', 'enemyStepHeavy', 'enemyDrag']) recipe(name, g => {
  g.layer(name.startsWith('enemy') ? 'brown' : 'pink', 0, name === 'enemyDrag' ? 0.12 : 0.06, 0.25, 0, 'lowpass', name.startsWith('enemy') ? 250 : 450);
  if (name === 'footstepMetal') g.layer('sine', 900, 0.08, 0.1);
  if (name === 'enemyStepHeavy') g.layer('sine', 50, 0.16, 0.3);
});
for (const name of ['moan', 'shriek', 'grumble', 'growl', 'attackShriek', 'bruteRoar', 'spawnGroan', 'hurtGrunt', 'deathMoan']) recipe(name, (g, ctx) => {
  const brute = /grumble|brute/.test(name), shriek = /[Ss]hriek/.test(name), attack = /growl|attack|Roar|hurt/.test(name);
  const f = (brute ? 60 : shriek ? 170 : 115) * (0.9 + Math.random() * 0.2), duration = name === 'hurtGrunt' ? 0.23 : attack ? 0.45 : name === 'deathMoan' ? 0.8 : 1.35;
  for (const [kind, detune] of [['sawtooth', -7], ['square', 7]]) {
    const l = g.layer(kind, f, duration, 0.17, 0, 'lowpass', shriek ? 1500 : 600, name === 'deathMoan' ? f * 0.7 : name === 'spawnGroan' ? f * 1.25 : f);
    l.source.detune.value = detune;
    l.filter.frequency.setValueAtTime(300, g.at); l.filter.frequency.linearRampToValueAtTime(attack ? 1400 : 900, g.at + duration * 0.45); l.filter.frequency.linearRampToValueAtTime(400, g.at + duration);
    const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = shriek ? 5 : 4; depth.gain.value = shriek ? 18 : 6; lfo.connect(depth); depth.connect(l.source.frequency); lfo.start(g.at); lfo.stop(g.end); g.nodes.push(lfo, depth); g.sources.push(lfo);
    l.env.gain.cancelScheduledValues(g.at); l.env.gain.setValueAtTime(0.0001, g.at); l.env.gain.linearRampToValueAtTime(0.17, g.at + Math.min(attack ? 0.05 : 0.25, duration / 3)); l.env.gain.exponentialRampToValueAtTime(0.0001, g.at + duration);
  }
  if (attack) g.layer('white', 0, duration, 0.12, 0, 'bandpass', 800);
  if (brute) g.layer('sine', 40, duration, 0.25);
});
recipe('bodyThud', g => { g.layer('sine', 70, 0.2, 0.6, 0, 'lowpass', 500, 40); g.layer('brown', 0, 0.15, 0.4, 0, 'lowpass', 200); });
for (const name of ['hitFlesh', 'headshot']) recipe(name, g => { g.layer('brown', 0, 0.07, 0.6, 0, 'lowpass', 350); g.layer('sine', 95, 0.05, 0.3); g.layer('white', 0, 0.015, 0.3, 0, 'bandpass', 1200); if (name === 'headshot') { g.layer('white', 0, 0.025, 0.5, 0, 'highpass', 2500); g.layer('sine', 900, 0.04, 0.2, 0, 'lowpass', 20000, 300); } });
for (const name of ['hitMarker', 'killMarker']) recipe(name, g => { g.layer('sine', 1800, 0.018, 0.25); g.layer('sine', 1800, 0.018, 0.25, 0.04); if (name === 'killMarker') g.layer('sine', 600, 0.04, 0.2, 0.06); });
for (const name of ['impactConcrete', 'impactTile', 'impactMetal', 'impactGlass', 'impactWood', 'impactSoft', 'ricochet']) recipe(name, g => {
  const soft = /Wood|Soft/.test(name), glass = name === 'impactGlass';
  g.layer('white', 0, soft ? 0.025 : 0.06, 0.35, 0, soft ? 'lowpass' : glass ? 'highpass' : 'bandpass', soft ? 350 : glass ? 4000 : 2800);
  if (/Metal|ricochet|Glass/.test(name)) for (const f of glass ? [4100, 5300, 6700] : [1700, 2300, 3100]) g.layer('sine', f, 0.25, 0.08, 0, 'lowpass', 12000, name === 'ricochet' ? f * 0.35 : f);
  if (name === 'impactTile') g.layer('sine', 3200, 0.04, 0.15);
});
recipe('playerHurt', g => { g.layer('brown', 0, 0.12, 0.7, 0, 'lowpass', 500); g.layer('sine', 55, 0.25, 0.4); g.layer('sawtooth', 220, 0.15, 0.3, 0, 'lowpass', 600, 110); });
recipe('crateOpen', g => { g.layer('white', 0, 0.03, 0.3, 0, 'bandpass', 1900); g.layer('pink', 0, 0.7, 0.25, 0.05, 'bandpass', 700); });
recipe('ammoPickup', g => { g.layer('sine', 880, 0.06, 0.2); g.layer('sine', 1320, 0.06, 0.2, 0.04); });
recipe('uiClick', g => g.layer('triangle', 1600, 0.02, 0.2));
recipe('waveSting', g => { for (const f of [55, 82.4]) g.layer('sawtooth', f, 1.4, 0.25, 0, 'lowpass', 1500); g.layer('pink', 0, 0.8, 0.15, 0.3, 'bandpass', 900); });
recipe('waveClear', g => [261.6, 329.6, 392].forEach((f, i) => g.layer('sine', f, 0.2, 0.3, i * 0.12)));
recipe('gameOver', g => { g.layer('sawtooth', 110, 2.5, 0.3, 0, 'lowpass', 600, 55); g.layer('brown', 0, 0.6, 0.3, 0, 'lowpass', 300); });
recipe('alarmChime', g => { for (let i = 0; i < 6; i++) g.layer('sine', i % 2 ? 620 : 740, 0.3, 0.3, i * 0.3); });
recipe('trainHorn', g => { for (const f of [311, 370]) g.layer('sawtooth', f, 1.2, 0.25, 0, 'lowpass', 1200); });
recipe('doorChime', g => { g.layer('sine', 659, 0.28, 0.3); g.layer('sine', 523, 0.4, 0.3, 0.28); });
for (const name of ['trainStopHiss', 'doorHiss']) recipe(name, g => g.layer('white', 0, name === 'doorHiss' ? 0.7 : 2, 0.25, 0, 'highpass', 2200));
recipe('doorThunk', g => { g.layer('sine', 90, 0.08, 0.4); g.layer('brown', 0, 0.07, 0.2, 0, 'lowpass', 400); });
recipe('paVoice', g => { for (const f of [400, 1100, 2300]) { const l = g.layer('pink', 0, 1.5, 0.2, 0, 'bandpass', f); l.filter.Q.value = 8; for (let i = 1; i < 10; i++) l.filter.frequency.linearRampToValueAtTime(f * (0.7 + Math.random() * 0.6), g.at + i * 0.15); } });
for (const name of ['buzzTick', 'sputter', 'sparkZap']) recipe(name, g => { const count = name === 'sputter' ? 3 : 1; for (let i = 0; i < count; i++) g.layer('square', name === 'sparkZap' ? 2200 : 120, 0.04, 0.08, i * 0.06, 'highpass', 800); if (name === 'sparkZap') g.layer('white', 0, 0.04, 0.3, 0, 'highpass', 3000); });
recipe('hingeCreak', g => g.layer('sawtooth', 180, 0.4, 0.15, 0, 'lowpass', 900, 120));
recipe('gateClang', g => { for (const f of [1100, 1900]) g.layer('sine', f, 0.4, 0.2); g.layer('white', 0, 0.03, 0.2, 0, 'highpass', 1800); });
recipe('drip', g => g.layer('sine', 1400, 0.025, 0.12, 0, 'lowpass', 3000, 900));
recipe('railTick', g => g.layer('pink', 0, 0.025, 0.15, 0, 'lowpass', 450));
// Loop descriptors are rendered by Audio.startLoop using persistent oscillators/buffers.
export const LOOP_RECIPES = {
  ambience: [['sine', 120, 0.05, 380], ['sine', 240, 0.02, 380], ['pink', 0, 0.05, 380], ['brown', 0, 0.04, 180]],
  vendingHum: [['sine', 60, 0.03, 200], ['sine', 120, 0.03, 200], ['pink', 0, 0.02, 200]],
  trainRumble: [['brown', 0, 0.5, 110], ['sine', 38, 0.25, 110], ['pink', 0, 0.2, 250]],
  motorWhine: [['sawtooth', 90, 0.2, 700]],
  brakeScreech: [['white', 0, 0.18, 3000], ['sine', 2900, 0.08, 6000]],
  heartbeat: [['sine', 50, 0.5, 150]],
};
