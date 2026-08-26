// Did the die actually bind?
//
// Codex's process passport records `dieRef` — WHICH die a station declared. D20
// showed that the removed vLLM `guided_*` fields are accepted and silently
// discarded: HTTP 200, no validation, no signal. Current `structured_outputs`
// and `response_format` reach xgrammar but crash HTTP 500 on the measured
// DiffusionGemma stack. So a passport recording `dieRef: guided_json`
// and treating the die as installed records a fiction, with a content hash and
// full provenance attached to it.
//
// This is the gauge for the missing field. Fable named it at 20:31Z, Opus-2
// specified the field at 02:09Z, and it needs a test that is DECISIVE rather
// than circumstantial.
//
// The circumstantial test is "did the emission come back fenced?" — that detects
// an envelope defect, and a die could be perfectly bound while the model wraps
// it, or unbound while the model happens to emit clean JSON. Fencing is evidence
// about habits, not about enforcement.
//
// The decisive test is to MAKE THE PROMPT AND THE DIE DISAGREE:
//
//   die permits    exactly one value, a sentinel the model has no reason to pick
//   prompt demands a different, obvious, plainly-stated answer
//
// If the sampler is enforcing, the die wins and the sentinel is the only thing
// that can be emitted — the model is not free to comply with the prompt. If the
// prompt wins, the constraint was never applied. Empty or malformed output is a
// third, explicitly non-qualifying reading: it does not establish enforcement.
// The no-die control must therefore qualify the exact prompt on the exact stack.
//
// AUTHORITY: none. It issues probe requests and reports; it installs nothing.

const SENTINEL = "status-599";
const DECOY = "status-401";

export const DIE_BINDING_SENTINEL = SENTINEL;
export const DIE_BINDING_DECOY = DECOY;

// Keep refusal separate from server failure. Neither is evidence that a die
// bound, but a 4xx says the request was refused while a 5xx says the serving
// path failed. Collapsing both into "constraint rejected" launders a crash.
export function classifyDieBindingHttpFailure(status) {
  if (!Number.isInteger(status) || status < 300 || status > 599) throw new TypeError("die-binding HTTP failure status must be an integer from 300 through 599");
  if (status >= 500) return Object.freeze({ transport: "server-error", verdict: "server-error" });
  if (status >= 400) return Object.freeze({ transport: "refused", verdict: "constraint-refused" });
  return Object.freeze({ transport: "unexpected-http-status", verdict: "transport-error" });
}

// The probe body. `constraint` names which mechanism is under test; the prompt is
// identical across all of them so the only thing varying is the constraint.
export function dieBindingRequest({ model, constraint }) {
  const messages = [{
    role: "user",
    // Deliberately unambiguous and easy. A model that is free to answer WILL
    // answer `alpha`; that is the point.
    // The canary rides on a REAL station prompt, not an imitation of one.
    // Measured on DiffusionGemma, 20 identical calls at temperature 0:
    //
    //   trivial one-liner      75% empty emissions
    //   mid-length two-line    55% empty
    //   this shape              0% empty  (20/20)
    //
    // A canary prompt must elicit a normal-length answer; only its constraint may
    // be short. A short-expected-answer probe puts DiffusionGemma in a measured
    // immediate-stop regime. Those empty emissions read as "neither present" —
    // indistinguishable from a stack that enforces nothing. The control must
    // qualify this exact prompt shape before any constrained row is interpreted.
    //
    // The die/prompt disagreement rides on top: the situation's correct answer
    // is the DECOY, and every die permits only the SENTINEL. If the sampler
    // enforces, it must emit the sentinel and cannot comply with the situation.
    content: [
      "You are choosing the single correct HTTP response status for one server situation.",
      "",
      "Catalog (choose exactly one id):",
      `  ${DECOY} — the caller is not authenticated`,
      `  ${SENTINEL} — never correct for any situation`,
      "  status-200 — the request succeeded and a body is returned",
      "  status-403 — the caller is authenticated but not permitted",
      "  status-404 — the addressed resource does not exist",
      "  status-409 — the request conflicts with the resource's current state",
      "  status-429 — the caller has exceeded a rate limit",
      "",
      "Situation:",
      "```",
      "A client calls GET /orders/17 with no Authorization header. The endpoint requires a bearer token.",
      "```",
      "",
      `Answer with exactly one catalog id and nothing else.`,
    ].join("\n"),
  }];
  // Budget and thinking are part of the probe, not incidental. On a
  // thinking-enabled worker a 24-token budget is consumed entirely by the
  // reasoning block and `content` comes back EMPTY — which reads as "neither
  // present" on every row and invalidates the whole table. The control caught
  // that; without it I would have reported a thinking-mode misconfiguration as a
  // stack-wide binding result.
  const body = {
    model, messages, temperature: 0,
    max_tokens: 400,
    chat_template_kwargs: { enable_thinking: false },
  };

  // Stack matters. `guided_*` are removed legacy vLLM parameters; current vLLM
  // uses `structured_outputs`, while llama.cpp uses `grammar` and
  // `response_format`. Feeding a stack the wrong parameter name produces EXACTLY
  // the same symptom as a stack that does not enforce — accepted, HTTP 200,
  // unconstrained output — which is why Fable's 20:31Z GBNF result read as
  // "silently ignored". It was, but by the wrong door. A binding gauge that is
  // not stack-aware cannot tell "this stack does not enforce" from "you asked it
  // in a dialect it does not speak."
  if (constraint === "grammar") body.grammar = `root ::= "${SENTINEL}"`;
  else if (constraint === "response_format_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: "canary", schema: { type: "object", properties: { answer: { type: "string", enum: [SENTINEL] } }, required: ["answer"], additionalProperties: false } } };
  }
  else if (constraint === "json_schema") body.json_schema = { type: "object", properties: { answer: { type: "string", enum: [SENTINEL] } }, required: ["answer"], additionalProperties: false };
  else if (constraint === "structured_choice") body.structured_outputs = { choice: [SENTINEL] };
  else if (constraint === "structured_regex") body.structured_outputs = { regex: SENTINEL };
  else if (constraint === "structured_grammar") body.structured_outputs = { grammar: `root ::= "${SENTINEL}"` };
  else if (constraint === "structured_json") {
    body.structured_outputs = { json: { type: "object", properties: { answer: { type: "string", enum: [SENTINEL] } }, required: ["answer"], additionalProperties: false } };
  }
  else if (constraint === "guided_choice") body.guided_choice = [SENTINEL];
  else if (constraint === "guided_regex") body.guided_regex = SENTINEL;
  else if (constraint === "guided_grammar") body.guided_grammar = `root ::= "${SENTINEL}"`;
  else if (constraint === "guided_json") {
    body.guided_json = { type: "object", properties: { answer: { type: "string", enum: [SENTINEL] } }, required: ["answer"], additionalProperties: false };
  } else if (constraint === "prefill") {
    // Not a sampler constraint at all — a fixture. Included because the branch's
    // poka-yoke work rests on it and it deserves the same decisive test.
    messages.push({ role: "assistant", content: SENTINEL.slice(0, 8) });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  } else if (constraint !== "none") {
    throw new Error(`unknown constraint: ${constraint}`);
  }
  return body;
}

// Read a probe response. `bound` is the only field that matters and it is
// deliberately conservative: anything that is not clearly the die winning counts
// as not bound.
export function readDieBinding({ constraint, content }) {
  const text = String(content ?? "");
  // Prefill has a dialect: vLLM returns the continuation only, llama.cpp echoes
  // the whole message. Reconstruct by prepending what the fixture supplied, so
  // both stacks read the same. This cannot invent a value the worker did not
  // write — it restores bytes the harness itself sent.
  const reconstructed = constraint === "prefill" ? `${SENTINEL.slice(0, 8)}${text}` : text;
  const mentionsSentinel = reconstructed.includes(SENTINEL) || text.includes(SENTINEL);
  // Ids contain hyphens, so a \b word-boundary match on `status-401` also fires
  // inside `status-4011`. Exact-token matching instead.
  const tokens = (constraint === "prefill" ? reconstructed : text).split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const mentionsDecoy = tokens.includes(DECOY);

  if (constraint === "none") {
    // The control. It SHOULD follow the prompt; if it does not, the probe itself
    // is broken and every other row is uninterpretable.
    return { bound: false, controlFollowedPrompt: mentionsDecoy, verdict: mentionsDecoy ? "control-ok" : "control-broken", content: text };
  }
  if (mentionsSentinel && !mentionsDecoy) return { bound: true, verdict: "die-won", content: text };
  if (mentionsDecoy && !mentionsSentinel) return { bound: false, verdict: "prompt-won-constraint-ignored", content: text };
  if (mentionsSentinel && mentionsDecoy) return { bound: false, verdict: "ambiguous-both-present", content: text };
  // A prefill that supplies a VALUE prefix rather than structural syntax can
  // produce neither answer: prefilled "status-5", the worker tried to write the
  // situation's correct id and emitted `status-501` — an id in no catalog. The
  // fixture constrains the opening, not the meaning, so when prefix and intent
  // disagree the product is CORRUPTED rather than either answer.
  //
  // The branch's actual jig prefills only `{"statusId":"` — structural syntax
  // with no value in it — which is why it is safe. Prefilling a value prefix is
  // a different and unsafe use of the same mechanism, and this row is what that
  // looks like.
  if (constraint === "prefill" && reconstructed !== text) {
    return { bound: false, verdict: "corrupted-hybrid", content: text, reconstructed };
  }
  // Every sampler die in this gauge permits exactly one literal. Once that
  // sentinel is absent, any non-empty output violates the die even when the
  // model mangles the prompt's decoy (`status401`, `-401`, and similar). Exact
  // prompt matching gives a useful specific verdict above; singleton membership
  // is the release-relevant invariant here.
  if (text.trim()) return { bound: false, verdict: "constraint-violating-output", content: text };
  return { bound: false, verdict: "neither-present", content: text };
}

// Summarise a set of probe readings into the passport field.
export function dieBindingVerdict(readings) {
  const constrained = readings.filter((row) => row.constraint !== "none");
  const controls = readings.filter((row) => row.constraint === "none");
  const byConstraint = new Map();
  for (const row of constrained) {
    if (!byConstraint.has(row.constraint)) byConstraint.set(row.constraint, []);
    byConstraint.get(row.constraint).push(row);
  }
  const mechanisms = [...byConstraint.entries()].map(([constraint, rows]) => ({
    constraint,
    trials: rows.length,
    bound: rows.filter((row) => row.bound).length,
    // A constraint that binds on some calls and not others is worse than one
    // that never binds, because a station would be qualified on the good ones.
    binding: rows.every((row) => row.bound) ? "bound" : (rows.some((row) => row.bound) ? "intermittent" : "not-bound"),
    verdicts: [...new Set(rows.map((row) => row.verdict))].sort(),
  })).sort((left, right) => left.constraint.localeCompare(right.constraint));

  return Object.freeze({
    schema: 1,
    kind: "bantam.factory-die-binding",
    // The passport field D20 makes necessary. `dieRef` says which die was
    // declared; this says whether declaring it did anything.
    dieBound: controls.some((row) => row.controlFollowedPrompt === true) && mechanisms.length > 0 && mechanisms.every((row) => row.binding === "bound"),
    anyBound: mechanisms.some((row) => row.binding !== "not-bound"),
    // A control that is itself stochastic must be MEASURED, not observed once.
    // Short-expected-answer prompts can collapse to an immediate stop on
    // DiffusionGemma, while the calibrated production-shaped control held 8/8.
    // The distribution therefore belongs in the evidence rather than being
    // replaced by a remembered universal threshold.
    // The probe is valid when the control demonstrably CAN follow the prompt;
    // its rate is reported so a degrading worker is visible.
    probeValid: controls.length > 0 && controls.some((row) => row.controlFollowedPrompt === true),
    controlPassRate: controls.length ? Number((controls.filter((row) => row.controlFollowedPrompt === true).length / controls.length).toFixed(4)) : 0,
    controlTrials: controls.length,
    mechanisms: Object.freeze(mechanisms.map((row) => Object.freeze(row))),
    note: "a die that does not bind is not installed, however faithfully its reference is recorded",
  });
}
