import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    const service = createJevService({ config: configWith("swap"), worker: { endpoint: "http://127.0.0.1:8085" }, engine });
    const status = await service.on({ serve: false });
    assert.deepEqual(engine.calls, ["start", "sleep"], "start, then the one slow first sleep up front");
    assert.equal(status.policy, "swap");
    await assert.rejects(createJevService({ config: configWith("alongside"), engine: fakeEngine() }).on({ host: "0.0.0.0", serve: true }), /needs an API token/);
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
