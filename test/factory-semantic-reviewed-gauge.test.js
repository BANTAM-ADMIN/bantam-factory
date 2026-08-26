import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  compileSemanticObject,
  defineSemanticReviewedRack,
  evaluateSemanticReviewedGauge,
  expandSemanticReviewedFacts,
  runSemanticReviewedGaugeArticle,
  SEMANTIC_REVIEW_LANES,
  semanticReviewedGaugeStationAsset,
  semanticSensorQualificationLine,
} from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const source = [
  { path: "src/positive.js", startLine: 1, endLine: 4, sha256: "a".repeat(64), lanes: Object.fromEntries(SEMANTIC_REVIEW_LANES.map((lane) => [lane, true])) },
  { path: "src/negative.js", startLine: 5, endLine: 8, sha256: "b".repeat(64), lanes: Object.fromEntries(SEMANTIC_REVIEW_LANES.map((lane) => [lane, false])) },
];
function artifact(marker) { return compileSemanticObject({ kit: { sourceFingerprint: marker, fixture: { die: "matrix", rubric: { lanes: SEMANTIC_REVIEW_LANES.map((key) => ({ key })) } }, classified: source, selected: source, summary: { elapsedMs: 10, promptTokens: 20, completionTokens: 2, lots: 1, dieFailures: 0 } }, compiledAt: "fixture" }).artifact; }
function rack() { return { schema: 1, kind: "bantam.semantic-reviewed-rack", rubric: "factory-mutation-surface-v1", units: source.map((unit, index) => ({ path: unit.path, startLine: unit.startLine, endLine: unit.endLine, sha256: unit.sha256, evidenceRef: `review://fixture/${index}`, decisions: { ...unit.lanes } })) }; }
function policy() { return { schema: 1, kind: "bantam.factory-semantic-sensor-qualification-policy", id: "reviewed-gauge-fixture", version: 1, taskFamily: "semantic-matrix-inspection", minimumArticles: 3, minimumSharedDecisions: 36, minimumLaneAgreement: 1, minimumPositiveJaccard: 1, minimumReviewedDecisions: 36, minimumReviewedPositivePerLane: 1, minimumReviewedNegativePerLane: 1, minimumPrecision: 1, minimumRecall: 1, maximumDieFailures: 0 }; }

describe("semantic reviewed gauge", () => {
  it("validates and expands an exact positive/negative review rack", () => {
    const defined = defineSemanticReviewedRack(rack());
    const facts = expandSemanticReviewedFacts(defined);
    assert.match(defined.ref, /^semantic-reviewed-rack:sha256:/);
    assert.equal(facts.length, 12);
    assert.equal(facts.filter((fact) => fact.present).length, 6);
    assert.equal(facts.filter((fact) => !fact.present).length, 6);
    assert.ok(facts.every((fact) => fact.evidenceRef.includes(`#${fact.lane}`)));
  });

  it("uses the exact station manufactured by the foundry change order", () => {
    const station = semanticReviewedGaugeStationAsset();
    const compiled = semanticSensorQualificationLine();
    assert.equal(compiled.assets.gauge.ref, station.ref);
    assert.equal(station.worker.adapter, "bantam.factory.semantic-reviewed-gauge/v1");
    assert.deepEqual(compiled.route.edges.map((edge) => edge.artifactType).sort(), ["bantam.semantic-matrix/v1", "bantam.semantic-reviewed-rack/v1"]);
  });

  it("qualifies exact articles and runs the manufactured gauge as an executable factory station", async () => {
    const artifacts = [artifact("one"), artifact("two"), artifact("three")];
    const direct = evaluateSemanticReviewedGauge({ artifacts, rack: rack(), policy: policy() });
    assert.equal(direct.status, "qualified");
    assert.equal(direct.reviewedAccuracy.precision, 1);
    assert.equal(direct.reviewedAccuracy.recall, 1);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-semantic-reviewed-gauge-")); roots.push(root);
    const result = await runSemanticReviewedGaugeArticle({ root, artifacts, rack: rack(), policy: policy(), jobId: "semantic-gauge-fixture" });
    assert.equal(result.status, "released", JSON.stringify({ infrastructure: result.infrastructure, events: result.line.events.slice(-8) }, null, 2));
    assert.equal(result.qualification.status, "qualified");
    assert.equal(result.stationRef, semanticReviewedGaugeStationAsset().ref);
    assert.ok(result.line.events.filter((event) => event.type === "gauge.result").every((event) => event.payload.status === "pass"));
  });

  it("fails closed on stale coupons, incomplete decisions, tampering, and blueprint drift", () => {
    const stale = rack(); stale.units[0].sha256 = "f".repeat(64);
    assert.throws(() => evaluateSemanticReviewedGauge({ artifacts: [artifact("one"), artifact("two"), artifact("three")], rack: stale, policy: policy() }), /do not address an article/);
    const incomplete = rack(); delete incomplete.units[0].decisions.authority_gate;
    assert.throws(() => defineSemanticReviewedRack(incomplete), /missing=\[authority_gate\]/);
    const defined = structuredClone(defineSemanticReviewedRack(rack())); defined.units[0].decisions.filesystem_write = !defined.units[0].decisions.filesystem_write;
    assert.throws(() => defineSemanticReviewedRack(defined), /content hash/);
  });
});
