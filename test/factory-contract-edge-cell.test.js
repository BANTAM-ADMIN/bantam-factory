import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import {
  auditFactoryTraveler,
  certifyContractEdgeWorker,
  CONTRACT_EDGE_QUALIFICATION_POLICY,
  contractEdgeCellLine,
  contractEdgeGrammar,
  FactoryStore,
  runContractEdgeFactoryCell,
  validateContractEdgeResponse,
  WorkforceRegistry,
} from "../src/factory.js";

const roots = new Set();
const catalog = Object.freeze([
  { id: "empty-input", description: "The input contains no items." },
  { id: "signed-values", description: "Individual values may have an explicit plus or minus sign." },
  { id: "descending-range", description: "A range may descend from its first endpoint to its second." },
  { id: "duplicate-values", description: "The same value can be produced by multiple items." },
  { id: "unsafe-integer", description: "A parsed value may exceed the safe integer domain." },
]);

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-edge-"));
  roots.add(value);
  return value;
}

function candidate(workforce, evidence = {}) {
  const worker = workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id: "edge-chicken",
    version: 1,
    runtime: "local",
    provider: "plant",
    model: "edge-chicken",
    reasoningEffort: null,
    transport: "llama.cpp-native",
    availabilityClass: "local-compute",
    capabilities: ["model.semantic-work"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
  workforce.qualify({
    workerRef: worker.ref,
    stationRef: contractEdgeCellLine().assets.enumerate.ref,
    taskFamily: "contract-edge-enumeration",
    status: "candidate",
    evidence: {
      articles: 5,
      passes: 5,
      escapes: 0,
      falseStops: 0,
      p95Ms: 8_000,
      meanTotalTokens: 400,
      expectedCostUsd: 0,
      sourceRefs: ["a", "b", "c", "d", "e"].map((char) => `sha256:${char.repeat(64)}`),
      ...evidence,
    },
    reason: "controlled edge cohort",
  });
  return worker;
}

class FixtureModel {
  constructor(edges) {
    this.edges = edges;
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 };
    this.calls = [];
  }
  metadata() { return { runtime: "local", model: "fixture-edge-worker", profile: "qwen", reasoningEffort: null }; }
  usageSummary() { return { ...this.usage }; }
  async complete(prompt, options) {
    this.calls.push({ prompt, options });
    const content = JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: this.edges });
    this.usage = { ...this.usage, requests: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheMissTokens: 80 };
    return { content, tokens: 20, stoppedEos: true, stoppedLimit: false, timings: {} };
  }
}

describe("contract edge enumeration factory cell", () => {
  it("compiles a three-station read-only route with a strict finite output die", () => {
    const line = contractEdgeCellLine();
    assert.deepEqual(line.route.stations.map((row) => row.id), ["intake", "enumerate", "inspection"]);
    assert.equal(line.assets.enumerate.worker.kind, "model");
    assert.deepEqual(line.assets.enumerate.authority, ["contract.read"]);
    assert.match(contractEdgeGrammar(catalog.map((row) => row.id)), /empty-input/);
    assert.doesNotMatch(contractEdgeGrammar(catalog.map((row) => row.id)), /string ::=|schar/);
  });

  it("releases an exact edge selection with one constrained model peck", async () => {
    const model = new FixtureModel(["signed-values", "empty-input"]);
    const factoryHome = root();
    const result = await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "contract-edge-pass",
      contract: "Empty input is valid. Each individual value may include an explicit sign.",
      catalog,
      expectedEdges: ["empty-input", "signed-values"],
      model,
    });
    assert.equal(result.status, "released");
    assert.deepEqual(result.selection.edges, ["empty-input", "signed-values"]);
    assert.equal(auditFactoryTraveler(result.line.events).terminal, true);
    assert.equal(model.calls.length, 1);
    assert.match(model.calls[0].prompt, /PUBLIC EDGE CATALOG/);
    assert.doesNotMatch(model.calls[0].prompt, /expectedEdges|expected set/i);
    assert.match(model.calls[0].options.grammar, /bantam\.contract-edge-selection/);
    const performance = result.line.events.find((event) => event.type === "station.performance" && event.payload.stationAttempt === "enumerate-1");
    assert.equal(performance.payload.workerRef, "local:fixture-edge-worker");
    assert.equal(performance.payload.totalTokens, 100);
    const loaded = result.line.events.find((event) => event.type === "blueprint.loaded");
    assert.equal(loaded.payload.blueprintRef, contractEdgeCellLine().blueprint.ref);
    assert.equal(new FactoryStore(factoryHome).getEvidence(loaded.payload.artifactRef).ref, loaded.payload.blueprintRef);
  });

  it("contains a plausible incomplete selection downstream and charges an escape", async () => {
    const factoryHome = root();
    const result = await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "contract-edge-escape",
      contract: "Empty input is valid. Signed values and descending ranges are accepted.",
      catalog,
      expectedEdges: ["empty-input", "signed-values", "descending-range"],
      model: new FixtureModel(["empty-input", "signed-values"]),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.line.supervisor.firstAbnormal.detectedAtStation, "inspection-1");
    const imported = new WorkforceRegistry(factoryHome).ingestFactoryPerformance({
      events: result.line.events,
      taskFamily: "contract-edge-enumeration",
    });
    const modelEvidence = imported.find((row) => row.qualificationEvent);
    assert.equal(modelEvidence.evidence.articles, 1);
    assert.equal(modelEvidence.evidence.passes, 0);
    assert.equal(modelEvidence.evidence.escapes, 1);
  });

  it("fails malformed, expanded, unknown, and duplicate selections at the local gauge", () => {
    assert.equal(validateContractEdgeResponse("not-json", catalog).code, "invalid-json");
    assert.equal(validateContractEdgeResponse(JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: [], note: "extra" }), catalog).code, "schema-expansion");
    assert.equal(validateContractEdgeResponse(JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: ["invented"] }), catalog).code, "unknown-edge");
    assert.equal(validateContractEdgeResponse(JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: ["empty-input", "empty-input"] }), catalog).code, "duplicate-edge");
  });

  it("rejects ambiguous fixture definitions before creating a traveler", async () => {
    const factoryHome = root();
    await assert.rejects(runContractEdgeFactoryCell({
      root: factoryHome,
      contract: "This contract text is intentionally long enough for admission.",
      catalog: [{ id: "edge", description: "one" }, { id: "edge", description: "two" }],
      expectedEdges: ["edge"],
      model: new FixtureModel([]),
    }), /duplicate contract edge identifier/);
    assert.equal(fs.existsSync(path.join(factoryHome, "journal")), false);
  });

  it("runs one auditable article through the factory CLI", async () => {
    const directory = root();
    const catalogPath = path.join(directory, "catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    let stdout = "";
    let stderr = "";
    const code = await runFactoryCommand([
      "factory", "contract-edges",
      "Empty input is valid and individual values may be signed.",
      "--catalog", catalogPath,
      "--expected", "empty-input,signed-values",
      "--job-id", "contract-edge-cli",
      "--factory-home", path.join(directory, "factory"),
      "--json",
    ], {
      model: new FixtureModel(["empty-input", "signed-values"]),
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const response = JSON.parse(stdout);
    assert.equal(response.jobId, "contract-edge-cli");
    assert.equal(response.status, "released");
    assert.equal(response.travelerEvents, 23);
    assert.equal(Object.hasOwn(response, "expectedEdges"), false);
  });

  it("certifies only a complete green cohort and makes the worker eligible", () => {
    const workforce = new WorkforceRegistry(root());
    const worker = candidate(workforce);
    const certified = certifyContractEdgeWorker({ workforce, workerRef: worker.ref });
    assert.equal(certified.alreadyQualified, false);
    assert.equal(certified.qualification.status, "qualified");
    assert.equal(certified.qualification.reason, `certified by ${CONTRACT_EDGE_QUALIFICATION_POLICY.ref}`);
    assert.deepEqual(certified.qualification.limits.authority, ["contract.read"]);
    workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "endpoint-ready", slotsAvailable: 1 });
    const recommendation = workforce.eligible({
      stationRef: certified.qualification.stationRef,
      taskFamily: "contract-edge-enumeration",
      requiredCapabilities: ["model.semantic-work"],
    });
    assert.equal(recommendation.selected, worker.ref);
    const before = workforce.project().events;
    assert.equal(certifyContractEdgeWorker({ workforce, workerRef: worker.ref }).alreadyQualified, true);
    assert.equal(workforce.project().events, before);
  });

  it("refuses to certify incomplete or lossy evidence", () => {
    const workforce = new WorkforceRegistry(root());
    const worker = candidate(workforce, { articles: 4, passes: 3, escapes: 1, p95Ms: 12_000, meanTotalTokens: 1_500 });
    assert.throws(() => certifyContractEdgeWorker({ workforce, workerRef: worker.ref }), /articles 4\/5; yield 0\.750\/1\.000; escapes 1\/0; p95 12000\/10000ms; mean-tokens 1500\/1000/);
    assert.equal(workforce.project().qualifications[0].status, "candidate");
  });

  it("exposes policy certification through an explicit workforce CLI interlock", async () => {
    const factoryHome = root();
    const workforce = new WorkforceRegistry(factoryHome);
    const worker = candidate(workforce);
    let stdout = "";
    let stderr = "";
    assert.equal(await runFactoryCommand([
      "factory", "workers", "certify-contract-edge", worker.ref,
      "--factory-home", factoryHome,
      "--yes", "--json",
    ], {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    }), 0);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).qualification.status, "qualified");

    let denied = "";
    assert.equal(await runFactoryCommand([
      "factory", "workers", "certify-contract-edge", worker.ref,
      "--factory-home", factoryHome,
    ], { stdout: { write() {} }, stderr: { write(value) { denied += String(value); } } }), 2);
    assert.match(denied, /repeat with --yes/);
  });
});
