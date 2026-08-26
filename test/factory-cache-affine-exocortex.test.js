import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileCacheAffineShiftPrompt, defineExocortexStandardWork, REPOSITORY_ASSESSMENT_STANDARD_WORK } from "../src/factory.js";

function packet(id, task, disposition) {
  return {
    schema: "bantam.factory.repository-shift-packet.v1", packetId: id, task,
    chassis: { repositoryFingerprint: `repository:${id}`, busBasis: { accepted: 1, derived: 1 } },
    summary: { releaseDisposition: disposition }, andons: [],
    buttons: [{ operation: "run-verification", authority: "propose-only", material: { test: "test/a.test.js" } }],
    products: [{ conclusionId: `conclusion:${id}`, station: "routing", predicate: "verification_work_order", tuple: { test: "test/a.test.js", changed: "src/a.js" }, severity: "warning", dependencies: [], dependenciesTruncated: false }],
    omissions: { count: 0, byPredicate: {} }, stopConditions: ["Do not treat a proposed button as executed work."],
  };
}

describe("cache-affine exocortex compiler", () => {
  it("keeps standard work byte-identical while task and chassis tails change", () => {
    const first = compileCacheAffineShiftPrompt({ packet: packet("one", "Assess one", "blocked") });
    const second = compileCacheAffineShiftPrompt({ packet: packet("two", "Assess two", "ready-for-authority-review") });
    assert.equal(first.prefixId, second.prefixId);
    assert.equal(first.prefix, second.prefix);
    assert.notEqual(first.tailId, second.tailId);
    assert.notEqual(first.promptId, second.promptId);
    assert.match(first.prefix, /CACHEABLE STANDARD WORK/);
    assert.match(first.tail, /test\/a\.test\.js/);
    assert.equal(first.metrics.totalBytes, Buffer.byteLength(first.prompt));
  });

  it("content-addresses standard work and rejects tampered references", () => {
    const defined = defineExocortexStandardWork(REPOSITORY_ASSESSMENT_STANDARD_WORK);
    assert.match(defined.ref, /^exocortex-standard-work:repository-release-assessment@1:sha256:/);
    assert.throws(() => defineExocortexStandardWork({ ...defined, ref: `${defined.ref}bad` }), /content hash/);
  });

  it("retains the stable prefix while replacing an evidence crate with a station kit", () => {
    const source = packet("one", "Assess one", "blocked");
    const full = compileCacheAffineShiftPrompt({ packet: source });
    const kit = { schema: "bantam.factory.test-kit.v1", kind: "bantam.factory-test-kit", packetId: source.packetId, affectedTests: ["test/a.test.js"] };
    const fitted = compileCacheAffineShiftPrompt({ packet: source, material: kit });
    assert.equal(fitted.prefixId, full.prefixId);
    assert.equal(fitted.prefix, full.prefix);
    assert.ok(fitted.metrics.tailBytes < full.metrics.tailBytes);
    assert.match(fitted.tail, /factory-test-kit/);
  });
});
