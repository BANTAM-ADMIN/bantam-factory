import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  certifySemanticSensorWorker,
  compileSemanticObject,
  evaluateSemanticSensorQualification,
  semanticSensorStationAsset,
  WorkforceRegistry,
} from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const lanes = ["filesystem_write", "authority_gate"];
const units = [
  { path: "src/a.js", startLine: 1, endLine: 4, sha256: "a".repeat(64), lanes: { filesystem_write: true, authority_gate: false } },
  { path: "src/b.js", startLine: 5, endLine: 9, sha256: "b".repeat(64), lanes: { filesystem_write: false, authority_gate: true } },
];

function artifact(marker, source = units, summary = {}) {
  return compileSemanticObject({
    kit: {
      sourceFingerprint: marker,
      fixture: { die: "matrix", rubric: { lanes: lanes.map((key) => ({ key, description: key })) } },
      classified: source,
      selected: source,
      summary: { elapsedMs: 100, promptTokens: 50, completionTokens: 5, lots: 1, parseFailures: 0, retries: 0, dieFailures: 0, ...summary },
    },
    compiledAt: "fixture",
  }).artifact;
}

function reviewed() {
  return units.flatMap((unit) => lanes.map((lane) => ({
    path: unit.path,
    startLine: unit.startLine,
    endLine: unit.endLine,
    sha256: unit.sha256,
    lane,
    present: unit.lanes[lane],
    evidenceRef: `review://${unit.path}/${lane}`,
  })));
}

function policy(overrides = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-semantic-sensor-qualification-policy",
    id: "fixture-policy",
    version: 1,
    taskFamily: "semantic-matrix-inspection",
    minimumArticles: 3,
    minimumSharedDecisions: 12,
    minimumLaneAgreement: 1,
    minimumPositiveJaccard: 1,
    minimumReviewedDecisions: 12,
    minimumReviewedPositivePerLane: 1,
    minimumReviewedNegativePerLane: 1,
    minimumPrecision: 1,
    minimumRecall: 1,
    maximumDieFailures: 0,
    ...overrides,
  };
}

describe("semantic sensor qualification die", () => {
  it("qualifies repeatable articles against explicit positive and negative reviewed decisions", () => {
    const report = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], reviewed: reviewed(), policy: policy() });
    assert.equal(report.status, "qualified");
    assert.equal(report.repeatability.pairs, 3);
    assert.equal(report.repeatability.totalSharedDecisions, 12);
    assert.equal(report.reviewedAccuracy.totals.reviewedDecisions, 12);
    assert.equal(report.reviewedAccuracy.precision, 1);
    assert.equal(report.reviewedAccuracy.recall, 1);
    assert.deepEqual(report.reviewedAccuracy.coverage.filesystem_write, { positive: 1, negative: 1 });
    assert.equal(report.blockers.length, 0);
    assert.ok(report.repeatability.controls.every((control) => control.artifactId.startsWith("semantic-sensor-control:sha256:")));
    assert.equal(report.workforceEvidence.articles, 3);
    assert.equal(report.workforceEvidence.passes, 3);
    assert.ok(Object.isFrozen(report));
  });

  it("keeps a disagreeing worker candidate and retains proof-addressed exceptions", () => {
    const changed = structuredClone(units);
    changed[0].lanes.filesystem_write = false;
    const report = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three", changed)], reviewed: reviewed(), policy: policy() });
    assert.equal(report.status, "candidate");
    assert.ok(report.blockers.some((row) => row.code === "lane-agreement-below-die" && row.lane === "filesystem_write"));
    assert.ok(report.blockers.some((row) => row.code === "positive-jaccard-below-die" && row.lane === "filesystem_write"));
    assert.ok(report.blockers.some((row) => row.code === "recall-below-die"));
    assert.ok(report.repeatability.controls.some((control) => control.exceptionIds.length > 0));
  });

  it("does not infer reviewed accuracy from model agreement", () => {
    const report = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], reviewed: [], policy: policy() });
    assert.equal(report.status, "candidate");
    assert.equal(report.reviewedAccuracy.precision, null);
    assert.ok(report.blockers.some((row) => row.code === "insufficient-reviewed-decisions"));
    assert.ok(report.blockers.some((row) => row.code === "precision-below-die"));
  });

  it("requires positive and negative reviewed coverage for every lane", () => {
    const negativeOnly = reviewed().map((fact) => ({ ...fact, present: false }));
    const report = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], reviewed: negativeOnly, policy: policy({ minimumPrecision: 0, minimumRecall: 0 }) });
    assert.equal(report.status, "candidate");
    assert.ok(report.blockers.some((row) => row.code === "insufficient-reviewed-positive-lane-coverage" && row.lane === "filesystem_write"));
    assert.ok(report.blockers.some((row) => row.code === "insufficient-reviewed-positive-lane-coverage" && row.lane === "authority_gate"));
  });

  it("fails closed on rubric drift, source-free reviews, duplicate articles, and tampering", () => {
    const base = artifact("one");
    assert.throws(() => evaluateSemanticSensorQualification({ artifacts: [base, base], reviewed: [], policy: policy({ minimumArticles: 2 }) }), /distinct article/);
    const foreign = reviewed(); foreign[0].sha256 = "f".repeat(64);
    assert.throws(() => evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], reviewed: foreign, policy: policy() }), /do not address an article/);
    const corrupt = structuredClone(base); corrupt.sourceUnits[0].sha256 = "f".repeat(64);
    assert.throws(() => evaluateSemanticSensorQualification({ artifacts: [corrupt], policy: policy({ minimumArticles: 1 }) }), /digest mismatch/);
    const narrow = compileSemanticObject({ kit: { sourceFingerprint: "narrow", fixture: { die: "matrix", rubric: { lanes: [{ key: "filesystem_write" }, { key: "rollback_or_recovery" }] } }, classified: [{ ...units[0], lanes: { filesystem_write: true, rollback_or_recovery: false } }], selected: [] }, compiledAt: "fixture" }).artifact;
    assert.throws(() => evaluateSemanticSensorQualification({ artifacts: [base, narrow], policy: policy({ minimumArticles: 2 }) }), /same lane keys/);
  });

  it("defines a strict station and only writes workforce qualification from a released report", () => {
    const station = semanticSensorStationAsset();
    assert.match(station.ref, /^station:semantic-matrix-inspector@1:sha256:/);
    assert.equal(station.gauge.independent, true);
    assert.deepEqual(station.authority, ["workspace.read"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-semantic-qualification-")); roots.push(root);
    const workforce = new WorkforceRegistry(root);
    const worker = workforce.install({
      schema: 1, kind: "bantam.factory-worker-profile", id: "dg-fixture", version: 1,
      runtime: "local", provider: "plant", model: "dg-awq", reasoningEffort: null,
      transport: "diffusion-native", availabilityClass: "local-compute",
      capabilities: ["model.semantic-work", "semantic.matrix.classify"],
      cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
    });
    const candidate = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], policy: policy() });
    assert.throws(() => certifySemanticSensorWorker({ workforce, workerRef: worker.ref, report: candidate }), /remains candidate/);
    assert.equal(workforce.project().qualifications.length, 0);
    const released = evaluateSemanticSensorQualification({ artifacts: [artifact("one"), artifact("two"), artifact("three")], reviewed: reviewed(), policy: policy() });
    const result = certifySemanticSensorWorker({ workforce, workerRef: worker.ref, report: released });
    assert.equal(result.qualification.status, "qualified");
    assert.equal(result.qualification.stationRef, station.ref);
    assert.equal(certifySemanticSensorWorker({ workforce, workerRef: worker.ref, report: released }).alreadyQualified, true);
  });
});
