// Durable, content-addressed run journal.
//
// This is intentionally a small storage primitive, not another agent policy
// layer. One lane has one JSONL writer. Large values live in BlobStore; journal
// entries carry hashes and form a tamper-evident parent chain. Mutable heads are
// tiny atomic refs updated with compare-and-swap.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

export class BlobStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  put(value, { durability = "strict" } = {}) {
    requireDurability(durability);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const digest = sha256(bytes);
    const destination = this.pathFor(digest);
    if (!fs.existsSync(destination)) {
      if (durability === "deferred") writeBufferOnceDeferred(destination, bytes);
      else writeBufferOnce(destination, bytes);
    }
    return `sha256:${digest}`;
  }

  putJson(value, options) {
    return this.put(canonicalJson(value), options);
  }

  get(ref) {
    const digest = normalizeDigest(ref);
    const bytes = fs.readFileSync(this.pathFor(digest));
    const actual = sha256(bytes);
    if (actual !== digest) throw new Error(`blob hash mismatch: expected ${digest}, found ${actual}`);
    return bytes;
  }

  getText(ref) {
    return this.get(ref).toString("utf8");
  }

  getJson(ref) {
    return JSON.parse(this.getText(ref));
  }

  has(ref) {
    return fs.existsSync(this.pathFor(normalizeDigest(ref)));
  }

  pathFor(ref) {
    const digest = normalizeDigest(ref);
    return path.join(this.root, "sha256", digest.slice(0, 2), digest.slice(2));
  }
}

export class LaneJournal {
  constructor({ root, laneId }) {
    this.root = path.resolve(root);
    this.laneId = validateId(laneId, "lane");
    this.path = path.join(this.root, "journal", "lanes", `${this.laneId}.jsonl`);
    const loaded = readJournal(this.path, this.laneId);
    this.events = loaded.events;
    this.head = this.events.at(-1) ?? null;
    this.pendingTailRepair = loaded.pendingRepair;
    this.quarantinedTailPath = null;
  }

  append(type, payload = {}, options = {}) {
    if (!type || typeof type !== "string") throw new Error("journal event type is required");
    const normalizedPayload = canonicalValue(payload);
    const hasExplicitParent = Object.prototype.hasOwnProperty.call(options, "parent");
    const parent = hasExplicitParent ? options.parent : (this.head?.id ?? null);
    if (parent !== null && (typeof parent !== "string" || !this.at(parent))) {
      throw new Error(`journal parent does not exist: ${parent}`);
    }
    if (parent === null && this.events.length > 0) {
      throw new Error("only the first journal event may have a null parent");
    }
    const body = {
      schema: 2,
      lane: this.laneId,
      seq: this.events.length + 1,
      parent,
      type,
      time: new Date().toISOString(),
      payload: normalizedPayload,
    };
    const id = `sha256:${sha256(canonicalJson(body))}`;
    const event = { ...body, id };
    this.repairTailBeforeAppend();
    // Deferred durability trades per-line fsync for buffered appends; the hash
    // chain and tail-repair machinery keep a crash-truncated suffix detectable
    // and recoverable, and any later strict append fsyncs the whole file,
    // landing every buffered line with it.
    const durability = requireDurability(options.durability ?? "strict");
    if (durability === "deferred") appendJsonLineDeferred(this.path, canonicalJson(event));
    else appendJsonLineDurable(this.path, canonicalJson(event));
    this.events.push(event);
    this.head = event;
    return event;
  }

  repairTailBeforeAppend() {
    const repair = this.pendingTailRepair;
    if (!repair) return false;
    const current = fs.existsSync(this.path) ? fs.readFileSync(this.path) : Buffer.alloc(0);
    if (current.length !== repair.sourceLength || sha256(current) !== repair.sourceDigest) {
      throw new Error(`journal changed since tail recovery was inspected: ${this.laneId}`);
    }
    if (repair.kind === "truncated") {
      const quarantine = quarantineTail(this.root, this.laneId, repair.fragment);
      writeBufferDurableAtomic(this.path, repair.prefix);
      this.quarantinedTailPath = quarantine;
    } else if (repair.kind === "missing-newline") {
      writeBufferDurableAtomic(this.path, Buffer.concat([current, Buffer.from("\n")]));
    } else {
      throw new Error(`unsupported journal tail repair: ${repair.kind}`);
    }
    this.pendingTailRepair = null;
    return true;
  }

  count() {
    return this.events.length;
  }

  at(eventId) {
    return this.events.find((event) => event.id === eventId) ?? null;
  }
}

export class RefStore {
  constructor(root, { staleAfterMs = DEFAULT_STALE_LOCK_MS } = {}) {
    this.root = path.resolve(root);
    this.staleAfterMs = validateStaleAfter(staleAfterMs);
  }

  read(kind, name) {
    const file = this.pathFor(kind, name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  init(kind, name, value) {
    const file = this.pathFor(kind, name);
    withRefLock(file, this.staleAfterMs, () => {
      if (fs.existsSync(file)) throw new Error(`${kind} ref already exists: ${name}`);
      writeJsonDurableAtomic(file, value);
    });
    return value;
  }

  compareAndSwap(kind, name, expectedEventId, next) {
    const file = this.pathFor(kind, name);
    return withRefLock(file, this.staleAfterMs, () => {
      const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      const actual = current?.eventId ?? null;
      if (actual !== (expectedEventId ?? null)) {
        throw new Error(`stale ${kind} ref ${name}: expected ${expectedEventId ?? "null"}, found ${actual ?? "null"}`);
      }
      writeJsonDurableAtomic(file, next);
      return next;
    });
  }

  pathFor(kind, name) {
    const safeKind = validateId(kind, "ref kind");
    const safeName = validateId(name, "ref name");
    return path.join(this.root, "refs", safeKind, `${safeName}.json`);
  }
}

export class LaneLease {
  constructor({ root, laneId, staleAfterMs = DEFAULT_STALE_LOCK_MS }) {
    this.laneId = validateId(laneId, "lane");
    this.path = path.join(path.resolve(root), "locks", `${this.laneId}.lock`);
    this.staleAfterMs = validateStaleAfter(staleAfterMs);
    this.owned = false;
    this.token = null;
  }

  acquire(meta = {}) {
    if (this.owned) throw new Error(`lane is already leased: ${this.laneId}`);
    try {
      const ownership = acquireLock(this.path, this.staleAfterMs, {
        kind: "lane",
        laneId: this.laneId,
        metadata: meta,
      });
      this.owned = true;
      this.token = ownership.token;
      return ownership.record;
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`lane is already leased: ${this.laneId}`);
      throw error;
    }
  }

  release() {
    if (!this.owned) return false;
    const released = releaseLock(this.path, this.token);
    this.owned = false;
    this.token = null;
    return released;
  }
}

export function verifyJournal(events, laneId = null) {
  const priorIds = new Set();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event || event.schema !== 2) throw new Error("unsupported journal event schema");
    if (laneId !== null && event.lane !== laneId) throw new Error("journal lane mismatch");
    if (event.seq !== index + 1) throw new Error(`journal sequence break at ${event.seq}`);
    if (index === 0 && event.parent !== null) throw new Error("first journal event must have a null parent");
    if (index > 0 && !priorIds.has(event.parent)) {
      throw new Error(`journal parent missing at sequence ${event.seq}`);
    }
    const { id, ...body } = event;
    const expected = `sha256:${sha256(canonicalJson(body))}`;
    if (id !== expected) throw new Error(`journal hash mismatch at sequence ${event.seq}`);
    if (priorIds.has(id)) throw new Error(`duplicate journal event at sequence ${event.seq}`);
    priorIds.add(id);
  }
  return true;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value, location = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`value at ${location} is not strict JSON`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`value at ${location} is not strict JSON`);
  if (ancestors.has(value)) throw new Error(`value at ${location} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`value at ${location} is not a plain JSON object`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const representedKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (representedKeys.length !== Object.keys(value).length) {
        throw new Error(`value at ${location} has non-JSON array properties`);
      }
      const extraKeys = Object.keys(value).filter((key) => {
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key;
      });
      if (extraKeys.length) throw new Error(`value at ${location} has non-JSON array properties`);
      const out = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`value at ${location}[${index}] is a sparse array entry`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new Error(`value at ${location}[${index}] is not a JSON data property`);
        }
        out.push(canonicalValue(value[index], `${location}[${index}]`, ancestors));
      }
      return out;
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new Error(`value at ${location} has non-JSON object properties`);
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`value at ${location}.${key} is not a JSON data property`);
      }
      Object.defineProperty(out, key, {
        value: canonicalValue(value[key], `${location}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function readJournal(file, laneId) {
  if (!fs.existsSync(file)) return { events: [], pendingRepair: null };
  const raw = fs.readFileSync(file);
  if (raw.length === 0) return { events: [], pendingRepair: null };

  const endsWithNewline = raw.at(-1) === 0x0a;
  const finalNewline = raw.lastIndexOf(0x0a);
  const hasCompleteLine = endsWithNewline || finalNewline >= 0;
  const completeBytes = endsWithNewline
    ? raw.subarray(0, raw.length - 1)
    : raw.subarray(0, Math.max(finalNewline, 0));
  const completeLines = hasCompleteLine ? completeBytes.toString("utf8").split("\n") : [];
  const events = completeLines.map((line, index) => parseJournalLine(line, index + 1));

  if (endsWithNewline) {
    verifyJournal(events, laneId);
    return { events, pendingRepair: null };
  }

  // An unterminated final value is the only ambiguous crash boundary. Verify
  // the complete prefix before deciding whether the tail is recoverable.
  verifyJournal(events, laneId);
  const fragmentOffset = finalNewline + 1;
  const fragment = raw.subarray(fragmentOffset);
  let finalEvent;
  try { finalEvent = JSON.parse(fragment.toString("utf8")); }
  catch {
    return {
      events,
      pendingRepair: {
        kind: "truncated",
        sourceDigest: sha256(raw),
        sourceLength: raw.length,
        prefix: Buffer.from(raw.subarray(0, fragmentOffset)),
        fragment: Buffer.from(fragment),
      },
    };
  }

  const allEvents = [...events, finalEvent];
  verifyJournal(allEvents, laneId);
  return {
    events: allEvents,
    pendingRepair: {
      kind: "missing-newline",
      sourceDigest: sha256(raw),
      sourceLength: raw.length,
    },
  };
}

function parseJournalLine(line, lineNumber) {
  if (line.length === 0) throw new Error(`invalid journal JSON at line ${lineNumber}`);
  try { return JSON.parse(line); }
  catch { throw new Error(`invalid journal JSON at line ${lineNumber}`); }
}

function quarantineTail(root, laneId, fragment) {
  const digest = sha256(fragment);
  const destination = path.join(root, "journal", "quarantine", laneId, `${digest}.fragment`);
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (!existing.equals(fragment)) throw new Error(`journal tail quarantine mismatch: ${destination}`);
    return destination;
  }
  writeBufferOnce(destination, fragment);
  const stored = fs.readFileSync(destination);
  if (!stored.equals(fragment)) throw new Error(`journal tail quarantine mismatch: ${destination}`);
  return destination;
}

function requireDurability(value) {
  if (value !== "strict" && value !== "deferred") throw new Error(`unsupported durability class: ${value}`);
  return value;
}

function appendJsonLineDeferred(file, serialized) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeFileSync(fd, serialized + "\n", "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeBufferOnceDeferred(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

function appendJsonLineDurable(file, serialized) {
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeFileSync(fd, serialized + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fsyncDirectory(path.dirname(file));
}

function writeBufferOnce(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(tmp, file);
      fsyncDirectory(path.dirname(file));
    }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

function writeBufferDurableAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

function writeJsonDurableAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

function withRefLock(file, staleAfterMs, fn) {
  const lock = `${file}.lock`;
  let ownership;
  try {
    ownership = acquireLock(lock, staleAfterMs, { kind: "ref", ref: file });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`ref is locked: ${file}`);
    throw error;
  }
  try { return fn(); }
  finally { releaseLock(lock, ownership.token); }
}

function acquireLock(file, staleAfterMs, metadata) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomBytes(16).toString("hex");
    const record = {
      ...metadata,
      schema: 1,
      pid: process.pid,
      hostname: os.hostname(),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      acquiredAt: new Date().toISOString(),
      token,
    };
    let fd;
    let created = false;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      created = true;
      fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(path.dirname(file));
      return { token, record };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) fs.rmSync(file, { force: true });
      if (error.code !== "EEXIST" || attempt > 0 || !recoverStaleLock(file, staleAfterMs)) throw error;
    }
  }
  const error = new Error(`lock already exists: ${file}`);
  error.code = "EEXIST";
  throw error;
}

function recoverStaleLock(file, staleAfterMs) {
  let first;
  try { first = readLock(file); }
  catch { return false; }
  if (!isRecoverableLock(first, staleAfterMs)) return false;

  // Contenders inspecting the same stale token serialize on a token-specific
  // recovery guard. They never wait or retry against a replacement lock, so a
  // newly acquired live lock cannot be unlinked using an old observation.
  const guard = acquireRecoveryGuard(file, first.record.token);
  if (!guard) return false;
  try {
    let second;
    try { second = readLock(file); }
    catch (error) { return error.code === "ENOENT"; }
    if (
      second.record.token !== first.record.token
      || second.record.pid !== first.record.pid
      || second.record.hostname !== first.record.hostname
      || second.record.uid !== first.record.uid
      || second.record.acquiredAt !== first.record.acquiredAt
      || second.stat.dev !== first.stat.dev
      || second.stat.ino !== first.stat.ino
      || !isRecoverableLock(second, staleAfterMs)
    ) return false;
    try {
      fs.unlinkSync(file);
      fsyncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      return false;
    }
  } finally {
    releaseLock(guard.path, guard.token);
  }
}

function isRecoverableLock(candidate, staleAfterMs) {
  if (!candidate.stat.isFile() || candidate.stat.isSymbolicLink()) return false;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const { record, stat } = candidate;
  if (record?.schema !== 1 || record.hostname !== os.hostname()) return false;
  if (currentUid !== null && (record.uid !== currentUid || stat.uid !== currentUid)) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0 || typeof record.token !== "string") return false;
  const acquired = Date.parse(record.acquiredAt);
  if (!Number.isFinite(acquired)) return false;
  const age = Date.now() - Math.max(acquired, stat.mtimeMs);
  return age >= staleAfterMs && !pidIsAlive(record.pid);
}

function acquireRecoveryGuard(file, targetToken) {
  const guardPath = `${file}.recovery.${sha256(targetToken).slice(0, 24)}`;
  const token = crypto.randomBytes(16).toString("hex");
  const record = {
    schema: 1,
    kind: "lock-recovery",
    target: file,
    targetToken,
    pid: process.pid,
    hostname: os.hostname(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    acquiredAt: new Date().toISOString(),
    token,
  };
  let fd;
  try {
    fd = fs.openSync(guardPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return { path: guardPath, token };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === "EEXIST") return null;
    fs.rmSync(guardPath, { force: true });
    throw error;
  }
}

function readLock(file) {
  const stat = fs.lstatSync(file);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  return { stat, record };
}

function releaseLock(file, token) {
  if (!token) return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return false; }
  if (record.token !== token) return false;
  try {
    fs.unlinkSync(file);
    fsyncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function validateStaleAfter(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`invalid stale lock age: ${value}`);
  }
  return milliseconds;
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateId(value, label) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid ${label} id: ${id}`);
  return id;
}

function normalizeDigest(ref) {
  const digest = String(ref ?? "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid sha256 ref: ${ref}`);
  return digest;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
