import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { admitExocortexMutationProduct, compileDispatchedShiftPrompt, compileExocortexMutationKit, defineExocortexDispatchPermit, defineExocortexStandardWork, inspectExocortexDispatchPermit } from "../src/factory.js";

const work = defineExocortexStandardWork({ schema: 1, kind: "bantam.factory-exocortex-standard-work", id: "one-hole", version: 1, title: "One hole", role: "driller", instructions: ["Drill exactly one hole."], outputContract: { fields: ["status"] } });
const packet = { schema: "bantam.factory.repository-shift-packet.v1", packetId: `repository-shift-packet:sha256:${"a".repeat(64)}`, task: "Drill", chassis: { repositoryFingerprint: `repository:sha256:${"b".repeat(64)}`, busBasis: {} }, summary: {}, andons: [], buttons: [], products: [], omissions: { count: 0, byPredicate: {} }, stopConditions: [] };
const input = { schema: 1, kind: "bantam.factory-exocortex-dispatch-permit", packetId: packet.packetId, chassisFingerprint: packet.chassis.repositoryFingerprint, standardWorkRef: work.ref, articleId: "article-one", workerRole: "driller", operation: "bounded-source-replacement", tool: { id: "fitted-editor", path: ".bantam/fitted-edit.mjs", sha256: "c".repeat(64), invocation: "node .bantam/fitted-edit.mjs" }, scope: { allowedPaths: ["src/core.js"] }, authority: { execute: "granted", release: "withheld", uses: 1 } };

describe("exocortex dispatch permits", () => {
  it("content-addresses a one-use execution capability while withholding release", () => {
    const permit = defineExocortexDispatchPermit(input);
    assert.match(permit.permitId, /^exocortex-dispatch-permit:sha256:/);
    assert.equal(permit.authority.release, "withheld");
    assert.equal(Object.isFrozen(permit.tool), true);
    assert.throws(() => defineExocortexDispatchPermit({ ...permit, operation: "other" }), /content hash/);
  });

  it("binds a dispatched prompt to packet, chassis, standard work, and permit", () => {
    const permit = defineExocortexDispatchPermit(input);
    const compiled = compileDispatchedShiftPrompt({ packet, standardWork: work, permit });
    assert.match(compiled.prompt, /SUPERVISOR DISPATCH/);
    assert.match(compiled.prompt, new RegExp(permit.permitId));
    assert.equal(compiled.metrics.totalBytes, Buffer.byteLength(compiled.prompt));
    assert.throws(() => compileDispatchedShiftPrompt({ packet: { ...packet, packetId: packet.packetId.replace(/a/g, "d") }, standardWork: work, permit }), /different shift packet/);
  });

  it("fails closed when a jig or target does not match the permit", () => {
    const permit = defineExocortexDispatchPermit(input);
    const common = { permit, packetId: packet.packetId, chassisFingerprint: packet.chassis.repositoryFingerprint, standardWorkRef: work.ref, operation: permit.operation, toolPath: permit.tool.path, toolSha256: permit.tool.sha256, targetPath: "src/core.js" };
    assert.deepEqual(inspectExocortexDispatchPermit(common).reasons, []);
    assert.deepEqual(inspectExocortexDispatchPermit({ ...common, toolSha256: "d".repeat(64), targetPath: "test/core.test.js" }).reasons, ["tool-hash-mismatch", "target-out-of-scope"]);
  });

  it("admits a bounded cognitive product without giving the model a write tool", () => {
    const permit = defineExocortexDispatchPermit(input);
    const product = admitExocortexMutationProduct({ answer: { status: "completed", permitId: permit.permitId, targetPath: "src/core.js", replacementSource: "export function normalizePort() {}\n", testsRun: ["node --test"] }, permit });
    assert.equal(product.disposition, "admitted-for-actuation");
    assert.match(product.productId, /^exocortex-mutation-product:sha256:/);
    const escape = admitExocortexMutationProduct({ answer: { status: "completed", permitId: permit.permitId, targetPath: "test/core.test.js", replacementSource: "x", testsRun: [] }, permit });
    assert.deepEqual(escape.reasons, ["target-out-of-scope"]);
  });

  it("machines repeated semantic products into a compact proof-addressed station kit", () => {
    const permit = defineExocortexDispatchPermit(input);
    const richPacket = { ...packet, products: [
      { predicate: "verification_work_order", tuple: { test: "test/core.test.js" }, conclusionId: "proof:test" },
      { predicate: "verification_work_order", tuple: { test: "test/core.test.js" }, conclusionId: "proof:test-duplicate" },
      { predicate: "requirement_affected", tuple: { requirement: "requirement:port" }, conclusionId: "proof:requirement" },
      { predicate: "release_blocked_stale_evidence", tuple: { requirement: "requirement:port" }, conclusionId: "proof:blocker" },
    ], omissions: { count: 9 } };
    const kit = compileExocortexMutationKit({ packet: richPacket, permit });
    assert.deepEqual(kit.routing.affectedTests, ["test/core.test.js"]);
    assert.deepEqual(kit.routing.governedRequirements, ["requirement:port"]);
    assert.equal(kit.blockers[0].code, "stale-evidence");
    assert.equal(kit.omittedProducts, 9);
  });
});
