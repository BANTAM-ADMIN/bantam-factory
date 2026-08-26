import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import { onboardLocalWorker, WorkforceRegistry } from "../src/factory.js";

const roots = new Set();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-worker-onboarding-"));
  roots.add(value);
  return value;
}

function response(value, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return value; } };
}

function endpointFetch(url) {
  if (url.endsWith("/health")) return response({ status: "ok" });
  if (url.endsWith("/v1/models")) return response({ data: [{ id: "Qwen3.6-27B-Q4_K_M.gguf", meta: { n_ctx: 80_128 } }] });
  if (url.endsWith("/props")) return response({
    default_generation_settings: { n_ctx: 80_128 },
    total_slots: 1,
    build_info: "b1899-test",
    modalities: { vision: false, audio: false, video: false },
  });
  throw new Error(`unexpected URL ${url}`);
}

function sink() { let value = ""; return { write(chunk) { value += chunk; }, text() { return value; } }; }

describe("local factory worker onboarding", () => {
  it("discovers one loopback worker, proves grammar, and records attendance without qualification", async () => {
    const factoryRoot = root();
    const seen = {};
    const result = await onboardLocalWorker({
      root: factoryRoot,
      endpoint: "http://127.0.0.1:8085/",
      profile: "qwen",
      ttlMs: 120_000,
      fetchFn: endpointFetch,
      modelFactory(options) {
        seen.options = options;
        return {
          async complete(prompt, options) { seen.prompt = prompt; seen.completion = options; return { content: "BANTAMCLOCKIN" }; },
          close() { seen.closed = true; },
        };
      },
    });
    assert.equal(result.kind, "bantam.factory-worker-onboarding");
    assert.equal(result.endpoint, "http://127.0.0.1:8085");
    assert.equal(result.model, "Qwen3.6-27B-Q4_K_M.gguf");
    assert.equal(result.contextTokens, 80_128);
    assert.equal(result.observedSlots, 1);
    assert.equal(result.declaredSlots, 1);
    assert.equal(result.grammar.passed, true);
    assert.equal(result.qualification, "not-granted");
    assert.equal(result.authority, "attendance-only");
    assert.equal(result.worker.runtime, "local");
    assert.equal(seen.options.endpoint, "http://127.0.0.1:8085");
    assert.match(seen.completion.grammar, /BANTAMCLOCKIN/);
    assert.equal(seen.closed, true);
    const workforce = new WorkforceRegistry(factoryRoot).project();
    assert.equal(workforce.profiles.length, 1);
    assert.equal(workforce.qualifications.length, 0);
    assert.equal(workforce.health[0].condition, "available");
    assert.equal(workforce.health[0].slotsAvailable, 1);
    assert.match(workforce.health[0].detail, /context 80128/);
  });

  it("fails before touching the workforce when grammar is ignored or capacity is overstated", async () => {
    const grammarRoot = root();
    await assert.rejects(() => onboardLocalWorker({
      root: grammarRoot,
      endpoint: "http://localhost:8085",
      fetchFn: endpointFetch,
      modelFactory: () => ({ async complete() { return { content: "anything" }; }, close() {} }),
    }), /did not honor/);
    assert.equal(new WorkforceRegistry(grammarRoot).project().events, 0);

    const capacityRoot = root();
    await assert.rejects(() => onboardLocalWorker({
      root: capacityRoot,
      endpoint: "http://127.0.0.1:8085",
      slots: 2,
      fetchFn: endpointFetch,
      modelFactory: () => { throw new Error("must not reach model probe"); },
    }), /server reports 1/);
    assert.equal(new WorkforceRegistry(capacityRoot).project().events, 0);
  });

  it("refuses non-loopback endpoints and URL-shaped authority expansion", async () => {
    for (const endpoint of ["http://example.com:8085", "file:///tmp/model", "http://127.0.0.1:8085/v1", "http://user@127.0.0.1:8085"]) {
      await assert.rejects(() => onboardLocalWorker({ root: root(), endpoint, fetchFn: endpointFetch }), /loopback|http or https|origin/);
    }
  });

  it("exposes onboarding through an explicit mutating CLI interlock", async () => {
    const factoryRoot = root();
    let calls = 0;
    const onboardLocalWorkerFn = async (input) => {
      calls += 1;
      assert.equal(input.endpoint, "http://127.0.0.1:8085");
      assert.equal(input.profile, "qwen");
      assert.equal(input.slots, 1);
      assert.equal(input.ttlMs, 90_000);
      return { worker: { ref: "worker:qwen@1:sha256:x" }, contextTokens: 80_128, declaredSlots: 1, observedSlots: 1 };
    };
    const denied = sink();
    assert.equal(await runFactoryCommand([
      "factory", "workers", "onboard", "--endpoint", "http://127.0.0.1:8085", "--factory-home", factoryRoot,
    ], { stdout: sink(), stderr: denied, onboardLocalWorkerFn }), 2);
    assert.match(denied.text(), /repeat with --yes/);
    assert.equal(calls, 0);

    const stdout = sink();
    assert.equal(await runFactoryCommand([
      "factory", "workers", "onboard", "--endpoint", "http://127.0.0.1:8085", "--profile", "qwen",
      "--slots", "1", "--ttl", "90000", "--yes", "--factory-home", factoryRoot,
    ], { stdout, stderr: sink(), onboardLocalWorkerFn }), 0);
    assert.match(stdout.text(), /qualification not granted/);
    assert.equal(calls, 1);
  });
});
