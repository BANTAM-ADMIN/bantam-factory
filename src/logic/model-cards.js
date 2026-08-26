// model-cards.js — self-updating performance cards for every model profile.
//
// Operator order (2026-08-19): as a model is used, its card should learn —
// TTFT, generation speed, prompt speed, bucketed by context length — so the
// system can estimate how long a request will take BEFORE running it, and a
// human can read one simple card and know what each profile is for. Samples
// come free with every completion (llama.cpp returns timings); nothing here
// costs a single extra token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cardsPath() {
  return process.env.BANTAM_MODEL_CARDS || path.join(os.homedir(), ".bantam", "model-cards.json");
}

export function activeProfilePath() {
  return process.env.BANTAM_ACTIVE_PROFILE_FILE || path.join(os.homedir(), ".bantam", "active-profile.json");
}

/** The profile the last swap/replay put on the endpoint, or null. */
export function activeProfile(file = activeProfilePath()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8"))?.name ?? null; } catch { return null; }
}

export function setActiveProfile(name, file = activeProfilePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name, at: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

// Context-length buckets: speed varies with how full the KV is, so stats are
// kept per band rather than blurred into one number.
const BUCKETS = [
  { key: "0-8k", max: 8192 },
  { key: "8-32k", max: 32768 },
  { key: "32-64k", max: 65536 },
  { key: "64k+", max: Infinity },
];
export function bucketFor(promptTokens) {
  return BUCKETS.find((b) => promptTokens < b.max).key;
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

// Exponentially-weighted mean: new samples matter more, thermal drift and
// upgrades show through, one outlier cannot own the card.
const ALPHA = 0.2;
const ewma = (prev, x) => (prev == null ? x : prev + ALPHA * (x - prev));

/** Record one completion's timings under the profile's card. */
export function recordSample(profile, { promptN = 0, promptMs = null, genN = 0, genMs = null }, { file = cardsPath() } = {}) {
  if (!profile || (!genN && !promptN)) return false;
  const d = load(file);
  d[profile] ??= { buckets: {}, samples: 0 };
  const b = (d[profile].buckets[bucketFor(promptN)] ??= { n: 0 });
  b.n += 1;
  d[profile].samples += 1;
  if (promptMs != null && promptN > 0) {
    b.ttftMs = Math.round(ewma(b.ttftMs, promptMs));
    b.promptTps = Math.round(ewma(b.promptTps, promptN / (promptMs / 1000)));
  }
  if (genMs != null && genN > 1) {
    b.genTps = Math.round(ewma(b.genTps, genN / (genMs / 1000)) * 10) / 10;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d, null, 1));
    return true;
  } catch { return false; }
}

/** ETA for a request from the card's own measurements; null when unlearned. */
export function estimateMs(profile, { promptTokens = 0, genTokens = 200 }, { file = cardsPath() } = {}) {
  const card = load(file)[profile];
  if (!card) return null;
  const b = card.buckets[bucketFor(promptTokens)]
    ?? Object.values(card.buckets).find((x) => x.genTps); // nearest learned band
  if (!b?.genTps) return null;
  const prefill = b.promptTps ? (promptTokens / b.promptTps) * 1000 : (b.ttftMs ?? 0);
  return { ms: Math.round(prefill + (genTokens / b.genTps) * 1000), basis: `measured over ${card.samples} request(s) on this machine` };
}

/** One plain-language card per profile, composed from every ledger we keep. */
export function renderCard(reg, { file = cardsPath(), loadLine = null } = {}) {
  const card = load(file)[reg.name];
  const lines = [];
  lines.push(`${reg.name}${reg.notes ? ` — ${reg.notes}` : ""}`);
  const caps = [
    reg.slots ? `${reg.slots} slot${reg.slots > 1 ? "s" : ""}` : null,
    reg.vision ? "vision" : null,
    reg.vramMb ? `~${(reg.vramMb / 1024).toFixed(1)} GB VRAM` : null,
  ].filter(Boolean);
  if (caps.length) lines.push(`  ${caps.join(" · ")}${loadLine ? ` · load ${loadLine}` : ""}`);
  if (card) {
    for (const [k, b] of Object.entries(card.buckets)) {
      const bits = [b.genTps ? `${b.genTps} tok/s` : null, b.ttftMs ? `ttft ~${(b.ttftMs / 1000).toFixed(1)}s` : null, b.promptTps ? `prefill ${b.promptTps} tok/s` : null].filter(Boolean);
      if (bits.length) lines.push(`  @${k}: ${bits.join(" · ")} (n=${b.n})`);
    }
  } else {
    lines.push("  no runtime samples yet — the card learns as you use it");
  }
  return lines.join("\n");
}
