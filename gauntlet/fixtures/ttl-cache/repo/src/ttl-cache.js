export function createTtlCache({ now = Date.now } = {}) {
  const entries = new Map();
  return {
    set(key, value, ttlMs) {
      entries.set(key, { value, expires: Date.now() + ttlMs });
      return this;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() > entry.expires) return undefined;
      return entry.value;
    },
    has(key) { return entries.has(key); },
    delete(key) { return entries.delete(key); },
    clear() { entries.clear(); },
  };
}
