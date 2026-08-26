import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditCodexMutationArticle, summarizeCodexMutationArm } from "../src/factory.js";

const hash = (digit) => digit.repeat(64);
const pass = { pass: true, status: "pass", exitCode: 0, durationMs: 10, command: "node --test", detail: "ok" };

describe("Codex mutation cohort independent gauges", () => {
  it("releases only an allowed product change with public and hidden verification", () => {
    const audit = auditCodexMutationArticle({ before: { "src/core.js": hash("a"), "test/core.test.js": hash("b") }, after: { "src/core.js": hash("c"), "test/core.test.js": hash("b") }, allowedPaths: ["src/core.js"], publicVerification: pass, hiddenVerification: pass });
    assert.equal(audit.disposition, "released");
    assert.deepEqual(audit.modified, ["src/core.js"]);
    assert.equal(Object.isFrozen(audit), true);
  });

  it("contains test tampering, extra scope, no-op work, and hidden escapes", () => {
    const base = { "src/core.js": hash("a"), "test/core.test.js": hash("b") };
    const tampered = auditCodexMutationArticle({ before: base, after: { "src/core.js": hash("c"), "test/core.test.js": hash("d") }, allowedPaths: ["src/core.js"], publicVerification: pass, hiddenVerification: pass });
    assert.deepEqual(tampered.reasons, ["scope-violation", "test-tampering"]);
    const noOp = auditCodexMutationArticle({ before: base, after: base, allowedPaths: ["src/core.js"], publicVerification: pass, hiddenVerification: pass });
    assert.deepEqual(noOp.reasons, ["no-product-change"]);
    const escape = auditCodexMutationArticle({ before: base, after: { ...base, "src/core.js": hash("c") }, allowedPaths: ["src/core.js"], publicVerification: pass, hiddenVerification: { ...pass, pass: false, status: "fail", exitCode: 1 } });
    assert.deepEqual(escape.reasons, ["hidden-verification-failed"]);
  });

  it("summarizes worker economics without conflating cached and uncached input", () => {
    const articles = [{ audit: { disposition: "released" }, run: { durationMs: 100, commands: [], usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 40 } } }, { audit: { disposition: "contained" }, run: { durationMs: 200, commands: [1], usage: { input_tokens: 800, cached_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 20 } } }];
    const summary = summarizeCodexMutationArm(articles);
    assert.equal(summary.yield, 0.5);
    assert.equal(summary.inputTokens.mean, 900);
    assert.equal(summary.uncachedInputTokens.mean, 500);
  });
});
