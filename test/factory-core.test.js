import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  StationRegistry,
  defineStationAsset,
  FactoryTraveler,
  auditFactoryTraveler,
  compareFactoryFrames,
  factoryFrameAt,
  projectFactorySupervisor,
  projectFactoryLiveness,
} from "../src/factory.js";

function station(overrides = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id: "repair-workspace",
    version: 1,
    title: "Repair workspace",
    purpose: "Apply one bounded repair to a released workspace revision.",
    worker: { kind: "model", adapter: "bantam.agent/v1" },
    inputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    outputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    capabilities: ["code.repair"],
    authority: ["workspace.write"],
    gauge: { id: "targeted-tests", version: 1, independent: true },
    dispositions: ["released", "rework", "contained"],
    presentation: { group: "fabrication", icon: "wrench", color: "amber" },
    ...overrides,
  };
}

function installExampleLine() {
  const registry = new StationRegistry();
  const intake = registry.install(station({
    id: "workspace-intake",
    title: "Workspace intake",
    purpose: "Resolve and admit the initial workspace chassis.",
    worker: { kind: "tool", adapter: "bantam.workspace-intake/v1" },
    inputs: [],
    authority: [],
    capabilities: ["workspace.resolve"],
    gauge: { id: "workspace-readable", version: 1, independent: true },
    presentation: { group: "intake", icon: "scan", color: "blue" },
  }));
  const repair = registry.install(station());
  const route = {
    schema: 1,
    kind: "bantam.factory-route",
    id: "repair-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "repair", station: repair.ref },
    ],
    edges: [{ from: "intake", out: "chassis", to: "repair", in: "chassis" }],
  };
  return { registry, intake, repair, route };
}

function buildReworkTraveler() {
  const traveler = new FactoryTraveler({
    jobId: "job-001",
    routeRef: "route:repair-cell:sha256:example",
    initialProductRevision: "tree:a",
    time: "2026-08-01T12:00:00.000Z",
  });
  const append = (type, payload, second) => traveler.append(type, payload, { time: `2026-08-01T12:00:${String(second).padStart(2, "0")}.000Z` });
  append("route.validated", { routeRef: "route:repair-cell:sha256:example" }, 1);
  append("station.started", { stationAttempt: "repair-1", stationRef: "station:repair@1", inputProductRevision: "tree:a" }, 2);
  append("station.completed", { stationAttempt: "repair-1", inputProductRevision: "tree:a", outputProductRevision: "tree:b", artifactRefs: ["artifact:patch-b"] }, 3);
  append("gauge.result", { stationAttempt: "repair-1", gaugeRef: "gauge:tests@1", status: "fail", evidenceRefs: ["artifact:test-failure"] }, 4);
  append("andon.raised", { code: "test-failure", createdAtStation: "repair-1", detectedAtStation: "repair-1", affectedProductRevision: "tree:b", evidenceRefs: ["artifact:test-failure"] }, 5);
  append("output.contained", { stationAttempt: "repair-1", productRevision: "tree:b", reason: "Targeted test failed." }, 6);
  append("rework.authorized", { fromProductRevision: "tree:a", reason: "Retry from the last released chassis.", reworkOf: "repair-1" }, 7);
  append("station.started", { stationAttempt: "repair-2", stationRef: "station:repair@1", inputProductRevision: "tree:a" }, 8);
  append("station.completed", { stationAttempt: "repair-2", inputProductRevision: "tree:a", outputProductRevision: "tree:c", artifactRefs: ["artifact:patch-c"] }, 9);
  append("gauge.result", { stationAttempt: "repair-2", gaugeRef: "gauge:tests@1", status: "pass", evidenceRefs: ["artifact:test-pass"] }, 10);
  append("station.released", { stationAttempt: "repair-2", productRevision: "tree:c" }, 11);
  append("job.released", { productRevision: "tree:c", evidenceRefs: ["artifact:release-pack"] }, 12);
  return traveler;
}

describe("factory station assets and route compilation", () => {
  it("content-addresses executable standard work in schema v2", () => {
    const standardWork = {
      operation: "Peck one illuminated button",
      instructions: ["Wait for material arrival.", "Peck once."],
      fixtures: ["One-button jig"],
      prohibited: ["Do not move to another station."],
      releaseCriteria: ["Gauge reports pass."],
    };
    const asset = defineStationAsset({ ...station(), schema: 2, standardWork });
    assert.equal(asset.schema, 2);
    assert.equal(asset.standardWork.operation, standardWork.operation);
    assert.equal(Object.isFrozen(asset.standardWork.instructions), true);
    assert.throws(() => defineStationAsset({ ...station(), schema: 2, standardWork: { ...standardWork, fixtures: [] } }), /fixtures must not be empty/);
    assert.notEqual(asset.ref, defineStationAsset({ ...station(), schema: 2, standardWork: { ...standardWork, operation: "Peck twice" } }).ref);
  });

  it("installs immutable, content-addressed station assets", () => {
    const registry = new StationRegistry();
    const asset = registry.install(station());
    assert.match(asset.ref, /^station:repair-workspace@1:sha256:[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(asset), true);
    assert.equal(Object.isFrozen(asset.worker), true);
    assert.equal(registry.install(station()), asset);
    assert.throws(() => registry.install(station({ title: "Different bytes" })), /different bytes/);
  });

  it("compiles only installed, authorized, type-safe acyclic routes", () => {
    const { registry, route } = installExampleLine();
    const compiled = registry.validateRoute(route, { authority: ["workspace.write"] });
    assert.match(compiled.ref, /^route:repair-cell:sha256:[a-f0-9]{64}$/);
    assert.equal(compiled.edges[0].artifactType, "bantam.workspace/v1");
    assert.throws(() => registry.validateRoute(route), /ungranted authority/);

    const wrongType = registry.install(station({
      id: "report-writer",
      title: "Report writer",
      purpose: "Produce a report.",
      inputs: [],
      outputs: [{ name: "report", artifactType: "bantam.report/v1", required: true }],
      authority: [],
    }));
    const mismatched = structuredClone(route);
    mismatched.stations[0].station = wrongType.ref;
    assert.throws(() => registry.validateRoute(mismatched, { authority: ["workspace.write"] }), /missing output|type mismatch/);
  });

  it("rejects unconnected required inputs and production cycles", () => {
    const registry = new StationRegistry();
    const first = registry.install(station({ id: "first-repair", authority: [] }));
    const second = registry.install(station({ id: "second-repair", authority: [] }));
    const stations = [{ id: "first", station: first.ref }, { id: "second", station: second.ref }];
    assert.throws(() => registry.validateRoute({ schema: 1, kind: "bantam.factory-route", id: "broken", stations, edges: [] }), /unconnected/);
    const edges = [
      { from: "first", out: "chassis", to: "second", in: "chassis" },
      { from: "second", out: "chassis", to: "first", in: "chassis" },
    ];
    assert.throws(() => registry.validateRoute({ schema: 1, kind: "bantam.factory-route", id: "cycle", stations, edges }), /cycle/);
  });
});

describe("factory traveler and supervisor projection", () => {
  it("preserves a failed branch, localizes the defect, and releases rework", () => {
    const traveler = buildReworkTraveler();
    assert.deepEqual(auditFactoryTraveler(traveler.events), {
      ok: true,
      jobId: "job-001",
      eventCount: 13,
      initialProductRevision: "tree:a",
      terminal: true,
    });

    const stopped = projectFactorySupervisor(traveler.events, 7);
    assert.equal(stopped.status, "line-stop");
    assert.equal(stopped.chassis.active, "tree:b");
    assert.equal(stopped.chassis.released, "tree:a");
    assert.deepEqual(stopped.chassis.contained, ["tree:b"]);
    assert.equal(stopped.firstAbnormal.createdAtStation, "repair-1");

    const final = projectFactorySupervisor(traveler.events);
    assert.equal(final.status, "released");
    assert.deepEqual(final.chassis.releasedLineage, ["tree:a", "tree:c"]);
    assert.deepEqual(final.chassis.contained, ["tree:b"]);
    assert.equal(final.reworkCount, 1);
    assert.equal(final.firstAbnormal.code, "test-failure");

    const comparison = compareFactoryFrames(traveler.events, 4, 13);
    assert.equal(comparison.productChanged, true);
    assert.equal(comparison.releasedProductChanged, true);
    assert.deepEqual(comparison.stationAttempts, ["repair-1", "repair-2"]);
  });

  it("supports inspection stations that do not create a new chassis revision", () => {
    const traveler = new FactoryTraveler({ jobId: "job-inspect", routeRef: "route:inspect", initialProductRevision: "tree:a" });
    traveler.append("station.started", { stationAttempt: "inspect-1", stationRef: "station:inspect@1", inputProductRevision: "tree:a" });
    traveler.append("station.completed", { stationAttempt: "inspect-1", inputProductRevision: "tree:a", outputProductRevision: "tree:a", artifactRefs: ["artifact:report"] });
    traveler.append("gauge.result", { stationAttempt: "inspect-1", gaugeRef: "gauge:inspect@1", status: "pass", evidenceRefs: ["artifact:report"] });
    traveler.append("station.released", { stationAttempt: "inspect-1", productRevision: "tree:a" });
    assert.deepEqual(projectFactorySupervisor(traveler.events).chassis.releasedLineage, ["tree:a"]);
  });

  it("refuses release without quality evidence and leaves the traveler unchanged", () => {
    const traveler = new FactoryTraveler({ jobId: "job-gate", routeRef: "route:gate", initialProductRevision: "tree:a" });
    traveler.append("station.started", { stationAttempt: "repair-1", stationRef: "station:repair@1", inputProductRevision: "tree:a" });
    traveler.append("station.completed", { stationAttempt: "repair-1", inputProductRevision: "tree:a", outputProductRevision: "tree:b", artifactRefs: [] });
    const before = traveler.events.length;
    assert.throws(() => traveler.append("station.released", { stationAttempt: "repair-1", productRevision: "tree:b" }), /passing gauge/);
    assert.equal(traveler.events.length, before);
  });

  it("allows downstream inspection to quarantine a previously station-released chassis", () => {
    const traveler = new FactoryTraveler({ jobId: "job-inspection-fail", routeRef: "route:inspect", initialProductRevision: "tree:a" });
    traveler.append("station.started", { stationAttempt: "inspect-1", stationRef: "station:inspect@1", inputProductRevision: "tree:a" });
    traveler.append("station.completed", { stationAttempt: "inspect-1", inputProductRevision: "tree:a", outputProductRevision: "tree:a", artifactRefs: ["artifact:report"] });
    traveler.append("gauge.result", { stationAttempt: "inspect-1", gaugeRef: "gauge:inspect@1", status: "fail", evidenceRefs: ["artifact:report"] });
    traveler.append("output.contained", { stationAttempt: "inspect-1", productRevision: "tree:a", reason: "Inspection failed." });
    const supervisor = projectFactorySupervisor(traveler.events);
    assert.equal(supervisor.chassis.released, null);
    assert.deepEqual(supervisor.chassis.contained, ["tree:a"]);
  });

  it("detects traveler tampering and does not retain mutable caller data", () => {
    const traveler = buildReworkTraveler();
    const tampered = structuredClone(traveler.events);
    tampered[3].payload.outputProductRevision = "tree:evil";
    assert.throws(() => auditFactoryTraveler(tampered), /hash mismatch/);

    const artifactRefs = ["artifact:one"];
    const second = new FactoryTraveler({ jobId: "job-copy", routeRef: "route:copy", initialProductRevision: "tree:a" });
    second.append("station.started", { stationAttempt: "copy-1", stationRef: "station:copy@1", inputProductRevision: "tree:a" });
    second.append("station.completed", { stationAttempt: "copy-1", inputProductRevision: "tree:a", outputProductRevision: "tree:b", artifactRefs });
    artifactRefs.push("artifact:late-mutation");
    assert.deepEqual(second.events.at(-1).payload.artifactRefs, ["artifact:one"]);
    assert.equal(Object.isFrozen(second.events.at(-1)), true);
    assert.equal(factoryFrameAt(second.events).activeProductRevision, "tree:b");
  });

  it("raises a live suspected-idle condition without inventing a root cause", () => {
    const started = "2026-08-01T12:00:00.000Z";
    const traveler = new FactoryTraveler({ jobId: "job-live", routeRef: "route:live", initialProductRevision: "tree:a", time: started });
    traveler.append("station.started", {
      stationAttempt: "worker-1",
      stationRef: "station:worker@1",
      inputProductRevision: "tree:a",
    }, { time: started });
    const live = projectFactoryLiveness(traveler.events, {
      now: Date.parse(started) + 31_000,
      idleAfterMs: 30_000,
    });
    assert.equal(live.condition, "suspected-idle");
    assert.equal(live.terminal, false);
    assert.equal(live.activeStations[0].stationAttempt, "worker-1");
    assert.equal(live.firstAbnormal, null);
  });
});

describe("station asset schema", () => {
  it("rejects accidental schema expansion", () => {
    assert.throws(() => defineStationAsset({ ...station(), surprise: true }), /unknown=\[surprise\]/);
  });
});
