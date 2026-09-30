import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createJevToolset } from "../src/mcp/toolsets/jev.js";
import { JevBusy } from "../src/jev/api.js";

function fakeService({ fail = null } = {}) {
  const calls = { decide: [], off: [] };
  const service = {
    async decide(request) {
      calls.decide.push(request);
      if (fail) throw fail;
      const answers = {};
      for (const [id, q] of Object.entries(request.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.91 };
        else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria)[1], probabilities: {}, confidence: 0.8 };
        else answers[id] = { type: "score", score: 2, probabilities: {}, confidence: 0.6 };
      }
      return { answers, evidence: {}, usage: { inputTokens: 10, outputTokens: 0 } };
    },
    async status() { return { engine: "awake", requests: calls.decide.length }; },
    async off(options) { calls.off.push(options); },
  };
  return { service, calls };
}

function setup(options = {}) {
  const { service, calls } = fakeService(options);
  let factoryCalls = 0;
  const toolset = createJevToolset({ serviceFactory: async () => { factoryCalls++; return { service, keepEngine: options.keepEngine ?? false }; } });
  const ctx = { localJobRunning: () => options.localBusy ?? false };
  toolset.start(ctx);
  const call = (name, args = {}) => toolset.tools.find((t) => t.name === name).handler(args, { caller: "claude" });
  return { toolset, call, calls, factoryCalls: () => factoryCalls };
}

describe("jev toolset", () => {
  it("answers in the Jev shapes with a readable summary, starting the engine once", async () => {
    const { call, calls, factoryCalls } = setup();
    assert.deepEqual(await call("jev_status"), { started: false, note: "Jev starts on the first jev_decide." });
    const result = await call("jev_decide", {
      state: "Mara left the lighthouse at dawn.",
      questions: {
        canon: { type: "noul", instructions: "Does this contradict: Mara never leaves the lighthouse?" },
        best: { type: "choice", instructions: "Which title fits?", criteria: { Dawn: null, Lighthouse: null } },
        tension: { type: "score", instructions: "How tense?", criteria: ["flat", "some", "gripping"] },
      },
    });
    assert.equal(result.model, "bantam-jev");
    assert.deepEqual(Object.keys(result.answers), ["canon", "best", "tension"]);
    assert.equal(result.summary, 'canon: yes (P(yes) 0.910)\nbest: Lighthouse (confidence 0.800)\ntension: level 2 "gripping" (confidence 0.600)');
    assert.equal(result.confidence.canon, 0.82);
    assert.equal(calls.decide[0].profile.name, "bantam-jev");
    assert.equal(calls.decide[0].releaseAfter, false);
    await call("jev_decide", { state: "x", questions: { q: { type: "noul", instructions: "?" } }, model: "bantam-jev-fast" });
    assert.equal(calls.decide[1].profile.name, "bantam-jev-fast");
    assert.equal(factoryCalls(), 1);
    assert.equal((await call("jev_status")).engine, "awake");
  });

  it("answers single-option questions without the engine", async () => {
    const { call, factoryCalls } = setup();
    const result = await call("jev_decide", { state: "x", questions: { only: { type: "choice", instructions: "?", criteria: { A: null } } } });
    assert.equal(result.answers.only.choice, "A");
    assert.equal(factoryCalls(), 0);
  });

  it("hands the GPU back at once while a local job runs", async () => {
    const { call, calls } = setup({ localBusy: true });
    await call("jev_decide", { state: "x", questions: { q: { type: "noul", instructions: "?" } } });
    assert.equal(calls.decide[0].releaseAfter, true);
  });

  it("explains invalid requests in words", async () => {
    const { call } = setup();
    await assert.rejects(call("jev_decide", { state: "x", questions: {} }), /questions: Dictionary should have at least 1 item/);
    await assert.rejects(call("jev_decide", { state: "x", questions: { q: { type: "essay" } } }), /noul \(yes\/no\), choice/);
    await assert.rejects(call("jev_decide", { state: "x", questions: { q: { type: "score", instructions: "?" } } }), /questions\.q\.score\.criteria: Field required/);
  });

  it("reports an engine that is unavailable or busy, and retries setup later", async () => {
    let attempts = 0;
    const toolset = createJevToolset({ serviceFactory: async () => { attempts++; throw new Error("Jev mode is not set up yet. Run `bantamfactory jev setup`"); } });
    toolset.start({});
    const decide = (args) => toolset.tools[0].handler(args, { caller: "claude" });
    const request = { state: "x", questions: { q: { type: "noul", instructions: "?" } } };
    await assert.rejects(decide(request), /Jev is not available: Jev mode is not set up yet\. Run `bantamfactory jev setup`/);
    await assert.rejects(decide(request), /not set up/);
    assert.equal(attempts, 2);
    const busy = setup({ fail: new JevBusy("the GPU is reserved for an image job") });
    await assert.rejects(busy.call("jev_decide", request), /Jev could not answer now: the GPU is reserved/);
  });

  it("turns the engine off on stop unless it was already running", async () => {
    const fresh = setup();
    await fresh.call("jev_decide", { state: "x", questions: { q: { type: "noul", instructions: "?" } } });
    await fresh.toolset.stop();
    assert.deepEqual(fresh.calls.off, [{ keepEngine: false }]);
    const shared = setup({ keepEngine: true });
    await shared.call("jev_decide", { state: "x", questions: { q: { type: "noul", instructions: "?" } } });
    await shared.toolset.stop();
    assert.deepEqual(shared.calls.off, [{ keepEngine: true }]);
    const unused = setup();
    await unused.toolset.stop();
    assert.deepEqual(unused.calls.off, []);
  });
});
