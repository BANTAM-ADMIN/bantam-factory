import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { authorityOf, JevBusy, startJevHttpServer, validateSystemOne } from "../src/jev/api.js";
import { modelList, resolveProfile } from "../src/jev/profiles.js";

// A fake decider: choice -> first key at 0.8, noul -> 0.9, score -> level 1.
const decided = [];
async function fakeDecide({ profile, questions, seed, thought }) {
  decided.push({ profile: profile.name, ids: Object.keys(questions), seed, thought });
  const answers = {};
  const evidence = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[id] = { type: "choice", choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / (keys.length - 1)])), confidence: 0.55 };
    }
    if (q.type === "score") answers[id] = { type: "score", score: 1, legend: {}, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])), confidence: 1 };
    evidence[id] = [{ step: id === "code" ? "exec" : "fast" }];
  }
  if (Object.keys(questions).includes("busy")) throw new JevBusy("engine busy");
  return { answers, usage: { inputTokens: 42, outputTokens: 0 }, evidence };
}

let server;
let base;
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ok = { model: "bantam-jev", state: "a customer was charged twice", questions: { refund: { type: "noul", instructions: "Is a refund owed?" } } };

describe("jev api (Jev wire contract)", () => {
  before(async () => {
    server = await startJevHttpServer({ decide: fakeDecide, gauges: [{ name: "exec" }], status: async () => ({ engine: "awake" }), maxQuestions: 5, maxBodyBytes: 10_000 }, { port: 0 });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it("serves health and the model list in Jev's shape", async () => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(models.models.every((m) => typeof m.name === "string" && typeof m.description === "string" && typeof m.release_date === "string"));
    assert.ok(models.models.some((m) => m.name === "bantam-jev") && models.models.some((m) => m.name === "openjev-latest"));
  });

  it("answers a request with Jev's response shape and headers", async () => {
    const res = await post("/v1/systemone", ok);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-typesafe-request-id"), /^req_[0-9a-f]{32}$/);
    assert.equal(res.headers.get("x-request-id"), res.headers.get("x-typesafe-request-id"));
    assert.match(res.headers.get("server-timing"), /^model;dur=[\d.]+, server;dur=[\d.]+, total;dur=[\d.]+$/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["answers", "model", "usage"], "no extension fields unless asked");
    assert.deepEqual(body.answers.refund, { type: "noul", noul: 0.9 });
    assert.deepEqual(body.usage, { input_tokens: 42, output_tokens: 0 });
  });

  it("answers single-option questions without a read, in Jev's forced shapes", async () => {
    decided.length = 0;
    const body = await (await post("/v1/systemone", { model: "bantam-jev", state: {}, questions: { only: { type: "choice", criteria: { a: "x" } }, lvl: { type: "score", criteria: ["low"] } } })).json();
    assert.deepEqual(body.answers.only, { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 });
    assert.deepEqual(body.answers.lvl, { type: "score", score: 0, legend: { 0: "low" }, probabilities: { 0: 1 }, confidence: 1 });
    assert.equal(decided.length, 0, "the model is not asked");
  });

  it("keeps question order, score legends as given, and reproducible seeds", async () => {
    const req = { model: "openjev-latest", state: { x: 1 }, questions: { z: { type: "score", criteria: [{ level: "low" }, "high"] }, a: { type: "choice", criteria: { yes: null, no: null } } } };
    const one = await (await post("/v1/systemone", req)).json();
    assert.deepEqual(Object.keys(one.answers), ["z", "a"]);
    assert.deepEqual(one.answers.z.legend, { 0: { level: "low" }, 1: "high" });
    assert.equal(one.model, "bantam-jev", "an alias answers as its profile");
    await post("/v1/systemone", req);
    assert.equal(decided.at(-1).seed, decided.at(-2).seed);
  });

  it("returns Jev's error shapes", async () => {
    const missing = await post("/v1/systemone", { model: "bantam-jev", questions: { q: { type: "noul" } } });
    assert.equal(missing.status, 422);
    const detail = (await missing.json()).detail;
    assert.ok(Array.isArray(detail) && detail[0].type === "missing" && detail[0].loc.join(".") === "body.state");
    const badType = await post("/v1/systemone", { ...ok, questions: { q: { type: "ranking" } } });
    assert.equal(badType.status, 400);
    assert.deepEqual(await badType.json(), { detail: { error_type: "api_usage_error", message: "Invalid request." } });
    const unknownModel = await post("/v1/systemone", { ...ok, model: "gpt-9" });
    assert.deepEqual([unknownModel.status, await unknownModel.json()], [400, { detail: { error_type: "api_usage_error", message: "Unknown model: gpt-9" } }]);
    const tooMany = await post("/v1/systemone", { ...ok, questions: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q${i}`, { type: "noul" }])) });
    assert.deepEqual([tooMany.status, await tooMany.json()], [400, { detail: "at most 5 questions per request" }]);
    const emptyChoice = await post("/v1/systemone", { ...ok, questions: { c: { type: "choice", criteria: {} } } });
    assert.deepEqual([emptyChoice.status, await emptyChoice.json()], [400, { detail: "Choice question must have at least one choice: c" }]);
    const badJson = await post("/v1/systemone", "{nope");
    assert.equal(badJson.status, 422);
    assert.equal((await badJson.json()).detail[0].type, "json_invalid");
    const range = await post("/v1/systemone", { ...ok, think: 5000 });
    assert.equal((await range.json()).detail[0].type, "less_than_equal");
    const big = await post("/v1/systemone", { ...ok, state: "x".repeat(20_000) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it("maps a busy engine to 529 with retry-after", async () => {
    const res = await post("/v1/systemone", { ...ok, questions: { busy: { type: "noul" } } });
    assert.equal(res.status, 529);
    assert.equal(res.headers.get("retry-after"), "1");
    assert.equal((await res.json()).detail.error_type, "overloaded_error");
  });

  it("extensions: explain adds evidence and authority, abstainBelow abstains, thought is passed through", async () => {
    const res = await (await post("/v1/systemone", { model: "bantam-jev", state: "s", questions: { code: { type: "choice", criteria: { a: 1, b: 2 } }, pick: { type: "choice", criteria: { x: 1, y: 2, z: 3 } } }, bantam: { explain: true, abstainBelow: 0.6, thought: "because" } })).json();
    assert.equal(res.bantam.answers.code.authority, "exact");
    assert.equal(res.bantam.answers.pick.authority, "model");
    assert.equal(res.answers.pick.type, "unknown", "confidence 0.55 is below 0.6");
    assert.equal(res.answers.pick.best.choice, "x");
    assert.ok(Array.isArray(res.bantam.answers.pick.evidence));
    assert.equal(decided.at(-1).thought, "because");
    assert.equal(authorityOf([{ step: "fast" }, { step: "derived" }]), "exact");
  });

  it("batch: decides many rows, and streams one NDJSON line per row", async () => {
    const rows = [{ state: "a", questions: { q: { type: "noul" } } }, { state: "b", questions: { q: { type: "ranking" } } }];
    const whole = await (await post("/v1/systemone/batch", { model: "bantam-jev", rows })).json();
    assert.equal(whole.results.length, 2);
    assert.equal(whole.results[0].answers.q.noul, 0.9);
    assert.equal(whole.results[1].status, 400);
    const streamed = await post("/v1/systemone/batch", { model: "bantam-jev", rows }, { accept: "application/x-ndjson" });
    assert.equal(streamed.headers.get("content-type"), "application/x-ndjson");
    const lines = (await streamed.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.index), [0, 1]);
    assert.equal((await post("/v1/systemone/batch", { model: "bantam-jev" })).status, 422);
  });

  it("serves gauges and status", async () => {
    assert.deepEqual(await (await fetch(`${base}/v1/gauges`)).json(), { gauges: [{ name: "exec" }] });
    assert.deepEqual(await (await fetch(`${base}/v1/bantam/status`)).json(), { engine: "awake" });
  });
});

describe("jev api auth", () => {
  it("requires the token on /v1 routes: 403 without, 401 when wrong", async () => {
    const guarded = await startJevHttpServer({ decide: fakeDecide, token: "s3cret" }, { port: 0 });
    const url = `http://127.0.0.1:${guarded.address().port}`;
    try {
      assert.equal((await fetch(`${url}/health`)).status, 200, "health stays open");
      const none = await fetch(`${url}/v1/models`);
      assert.deepEqual([none.status, (await none.json()).detail.error_type], [403, "authentication_error"]);
      assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer nope" } })).status, 401);
      assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer s3cret" } })).status, 200);
    } finally { guarded.close(); }
  });
});

describe("jev profiles", () => {
  it("resolves profiles and aliases, and lists them", () => {
    assert.equal(resolveProfile("openjev-latest").name, "bantam-jev");
    assert.equal(resolveProfile("bantam-jev-fast").options.gate, 0, "the fast profile never thinks");
    assert.equal(resolveProfile("nope"), null);
    assert.ok(modelList().length >= 4);
    assert.deepEqual(validateSystemOne({ model: "m", state: "s", questions: { q: { type: "noul" } } }), { fieldErrors: [], unknownType: false });
  });
});
