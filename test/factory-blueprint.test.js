import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import {
  compileFactoryBlueprint,
  contractEdgeCellLine,
  loadFactoryBlueprint,
  projectFactoryBlueprint,
  renderFactoryBlueprint,
  runContractEdgeFactoryCell,
  runFactoryBlueprint,
} from "../src/factory.js";

const blueprintFile = fileURLToPath(new URL("../src/factory/blueprints/contract-edge-cell.json", import.meta.url));
const catalog = [{ id: "empty-input", description: "The contract explicitly defines empty input." }];
const roots = new Set();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-blueprint-"));
  roots.add(root);
  return root;
}

class Model {
  constructor() { this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, costUsd: 0 }; }
  metadata() { return { runtime: "local", model: "blueprint-fixture" }; }
  usageSummary() { return { ...this.usage }; }
  async complete() {
    this.usage = { ...this.usage, requests: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheMissTokens: 20 };
    return { content: '{"schema":1,"kind":"bantam.contract-edge-selection","edges":["empty-input"]}', tokens: 10, stoppedEos: true, stoppedLimit: false };
  }
}

describe("runnable JSON factory blueprints", () => {
  it("loads one strict content-addressed definition into execution and visual topology", () => {
    const compiled = loadFactoryBlueprint(blueprintFile);
    assert.equal(compiled.blueprint.ref, "blueprint:contract-edge-cell@1:sha256:603249dc8ff3dcfb9ef36b8e7dfbbb6288300d5f7181742dd83ec724ffe3b3de");
    assert.equal(compiled.route.ref, "route:contract-edge-cell:sha256:9bcc40852697f20471222690b44fc8738003b6af722c0cac0be8b0648cee6f7a");
    assert.equal(compiled.assets.enumerate.ref, "station:contract-edge-enumerator@1:sha256:4a4fe2bedbe24f63ed2a964b1106fc2ecb6e4c7dc12557577223d52de0c63c82");
    assert.equal(contractEdgeCellLine().blueprint.ref, compiled.blueprint.ref);

    const projection = projectFactoryBlueprint(compiled);
    assert.deepEqual(projection.nodes.map((node) => [node.id, node.state, node.position.x]), [
      ["intake", "planned", 0], ["enumerate", "planned", 1], ["inspection", "planned", 2],
    ]);
    assert.deepEqual(projection.edges.map((edge) => edge.artifactType), ["bantam.contract-packet/v1", "bantam.contract-edge-response/v1"]);
    assert.equal(projection.nodes[1].adapter, "bantam.factory.contract-edge-enumerator/v1");
    assert.equal(projection.nodes[1].taskFamily, "contract-edge-enumeration");
  });

  it("supports content-addressed station-specific task families without changing legacy blueprints", () => {
    const source = JSON.parse(fs.readFileSync(blueprintFile, "utf8"));
    source.stations[1].taskFamily = "bounded-edge-selection";
    const compiled = compileFactoryBlueprint(source);
    assert.notEqual(compiled.blueprint.ref, loadFactoryBlueprint(blueprintFile).blueprint.ref);
    assert.equal(compiled.blueprint.stations[1].taskFamily, "bounded-edge-selection");
    assert.equal(projectFactoryBlueprint(compiled).nodes[1].taskFamily, "bounded-edge-selection");
    const expanded = structuredClone(source);
    expanded.stations[1].taskFamilyTypo = "unsafe";
    assert.throws(() => compileFactoryBlueprint(expanded), /fields mismatch/);
  });

  it("projects live states only when the traveler records the exact blueprint", async () => {
    const factoryHome = temporary();
    const article = await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "blueprint-live",
      contract: "An empty input returns an empty result.",
      catalog,
      expectedEdges: ["empty-input"],
      model: new Model(),
    });
    const projection = projectFactoryBlueprint(loadFactoryBlueprint(blueprintFile), { events: article.line.events });
    assert.equal(projection.live, true);
    assert.equal(projection.status, "released");
    assert.deepEqual(projection.nodes.map((node) => node.state), ["released", "released", "released"]);

    const withoutBinding = article.line.events.filter((event) => event.type !== "blueprint.loaded");
    assert.throws(() => projectFactoryBlueprint(loadFactoryBlueprint(blueprintFile), { events: withoutBinding }), /does not record a factory blueprint/);
    const mismatched = structuredClone(article.line.events);
    const loaded = mismatched.find((event) => event.type === "blueprint.loaded");
    loaded.payload.blueprintRef = `blueprint:wrong@1:sha256:${"a".repeat(64)}`;
    assert.throws(() => projectFactoryBlueprint(loadFactoryBlueprint(blueprintFile), { events: mismatched }), /does not match|hash mismatch/);
  });

  it("rejects schema expansion, content tampering, missing layout, and invalid material flow", () => {
    const source = JSON.parse(fs.readFileSync(blueprintFile, "utf8"));
    assert.throws(() => compileFactoryBlueprint({ ...source, surprise: true }), /fields mismatch/);
    const defined = loadFactoryBlueprint(blueprintFile).blueprint;
    assert.throws(() => compileFactoryBlueprint({ ...defined, title: "tampered" }), /content hash does not match/);
    const missingLayout = structuredClone(source);
    missingLayout.layout.stations.pop();
    assert.throws(() => compileFactoryBlueprint(missingLayout), /layout omits stations/);
    const wrongType = structuredClone(source);
    wrongType.stations[1].asset.inputs[0].artifactType = "bantam.wrong-material/v1";
    assert.throws(() => compileFactoryBlueprint(wrongType), /type mismatch/);
  });

  it("fails before traveler creation when referenced plant machinery is absent", async () => {
    const factoryHome = temporary();
    await assert.rejects(runFactoryBlueprint({
      compiled: loadFactoryBlueprint(blueprintFile),
      root: factoryHome,
      jobId: "missing-machinery",
      task: "Bounded contract",
      initialProductRevision: "artifact:input",
      adapters: {},
      gauges: {},
    }), /station adapter is not installed/);
    assert.equal(fs.existsSync(path.join(factoryHome, "journal")), false);
  });

  it("renders the same projection as a script-safe visual factory", () => {
    const html = renderFactoryBlueprint(projectFactoryBlueprint(loadFactoryBlueprint(blueprintFile)));
    assert.match(html, /Executable factory layout/);
    assert.match(html, /Station inspector/);
    assert.match(html, /bantam\.factory\.contract-edge-enumerator\/v1/);
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
  });

  it("loads static and live blueprint views through the factory CLI", async () => {
    const directory = temporary();
    const factoryHome = path.join(directory, "factory");
    const article = await runContractEdgeFactoryCell({
      root: factoryHome,
      jobId: "blueprint-cli-live",
      contract: "An empty input returns an empty result.",
      catalog,
      expectedEdges: ["empty-input"],
      model: new Model(),
    });
    let stdout = "", stderr = "";
    assert.equal(await runFactoryCommand(["factory", "blueprint", "show", blueprintFile, "--job-id", article.jobId, "--factory-home", factoryHome, "--json"], {
      stdout: { write(value) { stdout += String(value); } }, stderr: { write(value) { stderr += String(value); } },
    }), 0);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).nodes[1].state, "released");

    const report = path.join(directory, "blueprint.html");
    assert.equal(await runFactoryCommand(["factory", "blueprint", "report", blueprintFile, "--output", report, "--factory-home", factoryHome], {
      stdout: { write() {} }, stderr: { write(value) { stderr += String(value); } },
    }), 0);
    assert.match(fs.readFileSync(report, "utf8"), /Executable factory layout/);
  });
});
