import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileSemanticObject, projectSemanticSensorDisagreement } from "../src/factory.js";

const lanes = ["filesystem_write", "authority_gate", "rollback_or_recovery"];
function artifact(active, marker) {
  const classified = [{ path: "src/cell.js", startLine: 1, endLine: 8, sha256: "a".repeat(64), lanes: Object.fromEntries(lanes.map((lane) => [lane, active.includes(lane)])) }];
  return compileSemanticObject({ kit: { sourceFingerprint: marker, fixture: { die: "matrix", rubric: { lanes: lanes.map((key) => ({ key })) } }, classified, selected: classified, summary: {} }, compiledAt: "fixture" }).artifact;
}

describe("semantic sensor disagreement control", () => {
  it("compares only identical source units and emits one row per conflicting lane decision", () => {
    const control = projectSemanticSensorDisagreement({ leftArtifact: artifact(["filesystem_write"], "left"), rightArtifact: artifact(["authority_gate"], "right") });
    assert.equal(control.authority, "observe-only");
    assert.equal(control.comparison.sharedByteIdenticalUnits, 1);
    assert.equal(control.comparison.comparedDecisions, 3);
    assert.equal(control.summary.total, 2);
    assert.deepEqual(control.exceptions.map((row) => [row.lane, row.leftPresent, row.rightPresent]), [["authority_gate", false, true], ["filesystem_write", true, false]]);
  });

  it("retains both model decisions, exact source identity, and reviewed comparison policy in every proof", () => {
    const control = projectSemanticSensorDisagreement({ leftArtifact: artifact(["filesystem_write"], "left"), rightArtifact: artifact([], "right") });
    const kinds = flattenLeaves(control.exceptions[0].proof).flatMap((leaf) => leaf.datoms.map((datom) => datom.kind));
    assert.ok(kinds.filter((kind) => kind === "model-lane-decision").length >= 2);
    assert.ok(kinds.includes("exact-source-unit"));
    assert.ok(kinds.includes("reviewed-policy"));
    assert.equal(control.exceptions[0].packet.data.status, "review-required");
  });

  it("is deterministic and refuses tampered semantic objects", () => {
    const left = artifact([], "left"), right = artifact(["authority_gate"], "right");
    assert.equal(projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: right }).artifactId, projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: right }).artifactId);
    const corrupt = structuredClone(right); corrupt.sourceUnits[0].sha256 = "f".repeat(64);
    assert.throws(() => projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: corrupt }), /digest mismatch/);
  });

  it("fails closed instead of silently comparing only the overlap of different rubrics", () => {
    const left = artifact([], "left");
    const right = structuredClone(artifact([], "right"));
    right.rubric.pop();
    const { artifactId: _artifactId, compiledAt: _compiledAt, ...body } = right;
    // The object digest guard correctly fires before rubric compatibility. A
    // separately valid object with a different rubric is constructed through
    // the compiler below.
    assert.throws(() => projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: body }), /object required|artifactId/);
    const classified = [{ path: "src/cell.js", startLine: 1, endLine: 8, sha256: "a".repeat(64), lanes: { filesystem_write: false, authority_gate: false } }];
    const validDifferent = compileSemanticObject({ kit: { sourceFingerprint: "different", fixture: { die: "matrix", rubric: { lanes: [{ key: "filesystem_write" }, { key: "authority_gate" }] } }, classified, selected: classified, summary: {} }, compiledAt: "fixture" }).artifact;
    assert.throws(() => projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: validDifferent }), /same lane keys/);
  });
});

function flattenLeaves(proof) { return proof.base ? [proof] : proof.parents.flatMap(flattenLeaves); }
