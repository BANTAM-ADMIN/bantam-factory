export function normalizeChannels(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of list) {
    const name = String(entry).trim().toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function normalizeDelivery(value) {
  const out = {};
  for (const [key, flag] of Object.entries(value ?? {})) {
    out[String(key).trim().toLowerCase()] = Boolean(flag);
  }
  return out;
}
