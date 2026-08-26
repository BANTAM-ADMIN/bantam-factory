import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  COGNITIVE_DEFECT_CLASSES,
  CognitiveProcessRegistry,
  defineCognitiveDefectRoutingPolicy,
  defineCognitiveProcessControlEvidence,
  defineCognitiveProcessPassport,
  evaluateCognitiveProcessQualification,
  projectCognitiveProcessControl,
  projectFactoryYard,
  routeCognitiveProcessAttempt,
  selectCognitiveProcess,
} from "../src/factory.js";

const stationRef = `station:semantic-matrix-inspector@1:sha256:${"a".repeat(64)}`;
const workerRef = `worker:diffusiongemma-9b@1:sha256:${"b".repeat(64)}`;

function processPassport(id = "columns", die = id, additions = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-cognitive-process-passport",
    id,
    version: 1,
    taskFamily: "semantic-matrix-inspection",
    workerRef,
    stationRef,
    contextKitRef: `context-kit:semantic-rack@1:sha256:${"c".repeat(64)}`,
    dieRef: `die:${die}@1:sha256:${"d".repeat(64)}`,
    gaugeRefs: [`gauge:reviewed-matrix@1:sha256:${"e".repeat(64)}`],
    recoveryPolicyRef: `cognitive-routing:bounded@1:sha256:${"f".repeat(64)}`,
    ...additions,
  };
}

function boundDie(additions = {}) {
  const canaryRef = `die-binding-evidence:sha256:${"7".repeat(64)}`;
  const dieRef = `die:columns@1:sha256:${"d".repeat(64)}`;
  return {
    dieBinding: {
      stackRef: `serving-stack:llama-cpp-qwen@1:sha256:${"6".repeat(64)}`,
      mechanism: "grammar",
      canaryRef,
      status: "bound",
      ...additions,
    },
    prevention: {
      kind: "sampler-die",
      mechanismRef: dieRef,
      evidenceRef: canaryRef,
      necessity: "required-on-stack",
      necessityEvidenceRef: `bare-arm-evidence:sha256:${"8".repeat(64)}`,
    },
  };
}

function qualificationPolicy(overrides = {}) {
  return {
    schema: 1,
    kind: "bantam.factory-cognitive-process-qualification-policy",
    id: "semantic-matrix-wind-tunnel",
    version: 1,
    minimumArticles: 3,
    minimumStressClasses: 2,
    minimumFirstPassYield: 2 / 3,
    minimumRecoveredYield: 1,
    maximumEscapeRate: 0,
    maximumP95Ms: 1_000,
    maximumMeanCanvases: 2,
    maximumPassesPerReleased: 10,
    ...overrides,
  };
}

function attempt(id, overrides = {}) {
  return {
    attemptId: id,
    stressClass: id === "a" ? "nominal" : "near-neighbor",
    firstPassAccepted: true,
    finalAccepted: true,
    escapedDefect: false,
    defects: [],
    telemetry: {
      elapsedMs: 100,
      committedCanvases: 1,
      adaptivePasses: 3,
      promptTokens: 100,
      completionTokens: 20,
      calls: 1,
    },
    evidenceRefs: [`evidence://${id}`],
    ...overrides,
  };
}

function routingPolicy() {
  const actions = {
    "ambiguous-source": "recompile-context",
    "die-rejected": "split-lot",
    infrastructure: "alternate-worker",
    "malformed-output": "redraw",
    "protocol-fitting": "supervisor-review",
    "registry-inseparable": "recompile-context",
    "retry-exhausted": "supervisor-review",
    "semantic-rejection": "stronger-worker",
    "unknown-handle": "split-lot",
    "unmatched-source": "redraw",
    "wrong-record-escape": "stronger-worker",
  };
  return {
    schema: 1,
    kind: "bantam.factory-cognitive-defect-routing-policy",
    id: "bounded",
    version: 1,
    routes: COGNITIVE_DEFECT_CLASSES.map((defect) => ({ defect, action: actions[defect], maxAttempts: defect === "wrong-record-escape" ? 0 : 2 })),
  };
}

function qualified(id = "columns", telemetry = {}) {
  return evaluateCognitiveProcessQualification({
    process: processPassport(id),
    policy: qualificationPolicy(),
    attempts: [
      attempt(`${id}-a`, { stressClass: "nominal", telemetry: { ...attempt("x").telemetry, ...telemetry } }),
      attempt(`${id}-b`, { stressClass: "near-neighbor", telemetry: { ...attempt("x").telemetry, ...telemetry } }),
      attempt(`${id}-c`, { stressClass: "near-neighbor", firstPassAccepted: false, defects: ["protocol-fitting"], telemetry: { ...attempt("x").telemetry, adaptivePasses: 4, ...telemetry } }),
    ],
  });
}

describe("cognitive process metrology", () => {
  it("content-addresses stack-bound, expiring control evidence and rejects a tampered witness", () => {
    const evidence = defineCognitiveProcessControlEvidence({
      schema: 1,
      kind: "bantam.factory-cognitive-process-control-evidence",
      issuerRef: `gauge:die-binding-canary@1:sha256:${"9".repeat(64)}`,
      stationRef,
      taskFamily: "semantic-matrix-inspection",
      stackRef: `serving-stack:llama-cpp-qwen@1:sha256:${"6".repeat(64)}`,
      mechanismRef: `die:columns@1:sha256:${"d".repeat(64)}`,
      mechanism: "grammar",
      gauge: "sampler-canary",
      finding: "bound",
      controlStatus: "passed",
      controlTrials: 8,
      controlPasses: 8,
      sourceRefs: ["evidence://canary-control", "evidence://canary-constrained"],
      observedAt: "2026-08-02T22:00:00.000Z",
      validUntil: "2026-08-03T22:00:00.000Z",
    });
    assert.match(evidence.ref, /^process-control-evidence:sha256:/);
    assert.equal(evidence.controlPassRate, 1);
    assert.equal(defineCognitiveProcessControlEvidence(evidence).ref, evidence.ref);
    const tampered = structuredClone(evidence); tampered.finding = "not-bound";
    assert.throws(() => defineCognitiveProcessControlEvidence(tampered), /content hash/);
    assert.throws(() => defineCognitiveProcessControlEvidence({ ...evidence, ref: undefined, gauge: "prefill-continuation" }), /gauge.*finding|finding.*gauge/i);
    const weakControl = defineCognitiveProcessControlEvidence({ ...evidence, ref: undefined, controlPasses: 1, controlPassRate: undefined });
    assert.equal(weakControl.controlPassRate, 0.125);
    assert.notEqual(weakControl.ref, evidence.ref);
  });

  it("content-addresses the complete process rather than treating the model as the qualification unit", () => {
    const columns = defineCognitiveProcessPassport(processPassport("columns", "columns"));
    const bits = defineCognitiveProcessPassport(processPassport("columns", "bits"));
    assert.match(columns.ref, /^cognitive-process:columns@1:sha256:/);
    assert.notEqual(columns.ref, bits.ref);
    const tampered = structuredClone(columns); tampered.workerRef = "worker:someone-else";
    assert.throws(() => defineCognitiveProcessPassport(tampered), /content hash/);
  });

  it("binds exact serving-stack enforcement and prevention provenance into process identity", () => {
    const legacy = defineCognitiveProcessPassport(processPassport());
    const bound = defineCognitiveProcessPassport(processPassport("columns", "columns", boundDie()));
    assert.notEqual(bound.ref, legacy.ref);
    assert.equal(bound.dieBinding.status, "bound");
    assert.equal(bound.prevention.kind, "sampler-die");
    assert.equal(bound.prevention.necessity, "required-on-stack");
    for (const [field, value] of [
      ["stackRef", `serving-stack:other@1:sha256:${"1".repeat(64)}`],
      ["mechanism", "json-schema"],
      ["canaryRef", `die-binding-evidence:sha256:${"2".repeat(64)}`],
      ["status", "intermittent"],
    ]) {
      const changed = boundDie({ [field]: value });
      if (field === "canaryRef") changed.prevention.evidenceRef = value;
      if (field === "status") changed.prevention = { kind: "none", mechanismRef: null, evidenceRef: null, necessity: "not-applicable", necessityEvidenceRef: null };
      assert.notEqual(defineCognitiveProcessPassport(processPassport("columns", "columns", changed)).ref, bound.ref, field);
    }
    const optimized = boundDie(); optimized.prevention.necessity = "not-required-on-stack";
    assert.notEqual(defineCognitiveProcessPassport(processPassport("columns", "columns", optimized)).ref, bound.ref);
  });

  it("fails closed on unsupported or self-contradictory prevention claims", () => {
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: { ...boundDie().dieBinding, canaryRef: null },
      prevention: { kind: "none", mechanismRef: null, evidenceRef: null, necessity: "not-applicable", necessityEvidenceRef: null },
    })), /canary/);
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: { ...boundDie().dieBinding, status: "untested" },
      prevention: { kind: "none", mechanismRef: null, evidenceRef: null, necessity: "not-applicable", necessityEvidenceRef: null },
    })), /untested.*canary/i);
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: { ...boundDie().dieBinding, status: "not-bound" },
      prevention: boundDie().prevention,
    })), /sampler.*bound/i);
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: boundDie().dieBinding,
      prevention: { ...boundDie().prevention, mechanismRef: "die:other" },
    })), /mechanismRef.*dieRef/);
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: boundDie().dieBinding,
      prevention: { ...boundDie().prevention, necessity: "untested-on-stack" },
    })), /untested.*necessity evidence/i);
    assert.throws(() => defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: boundDie().dieBinding,
      prevention: { ...boundDie().prevention, necessityEvidenceRef: null },
    })), /necessity.*evidence/i);
    const fixture = defineCognitiveProcessPassport(processPassport("columns", "columns", {
      dieBinding: { ...boundDie().dieBinding, status: "not-bound" },
      prevention: {
        kind: "prefill-jig",
        mechanismRef: "fixture:columns-prefill@1",
        evidenceRef: "evidence://prefill-continuation-check",
        necessity: "required-on-stack",
        necessityEvidenceRef: "evidence://prefill-bare-arm",
      },
    }));
    assert.equal(fixture.prevention.kind, "prefill-jig");
  });

  it("separates first-pass capability, recovered yield, escapes, and sampler economics", () => {
    const report = qualified();
    assert.equal(report.status, "qualified");
    assert.equal(report.metrics.firstPassYield, 2 / 3);
    assert.equal(report.metrics.recoveredYield, 1);
    assert.equal(report.metrics.escapeRate, 0);
    assert.equal(report.metrics.protocolFittings, 1);
    assert.equal(report.metrics.committedCanvases, 3);
    assert.equal(report.metrics.adaptivePasses, 10);
    assert.equal(report.metrics.passesPerReleased, 10 / 3);
    assert.match(report.artifactId, /^cognitive-process-qualification:sha256:/);
  });

  it("fails qualification when a downstream semantic gauge catches a cleanly localized wrong record", () => {
    const escaped = attempt("escape", {
      stressClass: "near-neighbor",
      firstPassAccepted: true,
      finalAccepted: false,
      escapedDefect: true,
      defects: ["wrong-record-escape"],
    });
    const report = evaluateCognitiveProcessQualification({
      process: processPassport("unsafe-anchor"),
      policy: qualificationPolicy(),
      attempts: [attempt("a"), attempt("b"), escaped],
    });
    assert.equal(report.status, "candidate");
    assert.equal(report.metrics.escapeRate, 1 / 3);
    assert.ok(report.blockers.some((row) => row.code === "escape-rate-above-die"));
    assert.ok(report.blockers.some((row) => row.code === "recovered-yield-below-die"));
  });

  it("routes every known defect explicitly and contains exhausted or escaped work", () => {
    const policy = defineCognitiveDefectRoutingPolicy(routingPolicy());
    assert.equal(policy.routes.length, COGNITIVE_DEFECT_CLASSES.length);
    const clean = routeCognitiveProcessAttempt({ attempt: attempt("clean"), policy });
    assert.equal(clean.action, "release");
    const malformed = routeCognitiveProcessAttempt({ attempt: attempt("bad", { firstPassAccepted: false, finalAccepted: false, defects: ["malformed-output"] }), policy });
    assert.equal(malformed.action, "redraw");
    const exhausted = routeCognitiveProcessAttempt({ attempt: attempt("bad-2", { firstPassAccepted: false, finalAccepted: false, defects: ["malformed-output"] }), policy, attemptsByDefect: { "malformed-output": 2 } });
    assert.deepEqual({ action: exhausted.action, disposition: exhausted.disposition, exhausted: exhausted.exhausted }, { action: "contain", disposition: "contained", exhausted: true });
    const escape = routeCognitiveProcessAttempt({ attempt: attempt("escape", { firstPassAccepted: true, finalAccepted: false, escapedDefect: true, defects: ["wrong-record-escape"] }), policy });
    assert.equal(escape.action, "contain");
    assert.equal(escape.exhausted, true);
    const incomplete = routingPolicy(); incomplete.routes.pop();
    assert.throws(() => defineCognitiveDefectRoutingPolicy(incomplete), /routes are incomplete/);
  });

  it("selects a qualified process passport by risk and physical sampler cost", () => {
    const oneCanvas = qualified("columns", { committedCanvases: 1, adaptivePasses: 4, elapsedMs: 200 });
    const twoCanvas = qualified("bits", { committedCanvases: 2, adaptivePasses: 6, elapsedMs: 250 });
    const unsafe = evaluateCognitiveProcessQualification({
      process: processPassport("unsafe"), policy: qualificationPolicy(),
      attempts: [attempt("a"), attempt("b"), attempt("c", { firstPassAccepted: false, finalAccepted: false, defects: ["die-rejected"] })],
    });
    const selection = selectCognitiveProcess([twoCanvas, unsafe, oneCanvas]);
    assert.equal(selection.mode, "shadow");
    assert.equal(selection.selected, oneCanvas.process.ref);
    assert.equal(selection.eligible.length, 2);
    assert.equal(selection.rejected[0].processRef, unsafe.process.ref);
  });

  it("projects failed process dies as an observe-only yard control", () => {
    const good = qualified();
    const bad = evaluateCognitiveProcessQualification({
      process: processPassport("bad"), policy: qualificationPolicy({ maximumP95Ms: 50 }),
      attempts: [attempt("a"), attempt("b"), attempt("c")],
    });
    const control = projectCognitiveProcessControl([good, bad], { basis: "wind-tunnel:fixture" });
    assert.equal(control.authority, "observe-only");
    assert.equal(control.summary.processes, 2);
    assert.equal(control.summary.qualified, 1);
    assert.equal(control.summary.total, control.exceptions.length);
    assert.ok(control.exceptions.some((row) => row.code === "p95-latency-above-die"));
    const tampered = structuredClone(good); tampered.metrics.escapeRate = 1;
    assert.throws(() => projectCognitiveProcessControl([tampered]), /content hash/);
  });

  it("persists passports and evidence, then feeds the same control artifact into the factory yard", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cognitive-processes-"));
    try {
      const registry = new CognitiveProcessRegistry(root);
      const good = qualified("durable-columns");
      const bad = evaluateCognitiveProcessQualification({
        process: processPassport("durable-bits"), policy: qualificationPolicy(),
        attempts: [attempt("a"), attempt("b"), attempt("c", { firstPassAccepted: false, finalAccepted: false, defects: ["die-rejected"] })],
      });
      for (const report of [good, bad]) {
        registry.install(report.process);
        registry.recordQualification(report);
        assert.equal(registry.recordQualification(report).artifactId, report.artifactId);
      }
      const state = registry.project();
      assert.equal(state.processes.length, 2);
      assert.equal(state.qualifications.length, 2);
      assert.equal(state.history.length, 2);
      assert.equal(registry.select({ stationRef, taskFamily: "semantic-matrix-inspection" }).selected, good.process.ref);
      const control = registry.control({ basis: "registry:fixture" });
      const yard = projectFactoryYard({ root, semanticControls: [control] });
      assert.equal(yard.summary.semanticAndons, control.summary.total);
      assert.equal(yard.semanticControls.find((row) => row.kind === control.kind).artifactId, control.artifactId);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
