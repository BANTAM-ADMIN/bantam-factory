import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";

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
