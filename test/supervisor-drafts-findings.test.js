// The supervisor encodes the factory's real audits: films in, DRAFT findings
// with evidence out, judgment left to a human. Each fixture below is modeled
// on a real film that found a real mechanism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { supervise, renderSupervisorReport } from "../src/supervisor/report.js";
import { prefixBreaks, thrashAudit } from "../src/supervisor/analyzers.js";

const call = (i, { wall = 2000, cache = null, prompt = null, gen = null } = {}) => ({
  startedAt: new Date(1000000 + i * 10000).toISOString(),
  completedAt: new Date(1000000 + i * 10000 + wall).toISOString(),
  response: { rawBody: JSON.stringify({ timings: { cache_n: cache, prompt_n: prompt, predicted_n: gen } }) },
});
const turn = (i, a, observation) => ({ i, parsedAction: a, observation });

test("cache-collapse films draft a retroactive-rewrite finding (the timegrid audit, encoded)", () => {
  const film = {
    modelCalls: [call(0, { cache: 2800, prompt: 1500 }), call(1, { cache: 9000, prompt: 1500 }),
      call(2, { cache: 20000, prompt: 1400 }), call(3, { wall: 23000, cache: 2869, prompt: 43000 })],
    turns: [], metrics: {},
  };
  const r = supervise(film);
  assert.equal(r.breaks.detected.length, 1);
  assert.equal(r.breaks.detected[0].cache_n, 2869);
  const f = r.findings.find((x) => x.family === "retroactive-rewrite");
  assert.ok(f); assert.equal(f.severity, "high");
  assert.match(f.next, /byte-diff/);
});

test("red-span patch chains draft patch-thrash; ignored advice escalates", () => {
  const film = {
    modelCalls: [], metrics: { repourSteers: 1 },
    turns: [
      turn(0, { a: "shell", c: "npm test" }, "# pass 3\n# fail 2"),
      ...[1, 2, 3, 4, 5].map((i) => turn(i, { a: "replace", p: "src/render.js" }, "replaced 1 occurrence in src/render.js")),
      turn(6, { a: "shell", c: "npm test" }, "# pass 3\n# fail 2"),
    ],
  };
  const r = supervise(film);
  assert.ok(r.findings.some((f) => f.family === "patch-thrash"));
  assert.ok(r.findings.some((f) => f.family === "ignored-advice"), "steer fired + pattern persisted = escalation fuel");
});

test("zero suite runs across a long film drafts an oracle finding pointed at the HARNESS first", () => {
  const film = { modelCalls: [], metrics: {}, turns: Array.from({ length: 8 }, (_, i) => turn(i, { a: "shell", c: "python3 -c 'print(1)'" }, "1")) };
  const f = supervise(film).findings.find((x) => x.family === "oracle-swap");
  assert.ok(f);
  assert.match(f.next, /verifier wiring before judging the model/);
});

test("a healthy film reports no findings, and says a healthy film is data too", () => {
  const film = {
    modelCalls: [call(0, { cache: 3000, prompt: 900, gen: 400 }), call(1, { cache: 4200, prompt: 700, gen: 300 })],
    metrics: {},
    turns: [turn(0, { a: "write_file", p: "a.js" }, "wrote"), turn(1, { a: "shell", c: "npm test" }, "# pass 5\n# fail 0"), turn(2, { a: "done" }, "")],
  };
  const r = supervise(film);
  assert.equal(r.findings.length, 0);
  assert.match(renderSupervisorReport(r), /healthy film is data too/);
});

test("severity follows COST: a deep expensive break is high, a cheap tail reset is info", () => {
  // Prompts must DIVERGE (a byte-extension is correctly not a rewrite): each
  // second prompt rewrites a byte mid-history, then continues.
  const mk = (i, o) => ({ ...call(i, o), request: { body: { prompt: (o.mark ?? "x").repeat(o.chars ?? 1000) } } });
  const expensive = { modelCalls: [mk(0, { cache: 45000, prompt: 500, chars: 120000 }), mk(1, { wall: 24000, cache: 2869, prompt: 43000, chars: 128000, mark: "y" })], turns: [], metrics: {} };
  const cheap = { modelCalls: [mk(0, { cache: 9956, prompt: 500, chars: 32000 }), mk(1, { wall: 3500, cache: 2869, prompt: 7596, chars: 34000, mark: "z" })], turns: [], metrics: {} };
  const e = supervise(expensive).findings.find((f) => f.family === "retroactive-rewrite");
  assert.ok(e && e.severity === "high");
  const c = supervise(cheap).findings;
  assert.ok(!c.some((f) => f.family === "retroactive-rewrite"), "a cheap tail reset must not cry wolf");
  assert.ok(c.some((f) => f.family === "prefix-break-cheap" && f.severity === "info"));
});

test("a think-phase prompt is never compared against an action-phase prompt", () => {
  const withPrompt = (i, phase, o) => ({ ...call(i, o), request: { body: { prompt: phase === "think" ? "body".repeat(2000) + "<|im_start|>assistant\n<think>" : "body".repeat(2000) + '{"a":"done"}' } } });
  const film = { modelCalls: [withPrompt(0, "think", { cache: 9000, prompt: 100 }), withPrompt(1, "action", { cache: 2869, prompt: 7000 })], turns: [], metrics: {} };
  assert.deepEqual(prefixBreaks(film).detected, [], "phase change is not a rewrite");
});

test("verdicts are recognized in EVERY shape a real film carries", async () => {
  const { verdictOf, oracleAudit } = await import("../src/supervisor/analyzers.js");
  // The shape that broke it: BANTAM's own normalized observation (series 6 —
  // ten green pytest builds scored as "no suite runs" by a node-TAP-only reader).
  assert.deepEqual(verdictOf("VERDICT: all 17 tests passed."), { pass: 17, fail: 0 });
  assert.deepEqual(verdictOf("VERDICT: 17 of 17 tests FAILED (0 passed)."), { pass: 0, fail: 17 });
  assert.deepEqual(verdictOf("# pass 9\n# fail 0"), { pass: 9, fail: 0 });
  assert.deepEqual(verdictOf("33 passed in 0.54s"), { pass: 33, fail: 0 });
  assert.deepEqual(verdictOf("2 failed, 5 passed in 1.2s"), { pass: 5, fail: 2 });
  assert.equal(verdictOf("wrote 40 bytes"), null);
  const film = { turns: [{ i: 0, parsedAction: { a: "shell", c: "python3 -m pytest -v" }, observation: "VERDICT: all 17 tests passed." }], metrics: {} };
  const o = oracleAudit(film);
  assert.equal(o.suiteRuns, 1);
  assert.equal(o.lastPass, 17);
});

test("wall-concentration only drafts when the slow calls are REPROCESSING-dominated", () => {
  const mk = (i, o) => call(i, o);
  const emission = { modelCalls: [mk(0, { wall: 20000, prompt: 500, gen: 2000, cache: 3000 }), mk(1, { wall: 1000, prompt: 100, gen: 50, cache: 4000 })], turns: [], metrics: {} };
  assert.ok(!supervise(emission).findings.some((f) => f.family === "wall-concentration"), "big generation is physics, not a finding");
  const reprocess = { modelCalls: [mk(0, { wall: 20000, prompt: 30000, gen: 200, cache: 3000 }), mk(1, { wall: 1000, prompt: 100, gen: 50, cache: 4000 })], turns: [], metrics: {} };
  assert.ok(supervise(reprocess).findings.some((f) => f.family === "wall-concentration"), "reprocessing-dominated wall is a context problem");
});

test("analyzers are pure and tolerate absent fields", () => {
  assert.deepEqual(prefixBreaks({}).detected, []);
  assert.deepEqual(thrashAudit({}).chains, []);
});
