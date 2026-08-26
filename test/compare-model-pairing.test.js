import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { externalCodexSettings, compareModelOptions } from "../src/logic/compare-plan.js";

// `bantam compare` states its own claim at the top of compare-plan.js: "the SAME
// Codex model, once driven by BANTAM and once bare". For a while it did not do
// that. The bare arm spawned:
//
//   codex exec --skip-git-repo-check --sandbox <mode> <task>
//
// with no --model and no reasoning effort, so it ran whatever ~/.codex/config.toml
// defaulted to -- gpt-5.6-SOL on this machine -- against a bantam-codex arm pinned
// to gpt-5.6-TERRA.
//
// Five head-to-heads were run and reported before that was checked. All five
// compared two different models and attributed the difference to the harness. The
// numbers looked great, which is exactly why nobody looked.
//
// A comparison that does not control its main variable does not produce a weaker
// finding. It produces a finding about something else, phrased as if it were about
// the thing you asked.

describe("the competitor runs the subject's model", () => {
  it("pins the bare arm to the same model as bantam-codex", () => {
    assert.equal(externalCodexSettings({ codex: true }).model,
      compareModelOptions({ codex: true }).model);
  });

  it("follows the subject when the subject's model is overridden", () => {
    assert.equal(externalCodexSettings({ codex: true, model: "gpt-5.6-sol" }).model, "gpt-5.6-sol");
  });

  it("never leaves the model unset for the CLI's config to decide", () => {
    for (const spec of [null, undefined, {}, { codex: true }, "gpt-5.6-luna"]) {
      const { model } = externalCodexSettings(spec);
      assert.ok(model && typeof model === "string",
        `spec ${JSON.stringify(spec)} left the competitor's model unpinned`);
    }
  });
});

// Reasoning effort is the other half. BANTAM's Codex default was moved from high
// to medium for a measured -23% wall clock; if the competitor kept running at the
// config default, a wall-clock comparison would be measuring thinking budget.
describe("the competitor runs the subject's reasoning effort", () => {
  it("defaults to the same effort the subject defaults to", () => {
    assert.equal(externalCodexSettings({ codex: true }).effort, "medium");
  });

  it("follows an explicit effort override", () => {
    assert.equal(externalCodexSettings({ codex: true, effort: "xhigh" }).effort, "xhigh");
  });

  it("never leaves effort unset", () => {
    for (const spec of [null, {}, { codex: true }, { codex: true, model: "gpt-5.6-sol" }]) {
      assert.ok(externalCodexSettings(spec).effort, "competitor effort unpinned");
    }
  });
});
