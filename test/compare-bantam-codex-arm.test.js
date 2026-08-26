import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildComparePlan, compareModelOptions } from "../src/logic/compare-plan.js";

// `bantam compare` could not express the comparison this project exists to prove.
// Its bantam arms built `new ModelClient({ model })` -- a plain client that
// defaults to the LOCAL server -- so the head-to-head was BANTAM+local versus bare
// `codex exec`. That measures the wrong thing: it confounds the harness with the
// model, and it is unflattering for reasons that have nothing to do with the
// harness.
//
// The claim under test is BANTAM+Codex versus Codex alone, same model on both
// sides, so the only difference is the harness around it.

describe("the compare plan can drive Codex through the harness", () => {
  it("offers a bantam-codex arm beside bare codex", () => {
    const plan = buildComparePlan({ task: "do the thing" });
    const ids = plan.arms.map((a) => a.id ?? a.arm ?? a.name);
    assert.ok(ids.includes("bantam-codex"), `expected a bantam-codex arm, got ${ids.join(", ")}`);
    assert.ok(ids.includes("codex"), "the bare codex reference must remain");
  });

  it("marks bantam-codex as a subject, not a reference", () => {
    const plan = buildComparePlan({ task: "t" });
    const arm = plan.arms.find((a) => (a.id ?? a.arm ?? a.name) === "bantam-codex");
    assert.equal(arm.role, "subject");
  });
});

describe("model options for a compare arm", () => {
  it("builds a Codex client when the arm asks for one", () => {
    const opts = compareModelOptions({ codex: true, model: "gpt-5.6-terra", effort: "high" });
    assert.equal(opts.codex, true);
    assert.equal(opts.model, "gpt-5.6-terra");
    assert.equal(opts.codexEffort, "high");
  });

  // Without this the arm silently falls back to the local server and the
  // comparison quietly becomes the wrong one again.
  it("defaults a codex arm to a real model rather than the local server", () => {
    const opts = compareModelOptions({ codex: true });
    assert.equal(opts.codex, true);
    assert.ok(typeof opts.model === "string" && opts.model.length > 0,
      "a codex arm must name a model");
  });

  it("leaves a plain local arm untouched", () => {
    assert.equal(compareModelOptions(undefined).codex, undefined);
    assert.equal(compareModelOptions({ model: "local-thing" }).model, "local-thing");
    assert.equal(compareModelOptions({ model: "local-thing" }).codex, undefined);
  });

  it("accepts a bare string override for backwards compatibility", () => {
    assert.equal(compareModelOptions("some-model").model, "some-model");
  });
});
