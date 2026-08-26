import test from "node:test";
import assert from "node:assert/strict";

import { analyzePromptBloat, formatPromptBloat, callPrompt } from "../src/logic/prompt-bloat.js";

const sys = '<|im_start|>system\nschema: {"a":"write_file","p":"...","content":"..."}<|im_end|>\n';
const user = (s) => `<|im_start|>user\n${s}<|im_end|>\n`;
const edit = (p, body) => `<|im_start|>assistant\n{"a":"write_file","p":"${p}","content":"${body}"}<|im_end|>\n`;

const run = (prompts) => ({
  modelCalls: prompts.map((p) => ({ request: { body: { prompt: p } } })),
});

test("the system block is not counted as an edit echo", () => {
  // It documents the action schema, so it contains the literal `"a":"write_file"`.
  // Counting it inflated an early reading of this metric by 36,480 bytes.
  const a = analyzePromptBloat(run([sys + user("go")]));
  assert.equal(a.echoBlocks, 0);
  assert.equal(a.supersededBytes, 0);
});

test("only the newest body per path survives; earlier ones are superseded", () => {
  const last = sys + edit("a.py", "v1".repeat(200)) + edit("a.py", "v2".repeat(200)) + edit("b.py", "z");
  const a = analyzePromptBloat(run([sys, last]));
  assert.equal(a.echoBlocks, 3);
  const aPy = a.byPath.find((f) => f.path === "a.py");
  assert.equal(aPy.copies, 2);
  // exactly one of the two a.py bodies counts as dead weight, and b.py's single
  // body is still true on disk
  assert.equal(aPy.supersededBytes, edit("a.py", "v1".repeat(200)).length);
  assert.equal(a.byPath.find((f) => f.path === "b.py").supersededBytes, 0);
});

test("reports the panel and slimming state read from the BYTES, not from config", () => {
  const withPanel = sys + user("<open_files>\n# a.py (current, 1 lines)\n") + edit("a.py", "x") + edit("a.py", "y");
  assert.equal(analyzePromptBloat(run([sys, withPanel])).panelRendered, true);
  // the system prompt merely DESCRIBES <open_files>, which must not read as rendered
  const described = `<|im_start|>system\nWhen an <open_files> block is present…<|im_end|>\n`;
  assert.equal(analyzePromptBloat(run([described, described + edit("a.py", "x")])).panelRendered, false);
});

test("slimming counted as active when placeholders are present", () => {
  const slim = sys + '<|im_start|>assistant\n{"a":"write_file","p":"a.py","note":"[superseded — current file shown in <open_files>]"}<|im_end|>\n';
  assert.equal(analyzePromptBloat(run([sys, slim])).slimmingActive, true);
  assert.equal(analyzePromptBloat(run([sys, sys + edit("a.py", "x")])).slimmingActive, false);
});

test("a run with nothing superseded formats to nothing", () => {
  assert.deepEqual(formatPromptBloat(analyzePromptBloat(run([sys, sys + edit("a.py", "x")]))), []);
  assert.deepEqual(formatPromptBloat(null), []);
});

test("callPrompt survives a stringified body and a missing prompt", () => {
  assert.equal(callPrompt({ request: { body: JSON.stringify({ prompt: "hi" }) } }), "hi");
  assert.equal(callPrompt({ request: { body: "not json" } }), "");
  assert.equal(callPrompt({}), "");
});

test("returns null when the artifact records no prompts", () => {
  assert.equal(analyzePromptBloat({ modelCalls: [] }), null);
  assert.equal(analyzePromptBloat({}), null);
});
