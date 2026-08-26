import test from "node:test";
import assert from "node:assert/strict";

import { analyzeThinkTruncation, actionsAfterSevered, formatThinkTruncation } from "../src/logic/think-truncation.js";

const call = (content, outputTokens) => ({
  response: { normalized: { content, usage: { outputTokens } } },
});
const think = (text, tok) => call(text, tok);
const action = (a, tok = 50) => call(`{"a":"${a}","p":"x.py"}`, tok);

test("a think that spends its whole budget is severed; one that stops short is not", () => {
  const a = analyzeThinkTruncation({
    modelCalls: [think("done thinking.", 900), think("cut off mid", 4096)],
  });
  assert.equal(a.thinkCalls, 2);
  assert.equal(a.severedCount, 1);
  assert.equal(a.severed[0].tokens, 4096);
});

test("action-shaped calls are not counted as thinks", () => {
  // The action phase emits JSON and has its own budget; counting it would
  // report severed reasoning on runs that never truncated a thought.
  const a = analyzeThinkTruncation({ modelCalls: [action("write_file", 4096), think("ok.", 10)] });
  assert.equal(a.thinkCalls, 1);
  assert.equal(a.severedCount, 0);
});

test("mid-sentence endings are distinguished from finished ones", () => {
  const a = analyzeThinkTruncation({
    modelCalls: [think("all counts are 0. So", 4096), think("that settles it.", 4096)],
  });
  assert.equal(a.severedCount, 2);
  assert.equal(a.midSentence, 1);
});

test("the budget is configurable, because the run's may differ from the default", () => {
  const art = { modelCalls: [think("x", 2048)] };
  assert.equal(analyzeThinkTruncation(art).severedCount, 0);
  assert.equal(analyzeThinkTruncation(art, { budget: 2048 }).severedCount, 1);
});

test("names what the run DID after each severed thought", () => {
  const artifact = {
    modelCalls: [think("cut", 4096), action("write_file")],
    turns: [{ i: 7, modelCallIndex: 1, parsedAction: { a: "write_file", p: "encode.py" } }],
  };
  const a = analyzeThinkTruncation(artifact);
  const after = actionsAfterSevered(artifact, a);
  assert.equal(after[0].action, "write_file");
  assert.equal(after[0].turn, 7);
  const lines = formatThinkTruncation(a, artifact).join("\n");
  assert.match(lines, /FULL REWRITE 1 time/);
});

test("silent when nothing was severed", () => {
  const a = analyzeThinkTruncation({ modelCalls: [think("fine.", 100)] });
  assert.deepEqual(formatThinkTruncation(a, {}), []);
  assert.deepEqual(formatThinkTruncation(null, {}), []);
  assert.equal(analyzeThinkTruncation({ modelCalls: [] }), null);
});

// --- the seam: the note has to SURVIVE the trip to the action phase ----------
// The severed-thought note is appended to turnReasoning, but the action call
// does not receive turnReasoning verbatim — it receives
// compactActionReasoning(turnReasoning, cap). A compaction that kept only the
// head would drop the note silently and turn the whole fix into a no-op with no
// symptom. Test the seam, not the station.
import { compactActionReasoning } from "../src/thinking.js";

const SEVERED_NOTE = "\n\n[reasoning-budget] This thought was cut off at the budget"
  + " before it reached a conclusion — what is above is a fragment, not a finished plan."
  + " Do NOT start a full-file rewrite from it.";

test("the severed-thought note survives compaction at every realistic cap", () => {
  const longThought = "Reasoning about the arithmetic coder. ".repeat(400);
  for (const cap of [1200, 2000, 4000, 8000]) {
    const compacted = compactActionReasoning(longThought + SEVERED_NOTE, cap);
    assert.ok(
      compacted.includes("[reasoning-budget]"),
      `note dropped at cap ${cap} — the action phase would never learn the thought was cut`,
    );
  }
});

test("survives even when the thought itself fills the whole think budget", () => {
  // 4096 tokens is the default budget; ~2.92 chars/token on this tokenizer.
  const severed = "x".repeat(Math.floor(4096 * 2.92)) + SEVERED_NOTE;
  assert.ok(compactActionReasoning(severed, 2000).includes("[reasoning-budget]"));
});
