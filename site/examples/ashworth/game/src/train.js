import * as THREE from 'three';
import { TRAIN, TRAIN_LENGTH, TRACK, LIGHTS, MASK, trainCarCenterX } from './constants.js';
import { getMaterial, cloneMaterial } from './materials.js';
import { getTexture } from './textures.js';
import { makeBox, mergeGeos, transformGeo, clamp } from './utils.js';
const _p = new THREE.Vector3(), _forward = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
export class Train {
  constructor(G) { this.G = G; }
  init() {
    this.group = new THREE.Group(); this.group.name = 'Ashworth four-car consist'; this.G.scene.add(this.group);
    this.track = 'A'; this.dir = 1; this.timeScale = 1; this.doors = []; this.spawnPoints = []; this.dynamic = []; this.batches = new Map(); this.materials = new Map(); this.sprites = [];
    this.wheelPositions = []; this.distanceTravelled = 0;
    this.spots = this.G.lighting.getTrainSpots(); this.spotLocal = TRAIN.headlightLocal.map(p => new THREE.Vector3(...p));
    this.materials.set('ads', cloneMaterial('paper', { ...getTexture('trainAds'), emissiveMap: getTexture('trainAds').map, emissive: 0xffe3b5, emissiveIntensity: 0.22 }));
    // Baked interior bounce supplies the warm strip illumination without new
    // lights. Retain maps, normals and highlights on every interior surface.
    for (const name of ['trainInterior', 'trainFloor', 'trainSeatOrange', 'trainSeatYellow']) {
      const base = getMaterial(name);
      this.materials.set(name, cloneMaterial(name, { emissiveMap: base.map, emissive: new THREE.Color(0xffdfad).multiply(base.color), emissiveIntensity: name === 'trainFloor' ? 0.12 : 0.32 }));
    }
    this.materials.set('route', cloneMaterial('signBlack', { ...getTexture('trainRouteSign'), emissive: 0xffffff, emissiveIntensity: 3 }));
    this.materials.set('sideSign', cloneMaterial('signBlack', { color: 0xffffff, ...getTexture('trainSideSign'), emissive: 0xffffff, emissiveIntensity: 2 }));
    for (const [name, color] of [['lineGreen', 0x184c36], ['lineWhite', 0xdddcc7], ['lineBlack', 0x242b28]]) this.materials.set(name, cloneMaterial('signEnamel', { color, roughness: 0.45 }));
    this.materials.set('doorLED', cloneMaterial('emissiveWarm', { color: 0x241306 }));
    this.materials.set('interiorStrip', cloneMaterial('emissiveWarm'));
    this.stripColor = getMaterial('emissiveWarm').color.clone();
    const box = (name, x, y, z, w, h, d) => {
      const geo = transformGeo(makeBox(w, h, d), x, y, z);
      if (name === 'trainSteel') {
        // Side panels share car-space UV height, rather than restarting the
        // entire steel/stripe recipe at the bottom of every small box.
        const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
        for (let i = 0; i < p.count; i++) if (Math.abs(n.getZ(i)) > 0.9) uv.setXY(i, p.getX(i), p.getY(i));
      }
      return this.addGeo(name, geo);
    };
    const panel = (name, x, y, z, w, h, ry = 0) => this.addGeo(name, transformGeo(new THREE.PlaneGeometry(w, h), x, y, z, 0, ry));
    const cyl = (name, x, y, z, r, len, rx = 0) => this.addGeo(name, transformGeo(new THREE.CylinderGeometry(r, r, len, 10), x, y, z, rx));
    for (let car = 0; car < TRAIN.cars; car++) {
      const cx = trainCarCenterX(car), left = cx - TRAIN.carLength / 2, right = cx + TRAIN.carLength / 2;
      box('trainFloor', cx, -0.07, 0, TRAIN.carLength, 0.14, 2.96);
      box('trainInterior', cx, 2.48, 0, TRAIN.carLength, 0.10, 2.72);
      box('trainSteel', cx, 2.65, 0, TRAIN.carLength, 0.10, 2.35);
      for (const side of [-1, 1]) {
        // Curved roof shoulders: longitudinal facets, not a solid shell across windows.
        for (let k = 0; k < 5; k++) {
          const angle = (k + 0.5) * Math.PI / 10, z = side * (1.15 + 0.35 * Math.sin(angle)), y = 2.35 + 0.35 * Math.cos(angle);
          const g = makeBox(TRAIN.carLength, 0.075, 0.12); g.rotateX(side * angle); this.addGeo('trainSteel', transformGeo(g, cx, y, z));
        }
        // Continuous 15 cm enamel livery sits on the roof shoulder, independent
        // of the lower-body corrugation and the many window-panel UV islands.
        for (const [i, name] of ['lineBlack', 'lineWhite', 'lineGreen'].entries()) panel(name, cx, 2.525 + i * 0.05, side * 1.505, TRAIN.carLength, 0.05, side === 1 ? 0 : Math.PI);
        const doorXs = TRAIN.doorLocalX.map(x => cx + x);
        const edges = [left, ...doorXs.flatMap(x => [x - TRAIN.doorW / 2, x + TRAIN.doorW / 2]), right];
        for (let i = 0; i < 4; i++) {
          const x0 = edges[i * 2], x1 = edges[i * 2 + 1], mid = (x0 + x1) / 2, width = x1 - x0;
          box('trainSteel', mid, 0.54, side * 1.48, width, 1.08, 0.06);
          box('trainSteel', mid, 2.16, side * 1.45, width, 0.46, 0.07);
          // Interior liners face into the car; exterior steel must not double
          // as its unlit interior wall. Seat runs stop before each door opening.
          panel('trainInterior', mid, 0.54, side * 1.435, width, 1.08, side === 1 ? Math.PI : 0);
          panel('trainInterior', mid, 2.16, side * 1.405, width, 0.46, side === 1 ? Math.PI : 0);
          const seats = Math.max(1, Math.floor((width - 0.18) / 0.43));
          for (let seat = 0; seat < seats; seat++) {
            const sx = mid + (seat - (seats - 1) / 2) * 0.43;
            const material = seat % 2 ? 'trainSeatYellow' : 'trainSeatOrange';
            box(material, sx, 0.44, side * 1.13, 0.40, 0.12, 0.52);
            box(material, sx, 0.76, side * 1.36, 0.40, 0.56, 0.07);
          }
          const windowCount = 2, spacing = width / windowCount;
          for (let j = 0; j < windowCount; j++) {
            const wx = x0 + spacing * (j + 0.5), windowW = Math.min(1, spacing - 0.12);
            box('rubber', wx, 1.55, side * 1.465, windowW + 0.06, 0.86, 0.025);
            panel('trainGlass', wx, 1.55, side * 1.485, windowW, 0.8, side === 1 ? 0 : Math.PI);
            // The gasket is a frame: the dark backing is intentionally thin and transparent window reveals the lit interior.
            const last = this.batches.get('rubber').pop(); last.dispose();
            for (const y of [1.13, 1.97]) box('rubber', wx, y, side * 1.477, windowW + 0.06, 0.035, 0.028);
            for (const x of [wx - windowW / 2, wx + windowW / 2]) box('rubber', x, 1.55, side * 1.477, 0.035, 0.84, 0.028);
            const gapW = (spacing - windowW) / 2;
            for (const x of [x0 + j * spacing + gapW / 2, x0 + (j + 1) * spacing - gapW / 2]) box('trainSteel', x, 1.55, side * 1.46, gapW, 0.95, 0.08);
          }
          if (side === 1) this.collider([x0, 0, 1.42], [x1, 2.4, 1.5]);
        }
        for (const dx of doorXs) {
          box('chrome', dx, 2.01, side * 1.48, 1.46, 0.045, 0.1);
          box('trainSteel', dx, 2.2, side * 1.45, 1.3, 0.34, 0.08);
          panel('sideSign', dx, 2.20, side * 1.505, 1.15, 0.23, side === 1 ? 0 : Math.PI);
          box('doorLED', dx, 2.065, side * 1.51, 0.10, 0.025, 0.015);
          if (side === 1) {
            const index = this.spawnPoints.length;
            this.spawnPoints.push({ id: `train-${index}`, kind: 'train', localX: dx, pos: new THREE.Vector3(), yaw: Math.PI, exitDir: new THREE.Vector3(0, 0, 1), exitDist: 1.75, busy: false });
            for (const sign of [-1, 1]) this.doors.push({ x: dx + sign * TRAIN.leafW / 2, sign, collider: this.collider([0, 0, 1.44], [0, TRAIN.doorH, 1.5]) });
          } else {
            for (const sign of [-1, 1]) {
              const x = dx + sign * TRAIN.leafW / 2;
              box('trainSteel', x, 0.55, -1.48, TRAIN.leafW - 0.008, 1.1, 0.04);
              box('trainSteel', x, 1.91, -1.48, TRAIN.leafW - 0.008, 0.08, 0.04);
              panel('trainGlass', x, 1.49, -1.50, 0.48, 0.72, Math.PI);
              for (const edge of [-1, 1]) box('trainSteel', x + edge * 0.285, 1.49, -1.48, 0.07, 0.78, 0.04);
            }
          }
        }
        panel('ads', cx, 2.19, side * 1.385, 10, 0.36, side === 1 ? Math.PI : 0);
        // Each doorway carries its own destination display above the header.
        // Seating is built per wall interval above, never across a doorway.
        for (const dx of [-4.8, 0, 4.8]) cyl('chrome', cx + dx + 0.85, 1.2, side * 0.62, 0.025, 2.4);
        box('interiorStrip', cx, 2.40, side * 0.65, 12.5, 0.035, 0.08);
      }
      for (const x of [left, right]) { box('trainSteel', x, 1.3, 0, 0.09, 2.6, 2.8); this.collider([x - 0.05, 0, -1.5], [x + 0.05, 2.7, 1.5]); }
      this.collider([left, -0.15, -1.5], [right, 0, 1.5]); this.collider([left, 2.4, -1.5], [right, 2.75, 1.5]); this.collider([left, 0, -1.5], [right, 2.4, 0]);
      for (const dx of [-3.7, 3.7]) {
        box('steelGalv', cx + dx, 2.91, 0, 2.4, 0.35, 1.45);
        for (let i = 0; i < 12; i++) box('rubber', cx + dx - 1.0 + i * 0.18, 3.092, 0, 0.025, 0.008, 1.22);
      }
      box('steelPainted', cx, -0.47, 0, 8, 0.60, 1.65);
      for (const x of [left + TRAIN.bogieInset, right - TRAIN.bogieInset]) {
        box('steelPainted', x, -0.55, 0, 2.2, 0.5, 2);
        for (const axle of [-0.72, 0.72]) for (const side of [-1, 1]) {
          this.wheelPositions.push(new THREE.Vector3(x + axle, -0.53, side * 0.77));
          box('steelPainted', x + axle, -0.48, side * 1.01, 0.3, 0.3, 0.2);
        }
        box('steelRust', x, -0.82, -1.65, 1.8, 0.10, 0.20);
      }
      if (car < 3) { box('rubber', right + 0.25, 1.1, 0, 0.45, 2.2, 0.9); box('steelRust', right + 0.25, -0.3, 0, 0.5, 0.2, 0.25); }
    }
    // Cab overlays sit outside the capped end; glazing remains reflective, route sign blooms.
    for (const z of [-0.67, 0.67]) {
      panel('trainGlass', 29.606, 1.98, z, 0.83, 0.73, Math.PI / 2);
      box('rubber', 29.615, 1.69, z, 0.012, 0.018, 0.62);
      box('headlight', 29.62, 1.9, z > 0 ? 0.9 : -0.9, 0.04, 0.19, 0.19);
      box('tailLight', -29.61, 1.7, z, 0.03, 0.10, 0.10);
    }
    panel('route', 29.625, 2.47, 0, 2.25, 0.34, Math.PI / 2);
    for (const end of [-1, 1]) for (const z of [-0.9, 0.9]) {
      const material = new THREE.SpriteMaterial({ alphaMap: getTexture('lensStar').alphaMap, color: end === 1 ? 0xe4efff : 0xff3022, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const sprite = new THREE.Sprite(material); sprite.position.set(end * 29.64, end === 1 ? 1.9 : 1.7, z); sprite.scale.setScalar(end === 1 ? 1 : 0.35); this.group.add(sprite); this.sprites.push(sprite);
    }
    for (const [name, geos] of this.batches) { if (!geos.length) continue; const g = mergeGeos(geos), mesh = new THREE.Mesh(g, this.materials.get(name) || getMaterial(name)); mesh.name = `train:${name}`; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); this.group.add(mesh); for (const geo of geos) geo.dispose(); }
    this.batches.clear();
    const wheelGeo = new THREE.CylinderGeometry(TRAIN.wheelR, TRAIN.wheelR, 0.12, 16);
    wheelGeo.rotateX(Math.PI / 2);
    this.wheels = new THREE.InstancedMesh(wheelGeo, getMaterial('rail'), this.wheelPositions.length);
    this.wheels.name = 'train:rotating-wheels'; this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheels.frustumCulled = false; this.group.add(this.wheels);
    const leafGeo = [], glassGeo = [], trimGeo = [];
    const leafBox = (list, x, y, w, h) => list.push(transformGeo(makeBox(w, h, 0.04), x, y, 0));
    leafBox(leafGeo, 0, 0.55, 0.642, 1.1); leafBox(leafGeo, 0, 1.92, 0.642, 0.06);
    for (const x of [-0.285, 0.285]) leafBox(leafGeo, x, 1.50, 0.07, 0.8);
    glassGeo.push(transformGeo(new THREE.PlaneGeometry(0.49, 0.73), 0, 1.5, 0.025));
    for (const x of [-0.315, 0.315]) leafBox(trimGeo, x, 0.975, 0.012, 1.95);
    this.leafBatches = [new THREE.InstancedMesh(mergeGeos(leafGeo), getMaterial('trainSteel'), 24), new THREE.InstancedMesh(mergeGeos(glassGeo), getMaterial('trainGlass'), 24), new THREE.InstancedMesh(mergeGeos(trimGeo), getMaterial('rubber'), 24)];
    for (const list of [leafGeo, glassGeo, trimGeo]) for (const geo of list) geo.dispose();
    for (const mesh of this.leafBatches) { mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; this.group.add(mesh); }
    this.reset();
  }
  addGeo(name, geo) { if (!this.batches.has(name)) this.batches.set(name, []); this.batches.get(name).push(geo); }
  collider(min, max) { const c = { type: 'box', min: min.slice(), max: max.slice(), localMin: min, localMax: max, tag: 'train', surface: 'metal', mask: MASK.BULLET }; this.dynamic.push(c); return c; }
  sync() {
    const movingDoors = this.state === 'doorsOpening' || this.state === 'doorsClosing';
    const warning = movingDoors || (this.state === 'stopped' && this.chimed);
    this.doorLedOn = warning && Math.floor(this.T * 5) % 2 === 0;
    this.materials.get('doorLED').color.setHex(this.doorLedOn ? 0xffae32 : 0x241306).multiplyScalar(this.doorLedOn ? 2 : 1);
    // One brief contact interruption as the car settles, not perpetual flicker.
    this.interiorStripFactor = this.state === 'stopped' && this.stopT >= 0.07 && this.stopT < 0.14 ? 0.08 : 1;
    this.materials.get('interiorStrip').color.copy(this.stripColor).multiplyScalar(this.interiorStripFactor);
    this.wheelAngle = -this.distanceTravelled / TRAIN.wheelR;
    _q.setFromAxisAngle(_forward.set(0, 0, 1), this.wheelAngle);
    for (let i = 0; i < this.wheelPositions.length; i++) {
      _m.compose(this.wheelPositions[i], _q, _s); this.wheels.setMatrixAt(i, _m);
    }
    this.wheels.instanceMatrix.needsUpdate = true;
    this.noseX = this.centerX + this.dir * TRAIN_LENGTH / 2;
    this.group.position.set(this.centerX, 0, -this.dir * TRACK.centerZ); this.group.rotation.y = this.dir === 1 ? 0 : Math.PI; this.group.updateMatrixWorld(true);
    for (let i = 0; i < this.doors.length; i++) {
      const door = this.doors[i], x = door.x + door.sign * 0.68 * this.doorOpenAmount;
      _m.makeTranslation(x, 0, 1.48); for (const mesh of this.leafBatches) mesh.setMatrixAt(i, _m);
      door.collider.localMin[0] = x - TRAIN.leafW / 2; door.collider.localMax[0] = x + TRAIN.leafW / 2;
    }
    for (const mesh of this.leafBatches) mesh.instanceMatrix.needsUpdate = true;
    if (Math.abs(this.centerX) < 200 && this.state !== 'idle') {
      for (const c of this.dynamic) for (let axis = 0; axis < 3; axis++) {
        const offset = axis === 0 ? this.centerX : axis === 2 ? -this.dir * TRACK.centerZ : 0, sign = axis === 1 ? 1 : this.dir;
        c.min[axis] = offset + sign * (sign === 1 ? c.localMin[axis] : c.localMax[axis]); c.max[axis] = offset + sign * (sign === 1 ? c.localMax[axis] : c.localMin[axis]);
      }
      this.G.colliders.setDynamic('train', this.dynamic);
    } else this.G.colliders.clearDynamic('train');
    this.getDoorSpawnPoints();
  }
  callTrain(track) {
    if (this.state !== 'idle') return;
    if (track !== 'A' && track !== 'B') throw new RangeError('Unknown track');
    this.track = track; this.dir = track === 'A' ? 1 : -1; this.state = 'arriving'; this.T = 0; this.speed = TRAIN.cruiseSpeed; this.centerX = this.dir * TRAIN.startCenterX;
    this.distanceTravelled = 0;
    this.braked = this.entered = this.chimed = false; this.sparkT = 2; this.sync();
    this.G.bus.emit('train-called', { track, wave: this.G.waves.wave }); this.G.bus.emit('train-approach', { track, x: this.centerX });
  }
  openDoors() { if (this.state === 'stopped') { this.state = 'doorsOpening'; this.doorT = 0; } }
  closeDoors() { if (this.state === 'doorsOpen') { this.state = 'doorsClosing'; this.doorT = 0; } }
  isDocked() { return ['stopped', 'doorsOpening', 'doorsOpen', 'doorsClosing'].includes(this.state); }
  getDoorSpawnPoints() { for (const s of this.spawnPoints) { s.pos.set(s.localX, 0, 0.9).applyMatrix4(this.group.matrixWorld); s.exitDir.set(0, 0, this.dir); s.yaw = this.dir === 1 ? Math.PI : 0; } return this.spawnPoints; }
  update(dt) {
    if (this.state === 'idle') return;
    const delta = dt * this.timeScale; this.T += delta;
    if (this.state === 'arriving') {
      if (this.T < 5) { this.centerX = this.dir * (-140 + 14 * this.T); this.speed = 14; }
      else { const t = Math.min(10, this.T - 5); this.centerX = this.dir * (-70 + 14 * t - 0.7 * t * t); this.speed = Math.max(0, 14 - 1.4 * t); }
      this.sync();
      if (!this.braked && this.T >= 5) { this.braked = true; this.G.bus.emit('train-brake'); }
      if (!this.entered && this.dir * this.noseX >= -TRAIN.tunnelMouthX) { this.entered = true; this.G.bus.emit('train-enter'); }
      if (this.T >= 15) { this.state = 'stopped'; this.stopT = Math.max(0, this.T - 15); this.centerX = 0; this.speed = 0; this.sync(); this.G.bus.emit('train-stop'); }
    } else if (this.state === 'stopped') {
      this.stopT += delta; const t = this.stopT;
      this.centerX = this.dir * (t < TRAIN.settleTime ? TRAIN.settleAmp * Math.sin(Math.PI * 2 * t / TRAIN.settleTime) * (1 - t / TRAIN.settleTime) : 0);
      if (!this.chimed && t + 1e-8 >= TRAIN.chimeDelay) { this.chimed = true; this.G.bus.emit('train-chime'); }
      if (t + 1e-8 >= TRAIN.doorsDelay) this.openDoors();
    } else if (this.state === 'doorsOpening' || this.state === 'doorsClosing') {
      const opening = this.state === 'doorsOpening'; this.doorT += delta;
      this.doorOpenAmount = opening ? clamp(this.doorT / TRAIN.doorOpenTime, 0, 1) : 1 - clamp(this.doorT / TRAIN.doorCloseTime, 0, 1);
      if (this.doorT + 1e-8 >= (opening ? TRAIN.doorOpenTime : TRAIN.doorCloseTime)) {
        this.doorOpenAmount = opening ? 1 : 0;
        if (opening) { this.state = 'doorsOpen'; this.sync(); this.G.bus.emit('train-doors-open'); }
        else { this.G.bus.emit('train-doors-close'); this.state = 'departing'; this.departT = 0; this.G.bus.emit('train-depart'); }
      }
    } else if (this.state === 'departing') {
      this.departT += delta; this.centerX = this.dir * 0.5 * TRAIN.departAccel * this.departT ** 2; this.speed = TRAIN.departAccel * this.departT;
      if (Math.abs(this.centerX) >= TRAIN.goneX) { this.state = 'idle'; this.centerX = this.dir * TRAIN.parkX; this.speed = 0; this.sync(); this.G.bus.emit('train-gone'); }
    }
    if (this.speed > 0) { this.sparkT -= delta; if (this.sparkT <= 0) { this.sparkT = this.G.rng.range(2, 4); _p.set(this.centerX, -0.8, -this.dir * (TRACK.centerZ + 1.65)); this.G.lighting.sparkFlash(_p); this.G.particles.emit('spark', _p, { count: 6, size: 0.03, life: 0.3 }); } }
    // Analytic travel excludes the offscreen parking teleport and suspension
    // settling. Rotation is train-local, so mirroring Track B also mirrors roll.
    if (this.state === 'arriving') this.distanceTravelled = this.dir * this.centerX - TRAIN.startCenterX;
    else if (this.state === 'departing' || this.state === 'idle') this.distanceTravelled = -TRAIN.startCenterX + 0.5 * TRAIN.departAccel * this.departT ** 2;
    else this.distanceTravelled = -TRAIN.startCenterX;
    this.sync();
  }
  render() {
    const power = this.state === 'arriving' ? clamp(this.T, 0, 1) : this.state === 'departing' ? 1 : this.state !== 'idle' && this.T < 17 ? 1 : 0;
    _forward.set(this.dir, 0, 0);
    for (let i = 0; i < 2; i++) { const spot = this.spots[i]; spot.position.copy(this.spotLocal[i]).applyMatrix4(this.group.matrixWorld); spot.target.position.copy(spot.position).addScaledVector(_forward, TRAIN.headlightAim); spot.intensity = LIGHTS.trainSpot.intensity * power; }
  }
  reset() { this.distanceTravelled = 0; this.state = 'idle'; this.T = 0; this.stopT = this.doorT = this.departT = 0; this.centerX = this.dir * TRAIN.parkX; this.speed = this.doorOpenAmount = 0; this.group.visible = true; for (const s of this.spawnPoints) s.busy = false; this.sync(); this.render(); }
  dispose() { this.G.colliders.clearDynamic('train'); this.G.scene.remove(this.group); this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); for (const m of this.materials.values()) m.dispose(); for (const s of this.sprites) s.material.dispose(); }
}
