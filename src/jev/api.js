// The Jev-compatible HTTP API that BANTAM Factory serves in Jev mode.
//
// Wire contract: TypeSafe's Jev (OpenAPI 0.2.0), as implemented by OpenJev's
// openjev/api.py, so Jev SDKs and the Decision Index kit work unchanged:
//
//   GET  /health            {status: "ok"}
//   GET  /v1/models         {models: [{name, description, release_date}]}
//   POST /v1/systemone      {model, state, questions, ...} -> {model, answers, usage}
//
// Field errors are 422 with a list `detail`; semantic errors are 400 with a
// string `detail`; an unknown model or question type is 400 api_usage_error;
// auth failures are 403 (no key) or 401 (wrong key); a body over the cap is 413.
// Every response carries x-typesafe-request-id, x-request-id and server-timing.
//
// Extensions (opt-in; a plain Jev client never sees them): a request `bantam`
// object ({explain, abstainBelow, thought}) adds per-answer evidence and
// abstention; POST /v1/systemone/batch decides many rows (NDJSON streaming with
// Accept: application/x-ndjson); GET /v1/gauges lists the exact gauges;
// GET /v1/bantam/status reports the engine and GPU policy.
import crypto from "node:crypto";
import http from "node:http";

import { modelList, resolveProfile } from "./profiles.js";

export class JevBusy extends Error {}
export class JevUnavailable extends Error {}

const TYPES = new Set(["noul", "choice", "score"]);
const MAX_CHOICES = 255;
const MAX_SCORE_LEVELS = 10;

function isJsonContent(value) {
  return typeof value === "string" || (value !== null && typeof value === "object");
}

function trim(value, depth = 0) {
  if (typeof value === "string") return value.length <= 500 ? value : `${value.slice(0, 500)}...`;
  if (value && typeof value === "object") {
    if (depth >= 4) return "...";
    if (Array.isArray(value)) return [...value.slice(0, 20).map((v) => trim(v, depth + 1)), ...(value.length > 20 ? ["..."] : [])];
    const entries = Object.entries(value);
    const out = Object.fromEntries(entries.slice(0, 20).map(([k, v]) => [k, trim(v, depth + 1)]));
    if (entries.length > 20) out["..."] = `${entries.length - 20} more`;
    return out;
  }
  return value;
}

/** Jev's field-level checks. Returns {fieldErrors, unknownType}. */
export function validateSystemOne(body) {
  const errors = [];
  const add = (type, loc, msg, input) => errors.push({ type, loc: ["body", ...loc], msg, input: trim(input) });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    add("model_attributes_type", [], "Input should be a valid dictionary or object to extract fields from", body);
    return { fieldErrors: errors, unknownType: false };
  }
  if (body.state === undefined) add("missing", ["state"], "Field required", body);
  else if (!isJsonContent(body.state)) add("json_content", ["state"], "Input should be a string, object or array", body.state);
  if (body.model === undefined) add("missing", ["model"], "Field required", body);
  else if (typeof body.model !== "string") add("string_type", ["model"], "Input should be a valid string", body.model);
  let unknownType = false;
  if (body.questions === undefined) add("missing", ["questions"], "Field required", body);
  else if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) add("dict_type", ["questions"], "Input should be a valid dictionary", body.questions);
  else if (!Object.keys(body.questions).length) add("too_short", ["questions"], "Dictionary should have at least 1 item after validation, not 0", body.questions);
  else {
    for (const [id, q] of Object.entries(body.questions)) {
      if (!q || typeof q !== "object" || Array.isArray(q)) { add("model_attributes_type", ["questions", id], "Input should be a valid dictionary or object to extract fields from", q); continue; }
      if (q.type === undefined) { add("union_tag_not_found", ["questions", id], "Unable to extract tag using discriminator 'type'", q); continue; }
      if (!TYPES.has(q.type)) { unknownType = true; continue; }
      if (q.type === "choice" && (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria))) add(q.criteria === undefined ? "missing" : "dict_type", ["questions", id, "choice", "criteria"], q.criteria === undefined ? "Field required" : "Input should be a valid dictionary", q.criteria ?? q);
      if (q.type === "score") {
        if (!Array.isArray(q.criteria)) add(q.criteria === undefined ? "missing" : "list_type", ["questions", id, "score", "criteria"], q.criteria === undefined ? "Field required" : "Input should be a valid list", q.criteria ?? q);
        else if (!q.criteria.length) add("too_short", ["questions", id, "score", "criteria"], "List should have at least 1 item after validation, not 0", q.criteria);
      }
      if (q.type === "noul" && q.criteria != null && (typeof q.criteria !== "object" || Array.isArray(q.criteria))) add("model_attributes_type", ["questions", id, "noul", "criteria"], "Input should be a valid dictionary or object to extract fields from", q.criteria);
    }
  }
  for (const [field, lo, hi] of [["steps", 1, 8], ["samples", 1, 32], ["think", 0, 4096]]) {
    const v = body[field];
    if (v == null) continue;
    if (!Number.isInteger(v)) add("int_type", [field], "Input should be a valid integer", v);
    else if (v < lo) add("greater_than_equal", [field], `Input should be greater than or equal to ${lo}`, v);
    else if (v > hi) add("less_than_equal", [field], `Input should be less than or equal to ${hi}`, v);
  }
  if (body.sequential != null && typeof body.sequential !== "boolean") add("bool_type", ["sequential"], "Input should be a valid boolean", body.sequential);
  return { fieldErrors: errors, unknownType };
}

/** Semantic checks and the answers Jev gives without a read (one possible answer). */
export function planQuestions(questions, { maxQuestions }) {
  if (Object.keys(questions).length > maxQuestions) return { error: `at most ${maxQuestions} questions per request` };
  const forced = {};
  const toRead = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (!keys.length) return { error: `Choice question must have at least one choice: ${id}` };
      if (keys.length > MAX_CHOICES) return { error: `Too many choices. Must have at most ${MAX_CHOICES} choices.` };
      if (keys.length === 1) { forced[id] = { type: "choice", choice: keys[0], probabilities: { [keys[0]]: 1.0 }, confidence: 1.0 }; continue; }
    }
    if (q.type === "score") {
      if (q.criteria.length > MAX_SCORE_LEVELS) return { error: `Too many score levels. Must have at most ${MAX_SCORE_LEVELS} levels.` };
      if (q.criteria.length === 1) { forced[id] = { type: "score", score: 0.0, legend: { 0: q.criteria[0] }, probabilities: { 0: 1.0 }, confidence: 1.0 }; continue; }
    }
    toRead[id] = q;
  }
  return { forced, toRead };
}

/** Jev's answer shapes, exactly: score legends carry the criteria as given. */
function normalizeAnswer(question, answer) {
  if (question.type === "noul") return { type: "noul", noul: answer.noul };
  if (question.type === "choice") return { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
  return { type: "score", score: answer.score, legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])), probabilities: answer.probabilities, confidence: answer.confidence };
}

function answerConfidence(answer) {
  if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
  return answer.confidence;
}

/**
 * Build the request handler. `decide({profile, state, questions, seed, thought})`
 * returns {answers, usage: {inputTokens, outputTokens}, evidence}. `status()`
 * feeds /v1/bantam/status. `gauges` lists the exact gauges.
 */
export function createJevApi({ decide, status = async () => ({}), gauges = [], token = null, maxQuestions = 256, maxBodyBytes = 64 * 1024 * 1024, log = () => {} }) {
  const jsonHeaders = (rid, extra = {}) => ({ "content-type": "application/json", "x-typesafe-request-id": rid, "x-request-id": rid, ...extra });

  function send(res, status, body, rid, { started, modelNs = 0n, headers = {} } = {}) {
    const text = JSON.stringify(body);
    const totalMs = started ? Number(process.hrtime.bigint() - started) / 1e6 : 0;
    const modelMs = Number(modelNs) / 1e6;
    res.writeHead(status, {
      ...jsonHeaders(rid, headers),
      "content-length": Buffer.byteLength(text),
      "server-timing": `model;dur=${modelMs.toFixed(1)}, server;dur=${Math.max(0, totalMs - modelMs).toFixed(1)}, total;dur=${totalMs.toFixed(1)}`,
    });
    res.end(text);
  }
  const usageError = (message) => ({ detail: { error_type: "api_usage_error", message } });

  function checkAuth(req) {
    if (!token) return null;
    const auth = req.headers.authorization ?? "";
    if (!auth) return [403, { detail: { error_type: "authentication_error", message: "Must supply an API key! Check your request and try again." } }];
    const given = Buffer.from(auth.replace(/^Bearer /, "").trim());
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return [401, { detail: { error_type: "authentication_error", message: "Cannot authenticate with the server. Please check your API key and try again." } }];
    }
    return null;
  }

  async function readBody(req) {
    if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) return { tooBig: true };
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) return { tooBig: true };
      chunks.push(chunk);
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  }

  function parseJson(text) {
    try { return { body: JSON.parse(text) }; }
    catch (error) { return { error: { detail: [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {}, ctx: { error: String(error.message).slice(0, 200) } }] } }; }
  }

  /** One row: validate, answer forced questions, read the rest. Returns [status, body, modelNs]. */
  async function decideRow(body) {
    const { fieldErrors, unknownType } = validateSystemOne(body);
    if (unknownType) return [400, usageError("Invalid request.")];
    if (fieldErrors.length) return [422, { detail: fieldErrors }];
    const profile = resolveProfile(body.model);
    if (!profile) return [400, usageError(`Unknown model: ${body.model}`)];
    if (body.images?.length) return [400, { detail: "images are not supported by BANTAM Jev mode yet" }];
    const plan = planQuestions(body.questions, { maxQuestions });
    if (plan.error) return [400, { detail: plan.error }];
    const ext = body.bantam && typeof body.bantam === "object" ? body.bantam : {};
    let answers = { ...plan.forced };
    let usage = { input_tokens: 0, output_tokens: 0 };
    let evidence = {};
    const t0 = process.hrtime.bigint();
    if (Object.keys(plan.toRead).length) {
      // Same request, same noise draws: answers are reproducible (as in OpenJev).
      const seed = crypto.createHash("sha256").update(JSON.stringify([body.state, body.questions])).digest().readUInt32BE(0);
      const decided = await decide({ profile, state: body.state, questions: plan.toRead, seed, thought: typeof ext.thought === "string" ? ext.thought : null });
      for (const [id, q] of Object.entries(plan.toRead)) answers[id] = normalizeAnswer(q, decided.answers[id]);
      usage = { input_tokens: decided.usage?.inputTokens ?? 0, output_tokens: decided.usage?.outputTokens ?? 0 };
      evidence = decided.evidence ?? {};
    }
    const modelNs = process.hrtime.bigint() - t0;
    // Keep the caller's question order.
    answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, answers[id]]));
    const out = { model: profile.name, answers, usage };
    if (ext.explain || typeof ext.abstainBelow === "number") {
      const threshold = typeof ext.abstainBelow === "number" ? ext.abstainBelow : null;
      const perAnswer = {};
      for (const [id, answer] of Object.entries(answers)) {
        const confidence = answerConfidence(answer);
        const abstained = threshold != null && confidence < threshold;
        if (abstained) answers[id] = { type: "unknown", reason: `confidence ${confidence.toFixed(3)} is below ${threshold}`, best: answer };
        perAnswer[id] = {
          confidence,
          ...(abstained ? { abstained: true } : {}),
          ...(ext.explain ? { evidence: plan.forced[id] ? [{ step: "forced", reason: "only one possible answer" }] : evidence[id] ?? [] } : {}),
          authority: authorityOf(plan.forced[id] ? [{ step: "forced" }] : evidence[id]),
        };
      }
      out.bantam = { profile: profile.name, answers: perAnswer, ms: Number(modelNs) / 1e6 };
    }
    return [200, out, modelNs];
  }

  async function handler(req, res) {
    const rid = `req_${crypto.randomBytes(16).toString("hex")}`;
    const started = process.hrtime.bigint();
    const url = new URL(req.url, "http://jev.local");
    try {
      if (url.pathname.startsWith("/v1/")) {
        const denied = checkAuth(req);
        if (denied) return send(res, denied[0], denied[1], rid, { started });
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" }, rid, { started });
      if (req.method === "GET" && url.pathname === "/v1/models") return send(res, 200, { models: modelList() }, rid, { started });
      if (req.method === "GET" && url.pathname === "/v1/gauges") return send(res, 200, { gauges }, rid, { started });
      if (req.method === "GET" && url.pathname === "/v1/bantam/status") return send(res, 200, await status(), rid, { started });
      if (req.method === "POST" && (url.pathname === "/v1/systemone" || url.pathname === "/v1/systemone/batch")) {
        const read = await readBody(req);
        if (read.tooBig) return send(res, 413, usageError(`request body is larger than ${maxBodyBytes} bytes`), rid, { started });
        const parsed = parseJson(read.text);
        if (parsed.error) return send(res, 422, parsed.error, rid, { started });
        if (url.pathname === "/v1/systemone") {
          const [status, body, modelNs] = await decideRow(parsed.body);
          log({ rid, status, model: parsed.body?.model, questions: Object.keys(parsed.body?.questions ?? {}).length, ms: Number(process.hrtime.bigint() - started) / 1e6 });
          return send(res, status, body, rid, { started, modelNs });
        }
        return batch(req, res, parsed.body, rid, started);
      }
      return send(res, 404, { detail: "Not Found" }, rid, { started });
    } catch (error) {
      if (error instanceof JevBusy) return send(res, 529, { detail: { error_type: "overloaded_error", message: error.message } }, rid, { started, headers: { "retry-after": "1" } });
      if (error instanceof JevUnavailable) return send(res, 503, { detail: { error_type: "api_error", message: error.message } }, rid, { started, headers: { "retry-after": "2" } });
      log({ rid, status: 500, error: String(error?.stack ?? error) });
      return send(res, 500, { detail: { error_type: "api_error", message: "Internal server error." } }, rid, { started });
    }
  }

  // POST /v1/systemone/batch: {model, rows: [{state, questions}], bantam?} ->
  // {model, results: [{answers, usage} | {status, detail}]}; with
  // Accept: application/x-ndjson each row's result streams as one line.
  async function batch(req, res, body, rid, started) {
    if (!body || typeof body !== "object" || !Array.isArray(body.rows) || !body.rows.length) {
      return send(res, 422, { detail: [{ type: "missing", loc: ["body", "rows"], msg: "rows must be a non-empty list of {state, questions}", input: trim(body) }] }, rid, { started });
    }
    const stream = String(req.headers.accept ?? "").includes("application/x-ndjson");
    const rowRequest = (row) => ({ ...row, model: row.model ?? body.model, ...(body.bantam && !row.bantam ? { bantam: body.bantam } : {}) });
    if (stream) {
      res.writeHead(200, { "content-type": "application/x-ndjson", "x-typesafe-request-id": rid, "x-request-id": rid });
      for (const [index, row] of body.rows.entries()) {
        let line;
        try {
          const [status, result] = await decideRow(rowRequest(row));
          line = status === 200 ? { index, ...result } : { index, status, ...result };
        } catch (error) {
          line = { index, status: error instanceof JevBusy ? 529 : 503, detail: { error_type: "api_error", message: error.message } };
        }
        res.write(`${JSON.stringify(line)}\n`);
      }
      return res.end();
    }
    const results = [];
    let modelNs = 0n;
    for (const row of body.rows) {
      const [status, result, ns = 0n] = await decideRow(rowRequest(row));
      modelNs += ns;
      results.push(status === 200 ? result : { status, ...result });
    }
    return send(res, 200, { model: body.model, results }, rid, { started, modelNs });
  }

  return handler;
}

/** "exact" when a gauge or rule decided, "model" when a read did. */
export function authorityOf(steps = []) {
  const exact = new Set(["exec", "preference", "derived", "forced"]);
  return steps?.some?.((s) => exact.has(s.step)) ? "exact" : "model";
}

export function startJevHttpServer(options, { host = "127.0.0.1", port = 8090 } = {}) {
  const server = http.createServer(createJevApi(options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
