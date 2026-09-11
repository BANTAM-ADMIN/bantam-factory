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
import { ModelClient, measuredTimings, timingsTokensPerSecond } from "../src/model.js";
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

test("measured timings split prefill from decode when the response streamed", () => {
  const t = measuredTimings({ promptN: 1200, genN: 80, startedAt: 1000, firstTokenAt: 1400, finishedAt: 1800 });
  assert.equal(t.measured, "client-stream");
  assert.equal(t.prompt_n, 1200);
  assert.equal(t.predicted_n, 80);
  assert.equal(t.prompt_ms, 400, "first token is the prefill/decode boundary");
  assert.equal(t.predicted_ms, 400);
  assert.equal(t.predicted_per_second, 200, "80 tokens over 0.4s of decode");
});

test("measured timings admit when only the whole exchange was knowable", () => {
  const t = measuredTimings({ promptN: 500, genN: 40, startedAt: 0, firstTokenAt: null, finishedAt: 2000 });
  assert.equal(t.measured, "client-total");
  assert.equal(t.prompt_ms, undefined, "prefill is unobservable without a first-token boundary");
  assert.equal(t.predicted_ms, 2000);
  assert.equal(t.predicted_per_second, 20);
});

test("measured timings never invent a rate they cannot measure", () => {
  assert.deepEqual(measuredTimings({}), {}, "no clock, no claim");
  assert.equal(measuredTimings({ genN: 0, startedAt: 0, finishedAt: 100 }).predicted_per_second, undefined);
  assert.equal(timingsTokensPerSecond({}), null);
  assert.equal(timingsTokensPerSecond({ predicted_n: 50, predicted_ms: 500 }), 100, "rate is derived when absent");
});

test("a streaming response yields an observed rate the session can report", async (t) => {
  const client = new ModelClient({ profile: "qwen", apiUrl: "http://fixture.invalid/v1", model: "m", apiDialect: "vllm" });
  assert.equal(client.observedTokensPerSecond, null, "nothing measured before a response");
  const frame = (o) => `data: ${JSON.stringify(o)}`;
  const sse = [
    frame({ choices: [{ text: '{"a":"done",', index: 0 }] }),
    frame({ choices: [{ text: '"summary":"x"}', index: 0, finish_reason: "stop" }] }),
    frame({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } }),
    "data: [DONE]",
    "",
  ].join("\n\n");
  t.mock.method(globalThis, "fetch", async () => new Response(sse, {
    status: 200, headers: { "content-type": "text/event-stream" },
  }));
  const result = await client.complete("<|im_start|>user\nx<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n", { nPredict: 64, onProgress: () => {} });
  assert.equal(result.timings.measured, "client-stream", "vLLM sent no timings, so BANTAM measured its own");
  assert.ok(client.observedTokensPerSecond > 0, "the session can now answer how fast that was");
  assert.ok(Number.isFinite(client.observedPrefillMs), "and how long it waited for the first token");
});

test("a server that reports its own timings is still authoritative", async (t) => {
  const client = new ModelClient({ profile: "qwen", apiUrl: null, endpoint: "http://fixture.invalid" });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    content: "done", stop: true, tokens_predicted: 7, tokens_evaluated: 12,
    timings: { prompt_n: 12, predicted_n: 7, prompt_ms: 30, predicted_ms: 70, predicted_per_second: 100 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  // complete() so the full path runs, including _recordUsage().
  const result = await client.complete("x", {});
  assert.equal(result.timings.measured, undefined, "llama.cpp timings are passed through untouched");
  assert.equal(result.timings.predicted_per_second, 100);
  assert.equal(client.observedTokensPerSecond, 100);
});

test("generation speed stops at the last token, not at stream teardown", async (t) => {
  // A stream whose usage frame lands 300ms after the final token. Charging that
  // gap to decode time is what makes a fast server report a slow one.
  const client = new ModelClient({ profile: "qwen", apiUrl: "http://fixture.invalid/v1", model: "m", apiDialect: "vllm" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const frame = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
      c.enqueue(frame({ choices: [{ text: '{"a":"done",', index: 0 }] }));
      await sleep(40);
      c.enqueue(frame({ choices: [{ text: '"summary":"x"}', index: 0, finish_reason: "stop" }] }));
      await sleep(300); // teardown / usage frame lag
      c.enqueue(frame({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 60, total_tokens: 760 } }));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(stream, {
    status: 200, headers: { "content-type": "text/event-stream" },
  }));
  const t0 = performance.now();
  const result = await client.complete("<|im_start|>user\nx<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n", { nPredict: 64, onProgress: () => {} });
  const totalMs = performance.now() - t0;
  assert.ok(totalMs >= 300, `the exchange really did take ~340ms (${Math.round(totalMs)}ms)`);
  assert.ok(result.timings.predicted_ms < 200,
    `generation time excludes the 300ms teardown gap (measured ${Math.round(result.timings.predicted_ms)}ms)`);
  assert.ok(result.timings.predicted_per_second > 100,
    `60 tokens in under 200ms is the rate BANTAM should report (${Math.round(result.timings.predicted_per_second)} tok/s)`);
});
