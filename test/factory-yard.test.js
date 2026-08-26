import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import { FactoryRunTelemetry, FactoryStore, projectFactoryYard, renderFactoryYard, runContractEdgeFactoryCell, startFactoryYardServer, WorkforceRegistry } from "../src/factory.js";

const waitingStationRef = `station:yard-waiting-model@1:sha256:${"b".repeat(64)}`;

const temporary = new Set();
const servers = new Set();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-yard-"));
  temporary.add(root);
  const factoryHome = path.join(root, "factory");
  const workspace = (name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "index.js"), `export const line = "${name}";\n`);
    return directory;
  };
  return { factoryHome, workspace };
}

function result(overrides = {}) {
  return {
    reachedDone: true,
    responded: false,
    interrupted: false,
    blocked: null,
    modelFailure: null,
    verification: { status: "pass", exitCode: 0, detail: "pass" },
    integrity: null,
    summary: "done",
    metrics: { turns: 1, durationMs: 10 },
    ...overrides,
  };
}

function memoryStream() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, text() { return value; } };
}

function mutationControlFixture() {
  return {
    kind: "bantam.factory-mutation-authority-control",
    authority: "observe-only",
    basis: { semanticObjectId: "semantic-object:fixture", kitRef: "semantic-kit:fixture", factBasis: 12 },
    artifactId: "mutation-authority-control:fixture",
    summary: { total: 1, critical: 0, warning: 1 },
    exceptions: [{
      code: "model-observed-authority-gap", severity: "warning", file: "src/factory/store.js",
      chunkId: "chunk:fixture", proof: { base: true, datoms: [] }, packet: { data: { lane: "filesystem_write" } },
    }],
  };
}

class BlueprintModel {
  constructor() { this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 }; }
  metadata() { return { runtime: "local", model: "yard-blueprint-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete() {
    this.usage = { ...this.usage, requests: 1, inputTokens: 12, outputTokens: 8, totalTokens: 20, cacheMissTokens: 12 };
    return { content: '{"schema":1,"kind":"bantam.contract-edge-selection","edges":["empty-input"]}', tokens: 8, stoppedEos: true, stoppedLimit: false };
  }
}

function populatedYard() {
  const { factoryHome, workspace } = fixture();
  const active = new FactoryRunTelemetry({ root: factoryHome, jobId: "active-line", workspace: workspace("active"), task: "Work." });
  const released = new FactoryRunTelemetry({ root: factoryHome, jobId: "released-line", workspace: workspace("released"), task: "Finish." });
  released.finish(result());
  const stopped = new FactoryRunTelemetry({ root: factoryHome, jobId: "stopped-line", workspace: workspace("stopped"), task: "Fail." });
  stopped.finish(result({ reachedDone: false, verification: null }));
  new FactoryStore(factoryHome).create({
    jobId: "idle-line",
    routeRef: "route:idle-test",
    initialProductRevision: "tree:idle",
    time: "2020-01-01T00:00:00.000Z",
  });
  const corrupt = new FactoryRunTelemetry({ root: factoryHome, jobId: "corrupt-line", workspace: workspace("corrupt"), task: "Corrupt." });
  corrupt.finish(result());
  const journal = path.join(factoryHome, "journal", "lanes", "factory.corrupt-line.jsonl");
  const lines = fs.readFileSync(journal, "utf8").trimEnd().split("\n");
  const row = JSON.parse(lines[1]);
  row.payload.event.payload.executionMode = "tampered";
  lines[1] = JSON.stringify(row);
  fs.writeFileSync(journal, `${lines.join("\n")}\n`);
  return { factoryHome, active };
}

function waitingWorkerYard({ qualified = false } = {}) {
  const { factoryHome } = fixture();
  const writer = new FactoryStore(factoryHome).create({
    jobId: "waiting-worker-line",
    routeRef: "route:waiting-worker:sha256:article",
    initialProductRevision: "tree:waiting",
  });
  writer.append("route.validated", { routeRef: "route:waiting-worker:sha256:article" });
  writer.append("route.plan", {
    routeRef: "route:waiting-worker:sha256:article",
    taskFamily: "yard-waiting",
    stations: [{
      id: "contract-edge",
      stationRef: waitingStationRef,
      title: "Contract edge enumerator",
      workerKind: "model",
      capabilities: ["contract.extract"],
      authority: ["workspace.read"],
    }],
    edges: [],
  });
  const workforce = new WorkforceRegistry(factoryHome);
  const worker = workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id: "candidate-chicken",
    version: 1,
    runtime: "local",
    provider: "plant",
    model: "candidate-chicken",
    reasoningEffort: null,
    transport: "llama.cpp-native",
    availabilityClass: "local-compute",
    capabilities: ["contract.extract"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
  workforce.qualify({
    workerRef: worker.ref,
    stationRef: waitingStationRef,
    taskFamily: "yard-waiting",
    status: qualified ? "qualified" : "candidate",
    evidence: { articles: 1, passes: qualified ? 1 : 0, escapes: 0, falseStops: 0, p95Ms: 1000, meanTotalTokens: 100, expectedCostUsd: 0 },
    reason: qualified ? "qualified fixture" : "not yet qualified",
  });
  workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "endpoint-ready", slotsAvailable: 1, ttlMs: 60_000 });
  return { factoryHome, worker };
}

describe("multi-job factory yard", () => {
  it("isolates corrupt travelers and ranks every line by supervisor attention", () => {
    const { factoryHome } = populatedYard();
    const yard = projectFactoryYard({ root: factoryHome, idleAfterMs: 30_000 });
    assert.equal(yard.kind, "bantam.factory-yard");
    assert.equal(yard.summary.total, 5);
    assert.equal(yard.dispatch.kind, "bantam.factory-dispatch-board");
    assert.equal(yard.schedule.kind, "bantam.factory-shadow-schedule");
    assert.equal(yard.factControl.kind, "bantam.factory-workforce-health-control");
    assert.equal(yard.factControl.summary.total, 0);
    assert.equal(yard.summary.active, 1);
    assert.equal(yard.summary.released, 1);
    assert.equal(yard.summary.stopped, 1);
    assert.equal(yard.summary.suspectedIdle, 1);
    assert.equal(yard.summary.corrupt, 1);
    assert.equal(yard.workforceError, null);
    assert.deepEqual(yard.lines.map((row) => row.condition), ["corrupt", "stopped", "suspected-idle", "active", "released"]);
    assert.match(yard.lines[0].error, /hash mismatch/);
    assert.equal(yard.lines.find((row) => row.jobId === "released-line").lastEventType, "job.released");
    assert.equal(yard.lines.find((row) => row.jobId === "active-line").currentStation, "agent-1");
  });

  it("renders a script-safe control tower with filters and drill-down bays", () => {
    const { factoryHome } = populatedYard();
    const html = renderFactoryYard(projectFactoryYard({ root: factoryHome }));
    assert.match(html, /BANTAM FACTORY YARD/);
    assert.match(html, /Supervisor queue/);
    assert.match(html, /data-filter="attention"/);
    assert.match(html, /encodeURIComponent\(row\.jobId\)/);
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
  });

  it("distinguishes an unstaffed ready line from running work or generic idle", () => {
    const { factoryHome, worker } = waitingWorkerYard();
    const yard = projectFactoryYard({ root: factoryHome, now: Date.now() + 1_000, idleAfterMs: 1 });
    const line = yard.lines[0];
    assert.equal(yard.summary.active, 0);
    assert.equal(yard.summary.suspectedIdle, 0);
    assert.equal(yard.summary.waitingWorker, 1);
    assert.equal(yard.summary.wip, 0);
    assert.equal(line.condition, "waiting-worker");
    assert.equal(line.currentStation, "contract-edge");
    assert.equal(line.laborWait.code, "worker-unavailable");
    assert.match(line.laborWait.reason, /qualification-candidate/);
    assert.equal(yard.workforce.health.find((row) => row.workerRef === worker.ref).condition, "available");

    const html = renderFactoryYard(yard);
    assert.match(html, /waiting-worker/);
    assert.match(html, /waiting for labor/);
    assert.match(html, /row\.laborWait\?\.reason/);
  });

  it("distinguishes staffed work awaiting dispatch from idle and in-flight WIP", () => {
    const { factoryHome, worker } = waitingWorkerYard({ qualified: true });
    const yard = projectFactoryYard({ root: factoryHome, now: Date.now() + 1_000, idleAfterMs: 1 });
    const line = yard.lines[0];
    assert.equal(yard.summary.active, 0);
    assert.equal(yard.summary.suspectedIdle, 0);
    assert.equal(yard.summary.waitingWorker, 0);
    assert.equal(yard.summary.waitingDispatch, 1);
    assert.equal(yard.summary.wip, 0);
    assert.equal(line.condition, "waiting-dispatch");
    assert.equal(line.dispatchWait.code, "dispatch-required");
    assert.equal(yard.dispatch.operations[0].staffing.selected, worker.ref);
    assert.equal(yard.schedule.allocations[0].workerRef, worker.ref);
    const html = renderFactoryYard(yard);
    assert.match(html, /waiting-dispatch/);
    assert.match(html, /waiting dispatch/);
  });

  it("projects proof-bearing workforce exceptions into the same yard and semantic andon board", () => {
    const { factoryHome, worker } = waitingWorkerYard({ qualified: true });
    const workforce = new WorkforceRegistry(factoryHome);
    workforce.observeHealth({
      workerRef: worker.ref,
      condition: "unavailable",
      code: "api-down",
      slotsAvailable: 0,
      quotaRemaining: 0,
      ttlMs: 60_000,
    });
    const now = Date.now();
    const yard = projectFactoryYard({ root: factoryHome, now, idleAfterMs: 1 });

    assert.equal(yard.factControl.authority, "observe-only");
    assert.equal(yard.summary.semanticAndons, 3);
    assert.deepEqual(yard.factControl.exceptions.map((row) => row.code).sort(), [
      "capacity-zero",
      "health-unavailable",
      "quota-zero",
    ]);
    assert.equal(yard.factControl.inspectedAt, new Date(now).toISOString());
    assert.equal(yard.factControl.exceptions.every((row) => row.proof.parents.some((parent) => parent.datoms.length > 0)), true);

    const html = renderFactoryYard(yard);
    assert.match(html, /Semantic andon board/);
    assert.match(html, /renderFactControl/);
    assert.match(html, /proof leaves/);
    assert.match(html, /worker_health_out_of_control/);
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
  });

  it("plugs an explicit observe-only Datalog control into the shared supervisor surface", () => {
    const { factoryHome } = populatedYard();
    const mutationControl = mutationControlFixture();
    const yard = projectFactoryYard({ root: factoryHome, semanticControls: [mutationControl] });
    assert.equal(yard.semanticControls.length, 2);
    assert.equal(yard.semanticControls[1].artifactId, mutationControl.artifactId);
    assert.equal(yard.summary.semanticAndons, 1);
    const html = renderFactoryYard(yard);
    assert.match(html, /semanticControls/);
    assert.match(html, /model-observed-authority-gap/);
    assert.match(html, /SEMANTIC OBJECT/);
    assert.match(html, /slice\(0,40\)/);
    assert.match(html, /slice\(0,24\)/);
    assert.doesNotThrow(() => projectFactoryYard({ root: factoryHome, semanticControls: [] }));
    assert.throws(() => projectFactoryYard({ root: factoryHome, semanticControls: [{ ...mutationControl, authority: "dispatch" }] }), /observe-only/);
  });

  it("serves the yard and audited single-line drill-down from one local listener", async () => {
    const { factoryHome, active } = populatedYard();
    await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "blueprinted-line",
      contract: "An empty input returns an empty result.",
      catalog: [{ id: "empty-input", description: "The contract explicitly defines empty input." }],
      expectedEdges: ["empty-input"],
      model: new BlueprintModel(),
    });
    const server = await startFactoryYardServer({ root: factoryHome, port: 0, pollIntervalMs: 100, idleAfterMs: 30_000, semanticControls: [mutationControlFixture()] });
    servers.add(server);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(await page.text(), /Factory lines/);
    const yard = await (await fetch(new URL("/api/yard", server.url))).json();
    assert.equal(yard.summary.total, 6);
    assert.equal(yard.summary.semanticAndons, 1);
    assert.equal(yard.semanticControls.at(-1).kind, "bantam.factory-mutation-authority-control");
    assert.equal(yard.lines.find((row) => row.jobId === "corrupt-line").condition, "corrupt");
    assert.equal(yard.dispatch.authority, "observe-only");
    assert.equal(yard.schedule.authority, "observe-only");
    const floor = await fetch(new URL("/jobs/active-line", server.url));
    assert.equal(floor.status, 200);
    assert.match(await floor.text(), /"liveEndpoint":"\/api\/jobs\/active-line"/);
    const before = await (await fetch(new URL("/api/jobs/active-line", server.url))).json();
    active.note({ type: "observation", turn: 1, observation: "new production evidence" });
    const after = await (await fetch(new URL("/api/jobs/active-line", server.url))).json();
    assert.ok(after.events.length > before.events.length);
    const blueprintApi = await (await fetch(new URL("/api/blueprints/blueprinted-line", server.url))).json();
    assert.equal(blueprintApi.kind, "bantam.factory-blueprint-projection");
    assert.equal(blueprintApi.live, true);
    assert.deepEqual(blueprintApi.nodes.map((node) => node.state), ["released", "released", "released"]);
    const blueprintPage = await fetch(new URL("/blueprints/blueprinted-line", server.url));
    assert.equal(blueprintPage.status, 200);
    assert.match(await blueprintPage.text(), /Executable factory layout/);
    const blueprintFloor = await fetch(new URL("/jobs/blueprinted-line", server.url));
    assert.match(await blueprintFloor.text(), /class="blueprint-link"/);
    assert.equal((await fetch(new URL("/blueprints/active-line", server.url))).status, 503);
    assert.equal((await fetch(new URL("/jobs/corrupt-line", server.url))).status, 503);
    assert.equal((await fetch(new URL("/package.json", server.url))).status, 404);
    assert.equal((await fetch(new URL("/api/yard", server.url), { method: "POST" })).status, 405);
  });

  it("exposes a blocking yard CLI with a clean injected lifecycle", async () => {
    const { factoryHome } = populatedYard();
    const stdout = memoryStream();
    const stderr = memoryStream();
    let options;
    const code = await runFactoryCommand(["factory", "yard", "--factory-home", factoryHome, "--port", "0"], {
      stdout,
      stderr,
      startYardServerFn: async (value) => {
        options = value;
        return { url: "http://127.0.0.1:45678/", closed: Promise.resolve() };
      },
    });
    assert.equal(code, 0);
    assert.equal(stderr.text(), "");
    assert.match(stdout.text(), /control tower/);
    assert.equal(options.port, 0);
    assert.equal(options.idleAfterMs, 30_000);

    const invalidError = memoryStream();
    assert.equal(await runFactoryCommand(["factory", "yard", "--idle-after", "86400001"], {
      stdout: memoryStream(),
      stderr: invalidError,
    }), 2);
    assert.match(invalidError.text(), /at most 86400000ms/);
  });
});
