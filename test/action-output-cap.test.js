import test from "node:test";
import assert from "node:assert/strict";

import { actionPromptMenu } from "../src/action-protocol.js";
import { systemPrompt } from "../src/prompt.js";
import { ModelClient, modelOutputTokenCap } from "../src/model.js";

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

test("Codex does not inherit the local profile's unsent sampling cap", t => {
  const model = new ModelClient({ codex: true, nPredict: 8192 });
  t.after(() => model.close());
  const request = JSON.parse(model.buildRequest('Choose an action.').body);
  assert.equal(Object.hasOwn(request, 'nPredict'), false);
  assert.equal(modelOutputTokenCap(model), null);
  assert.doesNotMatch(systemPrompt({ outputTokenCap: modelOutputTokenCap(model) }), /LIMIT:/);
});

test("local and compatible completion transports retain their configured cap", t => {
  for (const options of [{ apiUrl: null }, { apiUrl: 'http://localhost:8085/v1' }]) {
    const model = new ModelClient({ ...options, nPredict: 4096 });
    t.after(() => model.close());
    const request = JSON.parse(model.buildRequest('Choose an action.').body);
    assert.equal(options.apiUrl ? request.max_tokens : request.n_predict, 4096);
    assert.equal(modelOutputTokenCap(model), 4096);
  }
});
