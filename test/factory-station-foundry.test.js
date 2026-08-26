import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  defineStationChangeOrder,
  manufactureStationAsset,
  projectFactoryBlueprint,
  runStationFoundryArticle,
  stationFoundryLine,
} from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function changeOrder(overrides = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-station-change-order",
    id: "semantic-reviewed-gauge",
    version: 1,
    requestedBy: "BANTAMFACTORY quality engineering",
    reason: "Manufacture an independent reviewed-accuracy gauge for semantic sensor qualification.",
    requestedStation: {
      schema: 2,
      kind: "bantam.factory-station",
      id: "semantic-reviewed-gauge",
      version: 1,
      title: "Reviewed semantic decision gauge",
      purpose: "Compare an immutable semantic matrix with an independently reviewed positive and negative decision rack.",
      worker: { kind: "tool", adapter: "bantam.factory.semantic-reviewed-gauge/v1" },
      inputs: [
        { name: "matrix", artifactType: "bantam.semantic-matrix/v1", required: true },
        { name: "reviewed-rack", artifactType: "bantam.semantic-reviewed-rack/v1", required: true },
      ],
      outputs: [{ name: "evidence", artifactType: "bantam.semantic-qualification-evidence/v1", required: true }],
      capabilities: ["quality.semantic-matrix"],
      authority: ["workspace.read"],
      gauge: { id: "semantic-reviewed-exactness", version: 1, independent: true },
      dispositions: ["blocked", "contained", "infrastructure", "released", "rework"],
      presentation: { group: "quality", icon: "gauge", color: "green" },
      standardWork: {
        operation: "Press each semantic decision through the reviewed truth wicket",
        instructions: ["Join only byte-identical source units.", "Score explicit positive and negative lane decisions.", "Emit precision, recall, false positives, and false negatives."],
        fixtures: ["Immutable semantic matrix", "Independently reviewed decision rack", "Exact source identity join"],
        prohibited: ["Do not treat model agreement as reviewed truth.", "Do not silently discard unmatched review material.", "Do not mutate source files."],
        releaseCriteria: ["Every reviewed decision is matched exactly and the qualification policy dies pass."],
      },
    },
    ...overrides,
  };
}

describe("station foundry", () => {
  it("compiles from one runnable JSON blueprint used by backend and visual projection", () => {
    const compiled = stationFoundryLine();
    const projection = projectFactoryBlueprint(compiled);
    assert.equal(compiled.blueprint.id, "station-foundry");
    assert.deepEqual(projection.nodes.map((row) => row.id), ["intake", "form", "inspection"]);
    assert.deepEqual(projection.edges.map((row) => row.artifactType), ["bantam.station-change-order/v1", "bantam.station-asset/v2"]);
    assert.ok(projection.nodes.every((node) => node.standardWork));
  });

  it("content-addresses the order and manufactures a strict station with recorded dies", () => {
    const order = defineStationChangeOrder(changeOrder());
    const record = manufactureStationAsset(changeOrder());
    assert.match(order.ref, /^station-change-order:semantic-reviewed-gauge@1:sha256:/);
    assert.match(record.station.ref, /^station:semantic-reviewed-gauge@1:sha256:/);
    assert.equal(record.inspection.status, "released");
    assert.equal(record.inspection.dies.length, 5);
    assert.ok(record.inspection.dies.every((row) => row.pass));
    assert.equal(record.orderRef, order.ref);
    assert.ok(Object.isFrozen(record.station));
    assert.equal(manufactureStationAsset(changeOrder()).artifactId, record.artifactId);
  });

  it("fails closed on schema expansion and contains stations without an independent gauge", () => {
    assert.throws(() => defineStationChangeOrder({ ...changeOrder(), surprise: true }), /unknown=\[surprise\]/);
    const unsafe = changeOrder(); unsafe.requestedStation.gauge.independent = false;
    const record = manufactureStationAsset(unsafe);
    assert.equal(record.inspection.status, "contained");
    assert.deepEqual(record.inspection.failures, ["independent-quality-gauge"]);
  });

  it("runs an end-to-end foundry article with independent exact reproduction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-station-foundry-")); roots.push(root);
    const result = await runStationFoundryArticle({ root, order: changeOrder(), jobId: "foundry-fixture" });
    assert.equal(result.status, "released", JSON.stringify(result.line.events.slice(-8), null, 2));
    assert.equal(result.product.inspection.status, "released");
    assert.equal(result.product.reproduction.exact, true);
    assert.equal(result.product.station.id, "semantic-reviewed-gauge");
    assert.equal(result.line.supervisor.stations.length, 3);
    assert.ok(result.line.events.some((event) => event.type === "blueprint.loaded"));
    assert.ok(result.line.events.filter((event) => event.type === "gauge.result").every((event) => event.payload.status === "pass"));
  });
});
