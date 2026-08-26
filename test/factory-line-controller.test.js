import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  FactoryLineController,
  FactoryStore,
  StationRegistry,
  auditFactoryTraveler,
  gaugeRef,
} from "../src/factory.js";

const temporary = new Set();

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function factoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-line-controller-"));
  temporary.add(root);
  return root;
}

function station({ id, worker, inputs, gauge, independent = true, authority = ["workspace.read"] }) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id,
    version: 1,
    title: id.replaceAll("-", " "),
    purpose: `Execute the ${id} production operation.`,
    worker: { kind: worker.startsWith("model") ? "model" : "tool", adapter: worker },
    inputs,
    outputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    capabilities: [`factory.${id}`],
    authority,
    gauge: { id: gauge, version: 1, independent },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "test-cell", icon: "station", color: "blue" },
  };
}

function line() {
  const registry = new StationRegistry();
  const intake = registry.install(station({
    id: "intake",
    worker: "tool.intake/v1",
    inputs: [],
    gauge: "intake-gauge",
  }));
  const edit = registry.install(station({
    id: "bounded-edit",
    worker: "model.edit/v1",
    inputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    gauge: "edit-gauge",
    authority: ["workspace.read", "workspace.write"],
  }));
  const inspect = registry.install(station({
    id: "final-inspection",
    worker: "tool.inspect/v1",
    inputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    gauge: "final-gauge",
    independent: true,
  }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "first-production-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "edit", station: edit.ref },
      { id: "inspect", station: inspect.ref },
    ],
    edges: [
      { from: "intake", out: "chassis", to: "edit", in: "chassis" },
      { from: "edit", out: "chassis", to: "inspect", in: "chassis" },
    ],
  }, { authority: ["workspace.read", "workspace.write"] });
  return { registry, route, assets: { intake, edit, inspect } };
}

function passingGauges(assets, overrides = {}) {
  return new Map([
    [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ readable: true }] })],
    [gaugeRef(assets.edit), async () => ({ status: "pass", evidence: [{ targetedTest: "pass" }] })],
    [gaugeRef(assets.inspect), async () => ({ status: "pass", evidence: [{ productContract: "pass" }] })],
    ...Object.entries(overrides),
  ]);
}

function adapters(log, overrides = {}) {
  return {
    "tool.intake/v1": async (order) => {
      log.push("intake");
      assert.equal(Object.isFrozen(order), true);
      assert.deepEqual(order.inputs, []);
      return { productRevision: "tree:a", outputs: { chassis: { files: ["index.js"], revision: "a" } } };
    },
    "model.edit/v1": async (order, { emit }) => {
      log.push("edit");
      assert.equal(order.inputs[0].port, "chassis");
      assert.equal(order.inputs[0].productRevision, "tree:a");
      emit("patch-applied", { paths: ["index.js"] });
      return { productRevision: "tree:b", outputs: { chassis: { files: ["index.js"], revision: "b" } }, evidence: [{ patch: "artifact" }] };
    },
    "tool.inspect/v1": async (order) => {
      log.push("inspect");
      assert.equal(order.inputs[0].productRevision, "tree:b");
      assert.equal(order.inputs[0].value.revision, "b");
      return { productRevision: "tree:b", outputs: { chassis: order.inputs[0].value } };
    },
    ...overrides,
  };
}

// Large enough that scheduler noise cannot close the gap it creates.
const GAUGE_SLEEP_MS = 1500;

describe("headless pluggable factory line", () => {
  it("charges gauge time to inspection, never to the operation", async () => {
    // Characterization pin for the station.performance split: the historical
    // computation produced the right number only because two now-relative
    // reads cancelled algebraically. This test makes any refactor that breaks
    // the cancellation loud instead of silently corrupting every throughput
    // figure (STATION-SIZING.md's exact hazard).
    const root = factoryRoot();
    const { registry, route, assets } = line();
    // Margins are sized for a loaded box running the whole suite in parallel:
    // the operation is instant (only scheduler noise can inflate it) and the
    // gauge sleeps, so the classic corruption — charging gauge time to the
    // operation — moves operationMs by the whole sleep, far past any noise.
    // The sleep is 1.5s rather than 0.5s because scheduler noise is not small:
    // measured 171ms on the operation and 60ms on the inspection while a live
    // agent run held the CPU, which left only 389ms between them and tripped a
    // 400ms margin. The gap has to dwarf the noise, not merely exceed it.
    // Only the edit gauge sleeps: the assertion reads edit-1, and slowing all
    // three tripled the test's runtime for nothing.
    const editRef = gaugeRef(assets.edit);
    const slowGauges = new Map(
      [...passingGauges(assets)].map(([ref, gauge]) => (ref === editRef
        ? [ref, async (order, context) => {
          await new Promise((resolve) => setTimeout(resolve, GAUGE_SLEEP_MS));
          return gauge(order, context);
        }]
        : [ref, gauge])),
    );
    const controller = new FactoryLineController({
      root,
      jobId: "job-timing-split",
      task: "Build the bounded repair.",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: adapters([]),
      gauges: slowGauges,
    });
    const result = await controller.run({ time: "2026-08-01T13:00:00.000Z" });

    const edit = result.events.find(
      (event) => event.type === "station.performance" && event.payload.stationAttempt === "edit-1",
    );
    assert.ok(edit, "edit station must record performance");
    assert.ok(
      edit.payload.inspectionMs >= GAUGE_SLEEP_MS * 0.6,
      `inspection time must carry the gauge delay, recorded ${edit.payload.inspectionMs}`,
    );
    // The SPLIT, not the absolute figures. An absolute `operationMs < 400` reads
    // the same corruption but also fires on a busy machine: measured 487ms with
    // a live agent run using the CPU (2026-08-17), costing four full-suite runs
    // to trace back to load. The corruption this pins — charging the gauge sleep
    // to the operation — collapses the gap to nothing, so a gap that is most of
    // the sleep is the load-tolerant reading of the same fact.
    const split = edit.payload.inspectionMs - edit.payload.operationMs;
    assert.ok(
      split >= GAUGE_SLEEP_MS * 0.45,
      `gauge time must sit in inspection, not the operation: inspection ${edit.payload.inspectionMs} - operation ${edit.payload.operationMs} = ${split}`,
    );
  });

  it("executes installed station plugins in dependency order and releases inspected material", async () => {
    const root = factoryRoot();
    const { registry, route, assets } = line();
    const execution = [];
    const controller = new FactoryLineController({
      root,
      jobId: "job-production-pass",
      task: "Build the bounded repair.",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: adapters(execution),
      gauges: passingGauges(assets),
    });
    const result = await controller.run({ time: "2026-08-01T13:00:00.000Z" });

    assert.deepEqual(execution, ["intake", "edit", "inspect"]);
    assert.equal(result.supervisor.status, "released");
    assert.equal(result.supervisor.chassis.released, "tree:b");
    assert.deepEqual(result.supervisor.chassis.releasedLineage, ["tree:a", "tree:b"]);
    assert.equal(result.supervisor.stations.find((entry) => entry.stationAttempt === "edit-1").telemetryCount, 1);
    assert.equal(result.supervisor.stations.every((entry) => entry.performance.operationMs >= 0), true);
    assert.equal(result.events.filter((event) => event.type === "station.performance").length, 3);
    assert.equal(result.outputs.length, 3);
    assert.equal(auditFactoryTraveler(result.events).terminal, true);
    assert.equal(new FactoryStore(root).load("job-production-pass").length, result.events.length);
  });

  it("contains a rejected station output and never dispatches downstream work", async () => {
    const root = factoryRoot();
    const { registry, route, assets } = line();
    const execution = [];
    const gauges = passingGauges(assets);
    gauges.set(gaugeRef(assets.edit), async (inspection) => {
      assert.equal(inspection.outputs[0].value.revision, "b");
      return { status: "fail", evidence: [{ test: "failed" }] };
    });
    const result = await new FactoryLineController({
      root,
      jobId: "job-production-fail",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: adapters(execution),
      gauges,
    }).run();

    assert.deepEqual(execution, ["intake", "edit"]);
    assert.equal(result.supervisor.status, "blocked");
    assert.equal(result.supervisor.chassis.released, "tree:a");
    assert.deepEqual(result.supervisor.chassis.contained, ["tree:b"]);
    assert.equal(result.supervisor.firstAbnormal.detectedAtStation, "edit-1");
    assert.equal(result.outputs.some((output) => output.key.startsWith("inspect.")), false);
  });

  it("turns adapter exceptions into an infrastructure station state and andon", async () => {
    const root = factoryRoot();
    const { registry, route, assets } = line();
    const execution = [];
    const result = await new FactoryLineController({
      root,
      jobId: "job-adapter-error",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: adapters(execution, { "model.edit/v1": async () => { throw new Error("worker unavailable"); } }),
      gauges: passingGauges(assets),
    }).run();

    assert.deepEqual(execution, ["intake"]);
    assert.equal(result.supervisor.status, "blocked");
    assert.equal(result.supervisor.stations.find((entry) => entry.stationAttempt === "edit-1").state, "infrastructure");
    assert.equal(result.supervisor.firstAbnormal.code, "adapter-infrastructure-edit");
    assert.equal(auditFactoryTraveler(result.events).terminal, true);
  });

  it("routes one bounded failed inspection back through upstream rework", async () => {
    const root = factoryRoot();
    const { registry, route, assets } = line();
    const execution = [];
    let editAttempt = 0;
    let inspections = 0;
    const custom = adapters(execution, {
      "model.edit/v1": async (order) => {
        editAttempt++;
        execution.push(`edit-${editAttempt}`);
        if (editAttempt === 2) {
          assert.equal(order.rework.reworkOf, "inspect-1");
          assert.equal(order.rework.detectorStationId, "inspect");
        }
        const revision = editAttempt === 1 ? "b" : "c";
        return { productRevision: `tree:${revision}`, outputs: { chassis: { files: ["index.js"], revision } } };
      },
      "tool.inspect/v1": async (order) => {
        execution.push(`inspect-${order.inputs[0].value.revision}`);
        return { productRevision: order.inputProductRevision, outputs: { chassis: order.inputs[0].value } };
      },
    });
    const gauges = passingGauges(assets);
    gauges.set(gaugeRef(assets.inspect), async () => ({
      status: ++inspections === 1 ? "fail" : "pass",
      evidence: [{ inspection: inspections }],
    }));
    const result = await new FactoryLineController({
      root,
      jobId: "job-bounded-rework",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: custom,
      gauges,
      rework: { inspect: { restartAt: "edit", maxCycles: 1 } },
    }).run();

    assert.deepEqual(execution, ["intake", "edit-1", "inspect-b", "edit-2", "inspect-c"]);
    assert.equal(result.supervisor.status, "released");
    assert.equal(result.supervisor.reworkCount, 1);
    assert.equal(result.supervisor.chassis.released, "tree:c");
    assert.deepEqual(result.supervisor.chassis.contained, ["tree:b"]);
    assert.deepEqual(result.supervisor.chassis.releasedLineage, ["tree:a", "tree:c"]);
    assert.equal(result.events.filter((event) => event.type === "rework.authorized").length, 1);
  });

  it("fails closed before production when plugins or final independent inspection are absent", () => {
    const root = factoryRoot();
    const { registry, route, assets } = line();
    assert.throws(() => new FactoryLineController({
      root,
      jobId: "job-missing-plugin",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters: {},
      gauges: passingGauges(assets),
    }), /station adapter is not installed/);

    const unsafeRegistry = new StationRegistry();
    const unsafe = unsafeRegistry.install(station({
      id: "self-certified",
      worker: "model.self/v1",
      inputs: [],
      gauge: "self-gauge",
      independent: false,
    }));
    const unsafeRoute = unsafeRegistry.validateRoute({
      schema: 1,
      kind: "bantam.factory-route",
      id: "unsafe-line",
      stations: [{ id: "self", station: unsafe.ref }],
      edges: [],
    }, { authority: ["workspace.read"] });
    assert.throws(() => new FactoryLineController({
      root,
      jobId: "job-self-certified",
      initialProductRevision: "tree:a",
      route: unsafeRoute,
      registry: unsafeRegistry,
      authority: ["workspace.read"],
      adapters: { "model.self/v1": async () => ({ outputs: { chassis: {} } }) },
      gauges: { [gaugeRef(unsafe)]: async () => ({ status: "pass" }) },
    }), /terminal station requires an independent gauge/);

    assert.throws(() => new FactoryLineController({
      root,
      jobId: "job-ungranted-write",
      initialProductRevision: "tree:a",
      route,
      registry,
      authority: ["workspace.read"],
      adapters: adapters([]),
      gauges: passingGauges(assets),
    }), /ungranted authority: workspace.write/);
  });
});
