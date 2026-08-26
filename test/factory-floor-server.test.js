import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import { FactoryRunTelemetry, runContractEdgeFactoryCell, startFactoryFloorServer } from "../src/factory.js";

const temporary = new Set();
const servers = new Set();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-floor-server-"));
  temporary.add(root);
  const workspace = path.join(root, "workspace");
  const factoryHome = path.join(root, "factory");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "index.js"), "export const answer = 1;\n");
  return { workspace, factoryHome };
}

function memoryStream() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, text() { return value; } };
}

class BlueprintModel {
  constructor() { this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 }; }
  metadata() { return { runtime: "local", model: "floor-blueprint-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete() {
    this.usage = { ...this.usage, requests: 1, inputTokens: 12, outputTokens: 8, totalTokens: 20, cacheMissTokens: 12 };
    return { content: '{"schema":1,"kind":"bantam.contract-edge-selection","edges":["empty-input"]}', tokens: 8, stoppedEos: true, stoppedLimit: false };
  }
}

describe("live chicken floor", () => {
  it("projects an append-only traveler live through a secured loopback viewer", async () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({
      root: factoryHome,
      jobId: "job-live-floor",
      workspace,
      task: "Observe the line.",
    });
    const floor = await startFactoryFloorServer({ root: factoryHome, jobId: "job-live-floor", port: 0, pollIntervalMs: 100 });
    servers.add(floor);

    assert.match(floor.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(floor.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const html = await page.text();
    assert.match(html, /id="play"/);
    assert.match(html, /id="speed"/);
    assert.match(html, /id="follow"/);
    assert.match(html, /"liveEndpoint":"\/api\/snapshot"/);

    const first = await (await fetch(new URL("/api/snapshot", floor.url))).json();
    assert.equal(first.kind, "bantam.factory-floor-snapshot");
    assert.equal(first.jobId, "job-live-floor");
    assert.ok(first.events.length > 0);

    telemetry.note({ type: "observation", turn: 1, observation: "button pecked" });
    const second = await (await fetch(new URL("/api/snapshot", floor.url))).json();
    assert.ok(second.events.length > first.events.length);
    assert.deepEqual(second.events.slice(0, first.events.length), first.events);

    assert.equal((await fetch(new URL("/package.json", floor.url))).status, 404);
    assert.equal((await fetch(new URL("/api/snapshot", floor.url), { method: "POST" })).status, 405);
    assert.deepEqual(await (await fetch(new URL("/health", floor.url))).json(), { ok: true, jobId: "job-live-floor" });
  });

  it("refuses public binding and invalid or absent travelers before listening", async () => {
    const { factoryHome } = fixture();
    await assert.rejects(
      startFactoryFloorServer({ root: factoryHome, jobId: "missing", host: "0.0.0.0", port: 0 }),
      /loopback/,
    );
    await assert.rejects(
      startFactoryFloorServer({ root: factoryHome, jobId: "missing", port: 0 }),
      /does not exist/,
    );
  });

  it("serves only the exact executable blueprint recorded by its traveler", async () => {
    const { factoryHome } = fixture();
    await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "job-blueprint-floor",
      contract: "An empty input returns an empty result.",
      catalog: [{ id: "empty-input", description: "The contract explicitly defines empty input." }],
      expectedEdges: ["empty-input"],
      model: new BlueprintModel(),
    });
    const floor = await startFactoryFloorServer({ root: factoryHome, jobId: "job-blueprint-floor", port: 0, pollIntervalMs: 100 });
    servers.add(floor);
    const page = await (await fetch(floor.url)).text();
    assert.match(page, /class="blueprint-link" href="\/blueprint"/);
    const projection = await (await fetch(new URL("/api/blueprint", floor.url))).json();
    assert.equal(projection.kind, "bantam.factory-blueprint-projection");
    assert.equal(projection.jobId, "job-blueprint-floor");
    assert.deepEqual(projection.nodes.map((node) => node.state), ["released", "released", "released"]);
    const blueprint = await fetch(new URL("/blueprint", floor.url));
    assert.equal(blueprint.status, 200);
    assert.match(await blueprint.text(), /Executable factory layout/);
  });

  it("exposes a blocking factory floor CLI command with injectable lifecycle", async () => {
    const { workspace, factoryHome } = fixture();
    new FactoryRunTelemetry({ root: factoryHome, jobId: "job-cli-floor", workspace, task: "Observe." });
    let options;
    const stdout = memoryStream();
    const stderr = memoryStream();
    const code = await runFactoryCommand([
      "factory", "floor", "job-cli-floor", "--factory-home", factoryHome, "--port", "0", "--interval", "250",
    ], {
      stdout,
      stderr,
      startFloorServerFn: async (value) => {
        options = value;
        return { url: "http://127.0.0.1:43210/", closed: Promise.resolve() };
      },
    });
    assert.equal(code, 0);
    assert.equal(stderr.text(), "");
    assert.match(stdout.text(), /http:\/\/127\.0\.0\.1:43210\//);
    assert.equal(options.port, 0);
    assert.equal(options.pollIntervalMs, 250);
    assert.equal(options.jobId, "job-cli-floor");
  });
});
