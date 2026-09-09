import * as THREE from 'three';
import * as C from './constants.js';
import { getMaterial, cloneMaterial, makeAoStrip } from './materials.js';
import { getTexture } from './textures.js';
import { makeBox, makePlane, transformGeo, mergeGeos, ensureColorAttr, bakeVertexAO, clamp } from './utils.js';

export class Station {
  constructor(G) { this.G = G; }
  init() {
    this.group = new THREE.Group(); this.group.name = 'ASHWORTH ST • structure'; this.G.scene.add(this.group);
    this.batches = new Map(); this.doors = []; this.posterSlots = []; this.mosaicCenters = [];
    this.anchors = { troffers: [], wallLamps: [], sodium: [], signals: [], exitSigns: [], emergency: [], shafts: [] };
    this.walkable = [
      { minX: -30, maxX: 30, minZ: -5, maxZ: 5, y: 0 },
      { minX: 30, maxX: 30.6, minZ: -1.2, maxZ: 1.2, y: 0 },
      { minX: 30.6, maxX: 37.8, minZ: -1.2, maxZ: 1.2, ramp: true },
      { minX: 37.8, maxX: 48, minZ: -6, maxZ: 6, y: 4.8 },
      { minX: 30, maxX: 37.8, minZ: -6, maxZ: -1.5, y: 4.8 },
      { minX: 30, maxX: 37.8, minZ: 1.5, maxZ: 6, y: 4.8 },
      { minX: 43.4, maxX: 44.6, minZ: 6, maxZ: 6.8, y: 4.8 },
      { minX: -42, maxX: -30, minZ: -0.6, maxZ: 0.6, y: 0 },
    ];
    this.playerSpawn = { pos: new THREE.Vector3(...C.PLAYER_SPAWN.pos), yaw: C.PLAYER_SPAWN.yaw, pitch: 0 };
    this.buildPlatform(); this.buildTracks(); this.buildWalls(); this.buildColumns();
    this.buildStairs(); this.buildMezzanine(); this.buildWest(); this.buildTunnels(); this.buildCrate(); this.buildAnchors();
    this.flush();
  }
  floorHeightAt(x, z) {
    const a = Math.abs(z);
    if (x >= -30 && x <= 30 && a <= 5) return 0;
    if (x > 30 && x <= 30.6 && a <= 1.2) return 0;
    if (x > 30.6 && x <= 37.8 && a <= 1.2) return (x - 30.6) * (4.8 / 7.2);
    if (x > 37.8 && x <= 48 && a <= 6) return 4.8;
    if (x > 30 && x <= 37.8 && a >= 1.5 && a <= 6) return 4.8;
    if (x >= 43.4 && x <= 44.6 && z > 6 && z <= 6.8) return 4.8;
    if (x >= -42 && x < -30 && a <= 0.6) return 0;
    return null;
  }
  addGeo(material, geo) {
    const key = typeof material === 'string' ? getMaterial(material) : material;
    if (!this.batches.has(key)) this.batches.set(key, []);
    ensureColorAttr(geo);
    // Baked underside occlusion: the shadowless point-light approximation must
    // not make soot-dark concrete above the troffer backs brighter than tubes.
    // Keep this in vertex colour so all 17 light constants and shader variants
    // remain unchanged, and the environment capture sees the same finish.
    if (key.name.startsWith('concrete')) {
      const p = geo.attributes.position, n = geo.attributes.normal, c = geo.attributes.color;
      for (let i = 0; i < p.count; i++) if (p.getY(i) >= 3.79 && n.getY(i) < -0.5) {
        c.setXYZ(i, c.getX(i) * 0.18, c.getY(i) * 0.18, c.getZ(i) * 0.18);
      }
    }
    this.batches.get(key).push(geo); return geo;
  }
  box(material, x, y, z, w, h, d) { return this.addGeo(material, transformGeo(makeBox(w, h, d), x, y, z)); }
  plane(material, x, y, z, w, h, rx = 0, ry = 0, meters = true) {
    return this.addGeo(material, transformGeo(meters ? makePlane(w, h) : new THREE.PlaneGeometry(w, h), x, y, z, rx, ry));
  }
  cylinder(material, x, y, z, r, h, segments = 12, rz = 0) {
    return this.addGeo(material, transformGeo(new THREE.CylinderGeometry(r, r, h, segments), x, y, z, 0, 0, rz));
  }
  collider(min, max, tag, surface = 'metal', mask = C.MASK.SOLID) { return this.G.colliders.addStaticBox(min, max, tag, surface, mask); }
  flush() {
    for (const [material, geometries] of this.batches) {
      const merged = mergeGeos(geometries), mesh = new THREE.Mesh(merged, material);
      mesh.name = `station:${material.name}`; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); this.group.add(mesh);
      for (const geometry of geometries) geometry.dispose();
    }
    this.batches.clear();
  }
  sign(texture, x, y, z, w, h, ry = 0, variant = 0) {
    const material = cloneMaterial('paper', { color: 0xffffff, map: getTexture(texture, variant).map });
    return this.plane(material, x, y, z, w, h, 0, ry, false);
  }
  buildPlatform() {
    this.box('concreteRaw', 0, -0.16, 0, 60, 0.28, 10);
    const top = new THREE.PlaneGeometry(60, 10, 120, 20); top.rotateX(-Math.PI / 2);
    const uv = top.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, top.attributes.position.getX(i), -top.attributes.position.getZ(i));
    const occluders = [];
    for (let i = 0; i < 13; i++) for (const z of [-3, 3]) occluders.push({ type: 'cyl', x: -27 + i * 4.5, z, r: 0.28, y0: 0, y1: 3.8 });
    bakeVertexAO(top, occluders, { radius: 0.4, strength: 0.4 }); this.addGeo('floorSlab', top);
    this.collider([-30, -0.3, -5], [30, 0, 5], 'floor', 'concrete', C.MASK.BULLET);
    for (const side of [-1, 1]) {
      this.plane('tactile', 0, 0.005, side * 4.7, 60, 0.6, -Math.PI / 2);
      this.box('nosing', 0, -0.078, side * 4.96, 60, 0.15, 0.15);
      this.collider([-30.5, -1.2, side < 0 ? -5.3 : 4.95], [30.5, 2.5, side < 0 ? -4.95 : 5.3], 'edge', 'none', C.MASK.PLAYER | C.MASK.ENEMY | C.MASK.NAV);
      for (let i = 0; i < 3; i++) this.cylinder('steelRust', 0, -0.45 - i * 0.12, side * 5.03, 0.03, 60, 6, Math.PI / 2);
      for (const x of [-22.5, -7.5, 7.5, 22.5]) {
        const mat = cloneMaterial('paper', { color: 0xffffff, map: getTexture('stencilStandClear').map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
        this.plane(mat, x, 0.006, side * 4.13, 3, 0.375, -Math.PI / 2, 0, true);
      }
      this.box('concreteRaw', side * 30.15, -0.7, 0, 0.3, 0.8, 10);
      this.collider([side < 0 ? -30.3 : 30, -1.1, -5], [side < 0 ? -30 : 30.3, -0.3, 5], 'end-wall', 'concrete', C.MASK.BULLET);
    }
    for (const x of C.DRAINS.xs) for (const z of C.DRAINS.zs) {
      this.box('rubber', x, -0.005, z, 0.6, 0.012, 0.3);
      for (let i = 0; i < 12; i++) this.box('steelGalv', x - 0.275 + i * 0.05, 0.001, z, 0.014, 0.01, 0.28);
    }
  }
  buildTracks() {
    for (const side of [-1, 1]) {
      const center = side * C.TRACK.centerZ;
      this.plane('trackbed', 0, -1.1, side * 7, 320, 4, -Math.PI / 2);
      this.box('rubber', 0, -1.21, center, 320, 0.02, 0.4);
      this.collider([-160, -1.4, side < 0 ? -9 : 5], [160, -1.1, side < 0 ? -5 : 9], 'trackbed', 'concrete', C.MASK.BULLET);
      for (let i = 0; i < 534; i++) {
        const x = -160 + i * 0.6;
        this.box(Math.abs(x) < 32 && i % 2 ? 'tieConcrete' : 'tieWood', x, -1.035, center, 0.25, 0.15, 2.6);
      }
      for (const offset of [-C.TRACK.gauge / 2, C.TRACK.gauge / 2]) {
        const z = center + offset;
        this.box('rail', 0, -0.97, z, 320, 0.04, 0.07);
        this.box('railRust', 0, -1.04, z, 320, 0.1, 0.02);
        this.box('railRust', 0, -1.09, z, 320, 0.02, 0.15);
        this.collider([-160, -1.1, z - 0.075], [160, -0.95, z + 0.075], 'rail', 'metal', C.MASK.BULLET);
      }
      this.box('railRust', 0, -0.85, side * 8.35, 320, 0.1, 0.06);
      this.box('wood', 0, -0.78, side * 8.35, 320, 0.02, 0.2);
      for (let x = -159; x < 160; x += 3) this.cylinder('signEnamel', x, -0.96, side * 8.35, 0.08, 0.2, 8);
    }
  }
  buildWalls() {
    for (const side of [-1, 1]) {
      const ry = side < 0 ? 0 : Math.PI;
      for (const [a, b, material] of C.WALL_BANDS) {
        const geo = new THREE.PlaneGeometry(64, b - a, 64, 4);
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 64, uv.getY(i) * (b - a));
        transformGeo(geo, 0, (a + b) / 2, side * 9, 0, ry); ensureColorAttr(geo);
        const p = geo.attributes.position, color = geo.attributes.color;
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i), edge = Math.min(clamp((y + 1.1) / 0.5, 0, 1), clamp((4.2 - y) / 0.5, 0, 1));
          const f = (0.55 + 0.45 * edge) * (0.95 + 0.05 * Math.sin(p.getX(i) * 0.75)); color.setXYZ(i, f, f, f);
        }
        this.addGeo(material, geo);
      }
      this.collider([-32, -1.1, side < 0 ? -9.3 : 9], [32, 4.2, side < 0 ? -9 : 9.3], side < 0 ? 'wall-a' : 'wall-b', 'tile', C.MASK.BULLET);
      for (let i = 0; i < 7; i++) this.posterSlots.push({ pos: new THREE.Vector3(-24 + i * 8, 1.4, side * 8.965), rotY: ry, w: 1.4, h: 1.9, backlit: i % 2 === 0 });
      for (const x of [-20, -12, -4, 4, 12, 20]) this.mosaicCenters.push(new THREE.Vector3(x, 2.675, side * 9));
      this.sign('signMezz', 24, 3.15, side * 8.97, 1.5, 0.25, ry);
      for (const x of [-20, 20]) this.sign('signDanger', x, -0.6, side * 8.97, 0.5, 0.25, ry);
      const ao = makeAoStrip(64, 0.35, 0.5); ao.position.set(0, 0.175, side * 8.99); ao.rotation.y = ry; this.group.add(ao);
    }
    // Separate ceiling bays: leak finish belongs near drains, not across the
    // entire roof. Subdivision gives the beam/wall junction AO a local falloff.
    for (let bay = 0; bay < 14; bay++) {
      const left = -32 + bay * 4.5, right = Math.min(30, left + 4.5);
      if (right <= left) continue;
      const geo = transformGeo(makePlane(right - left, 18, 8, 24), (left + right) / 2, 4.2, 0, Math.PI / 2);
      ensureColorAttr(geo);
      const p = geo.attributes.position, colors = geo.attributes.color;
      for (let i = 0; i < p.count; i++) {
        let beamDistance = Infinity;
        for (let b = 0; b < 13; b++) beamDistance = Math.min(beamDistance, Math.abs(p.getX(i) - (-27 + b * 4.5)));
        const wall = clamp((9 - Math.abs(p.getZ(i))) / 0.6, 0, 1);
        const beam = clamp((beamDistance - 0.25) / 0.65, 0, 1);
        const ao = (0.65 + 0.35 * wall) * (0.6 + 0.4 * beam);
        colors.setXYZ(i, ao, ao, ao);
      }
      const center = (left + right) / 2;
      this.addGeo(Math.abs(center - 6) < 3 || Math.abs(Math.abs(center) - 15) < 2 ? 'concreteLeak' : 'concretePainted', geo);
    }
    for (const z of [-5.25, 5.25]) this.plane('concretePainted', 31, 4.2, z, 2, 7.5, Math.PI / 2);
    this.collider([-32, 4.2, -9], [30, 4.5, 9], 'ceiling', 'concrete', C.MASK.BULLET);
    for (let i = 0; i < 13; i++) {
      const x = -27 + i * 4.5; this.box('concretePainted', x, 4, 0, 0.5, 0.4, 18);
      this.collider([x - 0.25, 3.8, -9], [x + 0.25, 4.2, 9], 'beam', 'concrete', C.MASK.BULLET);
    }
  }
  buildColumns() {
    for (let i = 0; i < 13; i++) for (const side of [-1, 1]) {
      const x = -27 + i * 4.5, z = side * 3;
      this.cylinder('ironGreen', x, 2.025, z, 0.17, 3.55, 16);
      this.box('ironGreen', x, 0.125, z, 0.55, 0.25, 0.55);
      this.box('ironGreen', x, 3.77, z, 0.5, 0.06, 0.5);
      for (let j = 0; j < 12; j++) for (const face of [-1, 1]) this.addGeo('ironGreen', transformGeo(new THREE.SphereGeometry(0.012, 5, 3), x + face * 0.12, 0.38 + j * 0.29, z - side * 0.125));
      this.G.colliders.addStaticCyl(x, z, 0.28, 0, 3.8, 'column', 'metal');
      const plate = new THREE.PlaneGeometry(0.2, 0.1), uv = plate.attributes.uv, slot = i + (side > 0 ? 13 : 0);
      for (let k = 0; k < uv.count; k++) uv.setXY(k, (slot % 4 + uv.getX(k)) / 4, 1 - (Math.floor(slot / 4) + 1 - uv.getY(k)) / 8);
      const mat = this.plateMaterial ||= cloneMaterial('paper', { color: 0xffffff, map: getTexture('columnPlates').map });
      this.addGeo(mat, transformGeo(plate, x, 1.7, z - side * 0.175, 0, side < 0 ? 0 : Math.PI));
    }
  }
  buildStairs() {
    this.box('concreteRaw', 34.5, -0.4, 0, 9, 1.4, 2.4);
    this.box('floorSlab', 30.3, -0.15, 0, 0.6, 0.3, 2.4);
    for (let i = 0; i < 24; i++) {
      const x = 30.75 + i * 0.3, y = (i + 1) * 0.2;
      this.box('tileBase', x, y / 2, 0, 0.3, y, 2.4);
      this.box('floorSlab', x, y + 0.002, 0, 0.3, 0.008, 2.4);
      this.box('rubber', x - 0.115, y + 0.008, 0, 0.045, 0.006, 2.35);
    }
    for (let i = 0; i < 6; i++) this.collider([30.6 + i * 1.2, -1.1, -1.2], [31.8 + i * 1.2, (i + 1) * 0.8, 1.2], 'floor-stair', 'concrete', C.MASK.BULLET);
    this.box('steelGalv', 38.4, 4.65, 0, 1.2, 0.3, 2.4);
    for (const side of [-1, 1]) {
      this.box('tileWhite', 34.5, 4.1, side * 1.35, 9, 8.2, 0.3);
      this.collider([30, 0, side < 0 ? -1.5 : 1.2], [39, 8.2, side < 0 ? -1.2 : 1.5], 'stair-wall', 'tile');
      const points = [new THREE.Vector3(30.3, 0.9, side * 1.05), new THREE.Vector3(30.6, 0.9, side * 1.05), new THREE.Vector3(37.8, 5.7, side * 1.05), new THREE.Vector3(38.8, 5.7, side * 1.05)];
      this.addGeo('chrome', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0), 32, 0.025, 6, false));
      for (let i = 0; i < 7; i++) this.cylinder('chrome', 30.6 + i * 1.2, 0.45 + i * 0.8, side * 1.05, 0.02, 0.9, 6);
      this.box('steelPainted', 30.15, 1.05, side * 3.175, 0.08, 0.08, 3.65);
      for (let z = 1.5; z <= 5; z += 0.5) this.cylinder('steelPainted', 30.15, 0.5, side * z, 0.025, 1, 6);
      this.collider([30, 0, side < 0 ? -5 : 1.35], [30.3, 1.1, side < 0 ? -1.35 : 5], 'end-rail');
    }
    const center = [new THREE.Vector3(30.6, 0.9, 0), new THREE.Vector3(37.8, 5.7, 0)];
    this.addGeo('chrome', new THREE.TubeGeometry(new THREE.LineCurve3(...center), 1, 0.025, 6, false));
    for (let i = 0; i < 7; i++) this.cylinder('chrome', 30.6 + i * 1.2, 0.45 + i * 0.8, 0, 0.02, 0.9, 6);
  }
  buildMezzanine() {
    for (const [x0, x1, z0, z1] of [[30, 37.8, -6, -1.5], [30, 37.8, 1.5, 6], [37.8, 48, -6, 6]]) {
      const slab = this.box('floorSlab', (x0 + x1) / 2, 4.65, (z0 + z1) / 2, x1 - x0, 0.3, z1 - z0);
      const pos = slab.attributes.position, normal = slab.attributes.normal, uv = slab.attributes.uv;
      for (let i = 0; i < pos.count; i++) if (normal.getY(i) > 0.9) uv.setXY(i, pos.getX(i), -pos.getZ(i));
      this.collider([x0, 4.5, z0], [x1, 4.8, z1], 'floor-mezz', 'concrete', C.MASK.BULLET);
    }
    this.plane('concretePainted', 39, 8.2, 0, 18, 12, Math.PI / 2);
    this.collider([30, 8.2, -6], [48, 8.5, 6], 'ceiling', 'concrete', C.MASK.BULLET);
    for (const [x0, x1, side] of [[30, 48, -1], [30, 43.4, 1], [44.6, 48, 1]]) {
      for (const [a, b, mat] of [[0, 0.45, 'tileBase'], [0.45, 2.4, 'tileWhite'], [2.4, 2.95, 'mosaicStair'], [2.95, 3.4, 'tileWhite']]) this.plane(mat, (x0 + x1) / 2, 4.8 + (a + b) / 2, side * 6, x1 - x0, b - a, 0, side < 0 ? 0 : Math.PI);
      this.collider([x0, 4.8, side < 0 ? -6.3 : 6], [x1, 8.2, side < 0 ? -6 : 6.3], 'mezz-wall', 'tile');
    }
    this.box('tileWhite', 44, 7.6, 6.15, 1.2, 1.2, 0.3);
    for (const x of [30, 48]) {
      this.plane('tileWhite', x, 6.5, 0, 12, 3.4, 0, x === 30 ? Math.PI / 2 : -Math.PI / 2);
      this.collider([x === 30 ? 29.7 : 48, 4.8, -6], [x === 30 ? 30 : 48.3, 8.2, 6], 'mezz-wall', 'tile');
    }
    for (const side of [-1, 1]) {
      this.box('chrome', 33.9, 5.9, side * 1.53, 7.8, 0.04, 0.04);
      for (let x = 30; x <= 37.8; x += 1.5) {
        this.cylinder('chrome', x, 5.35, side * 1.53, 0.02, 1.1, 6);
        this.box('steelPainted', x, 4.815, side * 1.53, 0.12, 0.03, 0.12);
      }
      this.collider([30, 4.8, side < 0 ? -1.56 : 1.5], [37.8, 5.9, side < 0 ? -1.5 : 1.56], 'well-rail');
    }
    for (const z of C.TURNSTILES.zs) {
      this.box('steelGalv', 41.5, 5.3, z, 0.9, 1, 0.2); this.box('chrome', 41.5, 5.805, z, 0.93, 0.025, 0.23);
      this.box('led', 41.11, 5.65, z - 0.105, 0.09, 0.03, 0.01);
      for (let i = 0; i < 3; i++) {
        const geo = new THREE.CylinderGeometry(0.02, 0.02, 0.38, 6); geo.rotateZ(Math.PI / 2); geo.translate(0.19, 0, 0); geo.rotateZ(i * Math.PI * 2 / 3);
        this.addGeo('chrome', transformGeo(geo, 41.5, 5.35, z + 0.14));
      }
      this.collider([41.05, 4.8, z - 0.1], [41.95, 5.8, z + 0.1], 'turnstile');
    }
    for (const [a, b] of C.TURNSTILES.railZ) {
      this.box('chrome', 41.5, 5.8, (a + b) / 2, 0.05, 0.05, b - a);
      for (let z = a; z < b; z += 0.2) this.cylinder('chrome', 41.5, 5.3, z, 0.018, 1, 6);
      this.box('steelGalv', 41.5, 4.84, (a + b) / 2, 0.055, 0.05, b - a);
      for (const z of [a + 0.08, b - 0.08]) this.box('steelPainted', 41.5, 4.815, z, 0.15, 0.03, 0.15);
      this.collider([41.475, 4.8, a], [41.525, 5.8, b], 'fare-rail');
    }
    // The emergency leaf is open along X, outside the clear doorway.
    for (let i = 0; i < 16; i++) this.cylinder('steelGalv', 41.55 + i * 0.13, 5.3, 1.16, 0.012, 1, 6);
    this.box('steelGalv', 42.55, 5.8, 1.16, 2.1, 0.035, 0.035);
    this.sign('signStationClosed', 47.975, 6.4, 0, 2.6, 0.8, -Math.PI / 2);
    for (let i = 0; i < 30; i++) this.box('steelGalv', 47.96, 4.88 + i * 0.078, 0, 0.06, 0.045, 3);
    this.box('emissiveWarm', 47.93, 4.84, 0, 0.015, 0.06, 2.8);
    this.collider([47.9, 4.8, -1.5], [48, 7.2, 1.5], 'shutter');
    this.box('brass', 47.87, 5.9, 0, 0.08, 0.15, 0.11);
    for (let i = 0; i < 30; i++) this.addGeo('chrome', transformGeo(new THREE.TorusGeometry(0.022, 0.006, 4, 8), 47.86, 5.5 + i * 0.025, 0.03 * Math.sin(i), 0, i % 2 * Math.PI / 2));
    this.box('floorSlab', 44, 4.65, 6.4, 1.2, 0.3, 0.8);
    for (const x of [43.3, 44.7]) { this.box('tileWhite', x, 5.9, 6.4, 0.2, 2.2, 0.8); this.collider([x - 0.1, 4.8, 6], [x + 0.1, 7, 6.8], 'door', 'tile'); }
    this.box('tileWhite', 44, 5.9, 6.9, 1.6, 2.2, 0.2); this.collider([43.2, 4.8, 6.8], [44.8, 7, 7], 'door', 'tile');
    this.spawnPoints = {};
    this.makeSpawnDoor('mezz-door', new THREE.Vector3(43.4, 4.8, 6.65), 1.2, 2.2, 0, 1, 'steelPainted');
    this.collider([43.4, 4.8, 6.62], [44.6, 7, 6.68], 'door');
    this.sign('signNoEntry', 44, 6.4, 6.61, 0.65, 0.35, Math.PI);
    this.posterSlots.push({ pos: new THREE.Vector3(32, 6.2, -5.97), rotY: 0, w: 1.4, h: 1.9, backlit: true }, { pos: new THREE.Vector3(46, 6.2, 5.97), rotY: Math.PI, w: 1.4, h: 1.9, backlit: false });
  }
  makeSpawnDoor(id, hinge, w, h, restYaw, sign, material) {
    const group = new THREE.Group(); group.position.copy(hinge); group.rotation.y = restYaw;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.045), getMaterial(material)); mesh.position.set(w / 2, h / 2, 0); group.add(mesh); this.group.add(group);
    const door = { group, amount: 0, target: false, restYaw, sign }; this.doors.push(door);
    const def = C.SPAWN_POINTS[id];
    this.spawnPoints[id] = { id, kind: def.kind, pos: new THREE.Vector3(...def.pos), yaw: def.yaw, exitDir: new THREE.Vector3(...def.exitDir), exitDist: def.exitDist, busy: false,
      open: () => { if (!door.target) { door.target = true; this.G.bus.emit('spawn-door-open', { id, pos: hinge }); } },
      close: () => { if (door.target) { door.target = false; this.G.bus.emit('spawn-door-close', { id, pos: hinge }); } } };
  }
  buildWest() {
    for (const [a, b] of [[-5, -0.6], [0.6, 5]]) {
      this.plane('chainlink', -30, 1.1, (a + b) / 2, b - a, 2.2, 0, Math.PI / 2);
      this.collider([-30.15, 0, a], [-29.85, 2.2, b], 'fence');
    }
    for (const z of [-5, -2.5, -0.6, 0.6, 2.5, 5]) this.cylinder('steelGalv', -30, 1.1, z, 0.035, 2.2, 8);
    this.makeSpawnDoor('west-gate', new THREE.Vector3(-30, 0, 0.6), 1.2, 2, Math.PI / 2, 1, 'chainlink');
    this.collider([-30.15, 0, -0.6], [-29.85, 2.2, 0.6], 'gate');
    this.sign('signNoTrespass', -29.82, 1.35, -1.7, 1, 0.5, Math.PI / 2);
    this.plane('chainlink', -36, 0, 0, 12, 1.2, -Math.PI / 2);
    for (const side of [-1, 1]) {
      this.box('steelGalv', -36, 1, side * 0.6, 12, 0.04, 0.04);
      for (let x = -42; x <= -30; x += 2) this.cylinder('steelGalv', x, -0.05, side * 0.6, 0.025, 2.1, 6);
      this.collider([-42, 0, side * 0.6 - 0.025], [-30.2, 1.05, side * 0.6 + 0.025], 'catwalk-rail', 'metal', C.MASK.PLAYER | C.MASK.BULLET);
    }
    this.box('concreteRaw', -42.15, 1.1, 0, 0.3, 4.4, 3);
    this.box('steelPainted', -41.98, 1.1, 0, 0.05, 2.2, 1.2);
    this.sign('signExitBlue', -41.94, 2.45, 0, 0.8, 0.4, Math.PI / 2);
  }
  buildTunnels() {
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -160 : 30, x1 = side < 0 ? -30 : 160;
      const floor = this.plane('concreteRaw', (x0 + x1) / 2, -1.1, 0, x1 - x0, 10, -Math.PI / 2);
      const colors = floor.attributes.color; for (let k = 0; k < colors.count; k++) colors.setXYZ(k, 0.45, 0.45, 0.45);
      this.collider([x0, -1.4, -5], [x1, -1.1, 5], 'floor-center', 'concrete', C.MASK.BULLET);
      const d0 = side < 0 ? -160 : 44, d1 = side < 0 ? -44 : 160;
      this.box('concreteRaw', (d0 + d1) / 2, -0.65, 0, d1 - d0, 0.9, 0.6);
      this.collider([d0, -1.1, -0.3], [d1, -0.2, 0.3], 'divider', 'concrete', C.MASK.BULLET);
      for (let i = 0; i < 21; i++) {
        const x = side * (35 + i * 6);
        for (const wall of [-1, 1]) {
          this.plane('concreteRaw', x, 1.4, wall * 9, 6, 5, 0, wall < 0 ? 0 : Math.PI);
          this.collider([x - 3, -1.1, wall < 0 ? -9.3 : 9], [x + 3, 3.9, wall < 0 ? -9 : 9.3], 'tunnel-wall', 'concrete', C.MASK.BULLET);
          if (i % 3 === 0) this.box('rubber', x + side, 0.5, wall * 8.96, 0.8, 1.6, 0.05);
          if (Math.abs(x) < 100) {
            for (let cable = 0; cable < 4; cable++) {
              const points = [new THREE.Vector3(x - 3, 2.8 + cable * 0.08, wall * 8.8), new THREE.Vector3(x, 2.75 + cable * 0.08, wall * 8.8), new THREE.Vector3(x + 3, 2.8 + cable * 0.08, wall * 8.8)];
              this.addGeo('rubber', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 6, 0.018, 5, false));
            }
            this.box('steelRust', x - 2, 2.9, wall * 8.7, 0.06, 0.5, 0.35);
          }
        }
        if (side > 0 && i === 0) {
          for (const z of [-5.25, 5.25]) this.plane('concreteRaw', x, 3.9, z, 6, 7.5, Math.PI / 2);
        } else this.plane('concreteRaw', x, 3.9, 0, 6, 18, Math.PI / 2);
        if (side < 0 || i > 0) this.collider([x - 3, 3.9, -9], [x + 3, 4.2, 9], 'tunnel-ceiling', 'concrete', C.MASK.BULLET);
      }
      for (let distance = 44; distance < 158; distance += 1.5) {
        const x = side * distance;
        this.box('steelRust', x, 1.85, 0, 0.06, 4.1, 0.25);
        for (const dx of [-0.105, 0.105]) this.box('steelRust', x + dx, 1.85, 0, 0.04, 4.1, 0.25);
        this.collider([x - 0.125, -0.2, -0.125], [x + 0.125, 3.9, 0.125], 'tunnel-column', 'metal', C.MASK.BULLET);
      }
      this.plane('rubber', side * 160, 1.4, 0, 18, 5, 0, side < 0 ? Math.PI / 2 : -Math.PI / 2);
    }
  }
  buildCrate() {
    const [x, y, z] = C.CRATE.pos;
    this.box('ironGreen', x, y + 0.85, z, 0.8, 1.7, 0.45);
    this.box('rubber', x, y + 0.95, z + 0.23, 0.67, 1.1, 0.01);
    this.crateLid = new THREE.Group(); this.crateLid.position.set(x, y + 1.5, z + 0.25);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.04), getMaterial('steelGalv')); leaf.position.y = -0.55; this.crateLid.add(leaf); this.group.add(this.crateLid);
    this.crateLampMaterial = cloneMaterial('led');
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), this.crateLampMaterial); lamp.position.set(x + 0.25, y + 1.6, z + 0.25); this.group.add(lamp);
    this.sign('signNoEntry', x, y + 0.2, z + 0.235, 0.52, 0.16);
    this.collider([x - 0.4, y, z - 0.225], [x + 0.4, y + 1.7, z + 0.225], 'crate');
    this.crate = { pos: new THREE.Vector3(x, y, z), armed: false, open: false,
      setArmed: value => { this.crate.armed = !!value; this.crateLampMaterial.color.set(value ? 0x55ff88 : 0xff3322).multiplyScalar(2); },
      setOpen: value => { this.crate.open = !!value; } };
    this.crate.setArmed(false);
  }
  buildAnchors() {
    let index = 0;
    for (let i = 0; i < 12; i++) for (const z of [-1.8, 1.8]) this.anchors.troffers.push({ pos: new THREE.Vector3(-24.75 + i * 4.5, 3.55, z), index: index++, mezz: false });
    for (const x of C.MEZZ_TROFFERS.xs) for (const z of C.MEZZ_TROFFERS.zs) this.anchors.troffers.push({ pos: new THREE.Vector3(x, 7.55, z), index: index++, mezz: true });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 10; i++) this.anchors.wallLamps.push(new THREE.Vector3(-27 + i * 6, 3.4, side * 8.8));
      for (let i = 0; i < 10; i++) this.anchors.sodium.push({ pos: new THREE.Vector3(side * (38 + i * 12), 3, (i % 2 ? -side : side) * 8.8), side });
      for (const distance of [44, 80]) this.anchors.signals.push({ pos: new THREE.Vector3(side * distance, 3, side * 8.8), side, x: side * distance });
    }
    this.anchors.exitSigns.push({ pos: new THREE.Vector3(30, 3.2, 0), rotY: -Math.PI / 2 }, { pos: new THREE.Vector3(47.9, 7.45, 0), rotY: -Math.PI / 2 }, { pos: new THREE.Vector3(-41.9, 2.45, 0), rotY: Math.PI / 2, blue: true });
    for (const x of [-15, 15]) this.anchors.emergency.push(new THREE.Vector3(x, 3.4, 0));
    this.anchors.shafts.push(
      { top: new THREE.Vector3(38.4, 8.18, 0), bottom: new THREE.Vector3(38.4, 4.81, 0), rTop: 0.5, rBottom: 1.2, color: 0xcfe0ff },
      { top: new THREE.Vector3(47.85, 7.15, 0), bottom: new THREE.Vector3(44, 4.81, -3), rTop: 0.2, rBottom: 1.1, color: 0xffd9a0 },
      { top: new THREE.Vector3(-9, 4.18, -6.5), bottom: new THREE.Vector3(-9, -0.8, -6.5), rTop: 0.3, rBottom: 0.8, color: 0xb7d5b7 });
  }
  getLightAnchors() { return this.anchors; }
  getPosterSlots() { return this.posterSlots; }
  getMosaicCenters() { return this.mosaicCenters; }
  update(dt) {
    for (const door of this.doors) {
      door.amount = clamp(door.amount + (door.target ? dt / 0.6 : -dt / 1.2), 0, 1);
      door.group.rotation.y = door.restYaw + door.amount * door.sign * Math.PI * 100 / 180;
    }
    if (this.crateLid) this.crateLid.rotation.x += ((this.crate.open ? -1.1 : 0) - this.crateLid.rotation.x) * Math.min(1, dt * 7);
  }
  reset() { for (const door of this.doors) { door.amount = 0; door.target = false; door.group.rotation.y = door.restYaw; } }
  dispose() { this.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); this.G.scene.remove(this.group); }
}
