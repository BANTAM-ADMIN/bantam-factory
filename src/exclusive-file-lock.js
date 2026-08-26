// Small synchronous cross-process lock with race-safe stale recovery.
//
// A stale pathname is never removed solely from an earlier stat/read. Recovery
// contenders serialize on a guard derived from the observed inode/token, then
// re-read and compare that exact inode and payload before unlinking it.

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const RECOVERY_CHILD = fileURLToPath(new URL("./lock-recovery-child.js", import.meta.url));

export function acquireExclusiveFileLock(file, {
  kind = "exclusive-lock",
  staleAfterMs = 30_000,
  initializeGraceMs = staleAfterMs,
  waitMs = 0,
  pollMs = 10,
} = {}) {
  const lockPath = path.resolve(file);
  validateDuration(staleAfterMs, "staleAfterMs");
  validateDuration(initializeGraceMs, "initializeGraceMs");
  validateDuration(waitMs, "waitMs");
  validateDuration(pollMs, "pollMs");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const token = crypto.randomBytes(16).toString("hex");
  const owner = {
    schema: 1,
    kind: String(kind),
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + waitMs;

  for (;;) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } catch (error) {
        removeOwnedPath(lockPath, descriptor);
        throw error;
      } finally {
        fs.closeSync(descriptor);
      }
      return ownership(lockPath, owner);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
      }
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = readLockSnapshot(lockPath);
    if (!observed) continue;
    if (isRecoverable(observed, { staleAfterMs, initializeGraceMs })) {
      if (recoverObservedLock(lockPath, observed, { staleAfterMs, initializeGraceMs })) {
        continue;
      }
      // The stale pathname either changed or another contender is recovering
      // it. Re-observe instead of acting on the old inode.
      if (Date.now() < deadline) {
        Atomics.wait(SLEEP, 0, 0, pollMs);
        continue;
      }
    }
    if (Date.now() >= deadline) throw busyError(lockPath, observed);
    Atomics.wait(SLEEP, 0, 0, pollMs);
  }
}

function ownership(file, owner) {
  let released = false;
  return {
    file,
    owner: { ...owner },
    token: owner.token,
    release() {
      if (released) return false;
      released = true;
      const observed = readLockSnapshot(file);
      if (!observed || observed.record?.token !== owner.token) return false;
      try {
        fs.unlinkSync(file);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

function recoverObservedLock(file, observed, limits) {
  const guardPath = `${file}.recovery`;
  const result = spawnSync(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      guardPath,
      process.execPath,
      RECOVERY_CHILD,
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        BANTAM_LOCK_RECOVERY_PAYLOAD: JSON.stringify({
          file,
          expectedDev: observed.stat.dev,
          expectedIno: observed.stat.ino,
          expectedSha256: digest(observed.raw),
          ...limits,
        }),
      },
    },
  );
  if (result.error) {
    throw new Error(`could not run crash-safe lock recovery: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if ([1, 3].includes(result.status)) return false;
  throw new Error(
    `crash-safe lock recovery failed (exit ${result.status}): ${String(result.stderr).trim()}`,
  );
}

function readLockSnapshot(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`lock is not a regular file: ${file}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let record = null;
  try { record = JSON.parse(raw); } catch { /* an initializing lock has no record yet */ }
  return { stat, raw, record };
}

function isRecoverable(snapshot, { staleAfterMs, initializeGraceMs }) {
  const record = snapshot.record;
  if (
    record
    && record.schema === 1
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.token === "string"
  ) {
    const acquiredAt = Date.parse(record.acquiredAt);
    const since = Number.isFinite(acquiredAt)
      ? Math.max(acquiredAt, snapshot.stat.mtimeMs)
      : snapshot.stat.mtimeMs;
    return Date.now() - since >= staleAfterMs && !processAlive(record.pid);
  }
  return Date.now() - snapshot.stat.mtimeMs >= initializeGraceMs;
}

function busyError(file, snapshot) {
  const error = new Error(`lock is active: ${file}`);
  error.code = "ELOCKED";
  error.owner = snapshot?.record ?? null;
  error.initializing = snapshot?.record === null;
  return error;
}

function removeOwnedPath(file, descriptor) {
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (opened.dev === current.dev && opened.ino === current.ino) fs.rmSync(file, { force: true });
  } catch {
    // Preserve the write/fsync failure that prompted cleanup.
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validateDuration(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
