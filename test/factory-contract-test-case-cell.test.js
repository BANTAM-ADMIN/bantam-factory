import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  contractEdgeCellLine,
  contractTestCaseCellLine,
  projectFactoryBlueprint,
  runContractTestCaseFactoryCell,
  testScenarioCellLine,
} from "../src/factory.js";

const roots = new Set();
const edgeCatalog = [
  { id: "missing-key", description: "A lookup for an absent key must return null." },
  { id: "surrounding-whitespace", description: "Whitespace around input is ignored." },
];
const scenarios = [
  { id: "return-null", description: "Query an absent key and assert null." },
  { id: "throw-error", description: "Query an absent key and assert an exception." },
];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-case-"));
  roots.add(root);
  return root;
}

class TwoStationModel {
  constructor(scenarioId = "return-null") {
    this.scenarioId = scenarioId;
    this.calls = [];
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }
  metadata() { return { runtime: "local", model: "two-station-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete(prompt, options) {
    this.calls.push({ prompt, options });
    this.usage.requests += 1;
    this.usage.inputTokens += 20;
    this.usage.outputTokens += 8;
    this.usage.totalTokens += 28;
    this.usage.cacheMissTokens += 20;
    const content = prompt.includes("PUBLIC EDGE CATALOG")
      ? { schema: 1, kind: "bantam.contract-edge-selection", edges: ["missing-key"] }
      : { schema: 1, kind: "bantam.test-scenario-selection", scenarioId: this.scenarioId };
    return { content: JSON.stringify(content), tokens: 8, stoppedEos: true, stoppedLimit: false };
  }
}

function article(root, model = new TwoStationModel()) {
  return runContractTestCaseFactoryCell({
    root,
    jobId: "contract-test-case-article",
    contract: "A lookup for an absent key must return exactly null.",
    catalog: edgeCatalog,
    expectedEdges: ["missing-key"],
    scenarioEdgeId: "missing-key",
    scenarios,
    expectedScenario: "return-null",
    model,
  });
}

describe("sequential two-judgment contract test-case plant", () => {
  it("locks eight stations while preserving both qualified machine identities", () => {
    const plant = contractTestCaseCellLine();
    assert.equal(plant.blueprint.ref, "blueprint:contract-test-case-cell@1:sha256:10ec5b844967d3aa3a9d596c17d1bb1beed6c883bbd3917f665610d4387ee580");
    assert.equal(plant.route.ref, "route:contract-test-case-cell:sha256:f6b93773bc4086149e05be4205c1b2f85f94d3e9518938c01f3a8f33a2a12961");
    assert.equal(plant.assets.enumerate.ref, contractEdgeCellLine().assets.enumerate.ref);
    assert.equal(plant.assets.select.ref, testScenarioCellLine().assets.select.ref);
    assert.deepEqual(projectFactoryBlueprint(plant).nodes.map((row) => row.taskFamily), [
      "contract-test-case-assembly", "contract-edge-enumeration", "contract-test-case-assembly", "contract-test-case-assembly",
      "contract-test-case-assembly", "contract-test-case-assembly", "test-scenario-selection", "contract-test-case-assembly",
    ]);
  });

  it("moves one chassis through two isolated model judgments and eight released stations", async () => {
    const model = new TwoStationModel();
    const result = await article(temporary(), model);
    assert.equal(result.status, "released");
    assert.equal(result.testPlan.obligations.length, 1);
    assert.equal(result.scenarioSelection.scenarioId, "return-null");
    assert.equal(model.calls.length, 2);
    assert.match(model.calls[0].prompt, /PUBLIC EDGE CATALOG/);
    assert.doesNotMatch(model.calls[1].prompt, /PUBLIC EDGE CATALOG|CONTRACT\n/);
    assert.match(model.calls[1].prompt, /exactly one test obligation|missing-key/i);
    assert.deepEqual(result.line.supervisor.stations.map((row) => row.state), Array(8).fill("released"));
    assert.deepEqual(result.line.events.filter((row) => row.type === "station.telemetry" && row.payload.sourceType === "worker-button").map((row) => row.payload.stationAttempt.split("-")[0]), ["enumerate", "select"]);
    const routePlan = result.line.events.find((row) => row.type === "route.plan").payload;
    assert.equal(routePlan.stations.find((row) => row.id === "enumerate").taskFamily, "contract-edge-enumeration");
    assert.equal(routePlan.stations.find((row) => row.id === "select").taskFamily, "test-scenario-selection");
  });

  it("contains a plausible wrong second judgment at its independent gauge", async () => {
    const result = await article(temporary(), new TwoStationModel("throw-error"));
    assert.equal(result.status, "blocked");
    assert.equal(result.scenarioSelection.scenarioId, "throw-error");
    assert.equal(result.line.supervisor.firstAbnormal.detectedAtStation, "scenario-inspection-1");
    assert.equal(result.line.events.filter((row) => row.type === "gauge.result").at(-1).payload.status, "fail");
  });

  it("rejects an obligation outside the held-out released plan before creating a traveler", async () => {
    const root = temporary();
    await assert.rejects(runContractTestCaseFactoryCell({
      root,
      contract: "A lookup for an absent key must return exactly null.",
      catalog: edgeCatalog,
      expectedEdges: ["missing-key"],
      scenarioEdgeId: "surrounding-whitespace",
      scenarios,
      expectedScenario: "return-null",
      model: new TwoStationModel(),
    }), /absent from expected plan/);
    assert.equal(fs.existsSync(path.join(root, "journal")), false);
  });
});
