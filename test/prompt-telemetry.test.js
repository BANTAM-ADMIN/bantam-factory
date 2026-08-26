import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePrompt,
  attachPromptTelemetry,
  summarizePromptTelemetry,
} from "../src/prompt-telemetry.js";

const system = "<|im_start|>system\nrules\n<|im_end|>\n";
const initial = "<|im_start|>user\nTask: fix it\n<|im_end|>\n";
const prefill = "<|im_start|>assistant\n";

test("prompt telemetry identifies exact prefix reuse and semantic churn", () => {
  const first = `${system}${initial}${prefill}`;
  const second = `${system}${initial}`
    + "<|im_start|>assistant\n{\"a\":\"read_file\"}<|im_end|>\n"
    + "<|im_start|>user\n<observation>\nsource\n</observation>\n<|im_end|>\n"
    + prefill;
  const telemetry = analyzePrompt(second, first, { previousRequestIndex: 7 });

  assert.equal(telemetry.comparison.previousRequestIndex, 7);
  // The first prompt is a byte-for-byte prefix of the second through its open
  // assistant marker; the added history begins exactly after those bytes.
  assert.equal(telemetry.comparison.commonPrefixChars, first.length);
  assert.deepEqual(telemetry.comparison.changedSections, [
    "actionHistory",
    "observations",
  ]);
  assert.equal(telemetry.comparison.firstChangedSection, "actionHistory");
  assert.match(telemetry.sections.system.sha256, /^[a-f0-9]{64}$/);
  assert.equal(telemetry.sections.system.chars, "rules".length);
  assert.equal("source" in telemetry, false);
});

test("attached telemetry rebases comparisons to the selected call sequence", () => {
  const prompts = [
    `${system}${initial}${prefill}`,
    `${system}${initial}<|im_start|>user\nnew guidance\n<|im_end|>\n${prefill}`,
  ];
  const calls = attachPromptTelemetry(prompts.map((prompt, index) => ({
    index: index + 10,
    request: { body: JSON.stringify({ prompt }) },
  })));

  assert.equal(calls[0].promptTelemetry.comparison, null);
  assert.equal(calls[1].promptTelemetry.comparison.previousRequestIndex, 10);
  assert.equal(calls[1].promptTelemetry.comparison.firstChangedSection, "guidance");
  assert.equal(calls[0].request.body, JSON.stringify({ prompt: prompts[0] }));
});

test("summary aggregates reusable-prefix and suffix churn without prompt content", () => {
  const calls = attachPromptTelemetry([
    { index: 0, request: { prompt: "abcdef" } },
    { index: 1, request: { prompt: "abcXYZ" } },
    { index: 2, request: { prompt: "abcXYZ123" } },
  ]);
  const summary = summarizePromptTelemetry(calls);

  assert.equal(summary.callsWithPrompt, 3);
  assert.equal(summary.comparableCalls, 2);
  assert.equal(summary.commonPrefixChars, 3 + 6);
  assert.equal(summary.comparablePromptChars, 6 + 9);
  assert.equal(summary.commonPrefixRatio, 9 / 15);
  assert.equal(summary.addedSuffixChars, 3 + 3);
  assert.equal(summary.replacedSuffixChars, 3);
});

test("missing prompts remain valid evidence without invented comparisons", () => {
  const calls = attachPromptTelemetry([{ index: 2, request: { body: "{}" } }]);
  assert.equal(calls[0].promptTelemetry, undefined);
  assert.deepEqual(summarizePromptTelemetry(calls), {
    schema: 1,
    callsWithPrompt: 0,
    comparableCalls: 0,
    totalChars: 0,
    averageChars: 0,
    maxChars: 0,
    comparablePromptChars: 0,
    commonPrefixChars: 0,
    commonPrefixRatio: null,
    addedSuffixChars: 0,
    replacedSuffixChars: 0,
    firstChangedSections: {},
    // Sections whose already-sent bytes changed; empty when there is nothing to compare.
    firstRewrittenSections: {},
  });
});
