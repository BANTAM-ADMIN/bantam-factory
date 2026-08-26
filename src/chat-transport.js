// chat-transport.js — send BANTAM's turns as `messages` instead of one rendered
// prompt string. OPT-IN, and gated on byte fidelity.
//
// WHY it is worth having. Reuse on this hybrid SWA+recurrent model is
// checkpoint-or-nothing, and /completion only ever gets the checkpoint llama.cpp
// places at n_ubatch+4 tokens before the end. The chat endpoint additionally
// checkpoints at every user-message start, so an edit anywhere inside the newest
// message costs only that message. Measured 2026-08-22 on BANTAM-shaped turns:
//
//   history   /completion            chat messages
//   ~6k       69.1% reuse, 1277 ms   90.1% reuse,  729 ms
//   ~20k      87.8% reuse, 1471 ms   96.0% reuse,  864 ms
//   ~48k      94.5% reuse, 1919 ms   98.2% reuse, 1157 ms
//
// It processes 764 prompt tokens where /completion processes 2350, at any size.
// That matters most for the profiles VRAM caps at ubatch 1024 (window 1028) —
// every profile here except solo.
//
// WHY it is gated. The server re-renders `messages` through its own Jinja chat
// template, and that is not guaranteed to reproduce the bytes BANTAM built. On
// this stack it does not: the template strips the newline BANTAM writes before
// every <|im_end|>, so the common prefix stops at token 1861 and only 43-80% of
// the prompt survives identical. Half the prompt silently re-tokenised is
// exactly the class of defect this repo keeps finding. So the transport measures
// first, and refuses unless the re-render is byte-identical.
//
// CORRECTION (2026-08-22, after actually trying it). An earlier version of this
// note said one convention change would unlock it: stop emitting "\n" before
// "<|im_end|>". That was diagnosed from the FIRST divergence only. Normalising
// the newline does move the match from 43% to char 9903 of 9903 — the entire
// body — but three more differences sit behind it, and the last one is fatal:
//
//   1. the "\n" before <|im_end|>                         (fixable)
//   2. sealed think spelled "<think>\n</think>" here and
//      "<think>\n\n</think>" by the template                (fixable)
//   3. the template emits "<think>\n\n</think>\n\n" at the start of EVERY
//      assistant turn, whatever the content already holds — so BANTAM's
//      assistant history doubles it                        (fixable, invasive)
//   4. that opener is emitted regardless of enable_thinking, so BANTAM's OPEN
//      "<think>\n" prefill — the whole mechanism of its reasoning phase — has
//      NO representation in this template                  (NOT fixable here)
//
// (4) is the blocker. A prompt shape the template cannot express cannot be sent
// byte-exact through it, so the gate below will keep refusing on this stack no
// matter what the renderer does. The newline change was therefore NOT made: its
// only purpose was to unlock this, and it would have altered the working
// /completion path for nothing.
//
// The measured prize is still real, so this stays built and gated. What would
// change the verdict is a different chat template (one that does not force a
// think opener), or llama.cpp gaining a way to suppress it.

const TURN = /<\|im_start\|>(\w+)\n([\s\S]*?)<\|im_end\|>/g;

/**
 * Split a rendered prompt into its turns plus the trailing prefill.
 *
 * The prefill is whatever follows the final `<|im_start|>assistant\n` — an OPEN
 * `<think>` when BANTAM is running its reasoning phase, a SEALED one otherwise,
 * or empty. It varies per turn, so it is carried verbatim rather than assumed.
 * Returns null for anything that is not turn-structured: a guess here would be
 * a different prompt.
 */
export function decomposeRenderedPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.includes("<|im_start|>")) return null;
  const messages = [];
  TURN.lastIndex = 0;
  let match;
  let end = 0;
  while ((match = TURN.exec(prompt)) !== null) {
    messages.push({ role: match[1], content: match[2] });
    end = TURN.lastIndex;
  }
  if (!messages.length) return null;
  const tail = prompt.slice(end);
  const cue = tail.match(/^\n?<\|im_start\|>assistant\n([\s\S]*)$/);
  return { messages, prefill: cue ? cue[1] : "" };
}

/** The request body for the chat endpoint, prefill carried as a trailing turn. */
export function buildChatBody({
  decomposed, grammar = null, nPredict, temperature, topP, topK, cachePrompt = true, stop, seed,
}) {
  const messages = decomposed.prefill
    // llama.cpp continues a trailing assistant message rather than starting a
    // new turn (--prefill-assistant, on by default). That is what keeps a
    // grammar-constrained action in `content` instead of `reasoning_content`.
    ? [...decomposed.messages, { role: "assistant", content: decomposed.prefill }]
    : decomposed.messages;
  const body = {
    messages,
    max_tokens: nPredict,
    temperature,
    top_p: topP,
    top_k: topK,
    cache_prompt: cachePrompt,
    // Without this the template prepends "Reasoning effort is set to xhigh…" to
    // the system message — text BANTAM never wrote. Verified: it is the only
    // kwarg that suppresses the injection on this template.
    chat_template_kwargs: { enable_thinking: false },
  };
  if (grammar) body.grammar = grammar;
  if (stop) body.stop = stop;
  if (seed !== undefined) body.seed = seed;
  return body;
}

async function tokenCount(endpoint, text, fetchImpl) {
  const r = await fetchImpl(`${endpoint}/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!r.ok) throw new Error(`/tokenize returned ${r.status}`);
  return (await r.json()).tokens ?? [];
}

/**
 * Would the chat transport send the same bytes? Asks the server to re-render
 * the decomposed messages and compares. Fails CLOSED — an unreachable server,
 * a missing /apply-template, or any mismatch all mean "do not use it".
 */
export async function chatTransportFidelity({ endpoint, prompt, fetchImpl = fetch }) {
  const base = String(endpoint).replace(/\/$/, "");
  const decomposed = decomposeRenderedPrompt(prompt);
  if (!decomposed) return { ok: false, exact: false, reason: "the prompt is not turn-structured, so it cannot be sent as messages" };

  let rendered;
  try {
    const body = buildChatBody({ decomposed, nPredict: 1, temperature: 0 });
    const r = await fetchImpl(`${base}/apply-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: body.messages, chat_template_kwargs: body.chat_template_kwargs }),
    });
    if (!r.ok) return { ok: false, exact: false, reason: `/apply-template returned ${r.status}; this server cannot be checked, so the transport stays off` };
    rendered = (await r.json()).prompt;
  } catch (err) {
    return { ok: false, exact: false, reason: `could not reach ${base}/apply-template: ${err.message}` };
  }

  if (rendered === prompt) {
    return { ok: true, exact: true, deltaTokens: 0, reason: "the server re-renders these messages byte-for-byte" };
  }

  // Not exact. Say precisely how far it gets before diverging, in tokens —
  // "a few characters" and "half the prompt re-tokenised" look identical in a
  // character diff and are not remotely the same problem.
  let detail = "";
  try {
    const [a, b] = await Promise.all([
      tokenCount(base, prompt, fetchImpl),
      tokenCount(base, rendered, fetchImpl),
    ]);
    let common = 0;
    while (common < Math.min(a.length, b.length) && a[common] === b[common]) common += 1;
    detail = `; ${a.length} tokens vs ${b.length} (${b.length - a.length >= 0 ? "+" : ""}${b.length - a.length}), identical for the first ${common} (${(100 * common / a.length).toFixed(1)}%)`;
    return {
      ok: false, exact: false, promptTokens: a.length, renderedTokens: b.length,
      commonPrefixTokens: common, deltaTokens: b.length - a.length,
      reason: `the server's re-render and BANTAM's prompt differ${detail}`,
    };
  } catch {
    return { ok: false, exact: false, reason: "the server's re-render and BANTAM's prompt differ" };
  }
}
