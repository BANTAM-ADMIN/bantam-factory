// The chat transport is opt-in and gated on BYTE FIDELITY.
//
// Sending BANTAM's turns as `messages` lets the server checkpoint at every
// user-message boundary — measured 3x less prefill work and ~40% less wall at
// 20k-48k contexts, because /completion only ever gets the one checkpoint at
// n_ubatch+4 from the end. But the server re-renders those messages through its
// own chat template, and on this stack that is NOT the same bytes BANTAM built:
// the template strips the newline BANTAM writes before every <|im_end|>, so the
// common prefix stops at token 1861 and only 43-80% of the prompt survives
// identical. A transport that quietly changed half the prompt's tokenisation
// would be the exact defect this project keeps cataloguing. So: measure, and
// refuse unless it is exact.
import assert from "node:assert/strict";
import test from "node:test";

import {
  decomposeRenderedPrompt,
  chatTransportFidelity,
  buildChatBody,
} from "../src/chat-transport.js";

const RENDERED = [
  "<|im_start|>system\nYou are Bantam.\n<|im_end|>\n",
  "<|im_start|>user\nTask: fix the bug\n<|im_end|>\n",
  '<|im_start|>assistant\n{"a":"inspect","p":"util.js"}<|im_end|>\n',
  "<|im_start|>user\n<observation>\nfile contents\n</observation>\n<|im_end|>\n",
  "<|im_start|>assistant\n<think>\n",
].join("");

test("a rendered prompt decomposes into its turns and its trailing prefill", () => {
  const d = decomposeRenderedPrompt(RENDERED);
  assert.deepEqual(d.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.match(d.messages[0].content, /You are Bantam/);
  assert.match(d.messages[2].content, /"a":"inspect"/);
  // The tail after the last <|im_end|> is the generation cue plus whatever
  // BANTAM prefilled — an OPEN think block here, because this turn is reasoning.
  assert.equal(d.prefill, "<think>\n");
});

test("the prefill varies per turn and is carried verbatim, not guessed", () => {
  const sealed = RENDERED.replace("<think>\n", "<think>\n</think>\n\n");
  assert.equal(decomposeRenderedPrompt(sealed).prefill, "<think>\n</think>\n\n");
  const bare = RENDERED.replace("<|im_start|>assistant\n<think>\n", "<|im_start|>assistant\n");
  assert.equal(decomposeRenderedPrompt(bare).prefill, "");
});

test("a prompt that is not turn-structured decomposes to null, never to a guess", () => {
  assert.equal(decomposeRenderedPrompt("just a bare string"), null);
  assert.equal(decomposeRenderedPrompt(""), null);
  assert.equal(decomposeRenderedPrompt(null), null);
});

test("the gate refuses when the server re-renders different bytes", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("/apply-template")) {
      // The real template strips the newline before <|im_end|>.
      return { ok: true, json: async () => ({ prompt: RENDERED.replace(/\n<\|im_end\|>/g, "<|im_end|>") }) };
    }
    return { ok: true, json: async () => ({ tokens: new Array(body.content.length).fill(0) }) };
  };
  const r = await chatTransportFidelity({ endpoint: "http://x", prompt: RENDERED, fetchImpl });
  assert.equal(r.exact, false);
  assert.equal(r.ok, false, "not exact means not usable");
  assert.match(r.reason, /differ/i);
});

test("the gate passes when the re-render is byte-identical", async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/apply-template")) return { ok: true, json: async () => ({ prompt: RENDERED }) };
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ tokens: new Array(body.content.length).fill(0) }) };
  };
  const r = await chatTransportFidelity({ endpoint: "http://x", prompt: RENDERED, fetchImpl });
  assert.equal(r.exact, true);
  assert.equal(r.ok, true);
});

test("an unreachable server fails the gate closed, not open", async () => {
  const r = await chatTransportFidelity({
    endpoint: "http://x", prompt: RENDERED,
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /connection refused|could not/i);
});

test("the chat body carries the grammar and the prefill, and suppresses template injection", () => {
  const { messages, ...body } = buildChatBody({
    decomposed: decomposeRenderedPrompt(RENDERED),
    grammar: 'root ::= "OK"', nPredict: 64, temperature: 0.7, topP: 0.9, topK: 20, cachePrompt: true,
  });
  // The prefill rides as a trailing assistant message — llama.cpp continues it
  // rather than starting a new turn, which is what keeps a grammar-constrained
  // action in `content` instead of `reasoning_content`.
  assert.equal(messages.at(-1).role, "assistant");
  assert.equal(messages.at(-1).content, "<think>\n");
  assert.equal(body.grammar, 'root ::= "OK"');
  assert.equal(body.max_tokens, 64);
  assert.equal(body.cache_prompt, true);
  // Without this the template injects "Reasoning effort is set to xhigh..." into
  // the system message — text BANTAM never wrote.
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
});

test("the echoed prefill is stripped, so the action parser sees only new text", async () => {
  const { stripChatPrefill } = await import("../src/model.js");
  // Measured: the chat endpoint returns '<think>\n</think>\n\nOKBANTAM' for a
  // grammar-constrained request whose trailing assistant message was the think
  // block. /completion returns 'OKBANTAM' alone.
  assert.equal(stripChatPrefill("<think>\n</think>\n\n{\"a\":\"done\"}", "<think>\n</think>\n\n"), '{"a":"done"}');
  assert.equal(stripChatPrefill('{"a":"done"}', "<think>\n"), '{"a":"done"}', "no echo, no change");
  assert.equal(stripChatPrefill("abc", ""), "abc");
  assert.equal(stripChatPrefill(null, "x"), null);
});

test("an armed transport stays off until the gate proves fidelity", async () => {
  const { ModelClient } = await import("../src/model.js");
  const m = new ModelClient({ endpoint: "http://127.0.0.1:9", chatTransport: true });
  assert.equal(m.chatTransport, true);
  assert.equal(m.chatTransportReady, null, "unproven, therefore unused");
  const r = await m.ensureChatTransport("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n");
  assert.equal(r.ok, false, "an unreachable server must not arm the transport");
  assert.equal(m.chatTransportReady, false);
  // And the request it builds is still the ordinary /completion one.
  const req = m.buildRequest("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n", {});
  assert.match(req.url, /\/completion$/);
  assert.equal(req.chatTransport, undefined);
});
