// System One: typed decisions read out of DiffusionGemma, not sampled from it.
//
// vLLM PR #57250 (merged 2026-09-22) lets a request seed DiffusionGemma's
// canvas with an answer template, leave only the label slot as noise, and run
// one read-only denoising pass. The slot's logprobs are then the answer: a
// distribution over the labels the station issued. Nothing is sampled, so the
// answer cannot leave the label set. That makes this the first die on this
// model that binds by construction; every sampler-side die measured by the
// die-binding gauge was ignored or refused.
//
// Binding is not calibration. A read renormalized over its labels always looks
// like a clean choice, even when most of the slot's mass sits on a token the
// station never offered. So every read reports `labelMass`, the absolute
// probability the model put on any issued label, and the renormalized
// distribution beside it. Neither number is authority: a read is an
// observation, and release still belongs to a gauge.
//
// Two ways to reach it:
//   createStructuredReader  native reads against the vLLM server; labels are
//                           BANTAM's own single-token handles
//   systemOneDecide         the Jev wire contract (POST /v1/systemone), so the
//                           same station can call OpenJev or TypeSafe's Jev
//
// AUTHORITY: none. It reads and reports.

import { formatCalcResults, runCalcSetup } from "./calc-gauge.js";
import { execGaugeChoice } from "./exec-gauge.js";
import { checkToolCalls, formatToolCallNotes } from "./tool-call-gauge.js";
import { palettePreferenceChoice } from "./preference-gauge.js";
import { derivedAfterChoice, entityTable, isChangeQuestion, noopChanges, parseChanges } from "./state-gauge.js";
import { claimCheckNote } from "./claim-gauge.js";
import { DIGEST_SYSTEM, digestNote, verifiedPoints, wantsDigest } from "./digest-station.js";

const TURN_CLOSE = 106;
const PAD = 0;
const CANVAS_STEP = 16;
const MAX_LABEL_IDS = 512;
const THOUGHT_SCAFFOLD = "<|channel>thought\n<channel|>";

/** Seeded uniform integer source, so a read's noise draw is replayable. */
export function seededNoise(seed) {
  let state = seed >>> 0;
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % bound);
  };
}

/**
 * Place a template on a read-only canvas. The canvas is the template, the
 * turn close, and padding to the next CANVAS_STEP; the slot holds a noise
 * token drawn from `seed`.
 */
export function buildReadCanvas({ templateIds, slot, seed, vocabularySize }) {
  if (!Array.isArray(templateIds) || !templateIds.length) throw new TypeError("read template must be a non-empty token array");
  if (!Number.isInteger(slot) || slot < 0 || slot >= templateIds.length) throw new TypeError("read slot must index the template");
  if (!Number.isInteger(vocabularySize) || vocabularySize < 2) throw new TypeError("vocabularySize must be an integer above 1");
  const width = Math.ceil((templateIds.length + 1) / CANVAS_STEP) * CANVAS_STEP;
  const canvas = [...templateIds, TURN_CLOSE];
  while (canvas.length < width) canvas.push(PAD);
  canvas[slot] = seededNoise(seed)(vocabularySize);
  return Object.freeze({ canvas: Object.freeze(canvas), width });
}

/**
 * Turn one slot's logprobs into a read. `logprobs` maps token id to logprob
 * as vLLM returned them at temperature 1, so exp() of each is an absolute
 * probability. A label vLLM did not return is bounded by the smallest
 * returned value rather than treated as impossible.
 */
export function readSlotDistribution({ logprobs, labels }) {
  const entries = Object.entries(logprobs ?? {}).map(([id, lp]) => [Number(id), Number(lp)]).filter(([, lp]) => Number.isFinite(lp));
  if (!entries.length) throw new Error("read returned no slot logprobs");
  const floor = Math.min(...entries.map(([, lp]) => lp));
  const byId = new Map(entries);
  const missing = [];
  const raw = labels.map((label) => {
    if (!byId.has(label.tokenId)) missing.push(label.label);
    return byId.get(label.tokenId) ?? floor;
  });
  const labelMass = Math.min(1, raw.reduce((total, lp) => total + Math.exp(lp), 0));
  const peak = Math.max(...raw);
  const scaled = raw.map((lp) => Math.exp(lp - peak));
  const total = scaled.reduce((sum, value) => sum + value, 0);
  const probabilities = scaled.map((value) => value / total);
  const order = probabilities.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
  const [top, second = [0]] = order;
  const [leader] = [...byId.entries()].sort((a, b) => b[1] - a[1]);
  return Object.freeze({
    choice: labels[top[1]].label,
    probability: top[0],
    margin: top[0] - second[0],
    probabilities: Object.freeze(Object.fromEntries(labels.map((label, i) => [label.label, probabilities[i]]))),
    labelMass,
    offLabelMass: 1 - labelMass,
    slotLeaderIsLabel: labels.some((label) => label.tokenId === leader[0]),
    missingLabels: Object.freeze(missing),
  });
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`), { status: response.status });
  return JSON.parse(text);
}

/**
 * Native structured reads against a DiffusionGemma vLLM server carrying
 * PR #57250. A label set is compiled once: every label must change exactly one
 * token of the answer template, at the same position, to a token no other
 * label uses. A set that fails that is refused, never approximated.
 */
export function createStructuredReader({ baseUrl, model, vocabularySize = 262144, maxModelLen = 16384, fetchImpl = fetch } = {}) {
  if (!baseUrl || !model) throw new TypeError("structured reader requires baseUrl and model");
  const root = baseUrl.replace(/\/+$/, "");
  const tokenCache = new Map();
  let head = null;

  async function tokenize(text) {
    if (!tokenCache.has(text)) {
      const result = await postJson(fetchImpl, `${root}/tokenize`, { model, prompt: text, add_special_tokens: false });
      tokenCache.set(text, Object.freeze(result.tokens.map(Number)));
    }
    return tokenCache.get(text);
  }

  // The canvas must start where the model's turn resumes. When the chat
  // template already closes an empty thought block (DiffusionGemma's does with
  // thinking disabled), repeating it on the canvas shifts the model's idea of
  // where the answer starts and pulls the slot's mass onto end-of-turn.
  async function canvasHead() {
    if (head) return head;
    const prompt = await postJson(fetchImpl, `${root}/tokenize`, {
      model,
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    const scaffold = await tokenize(THOUGHT_SCAFFOLD);
    const tail = prompt.tokens.slice(-scaffold.length).map(Number);
    head = Object.freeze({ tokens: tail.every((id, i) => id === scaffold[i]) ? Object.freeze([]) : scaffold, promptClosesThought: tail.every((id, i) => id === scaffold[i]) });
    return head;
  }

  async function compileLabels({ lead, tail = "", labels }) {
    if (!Array.isArray(labels) || labels.length < 2) throw new TypeError("a read needs at least two labels");
    if (labels.length > MAX_LABEL_IDS) throw new RangeError(`a read allows at most ${MAX_LABEL_IDS} labels`);
    if (new Set(labels).size !== labels.length) throw new Error("read labels must be unique");
    const { tokens: headTokens } = await canvasHead();
    const templates = await Promise.all(labels.map((label) => tokenize(`${lead}${label}${tail}`)));
    const base = templates[0];
    // The slot is where the labels' templates differ, not the lead's own
    // length: a lead ending in a space ("q1: ") tokenizes the space alone,
    // while "q1: yes" folds it into " yes".
    const slot = templates.slice(1).map((ids) => ids.findIndex((id, j) => id !== base[j])).find((index) => index >= 0) ?? -1;
    const compiled = labels.map((label, i) => {
      const ids = templates[i];
      const differs = slot < 0 || ids.length !== base.length || ids.some((id, j) => j !== slot && id !== base[j]);
      if (differs) throw new Error(`label ${JSON.stringify(label)} does not occupy one shared template slot`);
      return Object.freeze({ label, tokenId: ids[slot] });
    });
    if (new Set(compiled.map((row) => row.tokenId)).size !== compiled.length) throw new Error("read labels collide on a token");
    return Object.freeze({
      lead,
      tail,
      templateIds: Object.freeze([...headTokens, ...base]),
      slot: headTokens.length + slot,
      headLength: headTokens.length,
      labels: Object.freeze(compiled),
    });
  }

  /**
   * Several answer slots on one canvas: `leads` open each line ("q1: [",
   * "q2: [", ...), all sharing one label set. One request then carries several
   * differently framed questions over one prefill. Every label is checked at
   * every slot, since a newline before a lead can change how it tokenizes.
   */
  async function compileSlots({ leads, tail = "", separator = "\n", labels }) {
    if (!Array.isArray(leads) || leads.length < 1) throw new TypeError("compileSlots needs at least one lead");
    if (!Array.isArray(labels) || labels.length < 2) throw new TypeError("a read needs at least two labels");
    if (new Set(labels).size !== labels.length) throw new Error("read labels must be unique");
    const { tokens: headTokens } = await canvasHead();
    const text = (assign) => leads.map((lead, k) => `${lead}${assign[k]}${tail}`).join(separator);
    const base = await tokenize(text(leads.map(() => labels[0])));
    const slots = [];
    for (let k = 0; k < leads.length; k += 1) {
      const variants = await Promise.all(labels.map((label) => tokenize(text(leads.map((_, j) => (j === k ? label : labels[0]))))));
      const position = variants.slice(1).map((ids) => ids.findIndex((id, j) => id !== base[j])).find((index) => index >= 0) ?? -1;
      const tokenIds = variants.map((ids, i) => {
        if (position < 0 || ids.length !== base.length || ids.some((id, j) => j !== position && id !== base[j])) throw new Error(`label ${JSON.stringify(labels[i])} does not occupy one shared slot on line ${k + 1}`);
        return ids[position];
      });
      if (new Set(tokenIds).size !== tokenIds.length) throw new Error(`read labels collide on a token on line ${k + 1}`);
      slots.push(Object.freeze({ position: headTokens.length + position, labels: Object.freeze(labels.map((label, i) => Object.freeze({ label, tokenId: tokenIds[i] }))) }));
    }
    return Object.freeze({ templateIds: Object.freeze([...headTokens, ...base]), headLength: headTokens.length, slots: Object.freeze(slots) });
  }

  // One read-only pass over a canvas with any number of slots, either after a
  // chat prompt (`system`/`user`) or after explicit prompt token ids
  // (`prefixIds`, e.g. a prompt that already carries a thought).
  async function canvasRead({ system, user, prefixIds = null, templateIds, slots, seed = 0 }) {
    const width = Math.ceil((templateIds.length + 1) / CANVAS_STEP) * CANVAS_STEP;
    const canvas = [...templateIds, TURN_CLOSE];
    while (canvas.length < width) canvas.push(PAD);
    const noise = seededNoise(seed);
    for (const slot of slots) canvas[slot.position] = noise(vocabularySize);
    const labelIds = [...new Set(slots.flatMap((slot) => slot.labels.map((row) => row.tokenId)))];
    const xargs = { diffusion_seed_canvas: canvas, diffusion_canvas_length: width, diffusion_max_steps: 1, diffusion_read_only: true };
    const started = performance.now();
    let rows;
    let usage;
    if (prefixIds) {
      const envelope = await postJson(fetchImpl, `${root}/v1/completions`, { model, prompt: prefixIds, max_tokens: templateIds.length + 1, logprobs: 20, logprob_token_ids: labelIds, return_tokens_as_token_ids: true, vllm_xargs: xargs });
      rows = (envelope.choices?.[0]?.logprobs?.top_logprobs ?? []).map((row) => Object.fromEntries(Object.entries(row ?? {}).map(([token, lp]) => [Number(String(token).split(":")[1]), lp])));
      usage = envelope.usage;
    } else {
      const envelope = await postJson(fetchImpl, `${root}/v1/chat/completions`, {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: templateIds.length + 1,
        logprobs: true,
        top_logprobs: 20,
        logprob_token_ids: labelIds,
        return_tokens_as_token_ids: true,
        chat_template_kwargs: { enable_thinking: false },
        vllm_xargs: xargs,
      });
      rows = (envelope.choices?.[0]?.logprobs?.content ?? []).map((row) => Object.fromEntries((row?.top_logprobs ?? []).map((entry) => [Number(String(entry.token).split(":")[1]), entry.logprob])));
      usage = envelope.usage;
    }
    const elapsedMs = performance.now() - started;
    const reads = slots.map((slot) => {
      if (!rows[slot.position]) throw new Error("read returned no logprobs at a label slot");
      return readSlotDistribution({ logprobs: rows[slot.position], labels: slot.labels });
    });
    return Object.freeze({ reads: Object.freeze(reads), elapsedMs, promptTokens: usage?.prompt_tokens ?? 0 });
  }

  /** The multi-slot read over a chat prompt. */
  async function readSlots({ system, user, compiled, seed = 0 }) {
    return canvasRead({ system, user, templateIds: compiled.templateIds, slots: compiled.slots, seed });
  }

  /**
   * Let the model think before a read. Returns the prompt with thinking on,
   * the opened thought, the model's own tokens, and the closer, as token ids a
   * later read continues from (`readAfter`). `budget` caps the thought, and
   * the thought is also clamped to the room the context leaves after the
   * prompt (with space kept for the answer read), so a long budget on a long
   * prompt is cut off instead of failing.
   */
  async function think({ system, user, budget = 512 }) {
    const prompt = await postJson(fetchImpl, `${root}/tokenize`, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    const open = await tokenize("<|channel>thought\n");
    const close = await tokenize("<channel|>");
    const promptIds = [...prompt.tokens.map(Number), ...open];
    const room = maxModelLen - promptIds.length - THOUGHT_READ_RESERVE;
    const started = performance.now();
    const envelope = await postJson(fetchImpl, `${root}/v1/completions`, { model, prompt: promptIds, max_tokens: Math.max(1, Math.min(budget, room)), logprobs: 0, return_tokens_as_token_ids: true, stop_token_ids: [close[0]] });
    const elapsedMs = performance.now() - started;
    const choice = envelope.choices?.[0] ?? {};
    let ids = (choice.logprobs?.tokens ?? []).map((token) => Number(String(token).split(":")[1]));
    const cut = ids.indexOf(close[0]);
    if (cut >= 0) ids = ids.slice(0, cut);
    return Object.freeze({
      prefixIds: Object.freeze([...promptIds, ...ids, ...close]),
      thought: choice.text ?? "",
      thoughtTokens: ids.length,
      truncated: choice.finish_reason === "length",
      elapsedMs,
      promptTokens: envelope.usage?.prompt_tokens ?? promptIds.length,
    });
  }

  /**
   * Think and answer in ONE request: the model writes its thought, closes it
   * and writes `q1: [HANDLE]` itself; the handle's distribution is read from
   * the logprobs at the answer position of that same generation, so the
   * prompt is billed once rather than once for the thought and again for a
   * read. When the thought runs out of budget before an answer appears,
   * `answered` is false and the caller should fall back to `readAfter`.
   */
  async function thinkAnswer({ system, user, compiled, budget = 1024 }) {
    const prompt = await postJson(fetchImpl, `${root}/tokenize`, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    const open = await tokenize("<|channel>thought\n");
    const close = await tokenize("<channel|>");
    const promptIds = [...prompt.tokens.map(Number), ...open];
    const labelIds = compiled.labels.map((row) => row.tokenId);
    const started = performance.now();
    const envelope = await postJson(fetchImpl, `${root}/v1/completions`, {
      model, prompt: promptIds, max_tokens: budget + 24, logprobs: 20, logprob_token_ids: labelIds,
      return_tokens_as_token_ids: true, stop_token_ids: [TURN_CLOSE],
    });
    const elapsedMs = performance.now() - started;
    const choice = envelope.choices?.[0] ?? {};
    const ids = (choice.logprobs?.tokens ?? []).map((token) => Number(String(token).split(":")[1]));
    const tops = (choice.logprobs?.top_logprobs ?? []).map((row) => Object.fromEntries(Object.entries(row ?? {}).map(([token, lp]) => [Number(String(token).split(":")[1]), lp])));
    const closeAt = ids.indexOf(close[0]);
    const labelSet = new Set(labelIds);
    const answerAt = closeAt < 0 ? -1 : ids.findIndex((id, i) => i > closeAt && labelSet.has(id));
    let thoughtIds = closeAt < 0 ? ids : ids.slice(0, closeAt);
    const base = { thought: choice.text ?? "", thoughtTokens: thoughtIds.length, elapsedMs, promptTokens: envelope.usage?.prompt_tokens ?? promptIds.length, prefixIds: Object.freeze([...promptIds, ...thoughtIds, ...close]) };
    if (answerAt < 0 || !tops[answerAt]) return Object.freeze({ ...base, answered: false });
    return Object.freeze({ ...base, answered: true, ...readSlotDistribution({ logprobs: tops[answerAt], labels: compiled.labels }) });
  }

  /** Plain generation with thinking off, for setups a gauge will check. */
  async function complete({ system, user, maxTokens = 400 }) {
    const started = performance.now();
    const envelope = await postJson(fetchImpl, `${root}/v1/chat/completions`, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    });
    return Object.freeze({
      text: envelope.choices?.[0]?.message?.content ?? "",
      truncated: envelope.choices?.[0]?.finish_reason === "length",
      elapsedMs: performance.now() - started,
      promptTokens: envelope.usage?.prompt_tokens ?? 0,
      completionTokens: envelope.usage?.completion_tokens ?? 0,
    });
  }

  /**
   * A thought supplied from outside (another model's reasoning) placed in the
   * thought channel, as if this model had thought it. Returns prompt ids a
   * `readAfter` continues from. The borrowed-thought pilot found the read
   * follows a stated conclusion almost always (BORROWED_THOUGHT_EXPERIMENT.md).
   */
  async function borrowThought({ system, user, thought }) {
    const prompt = await postJson(fetchImpl, `${root}/tokenize`, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    const open = await tokenize("<|channel>thought\n");
    const close = await tokenize("<channel|>");
    const ids = await tokenize(String(thought));
    return Object.freeze({ prefixIds: Object.freeze([...prompt.tokens.map(Number), ...open, ...ids, ...close]), thoughtTokens: ids.length });
  }

  /** Read a compiled single-slot template after explicit prompt ids. */
  async function readAfter({ prefixIds, compiled, seed = 0 }) {
    const templateIds = compiled.templateIds.slice(compiled.headLength ?? 0);
    const position = compiled.slot - (compiled.headLength ?? 0);
    const result = await canvasRead({ prefixIds, templateIds, slots: [{ position, labels: compiled.labels }], seed });
    return Object.freeze({ ...result.reads[0], seed, elapsedMs: result.elapsedMs, promptTokens: result.promptTokens });
  }

  async function read({ system, user, compiled, seed = 0, head: headOverride = null }) {
    let { templateIds, slot } = compiled;
    if (headOverride) {
      // Diagnostic only: prepend an explicit canvas head, e.g. to measure a
      // client that repeats the thought scaffold the prompt already closed.
      const extra = await tokenize(headOverride);
      templateIds = [...extra, ...templateIds];
      slot += extra.length;
    }
    const { canvas, width } = buildReadCanvas({ templateIds, slot, seed, vocabularySize });
    const labelIds = compiled.labels.map((row) => row.tokenId);
    const started = performance.now();
    const envelope = await postJson(fetchImpl, `${root}/v1/chat/completions`, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: templateIds.length + 1,
      logprobs: true,
      top_logprobs: 20,
      logprob_token_ids: labelIds,
      return_tokens_as_token_ids: true,
      chat_template_kwargs: { enable_thinking: false },
      vllm_xargs: { diffusion_seed_canvas: canvas, diffusion_canvas_length: width, diffusion_max_steps: 1, diffusion_read_only: true },
    });
    const elapsedMs = performance.now() - started;
    const rows = envelope.choices?.[0]?.logprobs?.content;
    if (!Array.isArray(rows) || !rows[slot]) throw new Error("read returned no logprobs at the label slot");
    const logprobs = Object.fromEntries(rows[slot].top_logprobs.map((row) => [Number(String(row.token).split(":")[1]), row.logprob]));
    return Object.freeze({
      ...readSlotDistribution({ logprobs, labels: compiled.labels }),
      seed,
      elapsedMs,
      promptTokens: envelope.usage?.prompt_tokens ?? 0,
    });
  }

  return Object.freeze({ tokenize, canvasHead, compileLabels, compileSlots, read, readSlots, think, thinkAnswer, borrowThought, readAfter, complete });
}

/**
 * A read's labels must each be one token in the answer template, so arbitrary
 * options cannot be labels themselves. Instead of mapping options to letters
 * (which makes the model translate an option into a symbol it never saw in
 * the material), each option gets a short handle that IS one token, and the
 * material shows `[HANDLE] option text`. The model points at a handle it can
 * see; the station maps the handle back to the option.
 *
 * The pool is compiled against the live tokenizer: every candidate is kept
 * only if it occupies exactly one slot of the bracket template and no other
 * handle shares its token.
 */
export async function compileHandlePool(reader, { size = 256, lead = "q1: [", tail = "]" } = {}) {
  if (!Number.isInteger(size) || size < 2 || size > MAX_LABEL_IDS) throw new RangeError(`handle pool size must be 2..${MAX_LABEL_IDS}`);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const candidates = [];
  for (const a of letters) for (const b of letters) candidates.push(`${a}${b}`);
  for (const a of letters) for (const b of letters) for (const c of letters) candidates.push(`${a}${b}${c}`);
  const leadIds = await reader.tokenize(lead);
  const tailIds = await reader.tokenize(tail);
  const pool = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length && pool.length < size; i += 32) {
    const batch = candidates.slice(i, i + 32);
    const tokenized = await Promise.all(batch.map((handle) => reader.tokenize(`${lead}${handle}${tail}`)));
    batch.forEach((handle, j) => {
      const ids = tokenized[j];
      const fits = ids.length === leadIds.length + 1 + tailIds.length
        && leadIds.every((id, k) => ids[k] === id)
        && tailIds.every((id, k) => ids[leadIds.length + 1 + k] === id);
      const tokenId = ids[leadIds.length];
      if (fits && !seen.has(tokenId) && pool.length < size) {
        seen.add(tokenId);
        pool.push(Object.freeze({ handle, tokenId }));
      }
    });
  }
  if (pool.length < size) throw new Error(`tokenizer yielded only ${pool.length} single-token handles; asked for ${size}`);
  return Object.freeze(pool);
}

/**
 * Put arbitrary options on a rack. Handles are drawn from the pool in an
 * order fixed by `seed`, so a redundant rack can reuse the same options under
 * different handles and positions.
 */
export function rackOptions(pool, options, { seed = 0, shuffle = true } = {}) {
  if (!Array.isArray(options) || options.length < 2) throw new TypeError("a rack needs at least two options");
  if (options.length > pool.length) throw new RangeError(`${options.length} options exceed the ${pool.length}-handle pool`);
  const draw = seededNoise(seed);
  const handles = [...pool];
  for (let i = handles.length - 1; i > 0; i -= 1) {
    const j = draw(i + 1);
    [handles[i], handles[j]] = [handles[j], handles[i]];
  }
  const order = options.map((_, i) => i);
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = draw(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const rows = order.map((optionIndex, position) => Object.freeze({ handle: handles[position].handle, option: options[optionIndex], optionIndex }));
  return Object.freeze({
    rows: Object.freeze(rows),
    labels: Object.freeze(rows.map((row) => row.handle)),
    material: rows.map((row) => `[${row.handle}] ${typeof row.option === "string" ? row.option : JSON.stringify(row.option)}`).join("\n"),
    optionOf: (handle) => rows.find((row) => row.handle === handle)?.option,
  });
}

// Each rack asks the same question in a different way, so a slip tied to one
// framing does not repeat on every rack.
const RACK_ASKS = Object.freeze([
  "Which ONE bracketed handle answers the question?",
  "Pick the ONE bracketed option that is correct for the material above.",
  "Considering only the material above, which ONE bracketed handle is right?",
  "Which ONE bracketed option does the material support?",
]);

function textOf(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : JSON.stringify(value);
}

// Option keys that carry no meaning of their own: letters, option_N and hash
// ids. Shown in front of the option text they bias the reads toward a label
// (on the Decision Index sample the model picked "A" 42 times where 30 were
// right on cfcolor and 30 where 18 were right on VAST), the letter-label
// weakness the handles exist to remove.
const LABEL_KEY = /^(?:[A-Z]|(?:option|text|choice|candidate)_\d+|k_[0-9a-f]{6,})$/;

/**
 * Whether a question's option keys can be hidden: every key is a bare label
 * with a description, and the question does not refer to the keys (BBH's
 * "(A)", "option A", "option_1").
 */
function hideableKeys(question) {
  const keys = Object.keys(question.criteria ?? {});
  if (!keys.length || !keys.every((key) => LABEL_KEY.test(key) && textOf(question.criteria[key]))) return false;
  const text = textOf(question.instructions);
  return !keys.some((key) => new RegExp(`\\(${key}\\)|\\b(?:option|answer|choice)\\s+${key}\\b|\\b${key}[):.]`, "i").test(text) || (key.length > 1 && text.includes(key)));
}

// Stance options given as bare words. Read bare, the model scores a text's
// overall tone rather than its position on the topic asked about, and almost
// never picks "neutral" when the text is simply about something else (VAST:
// neutral chosen on 2 of 58 questions where 20 were neutral, every one of
// those 20 a post that never discusses its topic).
const STANCE_MEANING = {
  favor: "the text argues for or supports the topic itself",
  favour: "the text argues for or supports the topic itself",
  support: "the text argues for or supports the topic itself",
  pro: "the text argues for or supports the topic itself",
  against: "the text argues against or opposes the topic itself",
  oppose: "the text argues against or opposes the topic itself",
  con: "the text argues against or opposes the topic itself",
  neutral: "the text takes no position on the topic itself, including when it does not discuss the topic at all",
  none: "the text takes no position on the topic itself, including when it does not discuss the topic at all",
};

function stanceOptions(question) {
  const bare = Object.values(question.criteria ?? {}).map((d) => textOf(d).trim().toLowerCase());
  return bare.length >= 2 && bare.every((word) => word in STANCE_MEANING) && bare.some((w) => STANCE_MEANING[w].includes("no position"));
}

function jevOptions(question, { hideKeys = false, stanceFraming = false } = {}) {
  if (question.type === "noul") {
    const criteria = question.criteria ?? {};
    return [
      { key: "yes", text: textOf(criteria.true) ? `yes: ${textOf(criteria.true)}` : "yes" },
      { key: "no", text: textOf(criteria.false) ? `no: ${textOf(criteria.false)}` : "no" },
    ];
  }
  if (question.type === "choice") {
    if (stanceFraming && stanceOptions(question)) {
      return Object.entries(question.criteria).map(([key, description]) => {
        const word = textOf(description).trim().toLowerCase();
        return { key, text: `${word}: ${STANCE_MEANING[word]}` };
      });
    }
    const bare = hideKeys && hideableKeys(question);
    return Object.entries(question.criteria ?? {}).map(([key, description]) => ({ key, text: bare ? textOf(description) : textOf(description) ? `${key}: ${textOf(description)}` : key }));
  }
  if (question.type === "score") {
    return (question.criteria ?? []).map((level, i) => ({ key: String(i), text: `level ${i}: ${textOf(level)}` }));
  }
  throw new TypeError(`unknown question type ${question.type}`);
}

/**
 * Answer Jev-shaped questions with BANTAM's reads: every option on each rack
 * under its own one-token handle, the state ahead of the question so racks
 * share the cached prefix, and `racks` differently ordered and differently
 * worded racks averaged into one distribution. Returns Jev answer shapes plus
 * the per-rack reads as evidence.
 */
export async function decideJev({ reader, pool, state, questions, racks = 3, seed = 0, noulLabels = "handles" }) {
  if (!["handles", "words"].includes(noulLabels)) throw new TypeError("noulLabels must be handles or words");
  if (!Number.isInteger(racks) || racks < 1 || racks > RACK_ASKS.length) throw new RangeError(`racks must be 1..${RACK_ASKS.length}`);
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  const answers = {};
  const evidence = {};
  for (const [id, question] of Object.entries(questions)) {
    const options = jevOptions(question);
    if (options.length === 1) {
      answers[id] = jevAnswer(question, options, [1]);
      evidence[id] = [];
      continue;
    }
    const totals = options.map(() => 0);
    const reads = [];
    // Yes and no are already the model's own answer words; reading them
    // directly skips the handle translation step. Exploratory: chosen after
    // seeing JevBench's public items, so it needs held-out confirmation.
    if (question.type === "noul" && noulLabels === "words") {
      const compiled = await reader.compileLabels({ lead: "q1: ", labels: ["yes", "no"] });
      for (let r = 0; r < racks; r += 1) {
        const listed = r % 2 === 0 ? options : [...options].reverse();
        const user = `${stateText}\n\n---\nQUESTION: ${textOf(question.instructions) || "Answer about the state."}\n${listed.map((option) => option.text).join("\n")}\n\nq1: ${RACK_ASKS[r].replace(/ONE bracketed (handle|option)/, "yes or no")}`;
        const read = await reader.read({ system: "Answer one yes-or-no question about the material. Reply exactly as: q1: yes or q1: no", user, compiled, seed: seed + r });
        totals[0] += read.probabilities.yes / racks;
        totals[1] += read.probabilities.no / racks;
        reads.push({ choice: read.choice, probability: read.probability, labelMass: read.labelMass, elapsedMs: read.elapsedMs, promptTokens: read.promptTokens });
      }
      answers[id] = jevAnswer(question, options, totals);
      evidence[id] = reads;
      continue;
    }
    for (let r = 0; r < racks; r += 1) {
      const rack = rackOptions(pool, options.map((option) => option.text), { seed: seed + r * 7919 + 1 });
      const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
      const user = `${stateText}\n\n---\nQUESTION: ${textOf(question.instructions) || "Answer about the state."}\nOPTIONS:\n${rack.material}\n\nq1: ${RACK_ASKS[r]}`;
      const read = await reader.read({ system: "Answer one multiple-choice question about the material. Reply exactly as: q1: [HANDLE]", user, compiled, seed: seed + r });
      rack.rows.forEach((row) => { totals[row.optionIndex] += read.probabilities[row.handle] / racks; });
      reads.push({ choice: options[rack.rows.find((row) => row.handle === read.choice).optionIndex].key, probability: read.probability, labelMass: read.labelMass, elapsedMs: read.elapsedMs, promptTokens: read.promptTokens });
    }
    answers[id] = jevAnswer(question, options, totals);
    evidence[id] = reads;
  }
  // Every read re-sends the state, so billed input is the sum over reads,
  // even where the server's prefix cache made the repeat cheap to serve.
  const inputTokens = Object.values(evidence).flat().reduce((total, read) => total + (read.promptTokens ?? 0), 0);
  return Object.freeze({ answers, evidence, usage: Object.freeze({ inputTokens }) });
}

function jevAnswer(question, options, probabilities) {
  const peak = probabilities.indexOf(Math.max(...probabilities));
  const k = probabilities.length;
  const entropy = -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
  const confidence = k > 1 ? Math.max(0, Math.min(1, 1 - entropy / Math.log(k))) : 1;
  const byKey = Object.fromEntries(options.map((option, i) => [option.key, probabilities[i]]));
  if (question.type === "noul") return { type: "noul", noul: byKey.yes };
  if (question.type === "choice") return { type: "choice", choice: options[peak].key, probabilities: byKey, confidence };
  return {
    type: "score",
    score: probabilities.reduce((sum, p, i) => sum + i * p, 0),
    legend: Object.fromEntries(options.map((option, i) => [String(i), textOf(question.criteria[i])])),
    probabilities: byKey,
    confidence,
  };
}

// Context kept free after a thought for the closer and the answer read.
const THOUGHT_READ_RESERVE = 256;
const DEEP_FAST = "Answer one multiple-choice question about the material. Reply exactly as: q1: [HANDLE]";
const DEEP_THINK = "Answer one multiple-choice question about the material. Work through the relevant facts and any arithmetic carefully, then reply exactly as: q1: [HANDLE]";
const ROW_THINK = "Answer several multiple-choice questions about the same material. Think through the situation once: what is being asked, which facts decide it, and what follows from it for every question. Do not restate the material or the options; refer to them by name. Then reply with one line per question, exactly as: q1: [HANDLE]";
// Measured on the Decision Index sample: thoughts that ran out of budget added
// nothing (fast read 122 right vs 119 after the thought, n=337) because the
// model spent its budget copying the material. The concise style asks it not to.
const DEEP_THINK_CONCISE = "Answer one multiple-choice question about the material. Think briefly. Do not restate or copy the material, the question or the options; refer to them by name. Work only through the facts and arithmetic that decide the answer, in as few steps as you can, then reply exactly as: q1: [HANDLE]";
const DEEP_CALC = "You set up calculations; a calculator will compute them exactly. Do NOT restate the material and do NOT answer the question. Write only the lines needed to decide it, one per line, as name = expression. Use numbers copied exactly from the material, + - * / ( ), earlier names, min(), max(), round(x, digits), days(\"YYYY-MM-DD\", \"YYYY-MM-DD\") for whole days between two dates, and hours(\"YYYY-MM-DDTHH:MM+HH:MM\", \"YYYY-MM-DDTHH:MM+HH:MM\") for elapsed hours using each time's UTC offset (account for daylight-saving changes). Give every quantity a clear name. If the decision needs no calculation, write NONE.";
const DEEP_DUEL = "Exactly one of the two options is correct. Find the specific fact, rule or calculation in the material that decides between them, check it, then reply exactly as: q1: [HANDLE]";

function normalizeProbs(values) {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  return values.map((value) => value / total);
}
const argmaxIndex = (values) => values.reduce((best, value, i) => (value > values[best] ? i : best), 0);

/**
 * The think profile: one rack, one thought, then a read-only read of the
 * handle distribution after it. On the private holdout this beat the
 * calculator and arbitration variants (105/109 vs 102) at a third of their
 * billed input.
 */
export async function decideJevThink({ reader, pool, state, questions, seed = 0, thinkBudget = 1024 }) {
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  const answers = {};
  const evidence = {};
  let inputTokens = 0;
  for (const [id, question] of Object.entries(questions)) {
    const options = jevOptions(question);
    if (options.length === 1) { answers[id] = jevAnswer(question, options, [1]); evidence[id] = []; continue; }
    const rack = rackOptions(pool, options.map((option) => option.text), { seed: seed + 1 });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
    const user = `${stateText}\n\n---\nQUESTION: ${textOf(question.instructions) || "Answer about the state."}\nOPTIONS:\n${rack.material}\n\nq1: ${RACK_ASKS[0]}`;
    // Think, then a read-only read after the thought. Reading the answer inside
    // the generation (thinkAnswer) saves a request but measured ~3 items worse
    // on dev and no faster, since it asks for logprobs at every thought token.
    const t = await reader.think({ system: DEEP_THINK, user, budget: thinkBudget });
    const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
    inputTokens += t.promptTokens + read.promptTokens;
    const probabilities = options.map(() => 0);
    rack.rows.forEach((row) => { probabilities[row.optionIndex] = read.probabilities[row.handle]; });
    answers[id] = jevAnswer(question, options, normalizeProbs(probabilities));
    evidence[id] = [{ step: "think", thoughtTokens: t.thoughtTokens, truncated: t.truncated, labelMass: read.labelMass }];
  }
  return Object.freeze({ answers, evidence, usage: Object.freeze({ inputTokens }) });
}

// A select-all group: at least three yes/no questions in one row whose
// instructions share a stem and differ only in what is being judged (the
// candidate). Returns { ids, stem, candidates } or null. Triggered by the
// shape of the questions, never by a benchmark's name.
export function selectAllGroup(questions) {
  const entries = Object.entries(questions).filter(([, q]) => {
    const options = jevOptions(q);
    return options.length === 2 && options.some((o) => o.key === "yes") && options.some((o) => o.key === "no");
  });
  if (entries.length < 3 || entries.length !== Object.keys(questions).length) return null;
  const texts = entries.map(([, q]) => textOf(q.instructions));
  let stem = texts[0];
  for (const t of texts.slice(1)) {
    let i = 0;
    while (i < stem.length && i < t.length && stem[i] === t[i]) i += 1;
    stem = stem.slice(0, i);
  }
  const cut = Math.max(stem.lastIndexOf("\n"), stem.lastIndexOf(": "));
  if (cut > 0) stem = stem.slice(0, cut + 1);
  if (stem.trim().length < 20 || stem.length < 0.5 * Math.min(...texts.map((t) => t.length))) return null;
  const candidates = texts.map((t) => t.slice(stem.length).trim());
  if (new Set(candidates).size !== candidates.length || candidates.some((c) => !c)) return null;
  return { ids: entries.map(([id]) => id), stem: stem.trim(), candidates };
}

// Soften (T > 1) or sharpen (T < 1) a distribution: p' ∝ p^(1/T).
export function temperProbs(probabilities, temperature = 1) {
  if (temperature === 1) return probabilities;
  return normalizeProbs(probabilities.map((p) => Math.max(p, 1e-12) ** (1 / temperature)));
}

// Material that carries several numbers, percentages, probabilities, amounts
// or dates, where a single read is most likely to slip on arithmetic.
export function isQuantitative(text) {
  const hits = String(text).match(/\d+(?:[.,]\d+)?\s*%|\b0?\.\d+\b|[$€£]\s?\d|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\s*(?:percent|probability)/gi) ?? [];
  return hits.length >= 2;
}

/**
 * The adaptive profile. With `evidenceFirst`, a row that pairs several yes/no
 * checks about the material with judgment questions (an email's warning
 * signs and "is it phishing?") answers the checks first and gives the
 * judgments those answers as a checklist: answered one at a time, the model
 * said yes to four warning signs and "legitimate" in the same row.
 */
export async function decideJevAdaptive(args) {
  const { questions, evidenceFirst = false } = args;
  const checkIds = Object.keys(questions).filter((id) => questions[id].type === "noul");
  const judgmentIds = Object.keys(questions).filter((id) => questions[id].type !== "noul");
  if (!evidenceFirst || checkIds.length < 3 || !judgmentIds.length) return decideJevAdaptiveCore(args);
  const pick = (ids) => Object.fromEntries(ids.map((id) => [id, questions[id]]));
  const checks = await decideJevAdaptiveCore({ ...args, questions: pick(checkIds) });
  const checklist = checkIds.map((id) => `- ${textOf(questions[id].instructions) || id}: ${checks.answers[id].noul >= 0.5 ? "yes" : "no"}`);
  const judged = await decideJevAdaptiveCore({ ...args, questions: pick(judgmentIds), extraNotes: [...(args.extraNotes ?? []), `CHECKLIST (each check answered from the material above):\n${checklist.join("\n")}`] });
  return Object.freeze({
    answers: { ...checks.answers, ...judged.answers },
    evidence: { ...checks.evidence, ...judged.evidence },
    usage: Object.freeze({ inputTokens: checks.usage.inputTokens + judged.usage.inputTokens }),
  });
}

/**
 * The adaptive profile: every question gets one fast read; only a question
 * whose top probability is under `gate` gets a thought. Options, all off by
 * default:
 *   binaryDebias  two-option questions are read in both option orders and
 *                 averaged, removing a fixed position bias
 *   quantGate     a quantitative QUESTION (see isQuantitative) always gets the
 *                 calculator gauge and a thought, however confident the fast
 *                 read was: a confident arithmetic slip never trips the gate
 *   temperature   calibration applied to every final distribution
 *   debiasGate    "disagree": a debiased yes/no question thinks only when its
 *                 two orders pick different answers (or the average is near a
 *                 coin flip), not whenever averaging lowered its confidence
 *   thinkStyle    "concise": the thought is told not to restate the material
 *   jointSelect   select-all groups (see selectAllGroup) are decided jointly:
 *                 fast reads per candidate, one count read, top-k are yes
 */
async function decideJevAdaptiveCore({ reader, pool, state, questions, seed = 0, gate = 0.95, thinkBudget = 1024, binaryDebias = false, quantGate = false, temperature = 1, jointSelect = false, heavyQuestionLimit = 4, debiasGate = "confidence", thinkStyle = "full", truncatedThought = "read", rowThinkLimit = Infinity, execCell = null, toolGauge = false, rowThought = false, rowThoughtMin = 5, rowThoughtMaxChars = 36000, estimateBlend = null, thinkBlend = 1, hideKeys = false, preferenceGauge = false, stateGauge = false, evidenceFirst = false, extraNotes = [], claimGauge = false, thinkMinOptions = Infinity, selectAllFraming = false, stanceFraming = false, digestFirst = false, borrowedThought = null }) {
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  const answers = {};
  const evidence = {};
  let inputTokens = 0;
  const group = jointSelect ? selectAllGroup(questions) : null;
  // Per-row compute budget: the heavy quantitative path is for rows with a few
  // questions. Rows of many questions (retrieval rankings of 32 candidates)
  // stay on fast reads; their numbers are content, and time adds up per row.
  const fewQuestions = Object.keys(questions).length <= heavyQuestionLimit;
  const thinkSystem = thinkStyle === "concise" ? DEEP_THINK_CONCISE : DEEP_THINK;
  if (group) {
    // One fast read per candidate (shared cached prefix), one read of how many
    // candidates are right, then the top-k by fast-read probability are "yes".
    const pYes = [];
    for (const [i, id] of group.ids.entries()) {
      const options = jevOptions(questions[id]);
      const rack = rackOptions(pool, options.map((o) => o.text), { seed: seed + 1 });
      const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
      const user = `${stateText}\n\n---\nQUESTION: ${textOf(questions[id].instructions)}\nOPTIONS:\n${rack.material}\n\nq1: ${RACK_ASKS[0]}`;
      const read = await reader.read({ system: DEEP_FAST, user, compiled, seed: seed + i });
      inputTokens += read.promptTokens;
      const yesRow = rack.rows.find((row) => options[row.optionIndex].key === "yes");
      pYes.push(read.probabilities[yesRow.handle]);
    }
    const countOptions = Array.from({ length: group.ids.length + 1 }, (_, k) => `exactly ${k} of the candidates`);
    const countRack = rackOptions(pool, countOptions, { seed: seed + 3, shuffle: false });
    const countCompiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: countRack.labels });
    const list = group.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const countUser = `${stateText}\n\n---\nQUESTION: ${group.stem}\nCANDIDATES:\n${list}\n\nHow many of the candidates above are correct?\nOPTIONS:\n${countRack.material}\n\nq1: ${RACK_ASKS[0]}`;
    const countRead = await reader.read({ system: DEEP_FAST, user: countUser, compiled: countCompiled, seed: seed + 5 });
    inputTokens += countRead.promptTokens;
    const kProbs = countRack.rows.map((row) => [row.optionIndex, countRead.probabilities[row.handle]]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    const k = argmaxIndex(kProbs);
    const order = pYes.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const chosen = new Set(order.slice(0, k));
    group.ids.forEach((id, i) => {
      const options = jevOptions(questions[id]);
      const yes = chosen.has(i) ? Math.max(pYes[i], 0.51) : Math.min(pYes[i], 0.49);
      const probs = options.map((o) => (o.key === "yes" ? yes : 1 - yes));
      answers[id] = jevAnswer(questions[id], options, temperProbs(probs, temperature));
      evidence[id] = [{ step: "joint-select", pYes: pYes[i], count: k, chosen: chosen.has(i) }];
    });
    return Object.freeze({ answers, evidence, usage: Object.freeze({ inputTokens }) });
  }
  const pending = [];
  const entities = stateGauge ? entityTable(state) : null;
  // Select-all framing: candidates judged one at a time read each as if it
  // had to be THE answer, and missed correct ones (70 missed vs 25 wrongly
  // accepted on SATA-Bench). Every candidate's read is told it is one of
  // several, more than one may be right, and sees the whole list.
  const selectAll = selectAllFraming ? selectAllGroup(questions) : null;
  const selectAllNote = selectAll
    ? `CANDIDATES (${selectAll.candidates.length} candidates are offered for the same question; more than one of them may be correct, so accept every candidate that is correct, not only the best one):\n${selectAll.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : null;
  const claimNote = claimGauge ? claimCheckNote(state) : null;
  // Digest station: one read of the text before a family of candidates is
  // judged against it; only points whose quote is really in the text are kept.
  let digest = null;
  if (digestFirst && wantsDigest(stateText, questions)) {
    const made = await reader.complete({ system: DIGEST_SYSTEM, user: stateText, maxTokens: 400 });
    inputTokens += made.promptTokens;
    digest = digestNote(verifiedPoints(made.text, stateText));
  }
  for (const [id, question] of Object.entries(questions)) {
    const options = jevOptions(question, { hideKeys, stanceFraming });
    if (options.length === 1) { answers[id] = jevAnswer(question, options, [1]); evidence[id] = []; continue; }
    // Execution gauge: a function and its call arguments in the material are
    // run, not simulated; exactly one candidate equal to the value releases it.
    if (execCell && question.type === "choice") {
      const gauge = await execGaugeChoice(execCell, state, options.map((option) => textOf(question.criteria[option.key])));
      if (gauge.index >= 0) {
        answers[id] = jevAnswer(question, options, options.map((_, i) => (i === gauge.index ? 0.98 : 0.02 / (options.length - 1))));
        evidence[id] = [{ step: "exec", value: gauge.result.value }];
        continue;
      }
    }
    // Preference gauge: a rated palette history in the material is fitted
    // five ways; when all five agree which new palette the user prefers, that
    // answer is released (the model is at chance on color math).
    if (preferenceGauge) {
      const gauge = palettePreferenceChoice(state, question);
      if (gauge.key) {
        answers[id] = jevAnswer(question, options, options.map((option) => (option.key === gauge.key ? 0.9 : 0.1 / (options.length - 1))));
        evidence[id] = [{ step: "preference", scores: gauge.scores }];
        continue;
      }
    }
    const instructions = textOf(question.instructions) || "Answer about the state.";
    const rack = rackOptions(pool, options.map((option) => option.text), { seed: seed + 1 });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
    const userFor = (r, material) => `${material}\n\n---\nQUESTION: ${instructions}\nOPTIONS:\n${r.material}\n\nq1: ${RACK_ASKS[0]}`;
    // Tool-call gauge: exact findings join the material (after the state, so
    // the cached prefix is kept); calls that cannot be right are ruled out.
    const toolCheck = toolGauge ? checkToolCalls(state, question) : null;
    // State gauge: an option whose "change" sets a listed property to the
    // value it already has changes nothing, so it cannot be the outcome.
    const noops = stateGauge && isChangeQuestion(question) ? noopChanges(entities, question) : [];
    const notes = [
      ...extraNotes,
      ...(digest ? [digest] : []),
      ...(claimNote ? [claimNote] : []),
      ...(selectAllNote && selectAll.ids.includes(id) ? [selectAllNote] : []),
      ...(toolCheck ? [formatToolCallNotes(toolCheck.notes)] : []),
      ...(noops.length ? [`STATE CHECK (exact, against the listed state):\n${noops.map(({ note }) => `- ${note}`).join("\n")}`] : []),
    ];
    const material = notes.length ? `${stateText}\n\n${notes.join("\n\n")}` : stateText;
    const ruled = new Set([...(toolCheck?.ruledOut ?? []), ...noops.map(({ key }) => key)]);
    const ruleOut = (values) => {
      if (!ruled.size) return values;
      const kept = values.map((p, i) => (ruled.has(options[i].key) ? 0 : p));
      return kept.some((p) => p > 0) ? normalizeProbs(kept) : values;
    };
    const toOptions = (r, read) => {
      const out = options.map(() => 0);
      r.rows.forEach((row) => { out[row.optionIndex] = read.probabilities[row.handle]; });
      return ruleOut(normalizeProbs(out));
    };
    const fast = await reader.read({ system: DEEP_FAST, user: userFor(rack, material), compiled, seed });
    inputTokens += fast.promptTokens;
    let probabilities = toOptions(rack, fast);
    let firstOrder = null;
    let secondOrder = null;
    if (binaryDebias && options.length === 2) {
      // The second read shows the two options in the reverse of the order the
      // first read showed. (Fixing it as [options[1], options[0]] repeated the
      // first read's order whenever its shuffle had already put option 1 first,
      // about half of all questions, so position bias went unseen there.)
      const order = [rack.rows[1].optionIndex, rack.rows[0].optionIndex];
      const flipped = rackOptions(pool, order.map((i) => options[i].text), { seed: seed + 2, shuffle: false });
      const flippedCompiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: flipped.labels });
      const second = await reader.read({ system: DEEP_FAST, user: userFor(flipped, material), compiled: flippedCompiled, seed: seed + 1 });
      inputTokens += second.promptTokens;
      const other = options.map(() => 0);
      flipped.rows.forEach((row) => { other[order[row.optionIndex]] = second.probabilities[row.handle]; });
      firstOrder = probabilities;
      secondOrder = normalizeProbs(other);
      probabilities = ruleOut(normalizeProbs(probabilities.map((p, i) => (p + other[i]) / 2)));
    }
    // Keep the fast distribution so a lower gate can be replayed offline.
    const byKey = (values) => Object.fromEntries(options.map((option, i) => [option.key, values[i]]));
    const steps = [{ step: "fast", probability: Math.max(...probabilities), probabilities: byKey(probabilities), ...(firstOrder ? { orders: [byKey(firstOrder), byKey(secondOrder)], ordersAgree: argmaxIndex(firstOrder) === argmaxIndex(secondOrder) } : {}) }];
    if (toolCheck) steps.push({ step: "toolcheck", ruledOut: [...toolCheck.ruledOut] });
    if (noops.length) steps.push({ step: "statecheck", ruledOut: noops.map(({ key }) => key) });
    // Questions that always think: a claim with unsourced details (its fast
    // read passes them confidently), and questions of many options, where a
    // finished thought helped at every fast-read confidence.
    const force = Boolean(claimNote) || options.length >= thinkMinOptions;
    pending.push({ id, question, options, instructions, rack, compiled, userFor, toOptions, material, probabilities, fast: probabilities, firstOrder, secondOrder, steps, force });
  }
  // A thought cut off by the budget measured worse than no thought: on the
  // weak-benchmark test rows, keeping the fast answer beat reading after the
  // partial thought 84 to 75, on yes/no questions as well as many-option ones.
  const dropCut = (options) => truncatedThought === "keep-fast" || (truncatedThought === "keep-fast-multi" && options.length > 2);
  // Row thought: a row of many questions about one situation (a home, a set
  // of candidates) is scored as a whole case on some benchmarks, and
  // questions answered one at a time drift apart. One thought works through
  // the situation with every question in view; every question is then read
  // after that same thought. A cut-off row thought keeps the fast answers.
  if (rowThought && pending.length >= rowThoughtMin && pending.some((entry) => Math.max(...entry.probabilities) < gate) && pending.every((entry) => entry.material === stateText)) {
    const used = new Set();
    const row = pending.map((entry, n) => {
      const available = pool.filter((handle) => !used.has(handle.handle));
      const rack = rackOptions(available, entry.options.map((option) => option.text), { seed: seed + 7 + n });
      rack.labels.forEach((label) => used.add(label));
      return { entry, rack, slot: `q${n + 1}` };
    });
    const listing = row.map(({ entry, rack, slot }) => `${slot}: ${entry.instructions}\nOPTIONS:\n${rack.material}`).join("\n\n");
    const user = `${stateText}\n\n---\nQUESTIONS:\n${listing}\n\nAnswer every question, one line each, exactly as: q1: [HANDLE]`;
    if (user.length <= rowThoughtMaxChars) {
      const t = await reader.think({ system: ROW_THINK, user, budget: thinkBudget });
      inputTokens += t.promptTokens;
      for (const { entry, rack, slot } of row) {
        entry.settled = true;
        if (!(t.truncated && dropCut(entry.options))) {
          const compiled = await reader.compileLabels({ lead: `${slot}: [`, tail: "]", labels: rack.labels });
          const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
          inputTokens += read.promptTokens;
          entry.probabilities = entry.toOptions(rack, read);
          entry.thoughtRead = true;
        }
        entry.steps.push({ step: "rowthink", thoughtTokens: t.thoughtTokens, truncated: t.truncated, questions: row.length });
      }
    }
  }
  // Heavy steps run after every fast read, so a row's thinking budget goes to
  // its least confident questions first (a select-all row of fifteen
  // candidates otherwise thinks about nearly every one).
  pending.sort((a, b) => Math.max(...a.probabilities) - Math.max(...b.probabilities));
  let thoughts = 0;
  for (const entry of pending) {
    const { id, question, options, instructions, rack, compiled, userFor, toOptions, material, firstOrder, secondOrder, steps } = entry;
    let { probabilities } = entry;
    let thoughtRead = Boolean(entry.thoughtRead);
    if (borrowedThought && !entry.settled) {
      const lent = await reader.borrowThought({ system: thinkSystem, user: userFor(rack, material), thought: borrowedThought });
      const read = await reader.readAfter({ prefixIds: lent.prefixIds, compiled, seed });
      inputTokens += read.promptTokens;
      probabilities = toOptions(rack, read);
      thoughtRead = true;
      entry.settled = true;
      steps.push({ step: "borrowed", thoughtTokens: lent.thoughtTokens });
    }
    // A question that asks for a probability estimate is scored on
    // calibration, and a read after a finished thought is confident: Brier
    // 0.282 on the Decision Index sample, worse than always answering 0.5.
    // `estimateBlend` sets its own think weight; 0 skips thinking altogether.
    // Blending at 0.5 held up on both splits (skill 17.6 test, 20.7 dev);
    // the fast read alone did not (22.2 test, 9.7 dev).
    const estimate = estimateBlend != null && asksForProbability(instructions);
    if (estimate) {
      steps.push({ step: "estimate", thinkBlend: estimateBlend });
      if (estimateBlend === 0) entry.settled = true;
    }
    const budgetLeft = !entry.settled && thoughts < rowThinkLimit;
    // Only when the QUESTION itself carries the quantities: background material
    // full of dates and counts (forecasting, logs) is not a calculation, and
    // forcing a setup there measured slower and less accurate on dev.
    // A long question is a document to read (retrieval candidates carry whole
    // passages), not a calculation to set up.
    const quantitative = quantGate && fewQuestions && instructions.length <= 1500 && isQuantitative(instructions);
    if (quantitative && budgetLeft) {
      thoughts += 1;
      const setup = await reader.complete({ system: DEEP_CALC, user: `${material}\n\n---\nQUESTION: ${instructions}\nOPTIONS:\n${rack.material}`, maxTokens: 500 });
      inputTokens += setup.promptTokens;
      const run = runCalcSetup(setup.text);
      const withResults = run.results.length
        ? `${material}\n\nCALCULATOR RESULTS (exact arithmetic on a setup drawn from the material above; confirm each setup line matches the material before relying on it):\n${formatCalcResults(run.results)}`
        : material;
      const t = await reader.think({ system: thinkSystem, user: userFor(rack, withResults), budget: thinkBudget });
      inputTokens += t.promptTokens;
      if (!(t.truncated && dropCut(options))) {
        const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
        inputTokens += read.promptTokens;
        probabilities = toOptions(rack, read);
        thoughtRead = true;
      }
      steps.push({ step: "calcthink", results: run.results.length, thoughtTokens: t.thoughtTokens, truncated: t.truncated });
    } else if (budgetLeft && (entry.force || (firstOrder && debiasGate === "disagree"
      ? argmaxIndex(firstOrder) !== argmaxIndex(secondOrder) || Math.max(...probabilities) < 0.6
      : Math.max(...probabilities) < gate))) {
      thoughts += 1;
      const t = await reader.think({ system: thinkSystem, user: userFor(rack, material), budget: thinkBudget });
      inputTokens += t.promptTokens;
      if (!(t.truncated && dropCut(options))) {
        const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
        inputTokens += read.promptTokens;
        probabilities = toOptions(rack, read);
        thoughtRead = true;
      }
      steps.push({ step: "think", thoughtTokens: t.thoughtTokens, truncated: t.truncated });
    }
    // A finished thought pushes its read to 0.99/0.01. Blending it with the
    // fast read keeps the thought's decision where it is confident but keeps
    // the fast read's graded evidence, which calibration (Brier) and ranking
    // (nDCG over P(yes)) metrics score. Replayed on the Decision Index sample,
    // weight 0.75 raised the index 56.24 -> 56.95 with no benchmark worse off,
    // and on held-out dev rows lifted ToolRet 41.0 -> 48.0 and BRIGHT 23.3 ->
    // 27.0 with CLadder and MMLU-Pro unchanged.
    const tempered = temperProbs(probabilities, temperature);
    const weight = estimate ? estimateBlend : thinkBlend;
    const final = thoughtRead && weight < 1
      ? temperProbs(entry.fast, temperature).map((fast, i) => weight * tempered[i] + (1 - weight) * fast)
      : tempered;
    answers[id] = jevAnswer(question, options, final);
    evidence[id] = steps;
  }
  // Decide once, derive the rest: a question about an entity's property after
  // the handling follows from the row's chosen change and the listed state.
  if (stateGauge) {
    const changeIds = Object.keys(questions).filter((id) => answers[id]?.choice && isChangeQuestion(questions[id]));
    if (changeIds.length === 1) {
      const changes = parseChanges(questions[changeIds[0]].criteria[answers[changeIds[0]].choice]) ?? [];
      for (const [id, question] of Object.entries(questions)) {
        if (id === changeIds[0] || question.type !== "choice") continue;
        const key = derivedAfterChoice(entities, changes, question);
        if (!key) continue;
        const options = jevOptions(question);
        answers[id] = jevAnswer(question, options, options.map((option) => (option.key === key ? 0.95 : 0.05 / (options.length - 1))));
        evidence[id] = [...(evidence[id] ?? []), { step: "derived", from: changeIds[0], key }];
      }
    }
  }
  return Object.freeze({ answers, evidence, usage: Object.freeze({ inputTokens }) });
}

/**
 * Does the question ask for a probability estimate (a forecast) rather than a
 * decision? Only short questions count: a long question is a passage that may
 * merely mention likelihood (retrieval candidates do).
 */
export function asksForProbability(instructions) {
  const text = String(instructions ?? "");
  return text.length <= 400 && /\b(estimate|forecast|predict)\b[^.?\n]{0,40}\b(probability|chance|likelihood)\b|\bhow likely is it\b|\bprobability (that|of) [^.?\n]{0,80}(resolves?|will|occurs?)/i.test(text);
}

/**
 * The deep profile: the model writes a calculation setup that the calculator
 * gauge computes exactly; three differently worded racks read the material
 * plus those results; one thought reads it again. When the racks and the
 * thought agree the answer is their geometric mean; when they disagree, a duel
 * between the two candidates (both orders, fresh handles, a thought first)
 * decides, with a little of the other evidence kept. Chosen on JevBench's
 * public hard items; see SYSTEM_ONE_GUIDE.md for what it costs.
 */
export async function decideJevDeep({ reader, pool, state, questions, seed = 0, thinkBudget = 1024 }) {
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  const answers = {};
  const evidence = {};
  let inputTokens = 0;
  for (const [id, question] of Object.entries(questions)) {
    const options = jevOptions(question);
    if (options.length === 1) { answers[id] = jevAnswer(question, options, [1]); evidence[id] = []; continue; }
    const instructions = textOf(question.instructions) || "Answer about the state.";
    const racks = [0, 1, 2].map((r) => rackOptions(pool, options.map((option) => option.text), { seed: seed + r * 7919 + 1 }));
    const userFor = (rack, ask, material) => `${material}\n\n---\nQUESTION: ${instructions}\nOPTIONS:\n${rack.material}\n\nq1: ${ask}`;
    const toOptions = (rack, read) => {
      const out = options.map(() => 0);
      rack.rows.forEach((row) => { out[row.optionIndex] = read.probabilities[row.handle]; });
      return out;
    };
    const steps = [];

    const setup = await reader.complete({ system: DEEP_CALC, user: `${stateText}\n\n---\nQUESTION: ${instructions}\nOPTIONS:\n${racks[0].material}`, maxTokens: 500 });
    inputTokens += setup.promptTokens;
    const run = runCalcSetup(setup.text);
    const material = run.results.length
      ? `${stateText}\n\nCALCULATOR RESULTS (exact arithmetic on a setup drawn from the material above; confirm each setup line matches the material before relying on it):\n${formatCalcResults(run.results)}`
      : stateText;
    steps.push({ step: "calc", results: run.results.length, errors: run.errors.length });

    const fast = options.map(() => 0);
    for (let r = 0; r < 3; r += 1) {
      const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: racks[r].labels });
      const read = await reader.read({ system: DEEP_FAST, user: userFor(racks[r], RACK_ASKS[r], material), compiled, seed: seed + r });
      inputTokens += read.promptTokens;
      toOptions(racks[r], read).forEach((p, i) => { fast[i] += p / 3; });
    }
    steps.push({ step: "racks", choice: options[argmaxIndex(fast)].key });

    const thinkAndRead = async (rack, system, user, readSeed) => {
      const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
      const t = await reader.thinkAnswer({ system, user, compiled, budget: thinkBudget });
      inputTokens += t.promptTokens;
      if (t.answered) return toOptions(rack, t);
      const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed: readSeed });
      inputTokens += read.promptTokens;
      return toOptions(rack, read);
    };
    const thought = normalizeProbs(await thinkAndRead(racks[0], DEEP_THINK, userFor(racks[0], RACK_ASKS[0], material), seed));
    steps.push({ step: "think", choice: options[argmaxIndex(thought)].key });

    const a = argmaxIndex(fast);
    const b = argmaxIndex(thought);
    let final;
    if (a === b) {
      final = normalizeProbs(fast.map((p, i) => Math.sqrt(Math.max(p, 1e-9) * Math.max(thought[i], 1e-9))));
    } else {
      const duel = options.map(() => 0);
      for (const [d, pair] of [[0, [a, b]], [1, [b, a]]]) {
        const rack = rackOptions(pool, pair.map((i) => options[i].text), { seed: seed + 104729 * (d + 1), shuffle: false });
        const probs = await thinkAndRead(rack, DEEP_DUEL, userFor(rack, "Which ONE of these two bracketed options is correct?", material), seed + d);
        pair.forEach((optionIndex, j) => { duel[optionIndex] += probs[j] / 2; });
      }
      steps.push({ step: "duel", between: [options[a].key, options[b].key], choice: options[argmaxIndex(duel)].key });
      final = normalizeProbs(duel.map((p, i) => 0.8 * p + 0.1 * fast[i] + 0.1 * thought[i]));
    }
    answers[id] = jevAnswer(question, options, final);
    evidence[id] = steps;
  }
  return Object.freeze({ answers, evidence, usage: Object.freeze({ inputTokens }) });
}

/**
 * The Jev wire contract: POST {state, model, questions} to `/v1/systemone`.
 * Works against OpenJev and, with an API key, TypeSafe's hosted Jev. Answers
 * come back renormalized over each question's labels; label mass is not part
 * of the contract.
 */
export async function systemOneDecide({ baseUrl, model = "openjev-latest", state, questions, apiKey = null, fetchImpl = fetch }) {
  if (!baseUrl) throw new TypeError("systemOneDecide requires baseUrl");
  if (typeof state !== "string" || !state) throw new TypeError("systemOneDecide requires a text state");
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length) throw new TypeError("systemOneDecide requires questions");
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const started = performance.now();
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/systemone`, { method: "POST", headers, body: JSON.stringify({ model, state, questions }) });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`), { status: response.status });
  const body = JSON.parse(text);
  for (const key of Object.keys(questions)) {
    if (!body.answers?.[key]) throw new Error(`System One response omitted question ${key}`);
  }
  return Object.freeze({ model: body.model, answers: body.answers, usage: body.usage ?? null, elapsedMs });
}
