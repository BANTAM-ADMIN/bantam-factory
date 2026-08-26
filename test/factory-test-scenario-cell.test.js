import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import { certifyTestScenarioWorker, projectFactoryBlueprint, runTestScenarioFactoryCell, TEST_SCENARIO_QUALIFICATION_POLICY, testScenarioCellLine, testScenarioGrammar, validateTestScenarioResponse, WorkforceRegistry } from "../src/factory.js";

const roots = new Set();
const scenarios = [
  { id: "return-null", description: "Look up an absent key and assert the result is null." },
  { id: "return-undefined", description: "Look up an absent key and assert the result is undefined." },
  { id: "throw-error", description: "Look up an absent key and assert the operation throws." },
];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-test-scenario-"));
  roots.add(root);
  return root;
}

class Model {
  constructor(scenarioId, raw = null) {
    this.scenarioId = scenarioId;
    this.raw = raw;
    this.calls = [];
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }
  metadata() { return { runtime: "local", model: "test-scenario-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete(prompt, options) {
    this.calls.push({ prompt, options });
    this.usage = { ...this.usage, requests: 1, inputTokens: 24, outputTokens: 8, totalTokens: 32, cacheMissTokens: 24 };
    return { content: this.raw ?? JSON.stringify({ schema: 1, kind: "bantam.test-scenario-selection", scenarioId: this.scenarioId }), tokens: 8, stoppedEos: true, stoppedLimit: false };
  }
}

function article(root, model, overrides = {}) {
  return runTestScenarioFactoryCell({
    root,
    jobId: overrides.jobId ?? "scenario-article",
    edgeId: "missing-key",
    obligation: "A lookup for an absent key must return null.",
    scenarios,
    expectedScenario: "return-null",
    model,
    ...overrides,
  });
}

function candidate(workforce, evidence = {}) {
  const worker = workforce.install({
    schema: 1, kind: "bantam.factory-worker-profile", id: "scenario-worker", version: 1,
    runtime: "local", provider: "plant", model: "scenario-worker", reasoningEffort: null,
    transport: "llama.cpp-native", availabilityClass: "local-compute", capabilities: ["model.semantic-work"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
  workforce.qualify({
    workerRef: worker.ref,
    stationRef: testScenarioCellLine().assets.select.ref,
    taskFamily: "test-scenario-selection",
    status: "candidate",
    evidence: { articles: 5, passes: 5, escapes: 0, falseStops: 0, p95Ms: 1_500, meanTotalTokens: 390, expectedCostUsd: 0, sourceRefs: ["a", "b", "c", "d", "e"].map((value) => `sha256:${value.repeat(64)}`), ...evidence },
    reason: "controlled scenario cohort",
  });
  return worker;
}

describe("single-obligation test scenario cell", () => {
  it("compiles a three-station plant with an exact station task-family override", () => {
    const plant = testScenarioCellLine();
    assert.equal(plant.blueprint.ref, "blueprint:test-scenario-cell@1:sha256:3a0158fb7c304cc4426f198aa1da0787a3cd2c32d9969b078992d8d50c3443d4");
    assert.equal(plant.route.ref, "route:test-scenario-cell:sha256:0598b131948b17ffe5c1eb13af64a2a7ff66459c374c961543b441c7172e26c7");
    assert.equal(plant.assets.select.ref, "station:test-scenario-selector@1:sha256:39ecf8422b98eb58b0c65ce9179ce289d44eebca56631c3e6aeaec8202845915");
    const projection = projectFactoryBlueprint(plant);
    assert.deepEqual(projection.nodes.map((node) => node.taskFamily), ["contract-test-case-assembly", "test-scenario-selection", "contract-test-case-assembly"]);
    assert.match(testScenarioGrammar(scenarios.map((row) => row.id)), /return-null/);
  });

  it("releases one exact scenario while exposing no contract, plan, workspace, or tools", async () => {
    const model = new Model("return-null");
    const result = await article(temporary(), model);
    assert.equal(result.status, "released");
    assert.equal(result.line.events.length, 23);
    assert.equal(result.selection.scenarioId, "return-null");
    const plan = result.line.events.find((event) => event.type === "route.plan").payload;
    assert.equal(plan.taskFamily, "contract-test-case-assembly");
    assert.equal(plan.stations.find((row) => row.id === "select").taskFamily, "test-scenario-selection");
    assert.match(model.calls[0].prompt, /A lookup for an absent key/);
    assert.doesNotMatch(model.calls[0].prompt, /whole contract|test-plan|workspace/i);
    assert.equal(Object.hasOwn(model.calls[0].options, "tools"), false);
    const projection = projectFactoryBlueprint(testScenarioCellLine(), { events: result.line.events });
    assert.deepEqual(projection.nodes.map((node) => node.state), ["released", "released", "released"]);
  });

  it("contains a conforming but wrong scenario only at the independent downstream gauge", async () => {
    const result = await article(temporary(), new Model("throw-error"));
    assert.equal(result.status, "blocked");
    assert.equal(result.selection.scenarioId, "throw-error");
    assert.equal(result.line.supervisor.firstAbnormal.detectedAtStation, "inspection-1");
    assert.equal(result.line.supervisor.firstAbnormal.createdAtStation, null);
    assert.equal(result.line.events.filter((event) => event.type === "gauge.result").map((event) => event.payload.status).join(","), "pass,pass,fail");
  });

  it("rejects malformed and expanded responses at the local die", async () => {
    assert.equal(validateTestScenarioResponse("not-json", scenarios).code, "invalid-json");
    assert.equal(validateTestScenarioResponse('{"schema":1,"kind":"bantam.test-scenario-selection","scenarioId":"unknown"}', scenarios).code, "unknown-scenario");
    assert.equal(validateTestScenarioResponse('{"schema":1,"kind":"bantam.test-scenario-selection","scenarioId":"return-null","extra":true}', scenarios).code, "schema-expansion");
    const result = await article(temporary(), new Model(null, "not-json"));
    assert.equal(result.status, "blocked");
    assert.equal(result.line.events.some((event) => event.type === "station.started" && event.payload.stationAttempt.startsWith("inspection")), false);
  });

  it("rejects lossy or ambiguous fixtures before traveler creation", async () => {
    const root = temporary();
    await assert.rejects(article(root, new Model("return-null"), { scenarios: [scenarios[0]] }), /from 2 to 32/);
    await assert.rejects(article(root, new Model("return-null"), { expectedScenario: "absent" }), /absent from public rack/);
    assert.equal(fs.existsSync(path.join(root, "journal")), false);
  });

  it("runs the bounded station through the factory CLI", async () => {
    const root = temporary();
    const catalogFile = path.join(root, "scenarios.json");
    fs.writeFileSync(catalogFile, JSON.stringify(scenarios));
    let stdout = "", stderr = "";
    const code = await runFactoryCommand([
      "factory", "test-scenario", "A lookup for an absent key must return null.",
      "--edge-id", "missing-key", "--catalog", catalogFile, "--expected", "return-null",
      "--factory-home", path.join(root, "factory"), "--job-id", "scenario-cli", "--json",
    ], { model: new Model("return-null"), stdout: { write(value) { stdout += String(value); } }, stderr: { write(value) { stderr += String(value); } } });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.kind, "bantam.factory-test-scenario-command-result");
    assert.equal(result.selection.scenarioId, "return-null");
    assert.equal(result.travelerEvents, 23);
  });

  it("certifies only the exact scenario-selector role under a mechanical policy", () => {
    const workforce = new WorkforceRegistry(temporary());
    const worker = candidate(workforce);
    const certified = certifyTestScenarioWorker({ workforce, workerRef: worker.ref });
    assert.equal(certified.policy.ref, "qualification-policy:test-scenario-first-cohort@1:sha256:bc680d12ccaa174ffbbb63033fae0474739daa5fac6be231bc02392a8572c883");
    assert.equal(certified.qualification.status, "qualified");
    assert.deepEqual(certified.qualification.limits.authority, ["test-obligation.read"]);
    workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "ready", slotsAvailable: 1 });
    assert.equal(workforce.eligible({ stationRef: certified.qualification.stationRef, taskFamily: "test-scenario-selection", requiredCapabilities: ["model.semantic-work"] }).selected, worker.ref);
    assert.equal(workforce.eligible({ stationRef: certified.qualification.stationRef, taskFamily: "contract-edge-enumeration", requiredCapabilities: ["model.semantic-work"] }).selected, null);
  });

  it("refuses lossy evidence and exposes certification through the CLI interlock", async () => {
    const factoryHome = temporary();
    const workforce = new WorkforceRegistry(factoryHome);
    const bad = candidate(workforce, { articles: 4, passes: 3, escapes: 1, p95Ms: 6_000, meanTotalTokens: 800 });
    assert.throws(() => certifyTestScenarioWorker({ workforce, workerRef: bad.ref }), /articles 4\/5; yield 0\.750\/1\.000; escapes 1\/0; p95 6000\/5000ms; mean-tokens 800\/700/);

    const cleanHome = temporary();
    const cleanWorkforce = new WorkforceRegistry(cleanHome);
    const clean = candidate(cleanWorkforce);
    let stdout = "", stderr = "";
    const code = await runFactoryCommand(["factory", "workers", "certify-test-scenario", clean.ref, "--factory-home", cleanHome, "--yes", "--json"], { stdout: { write(value) { stdout += String(value); } }, stderr: { write(value) { stderr += String(value); } } });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).qualification.status, "qualified");
    assert.equal(TEST_SCENARIO_QUALIFICATION_POLICY.maximumP95Ms, 5_000);
  });
});
