import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineCognitiveProcessControlEvidence,
  defineCognitiveProcessPassport,
  defineFactoryProcessIr,
  defineStationAsset,
  evaluateCognitiveProcessQualification,
  gaugeRef,
  linkFactoryProcessIr,
  renderFactoryProcessLinkReport,
  semanticSensorStationAsset,
  StationRegistry,
} from "../src/factory.js";

const workerRef = `worker:local-diffusion@1:sha256:${"a".repeat(64)}`;
const contextKitRef = `context-kit:matrix@1:sha256:${"b".repeat(64)}`;
const recoveryPolicyRef = `cognitive-routing:matrix@1:sha256:${"c".repeat(64)}`;
const processGaugeRef = `gauge:reviewed-semantic-matrix@1:sha256:${"d".repeat(64)}`;
const controlIssuerRef = `gauge:process-control@1:sha256:${"9".repeat(64)}`;
const observedAt = "2026-08-02T22:00:00.000Z";
const validUntil = "2026-08-04T22:00:00.000Z";
const linkNow = "2026-08-03T12:00:00.000Z";

function controlEvidence({ stackRef, mechanismRef, mechanism, gauge, finding, controlStatus = "passed", controlTrials = 8, controlPasses = controlStatus === "passed" ? 8 : 0 }) {
  return defineCognitiveProcessControlEvidence({
    schema: 1, kind: "bantam.factory-cognitive-process-control-evidence",
    issuerRef: controlIssuerRef,
    stationRef: semanticSensorStationAsset().ref, taskFamily: "semantic-matrix-inspection",
    stackRef, mechanismRef, mechanism, gauge, finding, controlStatus,
    controlTrials, controlPasses,
    sourceRefs: [`evidence://${gauge}-control`, `evidence://${gauge}-observations`],
    observedAt, validUntil,
  });
}

function intakeStation() {
  return defineStationAsset({
    schema: 2, kind: "bantam.factory-station", id: "semantic-rack-intake", version: 1,
    title: "Semantic rack intake", purpose: "Admit immutable source and review racks.",
    worker: { kind: "tool", adapter: "fixture.intake/v1" }, inputs: [],
    outputs: [
      { name: "source-rack", artifactType: "bantam.semantic-source-rack/v1", required: true },
      { name: "reviewed-rack", artifactType: "bantam.semantic-reviewed-rack/v1", required: true },
    ],
    capabilities: ["material.admit"], authority: ["workspace.read"],
    gauge: { id: "semantic-rack-binding", version: 1, independent: true },
    dispositions: ["blocked", "contained", "released"], presentation: { group: "intake", icon: "dock", color: "amber" },
    standardWork: { operation: "Clamp source racks", instructions: ["Bind exact racks."], fixtures: ["Digest clamp"], prohibited: ["Do not rewrite source."], releaseCriteria: ["Digests match."] },
  });
}

function gaugeStation() {
  return defineStationAsset({
    schema: 2, kind: "bantam.factory-station", id: "semantic-matrix-release-gauge", version: 1,
    title: "Reviewed semantic matrix gauge", purpose: "Compare matrix decisions with independent reviewed truth.",
    worker: { kind: "tool", adapter: "fixture.gauge/v1" },
    inputs: [
      { name: "matrix", artifactType: "bantam.semantic-matrix/v1", required: true },
      { name: "reviewed-rack", artifactType: "bantam.semantic-reviewed-rack/v1", required: true },
    ],
    outputs: [{ name: "evidence", artifactType: "bantam.semantic-qualification-evidence/v1", required: true }],
    capabilities: ["quality.semantic-matrix"], authority: ["workspace.read"],
    gauge: { id: "reviewed-semantic-matrix", version: 1, independent: true },
    dispositions: ["blocked", "contained", "released"], presentation: { group: "quality", icon: "gauge", color: "green" },
    standardWork: { operation: "Press reviewed truth wicket", instructions: ["Compare every decision."], fixtures: ["Hidden reviewed rack"], prohibited: ["Do not repair matrix."], releaseCriteria: ["Every decision is exact."] },
  });
}

function processReport({ escaped = false, bindingStatus = null, prevention = null, controlStatus = "passed", evidenceOverrides = {} } = {}) {
  const sensor = semanticSensorStationAsset();
  const stackRef = `serving-stack:fixture@1:sha256:${"5".repeat(64)}`;
  const dieRef = `die:columns@1:sha256:${"e".repeat(64)}`;
  const canary = bindingStatus !== null && bindingStatus !== "untested"
    ? controlEvidence({ stackRef, mechanismRef: dieRef, mechanism: "grammar", gauge: "sampler-canary", finding: bindingStatus, controlStatus, ...evidenceOverrides })
    : null;
  const passport = {
    schema: 1, kind: "bantam.factory-cognitive-process-passport", id: "matrix-columns", version: 1,
    taskFamily: "semantic-matrix-inspection", workerRef, stationRef: sensor.ref,
    contextKitRef, dieRef,
    gaugeRefs: [processGaugeRef], recoveryPolicyRef,
  };
  if (bindingStatus !== null) {
    const canaryRef = canary?.ref ?? null;
    passport.dieBinding = {
      stackRef,
      mechanism: "grammar",
      canaryRef,
      status: bindingStatus,
    };
    const preventionSpec = prevention ?? (bindingStatus === "bound"
      ? { kind: "sampler-die", mechanismRef: passport.dieRef, necessity: "required-on-stack" }
      : { kind: "none", mechanismRef: null, necessity: "not-applicable" });
    if (preventionSpec.kind === "none") {
      passport.prevention = { ...preventionSpec, evidenceRef: null, necessityEvidenceRef: null };
    } else {
      const application = preventionSpec.kind === "sampler-die" ? canary : controlEvidence({
        stackRef, mechanismRef: preventionSpec.mechanismRef, mechanism: "prefill",
        gauge: "prefill-continuation", finding: "applied", controlStatus,
      });
      const necessityEvidence = preventionSpec.necessity === "untested-on-stack" ? null : controlEvidence({
        stackRef, mechanismRef: preventionSpec.mechanismRef, mechanism: preventionSpec.kind,
        gauge: "bare-arm", finding: preventionSpec.necessity,
      });
      passport.prevention = {
        ...preventionSpec,
        evidenceRef: application.ref,
        necessityEvidenceRef: necessityEvidence?.ref ?? null,
      };
    }
  }
  const process = defineCognitiveProcessPassport(passport);
  const attempt = (id, stressClass) => ({
    attemptId: id, stressClass, firstPassAccepted: true, finalAccepted: true,
    escapedDefect: false, defects: [],
    telemetry: { elapsedMs: 100, committedCanvases: 1, adaptivePasses: 4, promptTokens: 50, completionTokens: 10, calls: 1 },
    evidenceRefs: [`evidence://${id}`],
  });
  const attempts = [attempt("a", "nominal"), attempt("b", "neighbor"), attempt("c", "neighbor")];
  if (escaped) attempts[2] = { ...attempts[2], finalAccepted: false, escapedDefect: true, defects: ["wrong-record-escape"] };
  return evaluateCognitiveProcessQualification({
    process,
    policy: {
      schema: 1, kind: "bantam.factory-cognitive-process-qualification-policy", id: "link-fixture", version: 1,
      minimumArticles: 3, minimumStressClasses: 2, minimumFirstPassYield: 1,
      minimumRecoveredYield: 1, maximumEscapeRate: 0, maximumP95Ms: 500,
      maximumMeanCanvases: 1, maximumPassesPerReleased: 5,
    },
    attempts,
  });
}

function processControlEvidence(report, { applicationControlStatus = "passed", applicationOverrides = {} } = {}) {
  const { dieBinding, dieRef, prevention } = report.process;
  if (!dieBinding || !prevention) return [];
  const rows = [];
  if (dieBinding.canaryRef) rows.push(controlEvidence({
    stackRef: dieBinding.stackRef, mechanismRef: dieRef, mechanism: dieBinding.mechanism,
    gauge: "sampler-canary", finding: dieBinding.status, controlStatus: applicationControlStatus, ...applicationOverrides,
  }));
  if (prevention.kind === "prefill-jig") rows.push(controlEvidence({
    stackRef: dieBinding.stackRef, mechanismRef: prevention.mechanismRef, mechanism: "prefill",
    gauge: "prefill-continuation", finding: "applied", controlStatus: applicationControlStatus, ...applicationOverrides,
  }));
  if (prevention.necessityEvidenceRef) rows.push(controlEvidence({
    stackRef: dieBinding.stackRef, mechanismRef: prevention.mechanismRef, mechanism: prevention.kind,
    gauge: "bare-arm", finding: prevention.necessity,
  }));
  return [...new Map(rows.map((row) => [row.ref, row])).values()];
}

function plant() {
  const registry = new StationRegistry();
  const install = (asset) => { const copy = structuredClone(asset); delete copy.ref; return registry.install(copy); };
  const assets = { intake: install(intakeStation()), sensor: install(semanticSensorStationAsset()), gauge: install(gaugeStation()) };
  return { registry, assets };
}

function ir(processRef = processReport().process.ref, { requiresBoundDie = false } = {}) {
  const { assets } = plant();
  return {
    schema: 1, kind: "bantam.factory-process-ir", id: "semantic-matrix-shadow", version: 1,
    title: "Semantic matrix shadow process", taskFamily: "semantic-matrix-inspection",
    basis: { chassisRef: `source-rack:sha256:${"f".repeat(64)}`, factBasis: 42, workforceHead: `sha256:${"1".repeat(64)}`, processRegistryHead: `sha256:${"2".repeat(64)}` },
    goal: { objective: "Inspect a source rack and prove every semantic decision against reviewed truth.", acceptanceContractRef: `contract:semantic-matrix:sha256:${"3".repeat(64)}` },
    authority: ["workspace.read"],
    operations: [
      { id: "intake", kind: "deterministic", stationRef: assets.intake.ref, taskFamily: "semantic-matrix-inspection", processRef: null, obligationIds: [] },
      { id: "sensor", kind: "bounded-judgment", stationRef: assets.sensor.ref, taskFamily: "semantic-matrix-inspection", processRef, obligationIds: [], ...(requiresBoundDie ? { requiresBoundDie: true } : {}) },
      { id: "gauge", kind: "deterministic", stationRef: assets.gauge.ref, taskFamily: "semantic-matrix-inspection", processRef: null, obligationIds: ["semantic-exactness"] },
    ],
    edges: [
      { from: "intake", out: "source-rack", to: "sensor", in: "source-rack" },
      { from: "sensor", out: "matrix", to: "gauge", in: "matrix" },
      { from: "intake", out: "reviewed-rack", to: "gauge", in: "reviewed-rack" },
    ],
    proofObligations: [{ id: "semantic-exactness", description: "Every matrix decision matches independently reviewed truth.", gaugeOperationId: "gauge" }],
    release: { operationId: "gauge", outputPort: "evidence", obligationIds: ["semantic-exactness"] },
    layout: { direction: "left-to-right", operations: [{ id: "intake", x: 0, y: 1 }, { id: "sensor", x: 1, y: 1 }, { id: "gauge", x: 2, y: 1 }] },
  };
}

function link(value, report = processReport(), overrides = {}) {
  const { registry, assets } = plant();
  const binding = report.process.dieBinding;
  const prevention = report.process.prevention;
  return linkFactoryProcessIr({
    ir: value,
    stationRegistry: registry,
    processQualifications: [report],
    installedGaugeRefs: [gaugeRef(assets.intake), gaugeRef(assets.sensor), gaugeRef(assets.gauge), processGaugeRef],
    installedContextKitRefs: [contextKitRef],
    installedRecoveryPolicyRefs: [recoveryPolicyRef],
    installedProcessControlEvidence: processControlEvidence(report),
    trustedProcessControlIssuerRefs: [controlIssuerRef],
    now: linkNow,
    workerResources: [{ workerRef, condition: "available", slotsAvailable: 1, ...(binding ? { stackRef: binding.stackRef } : {}) }],
    ...overrides,
  });
}

describe("factory Process IR compiler", () => {
  it("defines a stable strict IR whose identity changes with its process binding", () => {
    const first = defineFactoryProcessIr(ir());
    assert.equal(defineFactoryProcessIr(first).ref, first.ref);
    const changed = ir(`cognitive-process:different@1:sha256:${"9".repeat(64)}`);
    assert.notEqual(defineFactoryProcessIr(changed).ref, first.ref);
    assert.notEqual(defineFactoryProcessIr(ir(undefined, { requiresBoundDie: true })).ref, first.ref);
    const tampered = structuredClone(first); tampered.goal.objective = "different";
    assert.throws(() => defineFactoryProcessIr(tampered), /content hash/);
  });

  it("links typed flow, qualification, resources, gauges, proof closure, and authority into one executable blueprint", () => {
    const report = link(ir());
    assert.equal(report.status, "linked", JSON.stringify(report.diagnostics));
    assert.equal(report.diagnostics.length, 0);
    assert.match(report.blueprintRef, /^blueprint:/);
    assert.match(report.routeRef, /^route:/);
    assert.equal(report.projection.nodes.length, 3);
    assert.deepEqual(report.projection.edges.map((row) => row.artifactType), ["bantam.semantic-source-rack/v1", "bantam.semantic-matrix/v1", "bantam.semantic-reviewed-rack/v1"]);
    assert.equal(report.bindings.find((row) => row.operationId === "sensor").status, "qualified");
    assert.match(renderFactoryProcessLinkReport(report), /PROCESS COMPILER LINK FLOOR/);
  });

  it("rejects a process with a downstream escape even when its model, station, and die all resolve", () => {
    const candidate = processReport({ escaped: true });
    const value = ir(candidate.process.ref);
    const report = link(value, candidate);
    assert.equal(report.status, "rejected");
    assert.ok(report.diagnostics.some((row) => row.code === "process-not-qualified"));
    assert.equal(report.blueprint, null);
  });

  it("reports missing machinery, health, capacity, gauges, recovery, and authority as distinct link errors", () => {
    const { registry } = plant();
    const report = linkFactoryProcessIr({
      ir: { ...ir(), authority: [] },
      stationRegistry: registry,
      processQualifications: [processReport()],
      installedGaugeRefs: [], installedContextKitRefs: [], installedRecoveryPolicyRefs: [],
      workerResources: [{ workerRef, condition: "unavailable", slotsAvailable: 0 }],
    });
    const codes = new Set(report.diagnostics.map((row) => row.code));
    for (const code of ["authority-ungranted", "station-gauge-uninstalled", "process-gauge-uninstalled", "context-kit-uninstalled", "recovery-policy-uninstalled", "worker-unavailable", "worker-capacity-zero"]) assert.ok(codes.has(code), code);
  });

  it("rejects route type errors and uncovered release obligations before blueprint emission", () => {
    const mismatched = ir(); mismatched.edges[1] = { from: "intake", out: "reviewed-rack", to: "gauge", in: "matrix" };
    const routeFailure = link(mismatched);
    assert.ok(routeFailure.diagnostics.some((row) => row.code === "route-link-failed" && /type mismatch|multiple producers/.test(row.detail)));
    const uncovered = ir(); uncovered.release.obligationIds = [];
    const proofFailure = link(uncovered);
    assert.ok(proofFailure.diagnostics.some((row) => row.code === "release-obligation-uncovered"));
  });

  it("links an operation that explicitly requires a canary-proven bound sampler die", () => {
    const report = processReport({ bindingStatus: "bound" });
    const result = link(ir(report.process.ref, { requiresBoundDie: true }), report);
    assert.equal(result.status, "linked", JSON.stringify(result.diagnostics));
    const binding = result.bindings.find((row) => row.operationId === "sensor");
    assert.equal(binding.dieBinding.status, "bound");
    assert.equal(binding.prevention.kind, "sampler-die");
    assert.equal(binding.prevention.necessity, "required-on-stack");
    assert.equal(binding.controlEvidence[0].controlPassRate, 1);
    assert.match(renderFactoryProcessLinkReport(result), /die-binding/i);
    assert.match(renderFactoryProcessLinkReport(result), /required-on-stack/);
  });

  it("distinguishes untested, intermittent, and not-bound prevention failures", () => {
    for (const [status, code] of [
      ["untested", "die-binding-untested"],
      ["intermittent", "die-binding-intermittent"],
      ["not-bound", "die-binding-not-bound"],
    ]) {
      const report = processReport({ bindingStatus: status });
      const result = link(ir(report.process.ref, { requiresBoundDie: true }), report);
      assert.equal(result.status, "rejected", status);
      assert.ok(result.diagnostics.some((row) => row.code === code), `${status}: ${JSON.stringify(result.diagnostics)}`);
      assert.equal(result.blueprint, null);
    }
    const legacy = processReport();
    const legacyResult = link(ir(legacy.process.ref, { requiresBoundDie: true }), legacy);
    assert.ok(legacyResult.diagnostics.some((row) => row.code === "die-binding-untested"));
  });

  it("rejects a claimed binding when its canary is absent or the staffed stack drifted", () => {
    const report = processReport({ bindingStatus: "bound" });
    const value = ir(report.process.ref, { requiresBoundDie: true });
    const missingEvidence = link(value, report, { installedProcessControlEvidence: [] });
    assert.ok(missingEvidence.diagnostics.some((row) => row.code === "die-binding-evidence-uninstalled"));
    const untrustedEvidence = link(value, report, { trustedProcessControlIssuerRefs: [] });
    assert.ok(untrustedEvidence.diagnostics.some((row) => row.code === "process-control-evidence-untrusted-issuer"));
    const onlyCanary = processControlEvidence(report).filter((row) => row.gauge === "sampler-canary");
    const missingPreventionEvidence = link(value, report, { installedProcessControlEvidence: onlyCanary });
    assert.ok(missingPreventionEvidence.diagnostics.some((row) => row.code === "prevention-necessity-evidence-uninstalled"));
    const expiredEvidence = link(value, report, { now: "2026-08-05T00:00:00.000Z" });
    assert.ok(expiredEvidence.diagnostics.some((row) => row.code === "process-control-evidence-expired"));
    const futureEvidence = link(value, report, { now: "2026-08-01T00:00:00.000Z" });
    assert.ok(futureEvidence.diagnostics.some((row) => row.code === "process-control-evidence-not-yet-valid"));
    const failedControlReport = processReport({ bindingStatus: "bound", controlStatus: "failed" });
    const failedControl = link(ir(failedControlReport.process.ref, { requiresBoundDie: true }), failedControlReport, {
      installedProcessControlEvidence: processControlEvidence(failedControlReport, { applicationControlStatus: "failed" }),
    });
    assert.ok(failedControl.diagnostics.some((row) => row.code === "die-binding-evidence-mismatch" && /controlStatus/.test(row.detail)));
    const wrongEvidenceStack = `serving-stack:wrong-evidence@1:sha256:${"7".repeat(64)}`;
    const mismatchedReport = processReport({ bindingStatus: "bound", evidenceOverrides: { stackRef: wrongEvidenceStack } });
    const mismatchedEvidence = link(ir(mismatchedReport.process.ref, { requiresBoundDie: true }), mismatchedReport, {
      installedProcessControlEvidence: processControlEvidence(mismatchedReport, { applicationOverrides: { stackRef: wrongEvidenceStack } }),
    });
    assert.equal(mismatchedEvidence.blueprint, null);
    assert.ok(mismatchedEvidence.diagnostics.some((row) => row.code === "die-binding-evidence-mismatch" && /stackRef/.test(row.detail)));
    const changedStack = link(value, report, {
      workerResources: [{ workerRef, condition: "available", slotsAvailable: 1, stackRef: `serving-stack:changed@1:sha256:${"8".repeat(64)}` }],
    });
    assert.ok(changedStack.diagnostics.some((row) => row.code === "worker-stack-mismatch"));
    const unknownStack = link(value, report, { workerResources: [{ workerRef, condition: "available", slotsAvailable: 1 }] });
    assert.ok(unknownStack.diagnostics.some((row) => row.code === "worker-stack-unverified"));
  });

  it("allows an independently qualified fitting process only when sampler prevention is not required", () => {
    const report = processReport({
      bindingStatus: "not-bound",
      prevention: { kind: "prefill-jig", mechanismRef: "fixture:matrix-prefill@1", necessity: "required-on-stack" },
    });
    const result = link(ir(report.process.ref), report);
    assert.equal(result.status, "linked", JSON.stringify(result.diagnostics));
    const binding = result.bindings.find((row) => row.operationId === "sensor");
    assert.equal(binding.dieBinding.status, "not-bound");
    assert.equal(binding.prevention.kind, "prefill-jig");
    const bareOnly = processControlEvidence(report).filter((row) => row.gauge !== "prefill-continuation");
    const missingContinuation = link(ir(report.process.ref), report, { installedProcessControlEvidence: bareOnly });
    assert.ok(missingContinuation.diagnostics.some((row) => row.code === "prevention-evidence-uninstalled"));
  });

  it("rejects bound-die requirements on non-model operations", () => {
    const value = ir();
    value.operations[0].requiresBoundDie = true;
    assert.throws(() => defineFactoryProcessIr(value), /non-model.*bound die/i);
  });
});
