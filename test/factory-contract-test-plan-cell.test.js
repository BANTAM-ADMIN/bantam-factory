import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import {
  buildContractTestPlan,
  contractEdgeCellLine,
  contractTestPlanCellLine,
  projectFactoryBlueprint,
  runContractTestPlanFactoryCell,
  validateContractTestPlan,
} from "../src/factory.js";

const roots = new Set();
const catalog = [
  { id: "empty-input", description: "The contract explicitly defines empty input." },
  { id: "surrounding-whitespace", description: "The contract explicitly defines surrounding whitespace." },
  { id: "missing-key", description: "The contract explicitly defines a missing key." },
];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-plan-"));
  roots.add(root);
  return root;
}

class Model {
  constructor(edges) {
    this.edges = edges;
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }
  metadata() { return { runtime: "local", model: "contract-plan-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete() {
    this.usage = { ...this.usage, requests: 1, inputTokens: 30, outputTokens: 12, totalTokens: 42, cacheMissTokens: 30 };
    return { content: JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: this.edges }), tokens: 12, stoppedEos: true, stoppedLimit: false };
  }
}

describe("contract-to-test-plan composed factory", () => {
  it("compiles a five-station JSON plant while preserving the qualified model operation", () => {
    const plant = contractTestPlanCellLine();
    assert.equal(plant.blueprint.ref, "blueprint:contract-test-plan-cell@1:sha256:b5d15a1e2fc290477e8fec9867a3ff49980100fe7cb174cb1e2c92c3c1087577");
    assert.equal(plant.blueprint.taskFamily, "contract-edge-enumeration");
    assert.equal(plant.route.ref, "route:contract-test-plan-cell:sha256:0895eb710a73cf8e629dec51c6936b1642ec01d015c3033c812efb077a182aab");
    assert.equal(plant.assets.enumerate.ref, contractEdgeCellLine().assets.enumerate.ref);
    assert.equal(plant.assets.plan.ref, "station:contract-test-plan-skeleton@1:sha256:e60a3711dee4865e9b4af25bcf804466cc3f9b43c3bcf54bb315fc6f00665f28");
    assert.deepEqual(plant.route.stations.map((row) => row.id), ["intake", "enumerate", "edge-inspection", "plan", "plan-inspection"]);
    assert.deepEqual(projectFactoryBlueprint(plant).edges.map((edge) => edge.artifactType), [
      "bantam.contract-packet/v1",
      "bantam.contract-edge-response/v1",
      "bantam.contract-packet/v1",
      "bantam.contract-edge-response/v1",
      "bantam.contract-test-plan/v1",
    ]);
  });

  it("releases one deterministic obligation per independently accepted edge", async () => {
    const root = temporary();
    const result = await runContractTestPlanFactoryCell({
      root,
      jobId: "contract-plan-release",
      contract: "Ignore surrounding whitespace. A missing key returns null.",
      catalog,
      expectedEdges: ["surrounding-whitespace", "missing-key"],
      model: new Model(["missing-key", "surrounding-whitespace"]),
    });
    assert.equal(result.status, "released");
    assert.equal(result.line.events.length, 33);
    assert.deepEqual(result.testPlan.obligations, [
      { edgeId: "missing-key", description: "The contract explicitly defines a missing key." },
      { edgeId: "surrounding-whitespace", description: "The contract explicitly defines surrounding whitespace." },
    ]);
    assert.match(result.line.supervisor.chassis.active, /^artifact:[a-f0-9]{64}$/);
    assert.deepEqual(result.line.supervisor.stations.map((row) => row.state), ["released", "released", "released", "released", "released"]);
    const projection = projectFactoryBlueprint(contractTestPlanCellLine(), { events: result.line.events });
    assert.deepEqual(projection.nodes.map((node) => node.state), ["released", "released", "released", "released", "released"]);
  });

  it("contains a lossy deterministic press before final plan inspection", async () => {
    const root = temporary();
    const result = await runContractTestPlanFactoryCell({
      root,
      jobId: "contract-plan-lossy",
      contract: "Ignore surrounding whitespace. A missing key returns null.",
      catalog,
      expectedEdges: ["surrounding-whitespace", "missing-key"],
      model: new Model(["missing-key", "surrounding-whitespace"]),
      planBuilder(material) {
        const plan = structuredClone(buildContractTestPlan(material));
        plan.obligations.pop();
        return plan;
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.testPlan, null);
    assert.equal(result.line.events.some((event) => event.type === "station.started" && event.payload.stationAttempt.startsWith("plan-inspection")), false);
    const gauge = result.line.events.findLast((event) => event.type === "gauge.result");
    assert.equal(gauge.payload.status, "fail");
    assert.equal(result.line.supervisor.firstAbnormal.createdAtStation, "plan-1");
  });

  it("rejects absent plant machinery before creating a traveler", async () => {
    const root = temporary();
    await assert.rejects(runContractTestPlanFactoryCell({
      root,
      jobId: "contract-plan-missing-press",
      contract: "A missing key returns null.",
      catalog,
      expectedEdges: ["missing-key"],
      model: new Model(["missing-key"]),
      planBuilder: null,
    }), /plan builder must be a function/);
    assert.equal(fs.existsSync(path.join(root, "journal")), false);
  });

  it("validates typed plan identity, exact coverage, descriptions, and schema closure", () => {
    const material = {
      contract: "A missing key returns null.",
      catalog,
      selection: { schema: 1, kind: "bantam.contract-edge-selection", edges: ["missing-key"] },
    };
    const plan = buildContractTestPlan(material);
    assert.equal(validateContractTestPlan(plan, material).pass, true);
    assert.equal(validateContractTestPlan({ ...plan, surprise: true }, material).code, "schema-expansion");
    assert.equal(validateContractTestPlan({ ...plan, selectionDigest: "0".repeat(64) }, material).code, "source-digest-mismatch");
    const wrongDescription = structuredClone(plan);
    wrongDescription.obligations[0].description = "invented";
    assert.equal(validateContractTestPlan(wrongDescription, material).code, "noncanonical-obligation");
    const duplicate = structuredClone(plan);
    duplicate.obligations.push(duplicate.obligations[0]);
    assert.equal(validateContractTestPlan(duplicate, material).code, "duplicate-obligation");
  });

  it("runs the composed JSON plant through the factory CLI", async () => {
    const root = temporary();
    const catalogFile = path.join(root, "catalog.json");
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    let stdout = "", stderr = "";
    const code = await runFactoryCommand([
      "factory", "contract-plan", "A missing key returns null.",
      "--catalog", catalogFile,
      "--expected", "missing-key",
      "--factory-home", path.join(root, "factory"),
      "--job-id", "contract-plan-cli",
      "--json",
    ], {
      model: new Model(["missing-key"]),
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.kind, "bantam.factory-contract-test-plan-command-result");
    assert.equal(result.status, "released");
    assert.equal(result.testPlan.obligations.length, 1);
    assert.equal(result.travelerEvents, 33);
  });
});
