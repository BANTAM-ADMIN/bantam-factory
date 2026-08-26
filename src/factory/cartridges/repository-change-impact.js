import crypto from "node:crypto";
import path from "node:path";

import { Datalog } from "../../logic/datalog.js";
import { createCodeFactIndex, materializeCodeFacts, readAliasConfig, refreshCodeFactIndex } from "../../logic/codefacts.js";
import { canonicalEncode } from "../fact-fabric.js";
import { FactBus } from "../fact-bus.js";
import { definePredicateCartridge, runPredicateCartridge } from "../predicate-cartridge.js";

/**
 * First production Predicate Cartridge: exact repository structure becomes a
 * proof-bearing change-impact and verification signal.
 */
export function repositoryChangeImpactCartridge() {
  return definePredicateCartridge({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge",
    id: "repository-change-impact",
    version: 1,
    title: "Repository change-impact cartridge",
    purpose: "Compile deterministic repository structure into proof-bearing blast-radius and affected-test conclusions.",
    sources: [{ name: "repository", lane: "accepted" }],
    loads: [
      { source: "repository", relation: "file", pattern: { a: "repo/file", v: true }, fields: ["e"] },
      { source: "repository", relation: "depends", pattern: { a: "repo/depends" }, fields: ["e", "v"] },
      { source: "repository", relation: "test", pattern: { a: "repo/test", v: true }, fields: ["e"] },
      { source: "repository", relation: "changed", pattern: { a: "repo/changed", v: true }, fields: ["e"] },
    ],
    rules: [
      "reaches(F,C) :- depends(F,C)",
      "reaches(F,C) :- depends(F,M), reaches(M,C)",
      "affected_by_change(F,F) :- changed(F)",
      "affected_by_change(F,C) :- reaches(F,C), changed(C)",
      "affected_test(T,C) :- test(T), affected_by_change(T,C)",
    ],
    conclusions: [
      { relation: "affected_by_change", variables: ["consumer", "changed"], title: "Repository material affected by change", severity: "info" },
      { relation: "affected_test", variables: ["test", "changed"], title: "Verification required by change", severity: "warning" },
    ],
    pullRecipes: [{
      id: "codex-impact-context",
      lane: "derived",
      includeEvidence: true,
      specification: { attributes: {
        "conclusion/predicate": { as: "predicate" },
        "conclusion/title": { as: "title" },
        "conclusion/severity": { as: "severity" },
        "conclusion/tuple": { as: "tuple" },
        "conclusion/proof": { as: "proof" },
        "conclusion/dependencies": { as: "dependencies" },
        "conclusion/status": { as: "status" },
      } },
    }],
    subscriptions: [{
      id: "affected-test-required",
      predicate: "affected_test",
      minimum: 1,
      severity: "warning",
      message: "A changed component has reachable tests; issue a verification work order.",
    }],
    qualification: {
      status: "qualified",
      scope: ["Static relative-import dependency closure", "JavaScript, TypeScript, and Python source recognized by BANTAM codefacts"],
      evidenceRefs: ["test:factory-predicate-cartridge:repository-change-impact-v1"],
    },
    presentation: { group: "repository", icon: "radar", color: "amber" },
  });
}

/** Manufacture the accepted structural lot consumed by the cartridge. */
export function buildRepositoryFactBus({ root, changedPaths, bus = new FactBus() } = {}) {
  const compiled = compileRepositoryStructure({ root, changedPaths });
  const receipt = acceptRepositoryOperations(bus, compiled.operations, compiled.sourceFingerprint);
  const { operations: _operations, ...summary } = compiled;
  return deepFreeze({ bus, receipt, ...summary });
}

/**
 * Reconcile a live repository twin by retracting and asserting only changed
 * primitive structural tuples. Unchanged facts retain their original proof
 * identity, which allows downstream semantic lots to remain physically reused.
 */
export function updateRepositoryFactBus({ root, changedPaths, bus } = {}) {
  if (!(bus instanceof FactBus)) throw new TypeError("repository update requires an existing FactBus");
  const compiled = compileRepositoryStructure({ root, changedPaths });
  return reconcileRepositoryFactBus({ bus, compiled });
}

/** Reconcile a precompiled sensor projection without rescanning the repository. */
export function reconcileRepositoryFactBus({ bus, compiled } = {}) {
  if (!(bus instanceof FactBus)) throw new TypeError("repository reconciliation requires an existing FactBus");
  if (!compiled || !Array.isArray(compiled.operations) || typeof compiled.sourceFingerprint !== "string") throw new TypeError("repository reconciliation requires a compiled source projection");
  const desired = new Map(compiled.operations.map((operation) => [tupleIdentity(operation), operation]));
  const currentRows = bus.view("accepted").match().filter((datom) => datom.a.startsWith("repo/"));
  const previousFingerprint = currentRows.find((datom) => datom.e === "repository:workspace" && datom.a === "repo/source-fingerprint")?.v ?? null;
  const current = new Map(currentRows.map((datom) => [tupleIdentity(datom), datom]));
  const retractions = [...current].filter(([key]) => !desired.has(key)).map(([, datom]) => ({ op: "retract", e: datom.e, a: datom.a, v: datom.v }));
  const assertions = [...desired].filter(([key]) => !current.has(key)).map(([, operation]) => operation);
  const timeline = previousFingerprint && previousFingerprint !== compiled.sourceFingerprint
    ? [fact(compiled.sourceFingerprint, "timeline/repository-supersedes", previousFingerprint)]
    : [];
  const operations = [...retractions, ...assertions, ...timeline].sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b)));
  const receipt = operations.length ? acceptRepositoryOperations(bus, operations, compiled.sourceFingerprint) : null;
  const { operations: _desiredOperations, ...summary } = compiled;
  return deepFreeze({
    bus,
    receipt,
    ...summary,
    operationCount: operations.length,
    delta: { asserted: assertions.length + timeline.length, retracted: retractions.length, unchanged: desired.size - assertions.length, timeline: timeline.length },
  });
}

/**
 * Ordered changed-file receiving dock.
 *
 * Cursor continuity makes a missed event visible. Source records are refreshed
 * only for named paths; graph-configuration changes force a full audit. A
 * caller should still schedule periodic fullAudit() calls as an independent
 * watcher/repository reconciliation wicket.
 */
export class RepositoryDeltaSensor {
  constructor({ root } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("repository delta sensor root is required");
    this.root = path.resolve(root);
    this.index = null;
    this.compiled = null;
    this.cursor = null;
    this.events = 0;
    this.fullAudits = 0;
  }

  initialize({ cursor, changedPaths } = {}) {
    if (this.index) throw new Error("repository delta sensor is already initialized");
    const nextCursor = token(cursor, "repository delta cursor");
    this.index = createCodeFactIndex(this.root);
    this.cursor = nextCursor;
    this.events += 1; this.fullAudits += 1;
    return this._project(changedPaths, { mode: "full-audit", cursor: nextCursor, previousCursor: null, refreshed: [...this.index.records.keys()].sort(), removed: [] });
  }

  advance({ cursor, previousCursor, changedPaths } = {}) {
    if (!this.index) throw new Error("repository delta sensor must be initialized before advance");
    const nextCursor = token(cursor, "repository delta cursor"), previous = token(previousCursor, "repository previous delta cursor");
    if (previous !== this.cursor) throw new Error(`repository delta cursor discontinuity: expected ${this.cursor}, received ${previous}`);
    if (nextCursor === this.cursor) throw new Error("repository delta cursor must advance");
    const paths = changedList(this.root, changedPaths);
    const controlChange = paths.some((entry) => ["tsconfig.json", "jsconfig.json"].includes(entry) || entry.endsWith("/tsconfig.json") || entry.endsWith("/jsconfig.json"));
    let mode, refreshed, removed;
    if (controlChange) {
      this.index = createCodeFactIndex(this.root); mode = "full-audit"; refreshed = [...this.index.records.keys()].sort(); removed = []; this.fullAudits += 1;
    } else {
      const before = new Map(paths.map((entry) => [entry, this.index.records.get(entry)]));
      const result = refreshCodeFactIndex(this.index, paths);
      if (!result.ok) throw new Error(`repository delta refresh failed: ${result.error}`);
      if (result.ignored.length) throw new Error(`repository delta contains unsupported source material: ${result.ignored.join(", ")}`);
      this.index = result.index; mode = "changed-files"; refreshed = result.refreshed; removed = result.removed;
      const extractionChanged = removed.length > 0 || refreshed.some((entry) => canonicalEncode(before.get(entry) ?? null) !== canonicalEncode(this.index.records.get(entry) ?? null));
      if (!extractionChanged && this.compiled) {
        this.cursor = nextCursor; this.events += 1;
        const eventPaths = paths, knownChanged = eventPaths.filter((entry) => this.index.records.has(entry));
        return deepFreeze({ ...this.compiled, sensor: { mode: "changed-files-noop", cursor: nextCursor, previousCursor: previous, refreshed, removed, eventPaths, impactPaths: knownChanged, conservativeFallback: false, event: this.events, fullAudits: this.fullAudits } });
      }
    }
    this.cursor = nextCursor; this.events += 1;
    return this._project(paths, { mode, cursor: nextCursor, previousCursor: previous, refreshed, removed });
  }

  fullAudit({ cursor, previousCursor, changedPaths } = {}) {
    if (!this.index) return this.initialize({ cursor, changedPaths });
    const nextCursor = token(cursor, "repository delta cursor"), previous = token(previousCursor, "repository previous delta cursor");
    if (previous !== this.cursor) throw new Error(`repository delta cursor discontinuity: expected ${this.cursor}, received ${previous}`);
    this.index = createCodeFactIndex(this.root); this.cursor = nextCursor; this.events += 1; this.fullAudits += 1;
    return this._project(changedPaths, { mode: "full-audit", cursor: nextCursor, previousCursor: previous, refreshed: [...this.index.records.keys()].sort(), removed: [] });
  }

  _project(changedPaths, sensor) {
    const eventPaths = changedList(this.root, changedPaths);
    const knownChanged = eventPaths.filter((entry) => this.index.records.has(entry));
    const impactPaths = knownChanged.length ? knownChanged : [...this.index.records.keys()].sort();
    const compiled = compileRepositoryIndex({ index: this.index, changedPaths: impactPaths });
    this.compiled = compiled;
    return deepFreeze({ ...compiled, sensor: { ...sensor, eventPaths, impactPaths, conservativeFallback: knownChanged.length === 0, event: this.events, fullAudits: this.fullAudits } });
  }
}

/** Stateful chassis that advances through repository bases and semantic lots. */
export class RepositoryTwin {
  constructor({ root, bus = new FactBus(), cartridge = repositoryChangeImpactCartridge() } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("repository twin root is required");
    if (!(bus instanceof FactBus)) throw new TypeError("repository twin requires a FactBus");
    this.root = path.resolve(root);
    this.bus = bus;
    this.cartridge = definePredicateCartridge(cartridge);
    this.cycles = 0;
  }

  cycle({ changedPaths } = {}) {
    const source = this.bus.view("accepted").match({ a: "repo/source-fingerprint" }).length === 0
      ? buildRepositoryFactBus({ root: this.root, changedPaths, bus: this.bus })
      : updateRepositoryFactBus({ root: this.root, changedPaths, bus: this.bus });
    const evaluation = runPredicateCartridge({ cartridge: this.cartridge, bus: this.bus });
    this.cycles += 1;
    return deepFreeze({
      schema: "bantam.factory.repository-twin-cycle.v1",
      cycle: this.cycles,
      root: this.root,
      source: { fingerprint: source.sourceFingerprint, changed: source.changed, stats: source.stats, operationCount: source.operationCount, delta: source.delta ?? null },
      evaluation,
      busBasis: this.bus.basis(),
    });
  }
}

function compileRepositoryStructure({ root, changedPaths } = {}) {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("repository root is required");
  const absoluteRoot = path.resolve(root);
  const index = createCodeFactIndex(absoluteRoot);
  return compileRepositoryIndex({ index, changedPaths });
}

function compileRepositoryIndex({ index, changedPaths } = {}) {
  if (!index?.root || !(index.records instanceof Map)) throw new TypeError("repository source projection requires a code fact index");
  const absoluteRoot = index.root;
  if (!Array.isArray(changedPaths) || !changedPaths.length) throw new TypeError("at least one changed repository path is required");
  const db = new Datalog({ provenance: true });
  const stats = materializeCodeFacts(db, index);
  const known = new Set(stats.filePaths);
  const changed = [...new Set(changedPaths.map((entry) => normalizeRelative(absoluteRoot, entry)))].sort();
  const unknown = changed.filter((entry) => !known.has(entry));
  if (unknown.length) throw new Error(`changed paths are not indexed repository source: ${unknown.join(", ")}`);

  const operations = [];
  for (const [file] of db.query("file", "?file")) operations.push(fact(file, "repo/file", true));
  for (const [file] of db.query("test", "?file")) operations.push(fact(file, "repo/test", true));
  for (const [consumer, source] of db.query("depends", "?consumer", "?source")) operations.push(fact(consumer, "repo/depends", source));
  for (const file of changed) operations.push(fact(file, "repo/changed", true));

  const sourceFingerprint = `repository-structure:sha256:${digest({ files: [...index.records].map(([file, record]) => ({ file, source: record.source })), graphConfig: readAliasConfig(index.root) })}`;
  operations.push(fact("repository:workspace", "repo/source-fingerprint", sourceFingerprint));
  operations.sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b)));
  return { sourceFingerprint, changed, stats, operationCount: operations.length, operations };
}

function acceptRepositoryOperations(bus, operations, sourceFingerprint) {
  const authority = "tool:bantam-codefacts-v1";
  return bus.accept(operations, {
    src: authority,
    kind: "deterministic-repository-structure",
    grant: { grant: "fact.accept", by: authority, evidenceRef: sourceFingerprint },
  });
}

export function inspectRepositoryChangeImpact(options = {}) {
  const lot = buildRepositoryFactBus(options);
  const cartridge = repositoryChangeImpactCartridge();
  const evaluation = runPredicateCartridge({ cartridge, bus: lot.bus });
  return deepFreeze({
    schema: "bantam.factory.repository-change-impact.v1",
    kind: "bantam.factory-repository-change-impact",
    root: path.resolve(options.root),
    cartridge,
    source: { fingerprint: lot.sourceFingerprint, changed: lot.changed, stats: lot.stats, operationCount: lot.operationCount },
    evaluation,
  });
}

function normalizeRelative(root, value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("changed path must be a non-empty string");
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`changed path escapes repository root: ${value}`);
  return relative;
}
function changedList(root, value) { if (!Array.isArray(value) || !value.length) throw new TypeError("repository delta requires at least one changed path"); return [...new Set(value.map((entry) => normalizeRelative(root, entry)))].sort(); }
function token(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new TypeError(`${label} must be a stable token`); return value; }
function fact(e, a, v) { return { op: "assert", e, a, v }; }
function tupleIdentity(value) { return canonicalEncode([value.e, value.a, value.v]); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
