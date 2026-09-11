// vLLM (OpenAI-compatible) transport contract.
//
// Everything here was established against a live vLLM 0.28.0 server
// (Qwen3.8-27B on :18020) on 2026-09-11, not inferred from documentation:
//
//   * vLLM's own GET /openapi.json exposes `structured_outputs` on
//     CompletionRequest and has NO GuidedDecodingParams at all, so the legacy
//     `guided_grammar` this repo used to send was accepted and IGNORED.
//   * vLLM accepts unknown request fields rather than rejecting them, so the
//     wrong grammar door fails silently — the exact symptom the doctor probe
//     exists to catch.
//   * With `--reasoning-parser qwen3` the constraint is suspended while the
//     model is inside its reasoning block (enable_in_reasoning=False), so a
//     probe must end on BANTAM's own CLOSED prefill to measure anything.
//   * Output-limit stops arrive as choices[0].finish_reason === "length"; the
//     native llama.cpp booleans are simply absent.
import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/model.js";
import { grammarFieldFor, buildOpenAiBody, STRUCTURED_OUTPUTS_FIELD } from "../src/openai-transport.js";
import { discoverOpenAiServers, discoverModelServers } from "../src/first-run.js";
import { startupChoiceNeeded } from "../src/startup-model-choice.js";

test("the vllm dialect nests the grammar under structured_outputs; llama.cpp stays flat", () => {
  const gbnf = 'root ::= "OK"';
  assert.equal(grammarFieldFor("vllm"), STRUCTURED_OUTPUTS_FIELD);
  assert.equal(grammarFieldFor(undefined), "grammar");
  assert.equal(grammarFieldFor("llamacpp"), "grammar");

  const vllm = buildOpenAiBody({ prompt: "x", grammar: gbnf, grammarField: grammarFieldFor("vllm") });
  assert.deepEqual(vllm.structured_outputs, { grammar: gbnf }, "vLLM reads structured_outputs.grammar");
  assert.equal(vllm.grammar, undefined, "a flat `grammar` is not sent in the vllm dialect");
  assert.equal(vllm.guided_grammar, undefined, "guided_grammar is a removed legacy parameter");

  const llama = buildOpenAiBody({ prompt: "x", grammar: gbnf, grammarField: grammarFieldFor("llamacpp") });
  assert.equal(llama.grammar, gbnf, "llama.cpp's top-level grammar is unchanged");
  assert.equal(llama.structured_outputs, undefined);
});

test("no grammar field is emitted when the caller passes none", () => {
  const body = buildOpenAiBody({ prompt: "x", grammar: null, grammarField: grammarFieldFor("vllm") });
  assert.equal(body.structured_outputs, undefined);
  assert.equal(body.grammar, undefined);
});

test("a capability probe is rendered in the client's own shape, think block closed", () => {
  const client = new ModelClient({ profile: "qwen", apiUrl: null, endpoint: "http://fixture.invalid" });
  assert.equal(
    client.probePrompt("Reply OKBANTAM."),
    "<|im_start|>user\nReply OKBANTAM.<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n",
    "must end on the real prefill: a bare prompt lets vLLM open a <think> block and suspends the constraint",
  );
});

test("an OpenAI output-limit stop is reported as stoppedLimit", async t => {
  const client = new ModelClient({ profile: "qwen", apiUrl: "http://fixture.invalid/v1", model: "m", apiDialect: "vllm", timeoutMs: 1000 });
  const record = { url: "http://fixture.invalid/v1/completions", method: "POST", body: "{}", headers: {} };

  for (const [finish, expected] of [["length", true], ["stop", false]]) {
    const payload = {
      choices: [{ text: "{\"a\":\"done\",\"summary\":\"x\"}", finish_reason: finish }],
      usage: { prompt_tokens: 120, completion_tokens: 14, prompt_tokens_details: { cached_tokens: 96 } },
    };
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const exchange = {};
    const result = await client._completeOnce(record, {}, exchange);
    assert.equal(result.stoppedLimit, expected, `finish_reason ${finish}`);
    assert.equal(result.tokens, 14, "vLLM usage.completion_tokens is the token count");
    assert.equal(result.promptTokens, 120);
    assert.equal(result.usage.cacheHitTokens, 96, "prompt_tokens_details.cached_tokens is the reuse count");
    assert.equal(exchange.response.normalized.stoppedLimit, expected);
  }
});

test("discovery reads the dialect and window from the server's own model card", async () => {
  const found = await discoverOpenAiServers({
    ports: [18020, 8085, 8000],
    fetchImpl: async (url) => {
      if (url.includes(":18020")) {
        return { ok: true, json: async () => ({ data: [{ id: "qwen3.8-27b", owned_by: "vllm", max_model_len: 106496 }] }) };
      }
      if (url.includes(":8085")) {
        return { ok: true, json: async () => ({ data: [{ id: "davidau-27b" }] }) };
      }
      throw Error("offline");
    },
  });
  assert.deepEqual(found, [
    { apiUrl: "http://127.0.0.1:18020/v1", models: ["qwen3.8-27b"], dialect: "vllm", contextTokens: 106496 },
    { apiUrl: "http://127.0.0.1:8085/v1", models: ["davidau-27b"], dialect: "llamacpp" },
  ]);
});

test("discoverModelServers keeps its long-standing projection", async () => {
  const found = await discoverModelServers({
    ports: [18020],
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "m", owned_by: "vllm", max_model_len: 999 }] }) }),
  });
  assert.deepEqual(found, [{ apiUrl: "http://127.0.0.1:18020/v1", models: ["m"] }]);
});

test("a live auto-detected API server suppresses the startup picker", () => {
  assert.equal(startupChoiceNeeded({
    canOffer: true, detectedLocalReady: false, detectedApiReady: true,
    rememberedConnection: null, backendHealthy: false,
  }), false, "an attached vLLM is serving, so there is nothing to ask");
  assert.equal(startupChoiceNeeded({
    canOffer: true, detectedLocalReady: false, detectedApiReady: false,
    rememberedConnection: null, backendHealthy: false,
  }), true, "with nothing attached the picker still opens");
});

test("the dialect name survives on the client for backend snapshots", () => {
  const client = new ModelClient({ profile: "qwen", apiUrl: "http://fixture.invalid/v1", model: "m", apiDialect: "VLLM" });
  assert.equal(client.apiDialect, "vllm", "normalized, so `:model` rollback cannot rewrite it as llama.cpp");
  assert.equal(client.grammarField, STRUCTURED_OUTPUTS_FIELD);
  client.switchToApi({ url: "http://other.invalid/v1", model: "n", dialect: "llamacpp" });
  assert.equal(client.apiDialect, "llamacpp");
  assert.equal(client.grammarField, "grammar");
});

test("stream usage is requested only for the vllm dialect", () => {
  const sampling = { nPredict: 8, temperature: 0 };
  const asked = buildOpenAiBody({ prompt: "x", sampling, stream: true, includeUsage: true, grammarField: grammarFieldFor("vllm") });
  assert.deepEqual(asked.stream_options, { include_usage: true });
  const quiet = buildOpenAiBody({ prompt: "x", sampling, stream: true, grammarField: "grammar" });
  assert.equal(quiet.stream_options, undefined, "llama.cpp's body is byte-identical to before");
});

test("streaming tokens come from the usage frame, not the SSE frame count", async () => {
  const client = new ModelClient({ profile: "qwen", apiUrl: "http://fixture.invalid/v1", model: "m", apiDialect: "vllm" });
  const frame = (o) => `data: ${JSON.stringify(o)}`;
  // Deliberately two content frames for nine tokens: a frame count is not a
  // token count, which is how the output-limit fallback went dead.
  const sse = [
    frame({ choices: [{ text: '{"a":"done"', index: 0 }] }),
    frame({ choices: [{ text: ',"summary":"x"}', index: 0, finish_reason: "stop" }] }),
    frame({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49, prompt_tokens_details: { cached_tokens: 32 } } }),
    "data: [DONE]",
    "",
  ].join("\n\n");
  const { result } = await client._readStream(
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    () => {},
  );
  assert.equal(result.content, '{"a":"done","summary":"x"}');
  assert.equal(result.tokens, 9, "usage.completion_tokens, not the 2 content frames");
  assert.equal(result.promptTokens, 40);
  assert.equal(result.stoppedLimit, false, "finish_reason stop is a finish, not a limit");
  assert.equal(result.usage.outputTokens, 9);
  assert.equal(result.usage.cacheHitTokens, 32);
});
