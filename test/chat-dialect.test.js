import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";

// 2026-08-24: codexapi (an OpenAI-compatible bridge in front of the codex CLI)
// serves only /v1/chat/completions. BANTAM's OpenAI path speaks raw-prompt
// /v1/completions with a GBNF grammar, so the bridge was unreachable as a
// model. A spike sending BANTAM's real turn-0 prompt as chat messages returned
// a valid action from both spark and luna in ~5 s: the protocol survives the
// transport. This dialect is that spike made durable.

const PROMPT = "<|im_start|>system\nYou are Bantam.<|im_end|>\n<|im_start|>user\nTask: look around<|im_end|>\n<|im_start|>assistant\n";
const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

test("the chat dialect posts messages to /chat/completions with the action schema as response_format", () => {
  const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", apiKey: "k", model: "gpt-5.3-codex-spark:low", apiDialect: "chat" });
  const request = client.buildRequest(PROMPT, { grammar: 'root ::= "x"', jsonSchema: SCHEMA, nPredict: 512 });
  const { url, headers } = request;
  const body = JSON.parse(request.body);
  assert.equal(url, "http://bridge:8787/v1/chat/completions");
  assert.equal(headers.Authorization, "Bearer k");
  assert.equal(body.model, "gpt-5.3-codex-spark:low");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"], "the empty assistant prefill is not a message");
  assert.equal(body.messages[1].content, "Task: look around");
  assert.equal(body.response_format?.type, "json_schema");
  assert.deepEqual(body.response_format.json_schema.schema, SCHEMA);
  assert.equal(body.grammar, undefined, "no GBNF over a chat endpoint");
  assert.equal(body.max_tokens, 512);
});

test("without a schema the chat dialect asks for plain JSON output", () => {
  const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", model: "luna", apiDialect: "chat" });
  const body = JSON.parse(client.buildRequest(PROMPT, { grammar: 'root ::= "x"' }).body);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("switching a live client to a chat-dialect API keeps the dialect", () => {
  const client = new ModelClient({ endpoint: "http://localhost:8085" });
  client.switchToApi({ url: "http://bridge:8787/v1/", model: "sol", dialect: "chat" });
  const { url } = client.buildRequest(PROMPT, {});
  assert.equal(url, "http://bridge:8787/v1/chat/completions");
});

test("BANTAM_CHAT_BODY_EXTRA merges operator fields into the chat body (codexapi's chat_preamble, web_search)", () => {
  const prev = process.env.BANTAM_CHAT_BODY_EXTRA;
  process.env.BANTAM_CHAT_BODY_EXTRA = '{"chat_preamble":false}';
  try {
    const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", model: "spark", apiDialect: "chat" });
    const body = JSON.parse(client.buildRequest(PROMPT, {}).body);
    assert.equal(body.chat_preamble, false);
    assert.equal(body.model, "spark", "extras never override the request's own fields");
  } finally {
    if (prev === undefined) delete process.env.BANTAM_CHAT_BODY_EXTRA; else process.env.BANTAM_CHAT_BODY_EXTRA = prev;
  }
});
