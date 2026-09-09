import * as THREE from 'three';
import { FX, BALLISTICS, LAYERS } from './constants.js';
import { getMaterial, cloneMaterial } from './materials.js';
import { getTexture } from './textures.js';
import { clamp } from './utils.js';
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _z = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(0, 1, 0), _color = new THREE.Color();
const _emitDir = new THREE.Vector3(), _bloodDir = new THREE.Vector3();
const TILES = { spark: 4, ember: 7, flare: 7, chip: 6, blood: 5, dust: 8, splinter: 10, shard: 11, fleck: 12 };
const pointVertex = `attribute vec3 aPos0; attribute vec3 aVel; attribute float aBorn; attribute float aLife; attribute float aSize; attribute float aSizeEnd; attribute vec3 aColor; attribute float aAlpha; attribute float aTile; attribute vec2 aPhysics;
uniform float uTime; uniform float uScale; varying vec3 vColor; varying float vAlpha; varying float vTile;
void main(){float t=max(0.,uTime-aBorn); float k=clamp(t/max(aLife,.001),0.,1.);float drag=aPhysics.y;float travel=drag>.001?(1.-exp(-drag*t))/drag:t;
vec3 p=aPos0+aVel*travel+vec3(0.,.5*aPhysics.x*t*t,0.);vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(mix(aSize,aSizeEnd,k)*uScale/max(.01,-mv.z),0.,256.);vColor=aColor;vAlpha=aAlpha*(1.-k)*step(t,aLife);vTile=aTile;}`;
const pointFragment = `uniform sampler2D uMap; uniform sampler2D uAlpha; varying vec3 vColor; varying float vAlpha; varying float vTile;
void main(){vec2 uv=(vec2(gl_PointCoord.x,1.-gl_PointCoord.y)+vec2(mod(vTile,4.),3.-floor(vTile/4.)))/4.;vec4 tex=texture2D(uMap,uv);gl_FragColor=vec4(tex.rgb*vColor,texture2D(uAlpha,uv).g*vAlpha);if(gl_FragColor.a<.002)discard;}`;
export class Particles {
  constructor(G) { this.G = G; }
  init() {
    this.clock = 0; this.off = []; this.objects = []; this.points = []; this.physical = [];
    const atlas = getTexture('spriteAtlas');
    for (let blend = 0; blend < 2; blend++) {
      const geo = new THREE.BufferGeometry(), capacity = FX.particles, attrs = {};
      for (const [name, size] of [['position', 3], ['aPos0', 3], ['aVel', 3], ['aBorn', 1], ['aLife', 1], ['aSize', 1], ['aSizeEnd', 1], ['aColor', 3], ['aAlpha', 1], ['aTile', 1], ['aPhysics', 2]]) { attrs[name] = new THREE.BufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, attrs[name]); }
      const material = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 500 }, uMap: { value: atlas.map }, uAlpha: { value: atlas.alphaMap } }, vertexShader: pointVertex, fragmentShader: pointFragment, transparent: true, depthWrite: false, blending: blend === 0 ? THREE.AdditiveBlending : THREE.NormalBlending });
      const mesh = new THREE.Points(geo, material); this.addObject(mesh); this.points.push({ mesh, attrs, head: 0, expiry: new Float32Array(capacity) });
    }
    const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true); tracerGeo.rotateX(Math.PI / 2);
    this.tracers = this.batch(tracerGeo, getMaterial('tracer'), FX.tracers);
    for (let i = 0; i < FX.tracers; i++) this.tracers.setColorAt(i, _color.setRGB(2.5, 2.5, 2.5));
    this.tracerItems = Array.from({ length: FX.tracers }, () => ({ active: false, age: 0, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, radius: 0, len: 0 })); this.tracerHead = 0;
    const casingGeo = new THREE.CylinderGeometry(1, 1, 1, 8); casingGeo.rotateX(Math.PI / 2);
    const casingMat = cloneMaterial('casingBrass');
    this.casings = this.makePhysical(casingGeo, casingMat, FX.casings);
    for (let i = 0; i < FX.casings; i++) this.casings.mesh.setColorAt(i, _color.setRGB(1, 1, 1));
    this.mags = this.makePhysical(new THREE.BoxGeometry(1, 1, 1), getMaterial('polymer'), 6);
    this.smokes = this.batch(new THREE.PlaneGeometry(1, 1), cloneMaterial('additive', { ...atlas, blending: THREE.NormalBlending }), FX.smoke);
    // Allocate instance colours before warm-up; blood puffs share the smoke
    // batch without adding materials or compiling a new shader during combat.
    for (let i = 0; i < FX.smoke; i++) this.smokes.setColorAt(i, _color.set(0xffffff));
    this.smokeItems = Array.from({ length: FX.smoke }, () => ({ active: false, age: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0, sizeEnd: 0, life: 0, alpha: 0 })); this.smokeHead = 0;
    this.smokeFade = new THREE.InstancedBufferAttribute(new Float32Array(FX.smoke), 1); this.smokes.geometry.setAttribute('aFade', this.smokeFade);
    this.smokes.material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float aFade; varying float vFade;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade=aFade;');
      shader.fragmentShader = 'varying float vFade;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', 'diffuseColor*=texture2D(map,vec2(vMapUv.x*.25,.75+vMapUv.y*.25));');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', 'diffuseColor.a*=texture2D(alphaMap,vec2(vAlphaMapUv.x*.25,.75+vAlphaMapUv.y*.25)).g*vFade;');
    };
    const flash = getTexture('muzzleFlash'); this.flashes = [];
    for (let i = 0; i < 3; i++) { const geo = new THREE.PlaneGeometry(1, 1), uv = geo.attributes.uv; for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * 0.5, 0.5 + uv.getY(j) * 0.5);
      const mesh = new THREE.Mesh(geo, cloneMaterial('additive', { ...flash, depthTest: false, side: THREE.DoubleSide })); mesh.renderOrder = 20; this.addObject(mesh); mesh.scale.setScalar(0); this.flashes.push(mesh); }
    this.flashT = 0; this.flashScale = 0; this.flashPos = new THREE.Vector3(); this.flashDir = new THREE.Vector3();
    this.blobShadows = this.batch(new THREE.PlaneGeometry(1, 1), cloneMaterial('blobShadow', { vertexColors: true }), 40);
    this.blobFade = new THREE.InstancedBufferAttribute(new Float32Array(40), 1); this.blobShadows.geometry.setAttribute('aFade', this.blobFade);
    this.blobShadows.material.onBeforeCompile = shader => { shader.vertexShader = 'attribute float aFade; varying float vFade;\n' + shader.vertexShader; shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade=aFade;'); shader.fragmentShader = 'varying float vFade;\n' + shader.fragmentShader; shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a*=vFade;'); };
    this.buildDust();
    this.off.push(this.G.bus.on('shot-fired', e => { this.smoke(e.muzzle, e.dir, { count: e.weapon === 'shotgun' ? 3 : 1 }); if (e.weapon === 'shotgun' || (e.weapon === 'rifle' && this.G.stats.shotsFired % 4 === 0)) this.emit('ember', e.muzzle, { count: 3, dir: e.dir, speed: 2, size: 0.025 }); }));
    this.off.push(this.G.bus.on('shot-hit-world', e => this.impact(e.pos, e.normal, e.surface, e.weapon)));
    this.off.push(this.G.bus.on('enemy-hit', e => this.blood(e.pos, e.dir, { headshot: e.headshot && e.killed })));
    this.off.push(this.G.bus.on('train-brake', () => { this.braking = true; })); this.off.push(this.G.bus.on('train-stop', () => { this.braking = false; }));
  }
  addObject(mesh) { mesh.layers.set(LAYERS.NO_ENV); mesh.frustumCulled = false; this.G.scene.add(mesh); this.objects.push(mesh); return mesh; }
  batch(geo, mat, cap) { const mesh = new THREE.InstancedMesh(geo, mat, cap); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); for (let i = 0; i < cap; i++) { _m.makeScale(0, 0, 0); mesh.setMatrixAt(i, _m); } return this.addObject(mesh); }
  makePhysical(geo, mat, cap) {
    const mesh = this.batch(geo, mat, cap), items = Array.from({ length: cap }, () => ({ active: false, age: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), ang: new THREE.Vector3(), rot: new THREE.Euler(), scale: new THREE.Vector3(), bounces: 0, resting: false, kind: '' }));
    const b = { mesh, items, head: 0 }; this.physical.push(b); return b;
  }
  buildDust() {
    const anchors = this.G.station.getLightAnchors(), n = FX.dustMotes + FX.mezzMotes + FX.shaftMotes * anchors.shafts.length;
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 3), color = new Float32Array(n * 3), rng = this.G.rngBuild;
    for (let i = 0; i < n; i++) {
      if (i < FX.dustMotes) _p.set(rng.range(-29, 29), rng.range(0.2, 4), rng.range(-4.5, 4.5));
      else if (i < FX.dustMotes + FX.mezzMotes) _p.set(rng.range(31, 47), rng.range(4.9, 8), rng.range(-5.8, 5.8));
      else { const a = anchors.shafts[Math.floor((i - FX.dustMotes - FX.mezzMotes) / FX.shaftMotes)]; _p.copy(a.top).lerp(a.bottom, rng()); _p.x += rng.range(-0.3, 0.3); _p.z += rng.range(-0.3, 0.3); }
      _p.toArray(pos, i * 3); color.fill(0.4, i * 3, i * 3 + 3);
    }
    this.dustBase = pos.slice(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    const mat = new THREE.PointsMaterial({ color: 0xc5cbbc, size: 0.015, transparent: true, opacity: 0.32, depthWrite: false, vertexColors: true });
    this.dust = this.addObject(new THREE.Points(geo, mat)); this.dust.visible = !this.G.opts.lowfx; this.dustTick = 0;
  }
  emit(kind, pos, { count = 8, dir = _up, spread = 1, speed = 4, life = 0.6, size = 0.1, gravity = -6, color = 0xffffff, drag = 2, sizeEnd = size * 0.3, alpha = 1 } = {}) {
    const b = this.points[['spark', 'ember', 'flare'].includes(kind) ? 0 : 1], a = b.attrs, rng = this.G.rng; _color.set(color);
    _emitDir.copy(dir); // Input direction may alias the per-particle scratch vector.
    for (let j = 0; j < count; j++) {
      const i = b.head++ % FX.particles; _v.set(rng.range(-spread, spread), rng.range(-spread, spread), rng.range(-spread, spread)).add(_emitDir).normalize().multiplyScalar(speed * rng.range(0.5, 1));
      a.aPos0.setXYZ(i, pos.x, pos.y, pos.z); a.aVel.setXYZ(i, _v.x, _v.y, _v.z); a.aBorn.setX(i, this.clock); a.aLife.setX(i, life); a.aSize.setX(i, size); a.aSizeEnd.setX(i, sizeEnd); a.aColor.setXYZ(i, _color.r, _color.g, _color.b); a.aAlpha.setX(i, alpha); a.aTile.setX(i, TILES[kind] ?? 8); a.aPhysics.setXY(i, gravity, drag); b.expiry[i] = this.clock + life;
      for (const name in a) if (name !== 'position') { a[name].addUpdateRange(i * a[name].itemSize, a[name].itemSize); a[name].needsUpdate = true; }
    }
  }
  smoke(pos, dir, { count = 1, size = 0.12, sizeEnd = 0.45, life = 0.6, alpha = 0.35, color = 0xffffff } = {}) {
    for (let j = 0; j < count; j++) { const i = this.smokeHead++ % FX.smoke, p = this.smokeItems[i]; p.active = true; p.age = 0; p.pos.copy(pos); p.vel.copy(dir).multiplyScalar(1.5); p.size = size; p.sizeEnd = sizeEnd; p.life = life; p.alpha = alpha; this.smokes.setColorAt(i, _color.set(color)); }
    this.smokes.instanceColor.needsUpdate = true;
  }
  tracer(from, to, radius = 0.012, len = 0.9) {
    const dist = from.distanceTo(to); if (dist < BALLISTICS.tracerMinDist) return;
    const p = this.tracerItems[this.tracerHead++ % FX.tracers]; p.active = true; p.age = 0; p.from.copy(from); p.dir.copy(to).sub(from).divideScalar(dist); p.dist = dist; p.radius = radius; p.len = len;
  }
  spawnPhysical(b, pos, vel, ang, sx, sy, sz, kind) { const i = b.head++ % b.items.length, p = b.items[i]; p.active = true; p.age = 0; p.pos.copy(pos); p.vel.copy(vel); p.ang.copy(ang); p.rot.set(0, 0, 0); p.scale.set(sx, sy, sz); p.bounces = 0; p.resting = false; p.kind = kind; return i; }
  ejectCasing(kind, pos, vel, angVel) { const hull = kind === 'hull12', i = this.spawnPhysical(this.casings, pos, vel, angVel, hull ? 0.0095 : 0.0045, hull ? 0.0095 : 0.0045, hull ? 0.06 : kind === 'brass556' ? 0.045 : 0.019, kind); this.casings.mesh.setColorAt(i, _color.set(hull ? 0xb33125 : 0xffffff)); this.casings.mesh.instanceColor.needsUpdate = true; }
  dropMag(pos, vel, key) { this.spawnPhysical(this.mags, pos, vel, _v.set(3, 2, 1), 0.035, key === 'rifle' ? 0.12 : 0.08, 0.04, 'mag'); }
  muzzleFlash(pos, dir, scale, variant) {
    this.flashT = FX.flashLife; this.flashScale = scale; this.flashPos.copy(pos); this.flashDir.copy(dir);
    this.flashVariant = ((variant % 4) + 4) % 4;
    // Visual rotation is derived from this shot's supplied variant and simulation
    // clock, not an extra gameplay RNG draw or wall-clock render timing.
    this.flashRoll = (this.flashVariant * 2.399963 + this.clock * 17.17) % (Math.PI * 2);
    const x = this.flashVariant % 2 * 0.5, y = (1 - Math.floor(this.flashVariant / 2)) * 0.5;
    for (const mesh of this.flashes) {
      const uv = mesh.geometry.attributes.uv;
      uv.setXY(0, x, y + 0.5); uv.setXY(1, x + 0.5, y + 0.5);
      uv.setXY(2, x, y); uv.setXY(3, x + 0.5, y); uv.needsUpdate = true;
    }
  }
  impact(pos, normal, surface) {
    if (surface === 'none') return;
    const metal = surface === 'metal', glass = surface === 'glass', wood = surface === 'wood';
    this.emit(metal ? 'spark' : glass ? 'shard' : wood ? 'splinter' : surface === 'plastic' || surface === 'paper' ? 'fleck' : 'chip', pos, { count: metal ? 14 : glass ? 8 : 7, dir: normal, speed: metal ? 7 : 4, size: metal ? 0.05 : 0.015, life: metal ? 0.35 : 0.6, color: metal ? 0xffcd82 : glass ? 0xbbe3e7 : wood ? 0xaa8050 : 0xb6b0a2 });
    if (!glass && surface !== 'paper' && surface !== 'plastic') this.smoke(pos, normal, { count: metal ? 1 : 2, size: 0.15, sizeEnd: 0.5, life: metal ? 0.2 : 0.5, alpha: 0.5 });
  }
  blood(pos, dir, { count = 10, headshot = false } = {}) { _bloodDir.copy(dir).negate(); this.emit('blood', pos, { count: headshot ? 24 : count, dir: _bloodDir, speed: 3, size: 0.045, color: 0xffffff, life: 0.5 }); this.smoke(pos, _bloodDir, { count: headshot ? 4 : 2, size: 0.18, sizeEnd: 0.4, life: 0.4, alpha: 0.55, color: 0x8a1515 }); }
  groundRing(pos, radius) { for (let i = 0; i < 12; i++) { _p.copy(pos); _p.x += Math.sin(i * Math.PI / 6) * radius; _p.z += Math.cos(i * Math.PI / 6) * radius; this.smoke(_p, _up, { size: 0.2, sizeEnd: 0.6, life: 0.5 }); } }
  setBlob(i, pos, radius, alpha) { _p.copy(pos); _p.y += 0.008; _q.setFromUnitVectors(_z, _up); _m.compose(_p, _q, _s.set(radius * 2, radius * 2, 1)); this.blobShadows.setMatrixAt(i, _m); this.blobFade.setX(i, alpha); this.blobFade.needsUpdate = true; this.blobShadows.instanceMatrix.needsUpdate = true; }
  hide(mesh, i) { _m.makeScale(0, 0, 0); mesh.setMatrixAt(i, _m); mesh.instanceMatrix.needsUpdate = true; }
  update(dt) {
    this.clock += dt; this.flashT = Math.max(0, this.flashT - dt);
    for (const b of this.points) b.mesh.material.uniforms.uTime.value = this.clock;
    for (let i = 0; i < this.tracerItems.length; i++) { const p = this.tracerItems[i]; if (!p.active) continue; p.age += dt;
      const life = clamp(p.dist / BALLISTICS.tracerSpeed, BALLISTICS.tracerMinTime, BALLISTICS.tracerMaxTime);
      if (p.age > life + 0.04) { p.active = false; this.hide(this.tracers, i); continue; }
      const head = Math.min(p.dist, BALLISTICS.tracerSpeed * p.age), tail = Math.max(0, head - p.len); _p.copy(p.from).addScaledVector(p.dir, (head + tail) / 2); _q.setFromUnitVectors(_z, p.dir); _m.compose(_p, _q, _s.set(p.radius, p.radius, Math.max(0.001, head - tail))); this.tracers.setMatrixAt(i, _m); this.tracers.setColorAt(i, _color.setRGB(2.5, 2.5, 2.5).multiplyScalar(clamp((life + 0.04 - p.age) / 0.04, 0, 1))); this.tracers.instanceMatrix.needsUpdate = true; this.tracers.instanceColor.needsUpdate = true;
    }
    for (const b of this.physical) for (let i = 0; i < b.items.length; i++) { const p = b.items[i]; if (!p.active) continue; p.age += dt;
      if (p.age >= FX.casingLife) { p.active = false; this.hide(b.mesh, i); continue; }
      if (!p.resting) { p.vel.y -= 9.81 * dt; p.pos.addScaledVector(p.vel, dt); p.rot.x += p.ang.x * dt; p.rot.y += p.ang.y * dt; p.rot.z += p.ang.z * dt;
        const floor = this.G.station.floorHeightAt(p.pos.x, p.pos.z), y = floor === null ? -1.1 : floor;
        if (p.pos.y <= y + p.scale.x) { p.pos.y = y + p.scale.x; p.vel.y = Math.abs(p.vel.y) * 0.35; p.vel.x *= 0.7; p.vel.z *= 0.7; p.ang.multiplyScalar(0.5); p.bounces++;
          if (p.bounces <= 2 && p.pos.distanceToSquared(this.G.player.pos) < 36) this.G.audio?.play?.(p.kind === 'hull12' ? 'hullBounce' : p.kind === 'mag' ? 'magDrop' : 'casingBounce', { pos: p.pos });
          if (p.bounces >= 3 || p.vel.length() < 0.15) p.resting = true;
        }
      }
      _q.setFromEuler(p.rot); _s.copy(p.scale).multiplyScalar(clamp((FX.casingLife - p.age) / 0.3, 0, 1)); _m.compose(p.pos, _q, _s); b.mesh.setMatrixAt(i, _m); b.mesh.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < this.smokeItems.length; i++) { const p = this.smokeItems[i]; if (!p.active) continue; p.age += dt; if (p.age >= p.life) { p.active = false; this.hide(this.smokes, i); continue; } p.vel.multiplyScalar(Math.exp(-4 * dt)); p.vel.y += 0.3 * dt; p.pos.addScaledVector(p.vel, dt); }
    if (this.braking && this.G.train?.speed > 3) { _p.set(this.G.train.noseX - this.G.train.dir * 3.2, -0.6, -this.G.train.dir * 6.65); this.emit('spark', _p, { count: 3, speed: 5, life: 0.3, size: 0.04 }); }
    const a = this.dust.geometry.attributes.position, colors = this.dust.geometry.attributes.color; this.dustTick++;
    for (let i = 0; i < a.count; i++) { const j = i * 3; a.setXYZ(i, this.dustBase[j] + Math.sin(this.clock * 0.2 + i) * 0.1, this.dustBase[j + 1] + Math.sin(this.clock * 0.3 + i * 2) * 0.07, this.dustBase[j + 2]);
      if (this.dustTick % 10 === 0) { let strength = 0.3; for (const t of this.G.station.getLightAnchors().troffers) { const dx = t.pos.x - a.getX(i), dy = t.pos.y - a.getY(i), dz = t.pos.z - a.getZ(i); if (dx * dx + dy * dy + dz * dz < 4) strength = 1; } colors.setXYZ(i, strength, strength, strength); }
    } a.needsUpdate = true; if (this.dustTick % 10 === 0) colors.needsUpdate = true;
  }
  render() {
    const camera = this.G.camera;
    for (const b of this.points) b.mesh.material.uniforms.uScale.value = this.G.renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    for (let i = 0; i < this.smokeItems.length; i++) { const p = this.smokeItems[i]; if (!p.active) continue; const k = p.age / p.life, size = p.size + (p.sizeEnd - p.size) * k; _m.compose(p.pos, camera.quaternion, _s.set(size, size, 1)); this.smokes.setMatrixAt(i, _m); this.smokeFade.setX(i, p.alpha * (1 - k)); } this.smokes.instanceMatrix.needsUpdate = true; this.smokeFade.needsUpdate = true;
    const flashAge = FX.flashLife - this.flashT, growth = 0.6 + 0.4 * clamp(flashAge / 0.015, 0, 1);
    for (let i = 0; i < 3; i++) {
      const mesh = this.flashes[i];
      // Longitudinal cards extend out of the barrel, not backwards through the
      // near-camera hands. Centred cross quads otherwise project enormously
      // as their rear corners approach the camera and cover the receiver.
      mesh.position.copy(this.flashPos).addScaledVector(this.flashDir, this.flashScale * growth * (i < 2 ? 0.5 : 0.15));
      mesh.quaternion.setFromUnitVectors(_z, this.flashDir);
      mesh.rotateZ(this.flashRoll || 0);
      if (i < 2) { mesh.rotateZ(i * Math.PI / 2); mesh.rotateY(Math.PI / 2); }
      // Shared flashScale is the cross-card width in metres; the front disc
      // preserves the specified 0.25/0.35 proportion instead of covering the aim.
      mesh.scale.setScalar(this.flashT > 0 ? this.flashScale * growth * (i === 2 ? 0.25 / 0.35 : 1) : 0);
      mesh.material.opacity = this.flashT > 0 ? clamp((FX.flashLife - flashAge) / (FX.flashLife - 0.015), 0, 1) : 0;
    }
  }
  get tracersActive() { let n = 0; for (const p of this.tracerItems) if (p.active) n++; return n; }
  get casingsActive() { let n = 0; for (const p of this.casings.items) if (p.active) n++; return n; }
  get particlesActive() { let n = 0; for (const b of this.points) for (const t of b.expiry) if (t > this.clock) n++; return n; }
  warmupDone() { this.reset(); }
  reset() { this.clock = 0; this.flashT = 0; this.braking = false; this.tracerHead = this.smokeHead = 0;
    for (const b of this.points) { b.head = 0; b.expiry.fill(0); b.attrs.aLife.array.fill(0); b.attrs.aLife.needsUpdate = true; b.mesh.material.uniforms.uTime.value = 0; }
    for (let i = 0; i < this.tracerItems.length; i++) { this.tracerItems[i].active = false; this.hide(this.tracers, i); }
    for (const b of this.physical) { b.head = 0; for (let i = 0; i < b.items.length; i++) { b.items[i].active = false; this.hide(b.mesh, i); } }
    for (let i = 0; i < this.smokeItems.length; i++) { this.smokeItems[i].active = false; this.hide(this.smokes, i); }
    for (const mesh of this.flashes) mesh.scale.setScalar(0); for (let i = 0; i < 40; i++) this.hide(this.blobShadows, i);
  }
  dispose() { for (const off of this.off) off(); for (const mesh of this.objects) { this.G.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); } }
}
