import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";
import {actionJsonSchema} from '../src/grammar.js';

test('a certified silent action gets one recovery and retains its unmeasured first attempt', async t => {
  for (const [retries, succeeds, expected] of [[2, true, 2], [5, false, 2], [0, true, 1]]) {
    const client = new ModelClient({codex: true, retries});
    t.after(() => client.close());
    const prompts = [];
    client.codexRuntime = {close() {}, async complete(prompt) {
      prompts.push(prompt);
      if (succeeds && prompts.length > 1) return {content: '{"a":"done","summary":"Finished."}', tokens: 1};
      throw Object.assign(new Error('silent action'), {code: 'model_timeout', provider: 'codex',
        timeoutKind: 'idle', retryable: false, canRegenerate: true, outputChars: 0,
        notificationCount: 2, lastEvent: 'item/started'});
    }};
    const result = client.complete('unchanged task and tool receipts', {jsonSchema: actionJsonSchema()});
    if (succeeds && retries > 0) assert.match((await result).content, /Finished/);
    else await assert.rejects(result, /silent action/);
    assert.equal(prompts.length, expected);
    assert.ok(prompts.every(prompt => prompt === prompts[0]));
    const record = client.requestLog().at(-1);
    assert.equal(record.attempts.length, expected);
    assert.equal(record.attempts[0].response, null, 'missing usage is not invented');
    assert.equal(record.attempts[0].error.outputChars, 0);
    assert.equal(record.attempts[0].error.lastEvent, 'item/started');
  }
});

test("ModelClient never multiplies a non-retryable Codex timeout", async (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    retries: 2,
  });
  t.after(() => client.close());
  let attempts = 0;
  client.codexRuntime = {
    async complete() {
      attempts++;
      const error = new Error("Codex app-server turn made no progress");
      error.code = "model_timeout";
      error.provider = "codex";
      error.retryable = false;
      throw error;
    },
    close() {},
  };

  await assert.rejects(
    client.complete("one bounded attempt"),
    (error) => error?.code === "model_timeout" && error?.retryable === false,
  );
  assert.equal(attempts, 1);
  assert.equal(client.requestLog().at(-1).attempts.length, 1);
});
