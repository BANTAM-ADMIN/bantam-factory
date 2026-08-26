import crypto from "node:crypto";

import { canonicalEncode } from "../fact-fabric.js";
import { FactBus } from "../fact-bus.js";
import { PredicateCartridgeRegistry } from "../predicate-cartridge.js";
import { definePredicateCartridgeCell, runPredicateCartridgeCell } from "../predicate-cartridge-cell.js";
import { buildRepositoryFactBus, reconcileRepositoryFactBus, RepositoryDeltaSensor, repositoryChangeImpactCartridge, updateRepositoryFactBus } from "./repository-change-impact.js";
import { changeVerificationRoutingCartridge, installChangeVerificationPolicy } from "./change-verification-routing.js";
import { requirementChangeImpactCartridge } from "./requirement-change-impact.js";
import { evidenceFreshnessCartridge } from "./evidence-freshness-control.js";
import { releaseAuthorityCartridge } from "./release-authority-control.js";

const GOVERNANCE_AUTHORITY = "authority:product-governance";
const EVIDENCE_GAUGE_AUTHORITY = "authority:verification-evidence-gauge";

export function repositoryGovernanceCellAsset({ registry } = {}) {
  const impact = repositoryChangeImpactCartridge(), routing = changeVerificationRoutingCartridge();
  const requirements = requirementChangeImpactCartridge(), freshness = evidenceFreshnessCartridge(), release = releaseAuthorityCartridge();
  return definePredicateCartridgeCell({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge-cell",
    id: "repository-governance-cell",
    version: 1,
    title: "Living repository governance cell",
    purpose: "Turn repository change into test work, affected obligations, evidence freshness, and revision-bound release disposition.",
    nodes: [
      { id: "impact", cartridge: impact.ref },
      { id: "verification-routing", cartridge: routing.ref },
      { id: "requirement-impact", cartridge: requirements.ref },
      { id: "evidence-freshness", cartridge: freshness.ref },
      { id: "release-control", cartridge: release.ref },
    ],
    edges: [
      { from: "impact", predicate: "affected_test", to: "verification-routing", source: "impact" },
      { from: "impact", predicate: "affected_by_change", to: "requirement-impact", source: "impact" },
      { from: "requirement-impact", predicate: "requirement_affected", to: "evidence-freshness", source: "requirements" },
      { from: "evidence-freshness", predicate: "current_verification_evidence", to: "release-control", source: "freshness" },
      { from: "evidence-freshness", predicate: "stale_verification_evidence", to: "release-control", source: "freshness" },
    ],
    presentation: { group: "governance", icon: "control-tower", color: "gold" },
  }, { registry });
}

/** Install or renew one requirement's active evidence and release approval. */
export function installRepositoryGovernanceFacts(bus, { requirement, component, test, authority, fingerprint } = {}) {
  if (!(bus instanceof FactBus)) throw new TypeError("repository governance facts require a FactBus");
  const values = {
    requirement: text(requirement, "requirement identity"), component: text(component, "requirement component"),
    test: text(test, "requirement test"), authority: text(authority, "release authority"), fingerprint: text(fingerprint, "governance fingerprint"),
  };
  const view = bus.view("accepted"), operations = [];
  ensure(view, operations, values.requirement, "requirement/implemented-by", values.component);
  ensure(view, operations, values.requirement, "requirement/verified-by", values.test);
  ensure(view, operations, values.requirement, "requirement/release-authority", values.authority);

  const activeForTest = view.match({ a: "evidence/active", v: true }).filter((row) => view.has(row.e, "evidence/test", values.test) && view.has(row.e, "evidence/requirement", values.requirement));
  const alreadyCurrent = activeForTest.some((row) => view.has(row.e, "evidence/validated-fingerprint", values.fingerprint));
  if (!alreadyCurrent) {
    for (const row of activeForTest) operations.push({ op: "retract", e: row.e, a: row.a, v: row.v });
    const evidence = `evidence:sha256:${digest({ requirement: values.requirement, test: values.test, fingerprint: values.fingerprint })}`;
    operations.push(
      fact(evidence, "evidence/test", values.test),
      fact(evidence, "evidence/requirement", values.requirement),
      fact(evidence, "evidence/validated-fingerprint", values.fingerprint),
      fact(evidence, "evidence/active", true),
    );
  }
  const approvals = view.match({ e: values.authority, a: "authority/approved-fingerprint" });
  for (const row of approvals) if (row.v !== values.fingerprint) operations.push({ op: "retract", e: row.e, a: row.a, v: row.v });
  if (!approvals.some((row) => row.v === values.fingerprint)) operations.push(fact(values.authority, "authority/approved-fingerprint", values.fingerprint));
  if (!operations.length) return null;
  operations.sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b)));
  return bus.accept(operations, {
    src: GOVERNANCE_AUTHORITY,
    kind: "reviewed-product-governance",
    grant: { grant: "fact.accept", by: GOVERNANCE_AUTHORITY, evidenceRef: `governance-article:sha256:${digest(values)}` },
  });
}

/** Admit a passing, independently measured test article as active evidence. */
export function acceptRepositoryVerificationEvidence(bus, { requirement, test, fingerprint, measurement } = {}) {
  if (!(bus instanceof FactBus)) throw new TypeError("repository verification evidence requires a FactBus");
  const values = { requirement: text(requirement, "evidence requirement"), test: text(test, "evidence test"), fingerprint: text(fingerprint, "evidence fingerprint") };
  if (!measurement || typeof measurement !== "object" || measurement.kind !== "bantam.factory-repository-test-measurement" || measurement.pass !== true || typeof measurement.artifactId !== "string") {
    throw new Error("repository evidence admission requires an independently passing test measurement");
  }
  const view = bus.view("accepted");
  if (!view.has(values.requirement, "requirement/verified-by", values.test)) throw new Error("test is not accepted verification for the requirement");
  if (!view.has("repository:workspace", "repo/source-fingerprint", values.fingerprint)) throw new Error("verification evidence does not bind the current repository fingerprint");
  if (measurement.test !== values.test || measurement.repositoryFingerprint !== values.fingerprint) throw new Error("verification measurement material does not match evidence admission");
  const active = view.match({ a: "evidence/active", v: true }).filter((row) => view.has(row.e, "evidence/test", values.test) && view.has(row.e, "evidence/requirement", values.requirement));
  if (active.some((row) => view.has(row.e, "evidence/validated-fingerprint", values.fingerprint))) return null;
  const operations = active.map((row) => ({ op: "retract", e: row.e, a: row.a, v: row.v }));
  const evidence = `evidence:sha256:${digest({ ...values, measurement: measurement.artifactId })}`;
  operations.push(
    fact(evidence, "evidence/test", values.test),
    fact(evidence, "evidence/requirement", values.requirement),
    fact(evidence, "evidence/validated-fingerprint", values.fingerprint),
    fact(evidence, "evidence/measurement", measurement.artifactId),
    fact(evidence, "evidence/active", true),
  );
  operations.sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b)));
  return bus.accept(operations, {
    src: EVIDENCE_GAUGE_AUTHORITY,
    kind: "independently-gauged-verification-evidence",
    grant: { grant: "fact.accept", by: EVIDENCE_GAUGE_AUTHORITY, evidenceRef: measurement.artifactId },
  });
}

/** Bind explicit release-authority approval to exactly one repository revision. */
export function approveRepositoryRevision(bus, { requirement, authority, fingerprint, approval } = {}) {
  if (!(bus instanceof FactBus)) throw new TypeError("repository revision approval requires a FactBus");
  const values = { requirement: text(requirement, "approval requirement"), authority: text(authority, "approval authority"), fingerprint: text(fingerprint, "approval fingerprint") };
  if (!approval || typeof approval !== "object" || approval.grant !== "release.approve" || approval.by !== values.authority || typeof approval.evidenceRef !== "string" || !approval.evidenceRef.trim()) {
    throw new Error("repository revision approval requires an explicit release.approve grant from the mapped authority");
  }
  const view = bus.view("accepted");
  if (!view.has(values.requirement, "requirement/release-authority", values.authority)) throw new Error("authority is not accepted for the requirement");
  if (!view.has("repository:workspace", "repo/source-fingerprint", values.fingerprint)) throw new Error("approval does not bind the current repository fingerprint");
  const approvals = view.match({ e: values.authority, a: "authority/approved-fingerprint" });
  if (approvals.some((row) => row.v === values.fingerprint)) return null;
  const operations = approvals.map((row) => ({ op: "retract", e: row.e, a: row.a, v: row.v }));
  operations.push(fact(values.authority, "authority/approved-fingerprint", values.fingerprint));
  operations.sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b)));
  return bus.accept(operations, { src: values.authority, kind: "explicit-revision-release-approval", grant: { grant: "fact.accept", by: values.authority, evidenceRef: approval.evidenceRef.trim() } });
}

/** Five-machine living twin from source delta through release disposition. */
export class RepositoryGovernanceCell {
  constructor({ root, bus = new FactBus() } = {}) {
    this.root = text(root, "repository governance root");
    this.bus = bus;
    installChangeVerificationPolicy(bus);
    this.registry = new PredicateCartridgeRegistry();
    for (const cartridge of [repositoryChangeImpactCartridge(), changeVerificationRoutingCartridge(), requirementChangeImpactCartridge(), evidenceFreshnessCartridge(), releaseAuthorityCartridge()]) this.registry.install(cartridge);
    this.cell = repositoryGovernanceCellAsset({ registry: this.registry });
    this.sensor = new RepositoryDeltaSensor({ root: this.root });
    this.lastExecution = null;
    this.cycles = 0;
  }

  cycle({ changedPaths, governance = null } = {}) {
    const source = this.bus.view("accepted").match({ a: "repo/source-fingerprint" }).length === 0
      ? buildRepositoryFactBus({ root: this.root, changedPaths, bus: this.bus })
      : updateRepositoryFactBus({ root: this.root, changedPaths, bus: this.bus });
    const governanceReceipt = governance ? installRepositoryGovernanceFacts(this.bus, { ...governance, fingerprint: governance.fingerprint === "current" || governance.fingerprint == null ? source.sourceFingerprint : governance.fingerprint }) : null;
    const execution = this._execute();
    this.cycles += 1;
    const evaluations = Object.fromEntries(execution.evaluations.map((row) => [row.nodeId, row.evaluation]));
    return deepFreeze({
      schema: "bantam.factory.repository-governance-cell-cycle.v1",
      cycle: this.cycles,
      cellRef: this.cell.ref,
      source: { fingerprint: source.sourceFingerprint, changed: source.changed, operationCount: source.operationCount, delta: source.delta ?? null },
      governanceReceipt,
      evaluations,
      projection: execution.projection,
      busBasis: this.bus.basis(),
    });
  }

  /** Advance from an ordered filesystem event batch without a full source scan. */
  cycleDelta({ delta, governance = null } = {}) {
    if (!delta || typeof delta !== "object") throw new TypeError("repository governance delta cycle requires an event batch");
    const projection = this.sensor.index
      ? (delta.fullAudit
          ? this.sensor.fullAudit({ cursor: delta.cursor, previousCursor: delta.previousCursor, changedPaths: delta.changedPaths })
          : this.sensor.advance({ cursor: delta.cursor, previousCursor: delta.previousCursor, changedPaths: delta.changedPaths }))
      : this.sensor.initialize({ cursor: delta.cursor, changedPaths: delta.changedPaths });
    const source = projection.sensor.mode === "changed-files-noop"
      ? { ...projection, receipt: null, operationCount: 0, delta: { asserted: 0, retracted: 0, unchanged: projection.operations.length, timeline: 0 } }
      : reconcileRepositoryFactBus({ bus: this.bus, compiled: projection });
    const governanceReceipt = governance ? installRepositoryGovernanceFacts(this.bus, { ...governance, fingerprint: governance.fingerprint === "current" || governance.fingerprint == null ? source.sourceFingerprint : governance.fingerprint }) : null;
    const execution = this._execute();
    this.cycles += 1;
    const evaluations = Object.fromEntries(execution.evaluations.map((row) => [row.nodeId, row.evaluation]));
    return deepFreeze({
      schema: "bantam.factory.repository-governance-cell-cycle.v1",
      cycle: this.cycles,
      cellRef: this.cell.ref,
      source: { fingerprint: source.sourceFingerprint, changed: source.changed, operationCount: source.operationCount, delta: source.delta ?? null, sensor: projection.sensor },
      governanceReceipt,
      evaluations,
      projection: execution.projection,
      busBasis: this.bus.basis(),
    });
  }

  _execute() {
    if (this.lastExecution && canonicalEncode(this.lastExecution.busBasis) === canonicalEncode(this.bus.basis())) return this.lastExecution;
    this.lastExecution = runPredicateCartridgeCell({ cell: this.cell, registry: this.registry, bus: this.bus });
    return this.lastExecution;
  }
}

function ensure(view, operations, e, a, v) { if (!view.has(e, a, v)) operations.push(fact(e, a, v)); }
function fact(e, a, v) { return { op: "assert", e, a, v }; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
