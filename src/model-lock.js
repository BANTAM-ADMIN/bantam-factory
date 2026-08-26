// One run at a time on a local model server.
//
// The local 27B serves a single slot (`--parallel 1`). Two concurrent bantam
// runs don't error — they alternate, and each swap evicts the other's KV cache,
// so the server re-prefills tens of thousands of prompt tokens per turn instead
// of generating (measured 2026-08-17: +29,700 prompt vs +200 generated tokens in
// 15s while two probes fought over the slot). Serialization is strictly faster
// than interleaving, so runs against a LOCAL endpoint hold a cross-process lock
// for their whole lifetime and later runs wait — visibly, via onWait.
//
// Remote/API endpoints have real concurrency and never lock. The lock file is
// O_EXCL-created and carries the holder's pid; a file whose pid is dead is
// stolen immediately, so a SIGKILLed run cannot wedge the queue.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

function isLocalEndpoint(endpoint) {
  try {
    return LOCAL_HOSTS.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function modelLockPath({ endpoint, lockDir = defaultLockDir(), slot = 0 }) {
  const key = String(endpoint).toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9.:-]+/g, "-").replace(/:/g, "_");
  return path.join(lockDir, slot > 0 ? `${key}.slot${slot}.lock` : `${key}.lock`);
}

/** How many concurrent runs the server can actually hold: its slot count.
 *  Probe failure means 1 — the historical single-flight behavior. */
export async function probeSlotCapacity(endpoint, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${String(endpoint).replace(/\/$/, "")}/slots`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return 1;
    const s = await r.json();
    return Array.isArray(s) && s.length > 0 ? s.length : 1;
  } catch { return 1; }
}

function defaultLockDir() {
  return path.join(os.tmpdir(), "bantam-model-locks");
}

/**
 * Acquire the single-flight lock for a local model endpoint. Resolves to
 * `{ path, release() }`, or `null` when no lock applies (remote endpoint, or
 * disabled). Waits indefinitely for a live holder; `onWait({holderPid,
 * heldForMs, path})` fires about every 5s so the wait is never silent.
 */
export async function acquireModelLock({
  endpoint,
  lockDir = defaultLockDir(),
  pollMs = 2000,
  onWait = null,
  slots = null,
  enabled = process.env.BANTAM_MODEL_LOCK !== "0",
} = {}) {
  if (!enabled || !endpoint || !isLocalEndpoint(endpoint)) return null;
  fs.mkdirSync(lockDir, { recursive: true });
  // Slot-aware capacity (2026-08-19): a multi-slot server really can hold N
  // concurrent runs — that is the point of the duo/crew profiles — so the
  // lock allows one holder PER SLOT. A failed probe means capacity 1, which
  // is exactly the historical single-flight behavior.
  const capacity = Math.max(1, slots ?? await probeSlotCapacity(endpoint));
  const body = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const waitStarted = Date.now();
  let lastWaitNote = 0;
  for (;;) {
    for (let slot = 0; slot < capacity; slot++) {
      const file = modelLockPath({ endpoint, lockDir, slot });
      try {
        fs.writeFileSync(file, body(), { flag: "wx" });
        return {
          path: file,
          slot,
          capacity,
          release() {
            // Remove only a lock we still own — a stolen lock belongs to the thief.
            try {
              if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file);
            } catch { /* already gone or unreadable — nothing of ours to remove */ }
          },
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* mid-write or corrupt — poll again */ }
      if (holder && Number.isInteger(holder.pid) && !isProcessAlive(holder.pid)) {
        try { fs.unlinkSync(file); } catch { /* someone else stole it first */ }
        slot--; // retry this slot immediately now that the corpse is gone
        continue;
      }
    }
    const now = Date.now();
    if (onWait && now - lastWaitNote >= Math.min(5000, pollMs)) {
      lastWaitNote = now;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(modelLockPath({ endpoint, lockDir, slot: 0 }), "utf8")); } catch { /* transient */ }
      onWait({ holderPid: holder?.pid ?? null, heldForMs: now - waitStarted, path: modelLockPath({ endpoint, lockDir, slot: 0 }), capacity });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Which live processes currently hold a lock on this endpoint. A swap restarts
 * the server, so anything holding a lock is a run that the swap would kill —
 * the swap needs to be able to SEE that before it acts. Dead holders are not
 * reported: a stale lock file is a corpse, not a claim.
 */
export function liveModelLockHolders({ endpoint, lockDir = defaultLockDir() } = {}) {
  if (!endpoint) return [];
  const prefix = path.basename(modelLockPath({ endpoint, lockDir })).replace(/\.lock$/, "");
  let names = [];
  try { names = fs.readdirSync(lockDir); } catch { return []; }
  const holders = [];
  for (const name of names) {
    if (name !== `${prefix}.lock` && !name.startsWith(`${prefix}.slot`)) continue;
    const file = path.join(lockDir, name);
    let body = null;
    try { body = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!Number.isInteger(body?.pid) || !isProcessAlive(body.pid)) continue;
    holders.push({ pid: body.pid, startedAt: body.startedAt ?? null, path: file });
  }
  return holders;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means "alive but not ours" — still alive.
    return e.code === "EPERM";
  }
}
