import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { defineWorkerProfile, WorkforceRegistry } from "../src/factory.js";
import { runFactoryCommand } from "../src/factory-cli.js";

const station = `station:lifecycle-diagnosis@2:sha256:${"a".repeat(64)}`;
const roots = new Set();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-workforce-test-"));
  roots.add(root);
  return new WorkforceRegistry(root);
}

function profile(id, { runtime = "codex", model = id, availabilityClass = "remote-api", capabilities = ["code.diagnose"], costKind = "subscription" } = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id,
    version: 1,
    runtime,
    provider: runtime === "local" ? "plant" : "openai",
    model,
    reasoningEffort: "medium",
    transport: runtime === "local" ? "openai-compatible" : "codex-app-server",
    availabilityClass,
    capabilities,
    cost: { kind: costKind, currency: costKind === "none" ? null : "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  };
}

function qualify(registry, workerRef, expectedCostUsd, p95Ms = 20_000) {
  return registry.qualify({
    workerRef,
    stationRef: station,
    taskFamily: "async-keyed-lifecycle",
    status: "qualified",
    evidence: { articles: 10, passes: 9, escapes: 0, falseStops: 0, p95Ms, meanTotalTokens: 50_000, expectedCostUsd },
    limits: { maxP95Ms: 60_000, maxExpectedCostUsd: 1, authority: ["workspace.read"] },
    reason: "controlled qualification cohort",
  });
}

describe("factory model workforce", () => {
  it("creates stable content-addressed worker identities and refuses version collisions", () => {
    const value = profile("terra-medium");
    assert.equal(defineWorkerProfile(value).ref, defineWorkerProfile(value).ref);
    const workers = registry();
    const installed = workers.install(value);
    assert.equal(workers.install(value).ref, installed.ref);
    assert.throws(() => workers.install({ ...value, model: "different" }), /different bytes/);
    assert.equal(workers.project().profiles.length, 1);
  });

  it("selects the lowest-cost available qualified worker for an exact station role", () => {
    const workers = registry();
    const terra = workers.install(profile("terra-medium"));
    const local = workers.install(profile("local-27b", { runtime: "local", model: "gemma-27b-q4", availabilityClass: "local-compute", costKind: "local" }));
    qualify(workers, terra.ref, 0.20, 16_000);
    qualify(workers, local.ref, 0.02, 22_000);
    workers.observeHealth({ workerRef: terra.ref, condition: "available", code: "transport-ok", ttlMs: 60_000, slotsAvailable: 4 });
    workers.observeHealth({ workerRef: local.ref, condition: "available", code: "gpu-ready", ttlMs: 60_000, slotsAvailable: 1 });

    const recommendation = workers.eligible({ stationRef: station, taskFamily: "async-keyed-lifecycle", requiredCapabilities: ["code.diagnose"] });
    assert.equal(recommendation.mode, "shadow");
    assert.equal(recommendation.selected, local.ref);
    assert.deepEqual(recommendation.eligible.map((row) => row.workerRef), [local.ref, terra.ref]);
  });

  it("reroutes around a no-show without revoking the worker's qualification", () => {
    const workers = registry();
    const terra = workers.install(profile("terra-medium"));
    const local = workers.install(profile("local-27b", { runtime: "local", availabilityClass: "local-compute", costKind: "local" }));
    qualify(workers, terra.ref, 0.20);
    qualify(workers, local.ref, 0.02);
    workers.observeHealth({ workerRef: terra.ref, condition: "available", code: "transport-ok", slotsAvailable: 2 });
    workers.observeHealth({ workerRef: local.ref, condition: "unavailable", code: "gpu-offline", slotsAvailable: 0 });

    const recommendation = workers.eligible({ stationRef: station, taskFamily: "async-keyed-lifecycle" });
    assert.equal(recommendation.selected, terra.ref);
    assert.deepEqual(recommendation.rejected.find((row) => row.workerRef === local.ref).reasons, ["unavailable:gpu-offline", "capacity-zero"]);
    assert.equal(workers.project().qualifications.find((row) => row.workerRef === local.ref).status, "qualified");
  });

  it("does not staff a worker whose current quota is explicitly empty", () => {
    const workers = registry();
    const terra = workers.install(profile("terra-quota"));
    qualify(workers, terra.ref, 0.2);
    workers.observeHealth({ workerRef: terra.ref, condition: "available", code: "transport-ok", slotsAvailable: 2, quotaRemaining: 0 });
    const report = workers.eligible({ stationRef: station, taskFamily: "async-keyed-lifecycle" });
    assert.equal(report.selected, null);
    assert.deepEqual(report.rejected[0].reasons, ["quota-zero"]);
  });

  it("expires transient health, honors suspension, capacity, and policy limits with explicit reasons", () => {
    const workers = registry();
    const fast = workers.install(profile("fast-worker", { capabilities: ["code.diagnose", "private-data"] }));
    const slow = workers.install(profile("slow-worker"));
    qualify(workers, fast.ref, 0.50, 10_000);
    qualify(workers, slow.ref, 0.10, 90_000);
    workers.observeHealth({ workerRef: fast.ref, condition: "unavailable", code: "quota-empty", ttlMs: 1, slotsAvailable: 0 });
    workers.qualify({ workerRef: fast.ref, stationRef: station, taskFamily: "async-keyed-lifecycle", status: "suspended", reason: "quality review" });

    const report = workers.eligible({
      stationRef: station,
      taskFamily: "async-keyed-lifecycle",
      requiredCapabilities: ["private-data"],
      maxP95Ms: 30_000,
      maxExpectedCostUsd: 0.25,
      now: Date.now() + 10_000,
    });
    assert.equal(report.selected, null);
    assert.deepEqual(report.rejected.find((row) => row.workerRef === fast.ref).reasons, ["qualification-suspended", "cost-limit"]);
    assert.deepEqual(report.rejected.find((row) => row.workerRef === slow.ref).reasons, ["missing-capability:private-data", "p95-limit"]);
    assert.equal(workers.project({ now: Date.now() + 10_000 }).health.find((row) => row.workerRef === fast.ref).current, false);
  });

  it("keeps qualifications isolated by station version and task family", () => {
    const workers = registry();
    const terra = workers.install(profile("terra-medium"));
    qualify(workers, terra.ref, 0.2);
    const otherStation = `station:lifecycle-diagnosis@3:sha256:${"b".repeat(64)}`;
    const report = workers.eligible({ stationRef: otherStation, taskFamily: "async-keyed-lifecycle" });
    assert.equal(report.selected, null);
    assert.deepEqual(report.rejected[0].reasons, ["not-qualified"]);
  });

  it("operates hire, qualification, health, and shadow substitution through the CLI", async () => {
    const workers = registry();
    const factoryRoot = workers.root;
    const profileFile = path.join(factoryRoot, "profile.json");
    const evidenceFile = path.join(factoryRoot, "evidence.json");
    const limitsFile = path.join(factoryRoot, "limits.json");
    fs.writeFileSync(profileFile, JSON.stringify(profile("terra-medium")));
    fs.writeFileSync(evidenceFile, JSON.stringify({ articles: 3, passes: 3, escapes: 0, falseStops: 0, p95Ms: 20_000, meanTotalTokens: 50_000, expectedCostUsd: 0.2 }));
    fs.writeFileSync(limitsFile, JSON.stringify({ maxP95Ms: 60_000, maxExpectedCostUsd: 1, authority: ["workspace.read"] }));

    const refused = sink();
    assert.equal(await runFactoryCommand(["factory", "workers", "install", profileFile, "--factory-home", factoryRoot], { stdout: sink(), stderr: refused }), 2);
    assert.match(refused.text(), /repeat with --yes/);

    const installedOut = sink();
    assert.equal(await runFactoryCommand(["factory", "workers", "install", profileFile, "--yes", "--factory-home", factoryRoot, "--json"], { stdout: installedOut, stderr: sink() }), 0);
    const workerRef = JSON.parse(installedOut.text()).ref;
    assert.equal(await runFactoryCommand([
      "factory", "workers", "qualify", workerRef, "--station-ref", station,
      "--task-family", "async-keyed-lifecycle", "--status", "qualified",
      "--evidence", evidenceFile, "--limits", limitsFile, "--yes", "--factory-home", factoryRoot,
    ], { stdout: sink(), stderr: sink() }), 0);
    assert.equal(await runFactoryCommand([
      "factory", "workers", "health", workerRef, "--condition", "available", "--code", "transport-ok",
      "--ttl", "60000", "--slots", "1", "--yes", "--factory-home", factoryRoot,
    ], { stdout: sink(), stderr: sink() }), 0);

    const eligible = sink();
    assert.equal(await runFactoryCommand([
      "factory", "workers", "eligible", "--station-ref", station, "--task-family", "async-keyed-lifecycle",
      "--factory-home", factoryRoot, "--json",
    ], { stdout: eligible, stderr: sink() }), 0);
    assert.equal(JSON.parse(eligible.text()).selected, workerRef);

    assert.equal(await runFactoryCommand([
      "factory", "workers", "health", workerRef, "--condition", "unavailable", "--code", "quota-empty",
      "--slots", "0", "--yes", "--factory-home", factoryRoot,
    ], { stdout: sink(), stderr: sink() }), 0);
    const substitute = sink();
    assert.equal(await runFactoryCommand([
      "factory", "workers", "eligible", "--station-ref", station, "--task-family", "async-keyed-lifecycle",
      "--factory-home", factoryRoot,
    ], { stdout: substitute, stderr: sink() }), 1);
    assert.match(substitute.text(), /selected none/);
    assert.match(substitute.text(), /unavailable:quota-empty/);
  });

  it("imports audited station performance only as candidate qualification evidence", () => {
    const workers = registry();
    const ids = ["1", "2", "3"].map((digit) => `sha256:${digit.repeat(64)}`);
    const events = [
      { id: ids[0], type: "station.started", payload: { stationAttempt: "diagnosis-1", stationRef: station } },
      { id: ids[1], type: "gauge.result", payload: { stationAttempt: "diagnosis-1", status: "pass" } },
      { id: ids[2], type: "station.performance", payload: {
        stationAttempt: "diagnosis-1", workerRef: "codex:gpt-5.6-terra:medium",
        operationMs: 15_000, inspectionMs: 20, totalTokens: 48_000, estimatedCostUsd: 0,
      } },
    ];
    const imported = workers.ingestFactoryPerformance({ events, taskFamily: "async-keyed-lifecycle" });
    assert.equal(imported.length, 1);
    assert.equal(imported[0].evidence.passes, 1);
    assert.deepEqual(imported[0].evidence.sourceRefs, ids);
    const state = workers.project();
    assert.equal(state.profiles[0].model, "gpt-5.6-terra");
    assert.equal(state.qualifications[0].status, "candidate");
    const recommendation = workers.eligible({ stationRef: station, taskFamily: "async-keyed-lifecycle" });
    assert.equal(recommendation.selected, null);
    assert.deepEqual(recommendation.rejected[0].reasons, ["qualification-candidate"]);
  });

  it("charges an exact downstream rejection as a local-worker escape and suspends a qualified role", () => {
    const workers = registry();
    const inspection = `station:independent-inspection@1:sha256:${"b".repeat(64)}`;
    const article = (offset) => {
      const ids = Array.from({ length: 8 }, (_, index) => `sha256:${String(offset + index).padStart(2, "0").repeat(32)}`);
      return {
        ids,
        events: [
          { id: ids[0], type: "station.started", payload: { stationAttempt: `implementation-${offset}`, stationRef: station, inputProductRevision: `tree:base-${offset}` } },
          { id: ids[1], type: "station.completed", payload: { stationAttempt: `implementation-${offset}`, outputProductRevision: `tree:candidate-${offset}` } },
          { id: ids[2], type: "gauge.result", payload: { stationAttempt: `implementation-${offset}`, status: "pass" } },
          { id: ids[3], type: "station.performance", payload: {
            stationAttempt: `implementation-${offset}`,
            workerRef: "local:Qwen3.6-27B-Q4_K_M.gguf",
            operationMs: 21_000,
            inspectionMs: 20,
            totalTokens: 29_000,
            estimatedCostUsd: 0,
          } },
          { id: ids[4], type: "station.released", payload: { stationAttempt: `implementation-${offset}`, productRevision: `tree:candidate-${offset}` } },
          { id: ids[5], type: "station.started", payload: { stationAttempt: `inspection-${offset}`, stationRef: inspection, inputProductRevision: `tree:candidate-${offset}` } },
          { id: ids[6], type: "station.completed", payload: { stationAttempt: `inspection-${offset}`, outputProductRevision: `tree:candidate-${offset}` } },
          { id: ids[7], type: "gauge.result", payload: { stationAttempt: `inspection-${offset}`, status: "fail" } },
        ],
      };
    };

    const first = article(10);
    const imported = workers.ingestFactoryPerformance({ events: first.events, taskFamily: "general-coding" });
    assert.equal(imported[0].profile.runtime, "local");
    assert.equal(imported[0].profile.model, "Qwen3.6-27B-Q4_K_M.gguf");
    assert.deepEqual(imported[0].profile.capabilities, ["code.general", "model.semantic-work"]);
    assert.equal(imported[0].evidence.articles, 1);
    assert.equal(imported[0].evidence.passes, 0);
    assert.equal(imported[0].evidence.escapes, 1);
    assert.ok(imported[0].evidence.sourceRefs.includes(first.ids[7]));
    assert.equal(imported[0].qualificationEvent.payload.status, "candidate");

    const beforeDuplicate = workers.project().events;
    const duplicate = workers.ingestFactoryPerformance({ events: first.events, taskFamily: "general-coding" });
    assert.equal(duplicate[0].duplicate, true);
    assert.equal(workers.project().events, beforeDuplicate);

    workers.qualify({
      workerRef: imported[0].profile.ref,
      stationRef: station,
      taskFamily: "general-coding",
      status: "qualified",
      evidence: imported[0].evidence,
      reason: "operator-controlled provisional qualification",
    });
    const second = article(30);
    const escapedAgain = workers.ingestFactoryPerformance({ events: second.events, taskFamily: "general-coding" });
    assert.equal(escapedAgain[0].evidence.articles, 2);
    assert.equal(escapedAgain[0].evidence.passes, 0);
    assert.equal(escapedAgain[0].evidence.escapes, 2);
    assert.equal(escapedAgain[0].qualificationEvent.payload.status, "suspended");
    assert.match(escapedAgain[0].qualificationEvent.payload.reason, /downstream escape/);
  });

  it("binds live attendance only to an installed exact runtime identity", () => {
    const workers = registry();
    const installed = workers.install(profile("codex-gpt-5.6-terra-medium", { model: "gpt-5.6-terra", capabilities: ["model.semantic-work"] }));
    assert.equal(workers.profileForRuntimeIdentity("codex:gpt-5.6-terra:medium").ref, installed.ref);
    assert.equal(workers.profileForRuntimeIdentity("bantam-agent:injected"), null);
    assert.equal(workers.observeRuntimeHealth({ identity: "codex:gpt-5.6-sol:high", condition: "available", code: "station-response" }), null);
    workers.observeRuntimeHealth({ identity: "codex:gpt-5.6-terra:medium", condition: "unavailable", code: "quota-unavailable", detail: "diagnosis-1" });
    const health = workers.project().health[0];
    assert.equal(health.workerRef, installed.ref);
    assert.equal(health.condition, "unavailable");
    assert.equal(health.code, "quota-unavailable");
  });
});

function sink() { let value = ""; return { write(chunk) { value += chunk; }, text() { return value; } }; }
