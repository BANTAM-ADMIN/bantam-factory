import * as THREE from 'three';
import { clamp } from './utils.js';

export class Input {
  constructor(G) { this.G = G; }
  init() {
    this.move = new THREE.Vector2();
    this.moveWorld = null;
    this.worldVector = new THREE.Vector2();
    this.injectedMove = new THREE.Vector2();
    this.lookDelta = { x: 0, y: 0 };
    this.pendingLook = { x: 0, y: 0 };
    this.keys = new Set();
    this.pending = {};
    this.handlers = [];
    this.reset();
    this.attach(this.G.canvas);
  }
  listen(target, type, fn, options) { target.addEventListener(type, fn, options); this.handlers.push({ target, type, fn, options }); }
  attach(domElement) {
    this.detach();
    this.listen(window, 'keydown', e => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyR') this.pressReload();
      if (e.code === 'KeyE') this.pressInteract();
      if (e.code === 'KeyQ') this.pending.lastWeapon = true;
      if (e.code === 'Enter') this.pending.restart = true;
      if (/^Digit[123]$/.test(e.code)) this.pressSwitch(Number(e.code.at(-1)) - 1);
    });
    this.listen(window, 'keyup', e => this.keys.delete(e.code));
    this.listen(window, 'blur', () => this.reset());
    this.listen(document, 'mousemove', e => {
      if (document.pointerLockElement === domElement) this.addLook(e.movementX, e.movementY);
    });
    this.listen(domElement, 'mousedown', e => {
      if (!this.G.started || this.G.paused || this.G.gameOver) return;
      if (e.button === 0) this.holdFire(true);
      if (e.button === 2) this.setAds(true);
    });
    this.listen(window, 'mouseup', e => { if (e.button === 0) this.holdFire(false); if (e.button === 2) this.setAds(false); });
    this.listen(domElement, 'contextmenu', e => e.preventDefault());
    this.listen(domElement, 'wheel', e => {
      e.preventDefault();
      if (this.wheelCooldown <= 0 && e.deltaY) { this.pending.cycle = Math.sign(e.deltaY); this.wheelCooldown = 0.12; }
    }, { passive: false });
  }
  detach() {
    if (!this.handlers) return;
    for (const h of this.handlers) h.target.removeEventListener(h.type, h.fn, h.options);
    this.handlers.length = 0;
  }
  update(dt = 1 / 60) {
    this.wheelCooldown = Math.max(0, this.wheelCooldown - dt);
    const k = this.keys;
    let x = this.injectedMove.x + Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'));
    let y = this.injectedMove.y + Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
    if (this.moveWorld) {
      const yaw = this.G.player.yaw, s = Math.sin(yaw), c = Math.cos(yaw);
      x = this.moveWorld.x * c - this.moveWorld.y * s;
      y = -this.moveWorld.x * s - this.moveWorld.y * c;
    }
    this.move.set(x, y).clampLength(0, 1);
    this.lookDelta.x = this.pendingLook.x; this.lookDelta.y = this.pendingLook.y;
    this.pendingLook.x = this.pendingLook.y = 0;
    this.sprint = this.sprintInjected || k.has('ShiftLeft') || k.has('ShiftRight');
    this.ads = this.adsInjected;
    this.fire = this.heldFire || this.tapFire;
    this.fireJustPressed = this.pending.firePressed || (this.fire && !this.previousFire);
    this.fireJustReleased = this.pending.fireReleased || (!this.fire && this.previousFire);
    this.previousFire = this.fire;
    this.tapFire = false;
    this.reload = !!this.pending.reload; this.interact = !!this.pending.interact;
    this.restart = !!this.pending.restart; this.lastWeapon = !!this.pending.lastWeapon;
    this.switchTo = this.pending.switchTo ?? -1; this.cycle = this.pending.cycle || 0;
    this.pending.reload = this.pending.interact = this.pending.restart = this.pending.lastWeapon = false;
    this.pending.firePressed = this.pending.fireReleased = false;
    this.pending.switchTo = -1; this.pending.cycle = 0;
  }
  setMove(strafe, forward) { this.moveWorld = null; this.injectedMove.set(strafe, forward).clampLength(0, 1); }
  setMoveWorld(dx, dz) {
    if (dz === null) { this.moveWorld = null; return; }
    this.worldVector.set(dx, dz).clampLength(0, 1); this.moveWorld = this.worldVector;
  }
  addLook(dx, dy) { this.pendingLook.x += clamp(dx, -200, 200); this.pendingLook.y += clamp(dy, -200, 200); }
  pressFire() { this.tapFire = true; this.pending.firePressed = true; }
  holdFire(value) {
    const next = !!value;
    if (next && !this.heldFire) this.pending.firePressed = true;
    if (!next && this.heldFire) this.pending.fireReleased = true;
    this.heldFire = next;
  }
  pressReload() { this.pending.reload = true; }
  pressSwitch(index) { if (Number.isInteger(index) && index >= 0 && index < 3) this.pending.switchTo = index; }
  pressInteract() { this.pending.interact = true; }
  setSprint(value) { this.sprintInjected = !!value; }
  setAds(value) { this.adsInjected = !!value; }
  reset() {
    this.keys.clear(); this.move.set(0, 0); this.injectedMove.set(0, 0); this.moveWorld = null;
    this.pendingLook.x = this.pendingLook.y = this.lookDelta.x = this.lookDelta.y = 0;
    this.sprint = this.ads = this.sprintInjected = this.adsInjected = false;
    this.fire = this.heldFire = this.tapFire = this.previousFire = this.fireJustPressed = this.fireJustReleased = false;
    this.reload = this.interact = this.restart = this.lastWeapon = false;
    this.switchTo = -1; this.cycle = 0; this.wheelCooldown = 0;
    for (const key of Object.keys(this.pending)) delete this.pending[key];
  }
  dispose() { this.detach(); this.reset(); }
}
