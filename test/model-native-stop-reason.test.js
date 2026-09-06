import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/model.js";

const cases = [
  { data: { stop_type: "limit", tokens_predicted: 2400 }, expected: true },
  { data: { stop_type: "limit", stopped_limit: false }, expected: true },
  { data: { stopped_limit: true }, expected: true },
  { data: { stop_type: "eos", stopped_eos: true }, expected: false },
  { data: { stop_type: "word", stopped_word: true }, expected: false },
  { data: { stop_type: "none" }, expected: false },
  { data: { tokens_predicted: 2400 }, expected: false },
  { data: { choices: [{ finish_reason: "stop", text: "complete" }] }, expected: false },
];

for (const mode of ["plain", "stream", "plain-fallback-for-stream"]) {
  test(`native stop_type limit is retained in ${mode} completions and exchange receipts`, async t => {
    let payload;
    t.mock.method(globalThis, "fetch", async () => new Response(
      mode === "stream" ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload),
      { status: 200, headers: { "content-type": mode === "stream" ? "text/event-stream" : "application/json" } },
    ));
    const client = new ModelClient({ profile: "qwen", apiUrl: null, endpoint: "http://fixture.invalid", timeoutMs: 1000 });
    for (const { data, expected } of cases) {
      payload = { content: "partial or complete text", stop: true, ...data };
      const exchange = {};
      const result = await client._completeOnce({ url: "http://fixture.invalid/completion", method: "POST", body: "{}", headers: {} },
        mode === "plain" ? {} : { onProgress: () => {} }, exchange);
      assert.equal(result.stoppedLimit, expected, JSON.stringify(data));
      assert.equal(result.stoppedEos, Boolean(data.stopped_eos), "existing EOS semantics stay unchanged");
      assert.equal(exchange.response.normalized.stoppedLimit, expected, "recorded normalized evidence agrees with returned result");
      assert.ok(exchange.response.rawBody.includes(JSON.stringify(data).slice(1, -1)) || mode === "stream");
    }
  });
}
