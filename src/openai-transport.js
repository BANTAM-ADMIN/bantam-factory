// OpenAI-compatible transport helpers. BANTAM assembles its own raw prompt and
// constrains generation with a GBNF grammar, so it speaks `/v1/completions` (raw
// prompt, no chat re-templating) and passes the grammar through the field the
// server understands. Verified live: llama.cpp's /v1/completions honors a
// top-level `grammar` and returns `{ choices: [{ text }] }`.
//
// Pure — unit-tested without a server.

/**
 * Where a server reads a GBNF grammar from, by dialect.
 *
 * llama.cpp's /v1 carries it in a top-level `grammar`. vLLM removed the legacy
 * `guided_*` parameters this used to send: read straight off a running vLLM
 * 0.28.0's own GET /openapi.json, `CompletionRequest` exposes
 * `structured_outputs` (whose schema has a `grammar` field) while
 * `GuidedDecodingParams` is gone entirely. vLLM accepts unknown request fields
 * instead of rejecting them, so `guided_grammar` still answers HTTP 200 and
 * constrains NOTHING — the silent-ignore failure that the doctor probe exists to
 * catch, arriving through a door that no longer exists.
 *
 * `"structured_outputs"` therefore does not name a field to assign: it names a
 * NESTED object, so buildOpenAiBody places the grammar one level down.
 */
export function grammarFieldFor(dialect) {
  if (dialect === "vllm") return STRUCTURED_OUTPUTS_FIELD;
  return "grammar"; // llama.cpp / DeepSeek default
}

/** vLLM's structured-output envelope: { grammar | json | regex | choice }. */
export const STRUCTURED_OUTPUTS_FIELD = "structured_outputs";

/**
 * Build the `/v1/completions` request body from BANTAM's raw prompt + sampling.
 * `sampling` carries { temperature, topP, topK, nPredict, stop, seed }.
 */
export function buildOpenAiBody({ prompt, grammar = null, sampling = {}, model = "local", grammarField = "grammar", stream = false, deepseek = false, includeUsage = false }) {
  const body = {
    model,
    prompt,
    max_tokens: sampling.nPredict,
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    stop: sampling.stop,
  };
  if (sampling.seed !== null && sampling.seed !== undefined) body.seed = sampling.seed;
  // Only present when a caller explicitly asked for it — the agent loop does, on
  // the retry after a generation collapsed into a repeated fragment. Never on a
  // first attempt: penalising repetition degrades code, where repeated tokens
  // are correct.
  if (sampling.presencePenalty) body.presence_penalty = sampling.presencePenalty;
  if (stream) {
    body.stream = true;
    // Opt-in per dialect. A streaming OpenAI server otherwise sends NO usage at
    // all, and SSE frames are not tokens (a live vLLM probe packed 5 tokens into
    // 2 frames), so BANTAM's token accounting would read a frame count. Only the
    // vllm dialect asks: an unknown field is ignored by permissive servers but
    // rejected by strict ones, and llama.cpp's native counters already arrive on
    // the final event.
    if (includeUsage) body.stream_options = { include_usage: true };
  }
  // One grammar, two shapes: llama.cpp wants a top-level `grammar`, vLLM wants
  // `structured_outputs.grammar`. See grammarFieldFor().
  if (grammar) {
    if (grammarField === STRUCTURED_OUTPUTS_FIELD) {
      body[STRUCTURED_OUTPUTS_FIELD] = { ...(body[STRUCTURED_OUTPUTS_FIELD] ?? {}), grammar };
    } else {
      body[grammarField] = grammar;
    }
  }
  if (deepseek) body.extra_body = { thinking: { type: "disabled" } };
  // Drop undefined keys so the body is clean for stricter servers.
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/**
 * Build DeepSeek's OpenAI-compatible Chat Completions body.
 *
 * DeepSeek's regular API is chat-only; its `/completions` route is a beta FIM
 * endpoint and cannot be used as a drop-in raw completion transport. The
 * provider adapter converts BANTAM's canonical rendered transcript back into
 * native chat roles. For action turns it prefers one forced `bantam_action`
 * function whose parameters are the current BANTAM JSON Schema; JSON mode is
 * retained only as a schema-less fallback. DeepSeek does not implement GBNF,
 * and all returned function arguments still require local validation.
 */
export function buildDeepSeekBody({
  prompt,
  sampling = {},
  model = "deepseek-v4-flash",
  stream = false,
  jsonMode = false,
  outputSchema = null,
  thinking = false,
  reasoningEffort = "high",
}) {
  const body = {
    model,
    messages: deepSeekMessagesFromPrompt(prompt),
    max_tokens: sampling.nPredict,
    stop: sampling.stop,
    thinking: { type: thinking ? "enabled" : "disabled" },
  };
  // DeepSeek ignores sampling controls in thinking mode. Omitting them keeps
  // the recorded request honest and avoids depending on compatibility
  // tolerance that other OpenAI-style proxies may not share.
  if (thinking) body.reasoning_effort = reasoningEffort;
  else {
    body.temperature = sampling.temperature;
    body.top_p = sampling.topP;
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (outputSchema && typeof outputSchema === "object") {
    body.tools = [{
      type: "function",
      function: {
        name: "bantam_action",
        description: "Return exactly one next BANTAM action.",
        parameters: outputSchema,
      },
    }];
    body.tool_choice = {
      type: "function",
      function: { name: "bantam_action" },
    };
  } else if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/**
 * Generic OpenAI chat-completions body for servers that speak ONLY
 * /v1/chat/completions (codexapi, most hosted providers). The canonical
 * transcript becomes real chat roles; the action JSON Schema rides in the
 * standard `response_format` so a server that enforces it constrains the reply
 * and one that ignores it still gets the JSON-only instruction. No GBNF: every
 * returned action is validated locally, as on every other transport.
 */
export function buildChatCompletionsBody({ prompt, sampling = {}, model = "local", stream = false, outputSchema = null, jsonMode = false, messages = null, sessionId = null }) {
  const body = {
    model,
    messages: Array.isArray(messages) && messages.length ? messages : chatMessagesFromPrompt(prompt),
    ...(sessionId ? { session_id: sessionId } : {}),
    max_tokens: sampling.nPredict,
    stop: sampling.stop,
    temperature: sampling.temperature,
    top_p: sampling.topP,
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (outputSchema && typeof outputSchema === "object") {
    body.response_format = { type: "json_schema", json_schema: { name: "bantam_action", strict: true, schema: outputSchema } };
  } else if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  // Operator-supplied fields for a specific server (codexapi's `chat_preamble`,
  // `web_search`, `session_id`), merged UNDER the request's own fields so they
  // can never rewrite the model or the messages. Env, not a flag: a strict
  // OpenAI endpoint rejects unknown fields, so nothing is sent unless asked.
  const extra = process.env.BANTAM_CHAT_BODY_EXTRA;
  if (extra) {
    try {
      const parsed = JSON.parse(extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (!(k in body)) body[k] = v;
      }
    } catch { /* malformed extras are ignored, never fatal */ }
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/**
 * Convert BANTAM's canonical Qwen-style transcript into actual chat messages.
 *
 * Local llama.cpp consumes the rendered control tokens directly. Sending that
 * same string as one DeepSeek user message makes role markers and the open
 * assistant prefill look like untrusted prose. Preserve the exact semantic
 * turns while removing transport-specific framing.
 */
export function chatMessagesFromPrompt(prompt) { return deepSeekMessagesFromPrompt(prompt); }

export function deepSeekMessagesFromPrompt(prompt) {
  const source = String(prompt);
  const marker = "<|im_start|>";
  const end = "<|im_end|>";
  const messages = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    const roleStart = start + marker.length;
    const newline = source.indexOf("\n", roleStart);
    if (newline === -1) break;
    const role = source.slice(roleStart, newline).trim();
    if (!["system", "user", "assistant"].includes(role)) {
      cursor = newline + 1;
      continue;
    }
    const close = source.indexOf(end, newline + 1);
    const openTurn = close === -1;
    const content = source.slice(newline + 1, openTurn ? source.length : close).trim();
    // The final open assistant marker is a llama.cpp generation prefill, not
    // conversation history. DeepSeek's Chat Completions route supplies its own
    // assistant turn, so an empty prefill must disappear.
    if (!(openTurn && role === "assistant" && !content)) {
      messages.push({ role, content });
    }
    cursor = openTurn ? source.length : close + end.length;
  }

  return messages.length ? messages : [{ role: "user", content: source }];
}

/** Content from a non-streaming completion response — OpenAI or native shape. */
export function extractCompletionText(json) {
  if (json && typeof json.content === "string") return json.content; // native llama.cpp
  const choice = json?.choices?.[0];
  if (choice) {
    const toolArguments = choice.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof toolArguments === "string") return toolArguments;
    if (typeof choice.text === "string") return choice.text;            // /v1/completions
    if (typeof choice.message?.content === "string") return choice.message.content; // chat (tolerated)
  }
  return "";
}

/** Delta text from a streaming SSE chunk — OpenAI or native shape. */
export function extractStreamDelta(json) {
  if (json && typeof json.content === "string") return json.content; // native
  const choice = json?.choices?.[0];
  if (choice) {
    const toolArguments = choice.delta?.tool_calls?.[0]?.function?.arguments;
    if (typeof toolArguments === "string") return toolArguments;
    if (typeof choice.text === "string") return choice.text;             // /v1/completions stream
    if (typeof choice.delta?.content === "string") return choice.delta.content; // chat stream
  }
  return "";
}

/** Whether a stream chunk signals completion (native `stop` or OpenAI finish_reason). */
export function isStreamDone(json) {
  if (json?.stop === true) return true; // native
  const fr = json?.choices?.[0]?.finish_reason;
  return typeof fr === "string" && fr.length > 0;
}

// --- persisted API config (`enter it once` via doctor) ---
import fs from "node:fs";
import path from "node:path";

/** Path to the saved OpenAI-API config for a workspace. */
export function apiConfigPath(dir = process.cwd()) {
  return path.join(dir, ".bantam", "api.json");
}

/** Load a saved OpenAI-API config ({ apiUrl, apiKey?, model?, dialect? }) or null. */
export function loadApiConfig(dir = process.cwd()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(apiConfigPath(dir), "utf8"));
    return cfg && typeof cfg.apiUrl === "string" ? cfg : null;
  } catch { return null; }
}

/** Persist an OpenAI-API config; returns the path written. */
export function saveApiConfig(dir, config) {
  const p = apiConfigPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
  return p;
}
