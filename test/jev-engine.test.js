import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_JEV_CONFIG, loadJevConfig } from "../src/jev/config.js";
import { createJevEngine } from "../src/jev/engine.js";

// A fake docker + vLLM pair: `container` is the docker state, `server` what the
// HTTP endpoint answers. Every call is recorded.
function fakeHost({ container = "running", server = "awake", loadPolls = 0 } = {}) {
  const calls = [];
  const host = { container, server, polls: 0 };
  const docker = async (args) => {
    calls.push(["docker", ...args]);
    const [cmd] = args;
    if (cmd === "inspect") { if (host.container === "missing") throw new Error("no such container"); return host.container; }
    if (cmd === "start" || cmd === "run") { host.container = "running"; host.server = "loading"; return "ok"; }
    if (cmd === "stop") { host.container = "exited"; host.server = "down"; return "ok"; }
    if (cmd === "logs") return "boom";
    throw new Error(`unexpected docker ${cmd}`);
  };
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname + new URL(url).search;
    calls.push([init.method ?? "GET", route]);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (host.server === "loading" && host.polls++ >= loadPolls) host.server = "awake";
    if (host.server === "down" || host.server === "loading") throw new Error("ECONNREFUSED");
    if (route === "/health") return json(200, {});
    if (route === "/is_sleeping") return json(200, { is_sleeping: host.server === "asleep" });
    if (route === "/sleep?level=1") { host.server = "asleep"; return json(200, {}); }
    if (route === "/wake_up") { host.server = "awake"; return json(200, {}); }
    return json(404, {});
  };
  return { host, calls, docker, fetchImpl };
}

const noFile = { readFile: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } };
const config = loadJevConfig({ engine: { mode: "managed" }, create: { image: "img:1", modelPath: "/models/dg" } }, noFile);
const engineFor = (fake) => createJevEngine(config, { docker: fake.docker, fetchImpl: fake.fetchImpl, wait: async () => {} });

describe("jev config", () => {
  it("defaults to the measured DiffusionGemma setup and merges overrides", () => {
    assert.equal(config.container, DEFAULT_JEV_CONFIG.container);
    assert.equal(config.gpu.policy, "auto");
    assert.equal(loadJevConfig({}, noFile).engine.mode, "unconfigured", "a fresh machine starts unconfigured");
    assert.equal(loadJevConfig({}, noFile).create.image, null, "no machine-specific image or model path by default");
    const custom = loadJevConfig({ gpu: { policy: "swap" } }, { readFile: () => JSON.stringify({ api: { port: 9000 } }) });
    assert.equal(custom.api.port, 9000);
    assert.equal(custom.api.host, "127.0.0.1", "unspecified nested fields keep their defaults");
    assert.equal(custom.gpu.policy, "swap");
    assert.equal(custom.gpu.burstMs, 30_000);
  });

  it("rejects an unknown GPU policy and a malformed file", () => {
    assert.throws(() => loadJevConfig({ gpu: { policy: "sometimes" } }, { readFile: () => "{}" }), /gpu.policy/);
    assert.throws(() => loadJevConfig({}, { readFile: () => "{nope" }), /not valid JSON/);
  });
});

describe("jev engine lifecycle", () => {
  it("reports each state", async () => {
    for (const [container, server, want] of [["missing", "down", "missing"], ["exited", "down", "stopped"], ["running", "loading", "starting"], ["running", "asleep", "asleep"], ["running", "awake", "awake"]]) {
      const fake = fakeHost({ container, server, loadPolls: 99 });
      assert.equal((await engineFor(fake).status()).state, want, `${container}/${server}`);
    }
  });

  it("starts a stopped container and waits until it serves", async () => {
    const fake = fakeHost({ container: "exited", server: "down", loadPolls: 2 });
    const lines = [];
    const status = await engineFor(fake).start({ onProgress: (line) => lines.push(line) });
    assert.equal(status.state, "awake");
    assert.ok(fake.calls.some((c) => c[0] === "docker" && c[1] === "start"));
    assert.ok(lines.some((l) => /cold start/.test(l)));
  });

  it("creates a missing container from the create spec", async () => {
    const fake = fakeHost({ container: "missing", server: "down" });
    await engineFor(fake).start();
    const run = fake.calls.find((c) => c[0] === "docker" && c[1] === "run");
    assert.ok(run.includes("VLLM_SERVER_DEV_MODE=1") && run.includes("--enable-sleep-mode"), "sleep mode is enabled at creation");
  });

  it("wakes instead of restarting when asleep, and sleeps on request", async () => {
    const fake = fakeHost({ container: "running", server: "asleep" });
    const engine = engineFor(fake);
    assert.equal((await engine.ensureAwake()).state, "awake");
    assert.ok(!fake.calls.some((c) => c[1] === "start"), "no docker start for a sleeping engine");
    await engine.sleep();
    assert.equal((await engine.status()).state, "asleep");
  });

  it("stops with docker stop, and reports a container that dies while loading", async () => {
    const fake = fakeHost();
    assert.equal((await engineFor(fake).stop()).state, "stopped");
    const dying = fakeHost({ container: "exited", server: "down", loadPolls: 99 });
    const engine = createJevEngine(config, { docker: async (args) => { const out = await dying.docker(args); if (args[0] === "start") dying.host.container = "exited"; return out; }, fetchImpl: dying.fetchImpl, wait: async () => {} });
    await assert.rejects(engine.start(), /exited while loading/);
  });

  it("external: talks to the user's server, never starts or stops it", async () => {
    const fake = fakeHost({ container: "missing", server: "asleep" });
    const external = createJevEngine(loadJevConfig({ engine: { mode: "external" }, endpoint: "http://gpu-box:8001" }, noFile), { docker: fake.docker, fetchImpl: fake.fetchImpl, wait: async () => {} });
    assert.equal((await external.status()).state, "asleep");
    assert.equal((await external.start()).state, "awake", "start only wakes it");
    await external.stop();
    assert.ok(!fake.calls.some((c) => c[0] === "docker"), "no docker command touches an external server");
    const down = fakeHost({ server: "down" });
    const unreachable = createJevEngine(loadJevConfig({ engine: { mode: "external" } }, noFile), { docker: down.docker, fetchImpl: down.fetchImpl });
    await assert.rejects(unreachable.start(), /not reachable/);
  });

  it("unconfigured: every action points to setup", async () => {
    const fake = fakeHost();
    const engine = createJevEngine(loadJevConfig({}, noFile), { docker: fake.docker, fetchImpl: fake.fetchImpl });
    assert.equal((await engine.status()).state, "unconfigured");
    await assert.rejects(engine.start(), /bantamfactory jev setup/);
    await assert.rejects(engine.wake(), /bantamfactory jev setup/);
  });
});
