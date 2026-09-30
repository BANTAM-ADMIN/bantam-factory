import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { imageLeases } from "../src/image-gpu.js";

import { askRequest } from "../src/jev/commands.js";
import { loadJevConfig } from "../src/jev/config.js";
import { JevUnavailable } from "../src/jev/api.js";
import { createJevService, effectivePolicy } from "../src/jev/service.js";

const noFile = { readFile: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } };
const configWith = (policy) => loadJevConfig({ gpu: { policy } }, noFile);

// A fake engine that records what the service asked of it.
function fakeEngine(state = "awake") {
  const calls = [];
  const engine = {
    calls,
    state,
    async status() { return { state: engine.state, endpoint: "http://fake" }; },
    async start() { calls.push("start"); engine.state = "awake"; return this.status(); },
    async ensureAwake() { calls.push("ensureAwake"); engine.state = "awake"; return this.status(); },
    async sleep() { calls.push("sleep"); engine.state = "asleep"; },
    async stop() { calls.push("stop"); engine.state = "stopped"; return this.status(); },
  };
  return engine;
}

// A fake llama.cpp worker: awake for `awakePolls` /props reads, then asleep.
function fakeLlama({ awakePolls }) {
  const llama = {
    endpoint: "http://127.0.0.1:59998",
    polls: 0,
    fetch: async (url) => {
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:59998\/props$/);
      const sleeping = llama.polls++ >= awakePolls;
      return new Response(JSON.stringify({ total_slots: 1, is_sleeping: sleeping }), { status: 200 });
    },
  };
  return llama;
}

// GPU leases live under os.tmpdir(); keep the test's own away from real ones.
async function withLeaseDir(fn) {
  const saved = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-lease-"));
  process.env.TMPDIR = root;
  try { return await fn(path.join(root, `bantam-image-gpu-${process.getuid?.() ?? "user"}`)); }
  finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("jev GPU policy", () => {
  it("auto picks swap for a local worker and alongside for Codex, API presets or no worker", () => {
    const auto = configWith("auto");
    assert.equal(effectivePolicy(auto, { endpoint: "http://127.0.0.1:8085" }), "swap");
    assert.equal(effectivePolicy(auto, { codex: true, endpoint: "http://127.0.0.1:8085" }), "alongside");
    assert.equal(effectivePolicy(auto, { apiMode: true, apiUrl: "https://api.deepseek.com" }), "alongside");
    assert.equal(effectivePolicy(auto, null), "alongside");
    assert.equal(effectivePolicy(configWith("off"), { endpoint: "http://127.0.0.1:8085" }), "off", "an explicit policy wins");
  });

  it("off refuses with 503 when the engine is not awake, and never starts it", async () => {
    const engine = fakeEngine("asleep");
    const service = createJevService({ config: configWith("off"), engine });
    await assert.rejects(service.decide({ profile: { options: {} }, state: "s", questions: { q: { type: "noul" } }, seed: 1 }), JevUnavailable);
    assert.deepEqual(engine.calls, []);
  });

  it("alongside wakes a sleeping engine before deciding", async () => {
    const engine = fakeEngine("asleep");
    const service = createJevService({ config: configWith("alongside"), engine, fetchImpl: async () => { throw new Error("no model in this test"); } });
    await assert.rejects(service.decide({ profile: { options: {} }, state: "s", questions: { q: { type: "noul" } }, seed: 1 }));
    assert.deepEqual(engine.calls, ["ensureAwake"], "woken first; the decision itself then needs the model");
  });

  it("on() under swap primes sleep mode once, and refuses a LAN address without a token", async () => {
    const engine = fakeEngine("stopped");
    const llama = fakeLlama({ awakePolls: 0 });
    const service = createJevService({ config: configWith("swap"), worker: { endpoint: llama.endpoint }, engine, fetchImpl: llama.fetch });
    const status = await withLeaseDir(() => service.on({ serve: false }));
    assert.deepEqual(engine.calls, ["start", "sleep"], "start, then the one slow first sleep up front");
    assert.equal(status.policy, "swap");
    await assert.rejects(createJevService({ config: configWith("alongside"), engine: fakeEngine() }).on({ host: "0.0.0.0", serve: true }), /needs an API token/);
  });

  it("on() under swap waits for the local model to sleep before starting DiffusionGemma, then releases the GPU", async () => {
    const llama = fakeLlama({ awakePolls: 3 });
    const engine = fakeEngine("stopped");
    const start = engine.start;
    let pollsBeforeStart = null;
    engine.start = async function () { pollsBeforeStart = llama.polls; return start.call(this); };
    const service = createJevService({ config: configWith("swap"), worker: { endpoint: llama.endpoint }, engine, fetchImpl: llama.fetch });
    await withLeaseDir(async (dir) => {
      await service.on({ serve: false });
      assert.equal(pollsBeforeStart, 4, "three awake polls, then asleep, then the start");
      assert.deepEqual(imageLeases(dir), [], "the local worker gets the GPU back after priming");
    });
    assert.deepEqual((await service.status()).gpuLease, { held: false });
  });

  it("on() under swap refuses, without starting anything, when the local model never sleeps", async () => {
    const llama = fakeLlama({ awakePolls: Infinity });
    const engine = fakeEngine("stopped");
    const config = loadJevConfig({ gpu: { policy: "swap", sleepTimeoutMs: 300 } }, noFile);
    const service = createJevService({ config, worker: { endpoint: llama.endpoint }, engine, fetchImpl: llama.fetch });
    await withLeaseDir(async (dir) => {
      await assert.rejects(service.on({ serve: false }), (error) => error instanceof JevUnavailable && /could not take the GPU from the local worker: llama\.cpp did not sleep/.test(error.message));
      assert.deepEqual(imageLeases(dir), []);
    });
    assert.deepEqual(engine.calls, []);
  });

  it("a second on() while Jev holds the GPU leaves the awake engine alone", async () => {
    const llama = fakeLlama({ awakePolls: 0 });
    const engine = fakeEngine("stopped");
    const service = createJevService({ config: configWith("swap"), worker: { endpoint: llama.endpoint }, engine, fetchImpl: llama.fetch });
    await withLeaseDir(async () => {
      await service.on({ serve: false });
      // A decide takes the GPU and keeps it for its burst window. The decision
      // itself fails here (no model), which is fine: the lease is what matters.
      await service.decide({ profile: { options: {} }, state: "s", questions: { q: { type: "noul" } }, seed: 1 }).catch(() => {});
      assert.equal((await service.status()).gpuLease.held, true);
      engine.calls.length = 0;
      await service.on({ serve: false });
      assert.deepEqual(engine.calls, [], "no start and no sleep under a held lease");
      assert.equal(engine.state, "awake");
      await service.off({ keepEngine: true });
    });
  });

  it("handback stop frees the whole GPU: no engine at on(), and the container stops when the GPU goes back", async () => {
    const llama = fakeLlama({ awakePolls: 0 });
    const engine = fakeEngine("stopped");
    const config = loadJevConfig({ gpu: { policy: "swap", handback: "stop" } }, noFile);
    const service = createJevService({ config, worker: { endpoint: llama.endpoint }, engine, fetchImpl: llama.fetch });
    await withLeaseDir(async (dir) => {
      await service.on({ serve: false });
      assert.deepEqual(engine.calls, [], "nothing starts until a question needs it");
      await service.decide({ profile: { options: {} }, state: "s", questions: { q: { type: "noul" } }, seed: 1, releaseAfter: true }).catch(() => {});
      assert.deepEqual(engine.calls, ["ensureAwake", "stop"], "started for the question, stopped (not slept) on handback");
      assert.equal(engine.state, "stopped");
      assert.deepEqual(imageLeases(dir), [], "the local worker has the GPU back");
    });
  });

  it("rejects an unknown handback", () => {
    assert.throws(() => loadJevConfig({ gpu: { handback: "nap" } }, noFile), /gpu.handback must be sleep or stop/);
    assert.equal(loadJevConfig({}, noFile).gpu.handback, "sleep");
  });

  it("off() stops the engine unless asked to keep it", async () => {
    const engine = fakeEngine();
    const service = createJevService({ config: configWith("alongside"), engine });
    await service.off({ keepEngine: true });
    assert.deepEqual(engine.calls, []);
    await service.off();
    assert.deepEqual(engine.calls, ["stop"]);
  });
});

describe("jev ask", () => {
  it("turns quick text into a yes/no or choice request", () => {
    assert.deepEqual(askRequest("Is 91 prime?").questions.answer, { type: "noul", instructions: "Is 91 prime?" });
    const choice = askRequest("Largest planet? | Mars | Jupiter").questions.answer;
    assert.equal(choice.type, "choice");
    assert.deepEqual(Object.keys(choice.criteria), ["Mars", "Jupiter"]);
    assert.equal(askRequest("   "), null);
  });
});
