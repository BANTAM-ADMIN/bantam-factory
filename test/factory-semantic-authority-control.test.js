import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileSemanticObject, projectMutationAuthorityControl, publishSemanticObjectFacts } from "../src/factory.js";

const lanes = ["filesystem_write", "process_execution", "persistent_state_mutation", "authority_gate"];
function chunk(path, startLine, active, hash) {
  return { path, startLine, endLine: startLine + 9, sha256: hash, lanes: Object.fromEntries(lanes.map((lane) => [lane, active.includes(lane)])) };
}
function artifact() {
  const classified = [
    chunk("src/unsafe.js", 1, ["filesystem_write"], "a".repeat(64)),
    chunk("src/safe.js", 1, ["filesystem_write", "authority_gate"], "b".repeat(64)),
  ];
  return compileSemanticObject({
    kit: {
      sourceFingerprint: "authority-control-fixture",
      fixture: { die: "matrix", rubric: { lanes: lanes.map((key) => ({ key })) } },
      classified,
      selected: classified,
      summary: {},
    },
    accepted: [{ path: "src/unsafe.js", startLine: 1, endLine: 10, lane: "filesystem_write", evidenceRef: "review:gauge-1" }],
    compiledAt: "fixture",
  }).artifact;
}

describe("semantic mutation authority control", () => {
  it("publishes model observations and reviewed acceptance as different provenance kinds", () => {
    const stored = artifact();
    const published = publishSemanticObjectFacts(stored);
    const unit = stored.sourceUnits.find((row) => row.path === "src/unsafe.js");
    assert.equal(published.view.has(unit.chunkId, "semantic/observed-lane", "filesystem_write"), true);
    assert.equal(published.view.has(unit.chunkId, "semantic/accepted-lane", "filesystem_write"), true);
    assert.equal(published.view.has("src/unsafe.js", "semantic/authority-observed", false), true);
    assert.equal(published.fabric.provenance(unit.chunkId, "semantic/observed-lane", "filesystem_write")[0].kind, "model-observation");
    assert.equal(published.fabric.provenance(unit.chunkId, "semantic/accepted-lane", "filesystem_write")[0].src, "review:gauge-1");
  });

  it("derives observation and accepted-evidence gaps without flagging a file with authority", () => {
    const control = projectMutationAuthorityControl({ artifact: artifact() });
    assert.equal(control.authority, "observe-only");
    assert.equal(control.summary.total, 2);
    assert.deepEqual(control.exceptions.map((row) => row.code).sort(), ["accepted-mutation-authority-gap", "model-observed-authority-gap"]);
    assert.equal(control.exceptions.every((row) => row.file === "src/unsafe.js"), true);
    assert.equal(control.exceptions.some((row) => row.file === "src/safe.js"), false);
    assert.equal(control.exceptions.find((row) => row.code.startsWith("accepted-")).severity, "critical");
    assert.equal(control.exceptions.find((row) => row.code.startsWith("model-")).severity, "warning");
  });

  it("retains source unit, model/review, policy, and absence leaves in supervisor packets", () => {
    const control = projectMutationAuthorityControl({ artifact: artifact() });
    for (const exception of control.exceptions) {
      const leaves = flattenLeaves(exception.proof);
      const kinds = leaves.flatMap((leaf) => leaf.datoms.map((datom) => datom.kind));
      assert.ok(kinds.includes("exact-source-unit"));
      assert.ok(kinds.includes("reviewed-policy"));
      assert.ok(kinds.includes("deterministic-presence-at-semantic-basis"));
      assert.ok(kinds.includes(exception.code.startsWith("accepted-") ? "reviewed-acceptance" : "model-observation"));
      assert.equal(exception.packet.data.file, "src/unsafe.js");
      assert.equal(exception.packet.data.status, "review-required");
      assert.equal(exception.packet.data.sourceBasis.semanticObjectId, control.basis.semanticObjectId);
    }
  });

  it("is deterministic and fails closed on semantic object tampering", () => {
    const stored = artifact();
    assert.equal(projectMutationAuthorityControl({ artifact: stored }).artifactId, projectMutationAuthorityControl({ artifact: stored }).artifactId);
    const corrupt = structuredClone(stored);
    corrupt.sourceUnits[0].sha256 = "f".repeat(64);
    assert.throws(() => projectMutationAuthorityControl({ artifact: corrupt }), /digest mismatch/);
  });
});

function flattenLeaves(proof) { return proof.base ? [proof] : proof.parents.flatMap(flattenLeaves); }
