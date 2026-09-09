/** Synchronous events with bounded, JSON-safe diagnostic history. */
export class Bus {
  constructor() {
    this.map = new Map();
    this.ring = [];
    this.ringHead = 0;
    this.ringCap = 512;
    this.time = 0;
  }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) { this.map.get(name)?.delete(fn); }
  once(name, fn) {
    const off = this.on(name, data => { off(); fn(data); });
    return off;
  }
  emit(name, payload = {}) {
    const data = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) data[key] = value;
      else if (value && value.id !== undefined) data[`${key}Id`] = value.id;
    }
    this.ring[this.ringHead] = { t: this.time, type: name, data };
    this.ringHead = (this.ringHead + 1) % this.ringCap;
    const listeners = this.map.get(name);
    if (listeners) for (const fn of [...listeners]) fn(payload);
  }
  clear() {
    this.ring.length = 0;
    this.ringHead = 0;
  }
}
