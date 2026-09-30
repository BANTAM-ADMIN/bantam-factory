// BANTAM's check of every draft: contradictions with the accepted canon and the
// book's rules, on the local model. It flags; the critic rules on each flag.
// A flag whose quote is not in the chapter is dropped by Book.recordCheck.

const SCHEMA = {
  type: "object", required: ["flags"],
  properties: { flags: { type: "array", items: { type: "object", required: ["against", "paragraph", "quote", "explanation"],
    properties: { against: { type: "string" }, paragraph: { type: "integer" }, quote: { type: "string" }, explanation: { type: "string" } } } } },
};

export function checkPrompt({ rules, canon, plan, paras }) {
  return [
    "CANON (facts established by accepted chapters):",
    ...(canon.length ? canon.map((c) => `${c.id}: ${c.fact}`) : ["(none yet)"]),
    "",
    "RULES (fixed for the whole book):",
    ...rules.map((r) => `${r.id}: ${r.text}`),
    "",
    `CHAPTER ${plan.n}: ${plan.title}`,
    ...paras.map((p, i) => `[${i + 1}] ${p}`),
    "",
    "List every place where the chapter contradicts a canon fact or breaks a rule. For each, give the id it goes against, the paragraph number, a verbatim quote of the offending words from that paragraph, and a one-sentence explanation. Do not flag style, taste or things the canon does not settle. If there are none, return an empty list.",
  ].join("\n");
}

/**
 * The local llama.cpp model through its OpenAI-compatible endpoint. A reasoning
 * model reasons before it answers: measured on a 930-word chapter with the
 * 27B, its server default (xhigh) used a 4000-token budget without answering,
 * "low" looped past 16000, "medium" answered in about 6000 tokens (97 s).
 */
export function llamaChecker({ endpoint = "http://127.0.0.1:8085", timeoutMs = 420_000, maxTokens = 16_000, reasoningEffort = "medium", fetchImpl = fetch } = {}) {
  return async (input, { signal = null } = {}) => {
    const started = Date.now();
    const res = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You check fiction chapters for continuity. You report only real contradictions with the given canon and rules, each backed by a verbatim quote." },
          { role: "user", content: checkPrompt(input) },
        ],
        temperature: 0.2, max_tokens: maxTokens,
        ...(reasoningEffort ? { chat_template_kwargs: { reasoning_effort: reasoningEffort } } : {}),
        response_format: { type: "json_schema", json_schema: { name: "check", schema: SCHEMA } },
      }),
    });
    if (!res.ok) throw new Error(`local model: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length" && !choice.message?.content?.trim()) {
      throw new Error(`the local model spent its ${maxTokens}-token budget reasoning and did not answer`);
    }
    let parsed;
    try { parsed = JSON.parse(choice?.message?.content ?? ""); }
    catch { throw new Error(`the local model's answer was not the JSON asked for: ${String(choice?.message?.content ?? "").slice(0, 120)}`); }
    return { status: "done", engine: "llama.cpp", ms: Date.now() - started, flags: Array.isArray(parsed.flags) ? parsed.flags : [] };
  };
}

/** Jev mode: one calibrated yes/no per canon fact and rule. No quotes; the critic reads the paragraph. */
export function jevChecker(decide) {
  return async ({ rules, canon, paras }) => {
    const started = Date.now();
    const items = [...canon.map((c) => ({ id: c.id, text: c.fact })), ...rules.map((r) => ({ id: r.id, text: r.text }))];
    if (!items.length) return { status: "done", engine: "jev", ms: 0, flags: [] };
    const state = paras.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
    const questions = Object.fromEntries(items.map((it) => [it.id, { type: "noul", instructions: `Does this chapter contradict or break the following: "${it.text}"?` }]));
    const out = await decide({ state, questions });
    const flags = items.filter((it) => out.answers[it.id]?.noul >= 0.5)
      .map((it) => ({ against: it.id, paragraph: null, quote: null, explanation: `Jev: P(contradiction) ${out.answers[it.id].noul.toFixed(2)} for "${it.text}"` }));
    return { status: "done", engine: "jev", ms: Date.now() - started, flags };
  };
}
