import crypto from "node:crypto";

const OP_ASSERT = "assert";
const OP_RETRACT = "retract";
const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Append-only, typed fact history with immutable temporal views.
 *
 * FactFabric deliberately owns storage and time, not belief or authority. A
 * committed datom records that a producer asserted or retracted an exact
 * tuple. Promotion from observation to accepted fact remains a factory policy.
 */
export class FactFabric {
  constructor() {
    this._basis = 0;
    this._history = [];
    this._current = new Map();
    this._snapshots = new Map();
    this._historyIndexes = createIndexes();
    this._currentIndexes = createIndexes();
  }

  get basis() { return this._basis; }
  get transactionCount() { return this._basis; }
  get operationCount() { return this._history.length; }

  /** Commit all operations at one new basis, or commit none of them. */
  transact(operations, { src, kind } = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TypeError("a non-empty operations array is required");
    }
    const producer = requireIdentity(src, "transaction src");
    const evidenceKind = requireIdentity(kind, "transaction kind");
    const basis = this._basis + 1;

    // Complete validation and defensive cloning before any retained state is
    // touched. This is the transaction's atomicity boundary.
    const prepared = operations.map((operation, ordinal) => prepareDatom(operation, {
      tx: basis,
      src: producer,
      kind: evidenceKind,
      ordinal,
    }));
    const txId = `fact-tx:sha256:${sha256(canonicalEncode({ basis, src: producer, kind: evidenceKind, operations: prepared }))}`;
    const datoms = prepared.map((datom) => deepFreeze({ ...datom, txId }));

    for (const datom of datoms) this._append(datom);
    this._basis = basis;

    return deepFreeze({
      basis,
      txId,
      src: producer,
      kind: evidenceKind,
      operationCount: datoms.length,
      datoms: [...datoms],
    });
  }

  /** The accepted current-state projection at the latest committed basis. */
  view() { return new FactView(this, this._basis, "current"); }

  /** A stable current-state projection reconstructed at an earlier basis. */
  asOf(basis) {
    validateBasis(basis, this._basis);
    return new FactView(this, basis, "as-of");
  }

  /** Pin the current basis under an immutable human-readable name. */
  snapshot(name) {
    const key = requireIdentity(name, "snapshot name");
    if (this._snapshots.has(key)) throw new Error(`snapshot already exists: ${key}`);
    const snapshot = deepFreeze({ name: key, basis: this._basis });
    this._snapshots.set(key, snapshot);
    return snapshot;
  }

  viewAt(name) {
    const key = requireIdentity(name, "snapshot name");
    const snapshot = this._snapshots.get(key);
    if (!snapshot) throw new Error(`unknown snapshot: ${key}`);
    return new FactView(this, snapshot.basis, `snapshot:${key}`);
  }

  snapshots() { return deepFreeze([...this._snapshots.values()]); }

  /** Raw append-only operations, optionally filtered by tuple/transaction fields. */
  history(pattern = {}, { strategy = "index" } = {}) {
    validatePattern(pattern);
    const selection = strategy === "scan"
      ? { index: "SCAN", candidates: this._history.map((_, index) => index) }
      : selectHistoryCandidates(this, pattern);
    const rows = selection.candidates
      .map((index) => this._history[index])
      .filter((datom) => datomMatches(datom, pattern));
    return deepFreeze(rows.slice());
  }

  /** Every assertion/retraction that ever touched one exact typed tuple. */
  provenance(e, a, v) {
    const pattern = normalizeExactTuple(e, a, v);
    return this.history(pattern);
  }

  /** Explain the physical access path without exposing fact values in telemetry. */
  explainMatch(pattern = {}, { basis = this._basis, history = false } = {}) {
    validatePattern(pattern);
    validateBasis(basis, this._basis);
    const selection = history
      ? selectHistoryCandidates(this, pattern)
      : selectStateCandidates(this, pattern, basis);
    return deepFreeze({
      basis,
      temporalMode: history ? "history" : basis === this._basis ? "current" : "as-of",
      index: selection.index,
      candidateCount: selection.candidates.length,
      operationCount: this._history.length,
    });
  }

  _append(datom) {
    const historyIndex = this._history.length;
    this._history.push(datom);
    addToIndexes(this._historyIndexes, datom, historyIndex);

    const tuple = tupleKey(datom.e, datom.a, datom.v);
    const previous = this._current.get(tuple);
    if (previous) removeFromIndexes(this._currentIndexes, previous, tuple);
    if (datom.op === OP_ASSERT) {
      this._current.set(tuple, datom);
      addToIndexes(this._currentIndexes, datom, tuple);
    } else {
      this._current.delete(tuple);
    }
  }
}

export class FactView {
  constructor(fabric, basis, label) {
    this._fabric = fabric;
    this.basis = basis;
    this.label = label;
    Object.freeze(this);
  }

  match(pattern = {}, { strategy = "index" } = {}) {
    validatePattern(pattern);
    const rows = strategy === "scan"
      ? scanResolvedState(this._fabric, pattern, this.basis)
      : indexedResolvedState(this._fabric, pattern, this.basis);
    return deepFreeze(rows.slice());
  }

  has(e, a, v) { return this.match(normalizeExactTuple(e, a, v)).length > 0; }

  explain(pattern = {}) { return this._fabric.explainMatch(pattern, { basis: this.basis }); }
}

/** Stable, type-aware encoding used for value identity and artifact digests. */
export function canonicalEncode(value) {
  return encodeValue(value, new Set(), "$", false);
}

function prepareDatom(operation, envelope) {
  if (!isPlainObject(operation)) throw new TypeError(`operation ${envelope.ordinal} must be a plain object`);
  const op = operation.op;
  if (op !== OP_ASSERT && op !== OP_RETRACT) {
    throw new TypeError(`operation ${envelope.ordinal} op must be assert or retract`);
  }
  const e = requireIdentity(operation.e, `operation ${envelope.ordinal} e`);
  const a = requireIdentity(operation.a, `operation ${envelope.ordinal} a`);
  canonicalEncode(operation.v); // Validate before cloning so errors precede mutation.
  const v = cloneValue(operation.v);
  return { e, a, v, tx: envelope.tx, op, src: envelope.src, kind: envelope.kind, ordinal: envelope.ordinal };
}

function normalizeExactTuple(e, a, v) {
  const tuple = { e: requireIdentity(e, "entity"), a: requireIdentity(a, "attribute"), v };
  canonicalEncode(v);
  return tuple;
}

function indexedResolvedState(fabric, pattern, basis) {
  const selection = selectStateCandidates(fabric, pattern, basis);
  let candidates;
  if (basis === fabric._basis) {
    candidates = selection.candidates.map((tuple) => fabric._current.get(tuple)).filter(Boolean);
  } else {
    const tuples = new Set(selection.candidates.map((index) => {
      const datom = fabric._history[index];
      return datom && datom.tx <= basis ? tupleKey(datom.e, datom.a, datom.v) : null;
    }).filter(Boolean));
    candidates = [...tuples].map((tuple) => resolveTupleAt(fabric, tuple, basis)).filter(Boolean);
  }
  return candidates.filter((datom) => datomMatches(datom, pattern)).sort(compareDatoms);
}

function scanResolvedState(fabric, pattern, basis) {
  const resolved = new Map();
  for (const datom of fabric._history) {
    if (datom.tx > basis) break;
    resolved.set(tupleKey(datom.e, datom.a, datom.v), datom);
  }
  return [...resolved.values()]
    .filter((datom) => datom.op === OP_ASSERT && datomMatches(datom, pattern))
    .sort(compareDatoms);
}

function resolveTupleAt(fabric, tuple, basis) {
  const indexes = fabric._historyIndexes.EAV.get(tuple) ?? [];
  let latest = null;
  for (const index of indexes) {
    const datom = fabric._history[index];
    if (datom.tx > basis) break;
    latest = datom;
  }
  return latest?.op === OP_ASSERT ? latest : null;
}

function selectStateCandidates(fabric, pattern, basis) {
  const current = basis === fabric._basis;
  const indexes = current ? fabric._currentIndexes : fabric._historyIndexes;
  const selection = chooseIndex(indexes, pattern);
  if (selection) return selection;
  return current
    ? { index: "SCAN", candidates: [...fabric._current.keys()] }
    : { index: "SCAN", candidates: fabric._history.map((_, index) => index) };
}

function selectHistoryCandidates(fabric, pattern) {
  const selection = chooseIndex(fabric._historyIndexes, pattern);
  return selection ?? { index: "SCAN", candidates: fabric._history.map((_, index) => index) };
}

function chooseIndex(indexes, pattern) {
  const e = OWN(pattern, "e");
  const a = OWN(pattern, "a");
  const v = OWN(pattern, "v");
  const tx = OWN(pattern, "tx");
  let name;
  let key;
  if (e && a && v) [name, key] = ["EAV", tupleKey(pattern.e, pattern.a, pattern.v)];
  else if (e && a) [name, key] = ["EA", pairKey(pattern.e, pattern.a)];
  else if (a && v) [name, key] = ["AV", pairKey(pattern.a, canonicalEncode(pattern.v))];
  else if (tx) [name, key] = ["TX", String(pattern.tx)];
  else if (e) [name, key] = ["E", pattern.e];
  else if (a) [name, key] = ["A", pattern.a];
  else if (v) [name, key] = ["V", canonicalEncode(pattern.v)];
  else return null;
  return { index: name, candidates: [...(indexes[name].get(key) ?? [])] };
}

function createIndexes() {
  return Object.fromEntries(["E", "A", "V", "EA", "EAV", "AV", "TX"].map((name) => [name, new Map()]));
}

function indexEntries(datom) {
  const value = canonicalEncode(datom.v);
  return [
    ["E", datom.e],
    ["A", datom.a],
    ["V", value],
    ["EA", pairKey(datom.e, datom.a)],
    ["EAV", tupleKey(datom.e, datom.a, datom.v)],
    ["AV", pairKey(datom.a, value)],
    ["TX", String(datom.tx)],
  ];
}

function addToIndexes(indexes, datom, reference) {
  for (const [name, key] of indexEntries(datom)) {
    const bucket = indexes[name].get(key) ?? new Set();
    bucket.add(reference);
    indexes[name].set(key, bucket);
  }
}

function removeFromIndexes(indexes, datom, reference) {
  for (const [name, key] of indexEntries(datom)) {
    const bucket = indexes[name].get(key);
    if (!bucket) continue;
    bucket.delete(reference);
    if (bucket.size === 0) indexes[name].delete(key);
  }
}

function validatePattern(pattern) {
  if (!isPlainObject(pattern)) throw new TypeError("fact pattern must be a plain object");
  const allowed = new Set(["e", "a", "v", "tx", "op", "src", "kind", "txId", "ordinal"]);
  for (const key of Object.keys(pattern)) if (!allowed.has(key)) throw new TypeError(`unsupported fact pattern field: ${key}`);
  if (OWN(pattern, "e")) requireIdentity(pattern.e, "pattern e");
  if (OWN(pattern, "a")) requireIdentity(pattern.a, "pattern a");
  if (OWN(pattern, "v")) canonicalEncode(pattern.v);
  if (OWN(pattern, "tx") && (!Number.isInteger(pattern.tx) || pattern.tx < 1)) throw new TypeError("pattern tx must be a positive integer");
  if (OWN(pattern, "op") && pattern.op !== OP_ASSERT && pattern.op !== OP_RETRACT) throw new TypeError("pattern op is invalid");
  for (const key of ["src", "kind", "txId"]) if (OWN(pattern, key)) requireIdentity(pattern[key], `pattern ${key}`);
  if (OWN(pattern, "ordinal") && (!Number.isInteger(pattern.ordinal) || pattern.ordinal < 0)) throw new TypeError("pattern ordinal must be a non-negative integer");
}

function datomMatches(datom, pattern) {
  for (const [key, expected] of Object.entries(pattern)) {
    if (key === "v") {
      if (canonicalEncode(datom.v) !== canonicalEncode(expected)) return false;
    } else if (datom[key] !== expected) return false;
  }
  return true;
}

function tupleKey(e, a, v) { return pairKey(pairKey(e, a), canonicalEncode(v)); }
function pairKey(left, right) { return `${left.length}:${left}${right}`; }

function compareDatoms(left, right) {
  return left.e.localeCompare(right.e) || left.a.localeCompare(right.a) ||
    canonicalEncode(left.v).localeCompare(canonicalEncode(right.v)) || left.tx - right.tx || left.ordinal - right.ordinal;
}

function encodeValue(value, ancestors, path, inArray) {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "undefined" && inArray) throw new TypeError(`${path} cannot be undefined`);
  if (typeof value !== "object") throw new TypeError(`${path} contains unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  let encoded;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) if (!OWN(value, index)) throw new TypeError(`${path}[${index}] cannot be a sparse hole`);
    encoded = `array:[${value.map((item, index) => encodeValue(item, ancestors, `${path}[${index}]`, true)).join(",")}]`;
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${path} must contain only arrays and plain objects`);
    encoded = `object:{${Object.keys(value).sort().map((key) => {
      if (typeof value[key] === "undefined") throw new TypeError(`${path}.${key} cannot be undefined`);
      return `${JSON.stringify(key)}=${encodeValue(value[key], ancestors, `${path}.${key}`, false)}`;
    }).join(",")}}`;
  }
  ancestors.delete(value);
  return encoded;
}

function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, cloneValue(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireIdentity(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function validateBasis(basis, maximum) {
  if (!Number.isInteger(basis) || basis < 0 || basis > maximum) {
    throw new RangeError(`basis must be an integer from 0 through ${maximum}`);
  }
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
