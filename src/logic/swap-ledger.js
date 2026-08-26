// swap-ledger.js — per-machine model load/swap timing history.
//
// Every load is recorded (operator order, 2026-08-19): the history buys three
// things at once — an honest ETA before a swap ("usually ~8.4s on this
// machine"), progress context while it runs, and a mechanical anomaly flag
// when a load runs far past its own record (a hang or a newly-slow model
// should be NAMED, not sat through). Timings are per-box facts, so the
// ledger lives in the home dir, never the repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HISTORY_CAP = 50;

export function ledgerPath() {
  return process.env.BANTAM_SWAP_LEDGER || path.join(os.homedir(), ".bantam", "swap-ledger.json");
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

export function recordLoad(name, ms, { ok = true, file = ledgerPath(), at = new Date().toISOString() } = {}) {
  const d = load(file);
  d[name] ??= { history: [] };
  d[name].history.push({ ms: Math.round(ms), ok, at });
  d[name].history = d[name].history.slice(-HISTORY_CAP);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d, null, 1));
    return true;
  } catch { return false; }
}

/** Expected duration from this machine's own history of SUCCESSFUL loads. */
export function expectedLoadMs(name, { file = ledgerPath() } = {}) {
  const hist = (load(file)[name]?.history ?? []).filter((h) => h.ok);
  if (!hist.length) return null;
  const sorted = hist.map((h) => h.ms).sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], n: hist.length, lastMs: hist[hist.length - 1].ms };
}

/** "usually ~8.4s on this machine (n=12)" or null on a first-ever load. */
export function renderExpectation(name, opts) {
  const e = expectedLoadMs(name, opts);
  if (!e) return null;
  return `usually ~${(e.medianMs / 1000).toFixed(1)}s on this machine (n=${e.n})`;
}

/**
 * A load is anomalous when it runs far past this machine's own median:
 * over 2x median AND at least 10s over it, with 3+ prior loads on record.
 * Returns a warning line, or null when the timing is unremarkable.
 */
export function loadAnomaly(name, ms, opts) {
  const e = expectedLoadMs(name, opts);
  if (!e || e.n < 3) return null;
  if (ms > 2 * e.medianMs && ms - e.medianMs > 10_000) {
    return `⚠ this load took ${(ms / 1000).toFixed(1)}s — ${(ms / e.medianMs).toFixed(1)}x this machine's usual ${(e.medianMs / 1000).toFixed(1)}s. Check GPU memory pressure, disk cache eviction, or the server log before trusting the stack.`;
  }
  return null;
}
