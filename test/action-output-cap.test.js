import test from "node:test";
import assert from "node:assert/strict";

import { actionPromptMenu } from "../src/action-protocol.js";
import { systemPrompt } from "../src/prompt.js";

test("the menu states the per-action output cap when one is known", () => {
  const menu = actionPromptMenu({ outputTokenCap: 8192 });
  assert.match(menu, /LIMIT: one action may emit at most ~8,192 tokens/);
  // the safe working figure is below the hard cap, so a plan built on it fits
  assert.match(menu, /under ~6,144 tokens/);
  assert.match(menu, /runnable skeleton first/);
});

test("no cap known, no line — nothing is invented", () => {
  assert.doesNotMatch(actionPromptMenu({}), /LIMIT:/);
  assert.doesNotMatch(actionPromptMenu({ outputTokenCap: 0 }), /LIMIT:/);
  assert.doesNotMatch(actionPromptMenu({ outputTokenCap: "abc" }), /LIMIT:/);
});

test("systemPrompt threads the cap into the menu it renders", () => {
  assert.match(systemPrompt({ outputTokenCap: 4096 }), /at most ~4,096 tokens/);
  assert.doesNotMatch(systemPrompt({}), /LIMIT:/);
});
