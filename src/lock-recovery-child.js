// Runs only under the host `flock` utility. The kernel releases the recovery
// mutex if this process crashes, so stale-lock recovery cannot leave its own
// permanent lock behind.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (isDirectExecution()) {
  const payload = parsePayload(process.env.BANTAM_LOCK_RECOVERY_PAYLOAD);
  process.exitCode = recover(payload) ? 0 : 3;
}

function recover({
  file,
  expectedDev,
  expectedIno,
  expectedSha256,
  staleAfterMs,
  initializeGraceMs,
}) {
  let stat;
  let raw;
  try {
    stat = fs.lstatSync(file);
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.dev !== expectedDev
    || stat.ino !== expectedIno
    || digest(raw) !== expectedSha256
  ) return false;

  let record = null;
  try { record = JSON.parse(raw); } catch { /* stale partial initialization */ }
  if (!isRecoverable({ stat, record }, { staleAfterMs, initializeGraceMs })) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function parsePayload(value) {
  let parsed;
  try { parsed = JSON.parse(String(value ?? "")); }
  catch { throw new Error("invalid lock recovery payload"); }
  if (
    !parsed
    || typeof parsed.file !== "string"
    || !Number.isFinite(parsed.expectedDev)
    || !Number.isFinite(parsed.expectedIno)
    || !/^[a-f0-9]{64}$/.test(parsed.expectedSha256 ?? "")
    || !Number.isFinite(parsed.staleAfterMs)
    || !Number.isFinite(parsed.initializeGraceMs)
  ) throw new Error("invalid lock recovery payload");
  return parsed;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}
