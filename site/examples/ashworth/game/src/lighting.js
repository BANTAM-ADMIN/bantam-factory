import * as THREE from 'three';
import { LIGHTS, FOG, FIXTURE_STATES } from './constants.js';
import { getMaterial, cloneMaterial, captureEnvironment } from './materials.js';
import { getTexture } from './textures.js';
import { clamp, damp } from './utils.js';

const _matrix = new THREE.Matrix4(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3();
const _color = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
export class Lighting {
  constructor(G) { this.G = G; }
  init() {
    const { scene } = this.G;
    scene.background = new THREE.Color(FOG.color); scene.fog = new THREE.FogExp2(FOG.color, FOG.density);
    this.group = new THREE.Group(); this.group.name = 'station emitters'; scene.add(this.group);
    this.off = []; this.emergency = false; this.recovering = false; this.emergencyTime = 0;
    this.troffersDim = 1; this.flashTicks = 0; this.flashPower = 0;
    const point = (def, pos) => {
      const light = new THREE.PointLight(def.color, def.intensity || 0, def.distance, def.decay);
      light.position.set(pos.x, pos.y, pos.z); scene.add(light); return light;
    };
    this.lights = {
      hemi: new THREE.HemisphereLight(LIGHTS.hemi.sky, LIGHTS.hemi.ground, LIGHTS.hemi.intensity),
      platform: LIGHTS.platform.xs.map(x => point(LIGHTS.platform, { x, y: LIGHTS.platform.y, z: 0 })),
      mezz: point(LIGHTS.mezz, LIGHTS.mezz),
      wallLamps: LIGHTS.wallLamps.map(p => point(LIGHTS.wallLamp, p)),
      sodium: LIGHTS.sodium.map(p => point(LIGHTS.sodiumLamp, p)),
      trainSpots: [], muzzle: point(LIGHTS.muzzle, { x: 0, y: -50, z: 0 }),
    };
    scene.add(this.lights.hemi);
    for (let i = 0; i < 2; i++) {
      const d = LIGHTS.trainSpot, light = new THREE.SpotLight(d.color, 0, d.distance, d.angle, d.penumbra, d.decay);
      scene.add(light, light.target); this.lights.trainSpots.push(light);
    }
    this.anchors = this.G.station.getLightAnchors();
    const states = [];
    for (const [state, count] of Object.entries(FIXTURE_STATES)) for (let i = 0; i < count; i++) states.push(state);
    for (let i = states.length - 1; i > 0; i--) { const j = this.G.rngBuild.int(i + 1); [states[i], states[j]] = [states[j], states[i]]; }
    this.fixtures = this.anchors.troffers.map((a, i) => ({ ...a, state: i < 24 ? states[i] : i === 26 ? 'flicker' : 'steady', factor: 1, timer: this.G.rngBuild.range(0.03, 0.2), phase: this.G.rngBuild.range(0, 10), interval: this.G.rngBuild.range(3, 8), lastBurst: -1 }));
    const tubeGeo = new THREE.CapsuleGeometry(0.019, 1.2, 2, 6); tubeGeo.rotateZ(Math.PI / 2);
    this.tubes = new THREE.InstancedMesh(tubeGeo, getMaterial('tubeLit'), 56); this.tubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.tubes);
    this.deadTubes = new THREE.InstancedMesh(tubeGeo.clone(), getMaterial('tubeDead'), 56);
    this.deadTubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.deadTubes);
    this.cards = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.4, 0.5), cloneMaterial('additive', { alphaMap: getTexture('glowRadial').alphaMap, opacity: 0.2, side: THREE.DoubleSide }), 28); this.group.add(this.cards);
    this.glowBatches = [this.makeGlowBatch(40, true), this.makeGlowBatch(20, false)];
    this.glowEntries = []; this.signals = []; this.emergencyGlows = [];
    this.buildEmitters();
    const on = (name, fn) => this.off.push(this.G.bus.on(name, fn));
    on('train-called', ({ track }) => { this.beginEmergency(); this.setSignal(track === 'A' ? -1 : 1, 'yellow'); });
    on('train-brake', () => this.setSignal(this.G.train.track === 'A' ? -1 : 1, 'green'));
    on('train-enter', () => { this.recovering = true; });
    on('train-stop', () => { this.endEmergency(); this.setSignal(this.G.train.track === 'A' ? -1 : 1, 'red'); });
    this.updateFixtures(0); this.render();
    captureEnvironment(this.G);
  }
  makeGlowBatch(capacity, fog) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: getTexture('glowRadial').alphaMap }, fogColor: { value: new THREE.Color(FOG.color) }, fogDensity: { value: fog ? FOG.density : 0 } },
      vertexShader: `attribute float aAlpha; varying vec2 vUv; varying vec3 vColor; varying float vAlpha; varying float vDepth;
        void main(){vUv=uv;vColor=instanceColor;vAlpha=aAlpha;vec4 center=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
        vec2 size=vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));center.xy+=position.xy*size;vDepth=-center.z;gl_Position=projectionMatrix*center;}`,
      fragmentShader: `uniform sampler2D map; uniform float fogDensity; varying vec2 vUv; varying vec3 vColor; varying float vAlpha; varying float vDepth;
        void main(){float a=texture2D(map,vUv).g*vAlpha*exp(-fogDensity*fogDensity*vDepth*vDepth);gl_FragColor=vec4(vColor,a);}`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity); mesh.count = 0; mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.group.add(mesh); return mesh;
  }
  setGlow(batch, i, pos, size, color, alpha) {
    const mesh = this.glowBatches[batch];
    _matrix.compose(pos, _quat.identity(), _scale.set(size, size, size)); mesh.setMatrixAt(i, _matrix);
    mesh.setColorAt(i, _color.set(color)); mesh.geometry.attributes.aAlpha.setX(i, alpha);
    mesh.count = Math.max(mesh.count, i + 1); mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
  emitter(pos, material, radius = 0.07) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 5), material); mesh.position.copy(pos); this.group.add(mesh); return mesh;
  }
  buildEmitters() {
    let slot = 0;
    for (const pos of this.anchors.wallLamps) {
      this.emitter(pos, getMaterial('emissiveWarm'));
      this.setGlow(0, slot++, pos, 0.6, 0xffe2b8, 0.4);
    }
    for (let i = 0; i < this.anchors.sodium.length; i++) {
      const { pos } = this.anchors.sodium[i]; this.emitter(pos, this.sodiumMaterial ||= cloneMaterial('sodiumLamp', { fog: false }));
      this.setGlow(1, i, pos, 1.2, 0xffa33a, 0.5);
    }
    for (const anchor of this.anchors.signals) {
      const lenses = [];
      for (let i = 0; i < 3; i++) {
        const p = anchor.pos.clone(); p.y += (1 - i) * 0.15;
        lenses.push(this.emitter(p, cloneMaterial('tailLight', { color: 0x151515 }), 0.06));
      }
      this.signals.push({ side: anchor.side, pos: anchor.pos, lenses, slot: slot++ });
    }
    for (const anchor of this.anchors.exitSigns) {
      const set = getTexture(anchor.blue ? 'signExitBlue' : 'signExit');
      const mat = cloneMaterial('emissiveWarm', { map: set.map, color: new THREE.Color(2.5, 2.5, 2.5) });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(anchor.blue ? 0.8 : 0.7, 0.35), mat);
      mesh.position.copy(anchor.pos); mesh.rotation.y = anchor.rotY; this.group.add(mesh);
      this.setGlow(0, slot++, anchor.pos, 0.9, anchor.blue ? 0x3b6cff : 0x65d47d, 0.17);
    }
    for (const pos of this.anchors.emergency) {
      const mesh = this.emitter(pos, cloneMaterial('emergencyRed', { color: 0x160501 }), 0.09);
      this.emergencyGlows.push({ pos, mesh, slot: slot++ }); this.setGlow(0, slot - 1, pos, 1.4, 0xff2a1a, 0);
    }
    for (const shaft of this.anchors.shafts) {
      const direction = shaft.top.clone().sub(shaft.bottom), length = direction.length();
      const material = cloneMaterial('additive', { color: shaft.color, alphaMap: getTexture('shaftGradient').alphaMap, opacity: 0.12, side: THREE.DoubleSide });
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'varying vec3 shaftN; varying vec3 shaftV;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nshaftN=normalize(normalMatrix*normal);shaftV=normalize(-(modelViewMatrix*vec4(position,1.)).xyz);');
        shader.fragmentShader = 'varying vec3 shaftN; varying vec3 shaftV;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a*=pow(abs(dot(normalize(shaftN),normalize(shaftV))),1.5);');
      };
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(shaft.rTop, shaft.rBottom, length, 24, 1, true), material);
      mesh.position.copy(shaft.top).add(shaft.bottom).multiplyScalar(0.5); mesh.quaternion.setFromUnitVectors(_up, direction.normalize()); mesh.renderOrder = 2; this.group.add(mesh);
    }
    this.setSignal(-1, 'red'); this.setSignal(1, 'red');
  }
  setSignal(side, state) {
    const selected = { red: 0, yellow: 1, green: 2 }[state], colors = [0xff1a1a, 0xffbb22, 0x22ff55];
    for (const signal of this.signals) if (signal.side === side) {
      signal.lenses.forEach((mesh, i) => mesh.material.color.set(i === selected ? colors[i] : 0x120c08).multiplyScalar(i === selected ? 3 : 1));
      this.setGlow(0, signal.slot, signal.lenses[selected].position, 0.65, colors[selected], 0.45);
    }
  }
  setFixtureState(index, state) {
    if (!this.fixtures[index] || !['steady', 'flicker', 'dead', 'dying'].includes(state)) throw new RangeError('Invalid fixture state');
    this.fixtures[index].state = state;
  }
  updateFixtures(dt) {
    const time = this.G.time || 0;
    for (const f of this.fixtures) {
      let factor = f.state === 'dead' ? 0 : f.state === 'dying' ? 0.9 : 1;
      if (f.state === 'flicker' || (f.state === 'dying' && (time + f.phase) % f.interval < 0.3)) {
        const tick = Math.floor((time + f.phase) / 0.07);
        const noise = Math.abs(Math.sin(tick * 127.1 + f.index * 311.7));
        factor = noise > 0.6 ? 1 : noise > 0.35 ? 0.78 : noise > 0.15 ? 0.22 : 0.05;
        if (tick !== f.lastBurst && factor < 0.1) this.G.bus.emit('light-flicker', { index: f.index, pos: f.pos, kind: f.state === 'dying' ? 'sputter' : 'flicker' });
        f.lastBurst = tick;
      }
      f.factor = factor;
      for (let tube = 0; tube < 2; tube++) {
        const index = f.index * 2 + tube, dead = f.state === 'dead';
        _matrix.makeScale(dead ? 0 : 1, dead ? 0 : 1, dead ? 0 : 1);
        _matrix.setPosition(f.pos.x, f.pos.y, f.pos.z + (tube ? 0.085 : -0.085)); this.tubes.setMatrixAt(index, _matrix);
        this.tubes.setColorAt(index, _color.setScalar(factor * this.troffersDim));
        _matrix.makeScale(dead ? 1 : 0, dead ? 1 : 0, dead ? 1 : 0);
        _matrix.setPosition(f.pos.x, f.pos.y, f.pos.z + (tube ? 0.085 : -0.085)); this.deadTubes.setMatrixAt(index, _matrix);
      }
      _quat.setFromAxisAngle(_up.set(1, 0, 0), Math.PI / 2); _up.set(0, 1, 0);
      _matrix.compose(f.pos, _quat, _scale.set(1, 1, 1)); _matrix.elements[13] -= 0.06; this.cards.setMatrixAt(f.index, _matrix);
      this.cards.setColorAt(f.index, _color.setScalar(factor * this.troffersDim));
    }
    for (let i = 0; i < this.lights.platform.length; i++) {
      let factor = 1, distance = Infinity;
      for (const f of this.fixtures) if (!f.mezz && Math.abs(f.pos.x - LIGHTS.platform.xs[i]) < distance) { distance = Math.abs(f.pos.x - LIGHTS.platform.xs[i]); factor = f.factor; }
      this.lights.platform[i].intensity = LIGHTS.platform.intensity * this.troffersDim * (0.4 + 0.6 * factor);
    }
    this.lights.mezz.intensity = LIGHTS.mezz.intensity * (0.4 + 0.6 * this.fixtures[26].factor);
    this.deadTubes.instanceMatrix.needsUpdate = true;
    for (const mesh of [this.tubes, this.cards]) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
  }
  beginEmergency() { if (this.emergency) return; this.emergency = true; this.recovering = false; this.emergencyTime = 0; this.G.bus.emit('emergency-start'); }
  endEmergency() { if (this.emergency) this.G.bus.emit('emergency-end'); this.emergency = false; this.recovering = true; }
  flashMuzzle(pos, intensity) { this.lights.muzzle.position.copy(pos); this.lights.muzzle.color.set(LIGHTS.muzzle.color); this.flashPower = intensity; this.flashTicks = 4; this.lights.muzzle.intensity = intensity; }
  sparkFlash(pos, intensity = 30, color = 0xa0c8ff) { if (this.flashTicks) return; this.flashMuzzle(pos, intensity); this.lights.muzzle.color.set(color); this.flashTicks = 1; }
  getTrainSpots() { return this.lights.trainSpots; }
  update(dt) {
    this.emergencyTime += dt;
    this.troffersDim = damp(this.troffersDim, this.emergency && !this.recovering ? 0.3 : 1, this.recovering ? 2 : 5, dt);
    if (this.flashTicks > 0) { this.flashTicks--; this.lights.muzzle.intensity = this.flashPower * Math.min(1, this.flashTicks / 2); }
    const pulse = this.emergency && this.emergencyTime % 1 < 0.2;
    for (let i = 0; i < 2; i++) {
      const light = this.lights.sodium[i], p = LIGHTS.sodium[i];
      light.position.set(this.emergency ? LIGHTS.emergency.xs[i] : p.x, this.emergency ? LIGHTS.emergency.y : p.y, this.emergency ? 0 : p.z);
      light.color.set(this.emergency ? LIGHTS.emergency.color : LIGHTS.sodiumLamp.color);
      light.intensity = this.emergency ? pulse ? LIGHTS.emergency.intensity : 0 : LIGHTS.sodiumLamp.intensity * (1 + 0.02 * Math.sin(this.G.time * 4.398));
    }
    for (const e of this.emergencyGlows) { e.mesh.material.color.set(pulse ? 0xff2a1a : 0x160501).multiplyScalar(pulse ? 6 : 1); this.setGlow(0, e.slot, e.pos, 1.4, 0xff2a1a, pulse ? 0.6 : 0); }
    this.updateFixtures(dt);
  }
  render() {}
  reset() { this.emergency = false; this.recovering = false; this.troffersDim = 1; this.flashTicks = 0; this.lights.muzzle.intensity = 0; this.setSignal(-1, 'red'); this.setSignal(1, 'red'); this.update(0); }
  dispose() {
    for (const off of this.off) off();
    for (const value of Object.values(this.lights)) for (const light of Array.isArray(value) ? value : [value]) { this.G.scene.remove(light); if (light.isSpotLight) this.G.scene.remove(light.target); }
    this.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); this.G.scene.remove(this.group);
  }
}
