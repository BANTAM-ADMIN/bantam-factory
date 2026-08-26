import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";

// 2026-08-24, luna through codexapi: the server answered three action calls with
// an SSE error frame — `data: {"error":{"message":"blocked: the model attempted a
// commandExecution tool call, which chat mode forbids"}}` — and BANTAM read them
// as empty completions: "no JSON object found in output", three repair turns,
// and a transcript that blamed the model's JSON. An error frame is an error.

test("an SSE error frame surfaces as a model error, not an empty completion", async () => {
  const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", model: "luna", apiDialect: "chat" });
  const body = (async function* () {
    yield Buffer.from('data: {"error":{"message":"blocked: the model attempted a commandExecution tool call, which chat mode forbids","type":"internal_error"}}\n\n');
  })();
  await assert.rejects(
    () => client._readStream({ body }, () => {}),
    (e) => /blocked: the model attempted a commandExecution tool call/.test(e.message) && e.code === "stream_error",
  );
});
