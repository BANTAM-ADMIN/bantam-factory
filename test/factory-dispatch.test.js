import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import { FactoryStore, projectFactoryDispatchBoard, WorkforceRegistry } from "../src/factory.js";

const roots = new Set();
const diagnosisRef = `station:dispatch-diagnosis@1:sha256:${"d".repeat(64)}`;
const intakeRef = `station:dispatch-intake@1:sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function factory({ stationTaskFamily = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-dispatch-"));
  roots.add(root);
  const writer = new FactoryStore(root).create({
    jobId: "dispatch-article",
    routeRef: "route:dispatch-cell:sha256:article",
    initialProductRevision: "tree:input",
  });
  writer.append("route.validated", { routeRef: "route:dispatch-cell:sha256:article" });
  writer.append("route.plan", {
    routeRef: "route:dispatch-cell:sha256:article",
    taskFamily: "dispatch-specimen",
    stations: [
      { id: "intake", stationRef: intakeRef, title: "Material intake", workerKind: "tool", capabilities: [], authority: ["workspace.read"] },
      { id: "diagnosis", stationRef: diagnosisRef, title: "Bounded diagnosis", workerKind: "model", capabilities: ["code.diagnose"], authority: ["workspace.read"], ...(stationTaskFamily ? { taskFamily: stationTaskFamily } : {}) },
    ],
    edges: [{ from: "intake", to: "diagnosis" }],
  });
  return { root, writer };
}

function profile(id, { runtime = "codex", costKind = "subscription" } = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id,
    version: 1,
    runtime,
    provider: runtime === "local" ? "plant" : "openai",
    model: id,
    reasoningEffort: "medium",
    transport: runtime === "local" ? "openai-compatible" : "codex-app-server",
    availabilityClass: runtime === "local" ? "local-compute" : "remote-api",
    capabilities: ["code.diagnose"],
    cost: { kind: costKind, currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  };
}

function qualify(workforce, workerRef, expectedCostUsd, taskFamily = "dispatch-specimen") {
  workforce.qualify({
    workerRef,
    stationRef: diagnosisRef,
    taskFamily,
    status: "qualified",
    evidence: { articles: 5, passes: 5, escapes: 0, falseStops: 0, p95Ms: 20_000, meanTotalTokens: 20_000, expectedCostUsd },
    reason: "dispatch board controlled specimen",
  });
}

function streams() {
  let output = "";
  return { write(value) { output += String(value); }, text() { return output; } };
}

describe("factory shadow dispatch board", () => {
  it("projects dependency-ready, running, blocked, and completed operations from route facts", () => {
    const { root, writer } = factory();
    let board = projectFactoryDispatchBoard({ root });
    assert.deepEqual(board.operations.map((row) => [row.stationId, row.state]), [["intake", "ready"], ["diagnosis", "blocked"]]);

    writer.append("station.started", { stationAttempt: "intake-1", routeStationId: "intake", stationRef: intakeRef, inputProductRevision: "tree:input", stationTitle: "Material intake", workerKind: "tool", standardWork: null });
    board = projectFactoryDispatchBoard({ root });
    assert.equal(board.operations.find((row) => row.stationId === "intake").state, "running");

    writer.append("station.completed", { stationAttempt: "intake-1", inputProductRevision: "tree:input", outputProductRevision: "tree:input", artifactRefs: [] });
    writer.append("gauge.result", { stationAttempt: "intake-1", gaugeRef: "gauge:intake", status: "pass", evidenceRefs: [] });
    writer.append("station.released", { stationAttempt: "intake-1", productRevision: "tree:input" });
    board = projectFactoryDispatchBoard({ root });
    assert.equal(board.operations.find((row) => row.stationId === "intake").state, "completed");
    assert.equal(board.operations.find((row) => row.stationId === "diagnosis").state, "ready");
  });

  it("recommends a reversible substitute without changing the traveler", () => {
    const { root, writer } = factory();
    writer.append("station.started", { stationAttempt: "intake-1", routeStationId: "intake", stationRef: intakeRef, inputProductRevision: "tree:input", stationTitle: "Material intake", workerKind: "tool", standardWork: null });
    writer.append("station.completed", { stationAttempt: "intake-1", inputProductRevision: "tree:input", outputProductRevision: "tree:input", artifactRefs: [] });
    writer.append("gauge.result", { stationAttempt: "intake-1", gaugeRef: "gauge:intake", status: "pass", evidenceRefs: [] });
    writer.append("station.released", { stationAttempt: "intake-1", productRevision: "tree:input" });
    const eventsBefore = writer.events.length;

    const workforce = new WorkforceRegistry(root);
    const local = workforce.install(profile("local-27b", { runtime: "local", costKind: "local" }));
    const terra = workforce.install(profile("terra-medium"));
    qualify(workforce, local.ref, 0.01);
    qualify(workforce, terra.ref, 0.20);
    workforce.observeHealth({ workerRef: local.ref, condition: "unavailable", code: "gpu-offline", slotsAvailable: 0 });
    workforce.observeHealth({ workerRef: terra.ref, condition: "available", code: "transport-ok", slotsAvailable: 1 });

    let operation = projectFactoryDispatchBoard({ root }).operations.find((row) => row.stationId === "diagnosis");
    assert.equal(operation.staffing.decision, "substitute");
    assert.equal(operation.staffing.selected, terra.ref);
    assert.deepEqual(operation.staffing.rejected.find((row) => row.workerRef === local.ref).reasons, ["unavailable:gpu-offline", "capacity-zero"]);

    workforce.observeHealth({ workerRef: local.ref, condition: "available", code: "gpu-restored", slotsAvailable: 1 });
    operation = projectFactoryDispatchBoard({ root }).operations.find((row) => row.stationId === "diagnosis");
    assert.equal(operation.staffing.decision, "recommend");
    assert.equal(operation.staffing.selected, local.ref);
    assert.equal(writer.events.length, eventsBefore);
  });

  it("binds staffing to a station task family without changing the route-wide default", () => {
    const { root, writer } = factory({ stationTaskFamily: "bounded-diagnosis" });
    writer.append("station.started", { stationAttempt: "intake-1", routeStationId: "intake", stationRef: intakeRef, inputProductRevision: "tree:input", stationTitle: "Material intake", workerKind: "tool", standardWork: null });
    writer.append("station.completed", { stationAttempt: "intake-1", inputProductRevision: "tree:input", outputProductRevision: "tree:input", artifactRefs: [] });
    writer.append("gauge.result", { stationAttempt: "intake-1", gaugeRef: "gauge:intake", status: "pass", evidenceRefs: [] });
    writer.append("station.released", { stationAttempt: "intake-1", productRevision: "tree:input" });
    const workforce = new WorkforceRegistry(root);
    const worker = workforce.install(profile("specialist"));
    qualify(workforce, worker.ref, 0.1, "bounded-diagnosis");
    workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "ready", slotsAvailable: 1 });
    const board = projectFactoryDispatchBoard({ root });
    const intake = board.operations.find((row) => row.stationId === "intake");
    const diagnosis = board.operations.find((row) => row.stationId === "diagnosis");
    assert.equal(board.jobs[0].taskFamily, "dispatch-specimen");
    assert.equal(intake.taskFamily, "dispatch-specimen");
    assert.equal(diagnosis.taskFamily, "bounded-diagnosis");
    assert.equal(diagnosis.staffing.selected, worker.ref);
  });

  it("never proposes a staffing change for blocked or completed work", () => {
    const { root, writer } = factory();
    writer.append("job.blocked", { code: "material-hold", reason: "Input material was held." });
    const board = projectFactoryDispatchBoard({ root });
    const model = board.operations.find((row) => row.stationId === "diagnosis");
    assert.equal(model.state, "blocked");
    assert.equal(model.staffing.decision, "deferred");
    assert.equal(model.staffing.selected, null);
    assert.match(model.explanation, /terminal disposition.*staffing deferred/);
  });

  it("fails honest for legacy travelers that do not record a route plan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-dispatch-legacy-"));
    roots.add(root);
    new FactoryStore(root).create({ jobId: "legacy", routeRef: "route:legacy", initialProductRevision: "tree:legacy" });
    const board = projectFactoryDispatchBoard({ root });
    assert.equal(board.summary.planUnavailable, 1);
    assert.match(board.jobs[0].error, /plan is not recorded/);
    assert.deepEqual(board.operations, []);
  });

  it("rejects route plans that lie about topology or station identity", () => {
    const { writer } = factory();
    assert.throws(() => writer.append("route.plan", {
      routeRef: "route:dispatch-cell:sha256:article",
      taskFamily: "dispatch-specimen",
      stations: [{ id: "loop", stationRef: intakeRef, title: "Loop", workerKind: "tool", capabilities: [], authority: [] }],
      edges: [{ from: "loop", to: "loop" }],
    }), /multiple route.plan|invalid route plan edge/);
    assert.throws(() => writer.append("station.started", { stationAttempt: "wrong-1", routeStationId: "diagnosis", stationRef: intakeRef, inputProductRevision: "tree:input", stationTitle: "Wrong", workerKind: "model", standardWork: null }), /does not match planned station/);
  });

  it("exposes the board as a read-only CLI projection", async () => {
    const { root } = factory();
    const stdout = streams();
    const stderr = streams();
    assert.equal(await runFactoryCommand(["factory", "dispatch", "--factory-home", root, "--json"], { stdout, stderr }), 0);
    const board = JSON.parse(stdout.text());
    assert.equal(board.kind, "bantam.factory-dispatch-board");
    assert.equal(board.authority, "observe-only");
    assert.equal(stderr.text(), "");
  });
});
