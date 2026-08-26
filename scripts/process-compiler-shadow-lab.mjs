#!/usr/bin/env node

/** Link a real Process IR against the durable cognitive wind-tunnel registry. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CognitiveProcessRegistry,
  defineFactoryProcessIr,
  defineStationAsset,
  gaugeRef,
  linkFactoryProcessIr,
  renderFactoryProcessLinkReport,
  semanticReviewedGaugeStationAsset,
  semanticSensorStationAsset,
  StationRegistry,
} from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const factoryRoot = resolve(option("factory-home", ".bantam"));
const irOutput = resolve(option("ir", ".bantam/factory-processes/semantic-matrix-shadow-v1.json"));
const output = resolve(option("output", ".bantam/factory-benchmarks/process-compiler-shadow-v1.json"));
const htmlOutput = resolve(option("html", ".bantam/factory-reports/process-compiler-shadow-v1.html"));

const processRegistry = new CognitiveProcessRegistry(factoryRoot);
const processState = processRegistry.project();
const sensor = semanticSensorStationAsset();
const gauge = semanticReviewedGaugeStationAsset();
const intake = semanticMatrixIntakeStationAsset();
const candidates = processState.qualifications.filter((row) => (
  row.process.stationRef === sensor.ref
  && row.process.taskFamily === "semantic-matrix-inspection"
  && row.process.version === 2
));
if (candidates.length !== 3) throw new Error(`expected three exact semantic-matrix process passports, found ${candidates.length}; run npm run factory:cognitive-wind-tunnel first`);
const selection = processRegistry.select({ stationRef: sensor.ref, taskFamily: "semantic-matrix-inspection" });
const selected = candidates.find((row) => row.process.ref === selection.selected);
if (!selected) throw new Error("durable process registry did not select an exact semantic-matrix process");

const stationRegistry = new StationRegistry();
for (const asset of [intake, sensor, gauge]) stationRegistry.install(withoutRef(asset));
const installedGaugeRefs = [gaugeRef(intake), gaugeRef(sensor), gaugeRef(gauge), ...candidates.flatMap((row) => row.process.gaugeRefs)];
const installedContextKitRefs = candidates.map((row) => row.process.contextKitRef);
const installedRecoveryPolicyRefs = candidates.map((row) => row.process.recoveryPolicyRef);
const workerResources = [{ workerRef: selected.process.workerRef, condition: "available", slotsAvailable: 1 }];

const selectedIr = defineFactoryProcessIr(processIr(selected.process.ref, { intake, sensor, gauge, processRegistryHead: processState.head, id: "semantic-matrix-shadow" }));
const linked = link(selectedIr, candidates);
if (linked.status !== "linked") throw new Error(`selected Process IR failed to link: ${JSON.stringify(linked.diagnostics)}`);
const alternatives = candidates.filter((row) => row.process.ref !== selected.process.ref).map((qualification, index) => {
  const candidateIr = defineFactoryProcessIr(processIr(qualification.process.ref, { intake, sensor, gauge, processRegistryHead: processState.head, id: `semantic-matrix-candidate-${index + 1}` }));
  const result = link(candidateIr, candidates);
  return { processRef: qualification.process.ref, processId: qualification.process.id, qualificationStatus: qualification.status, irRef: candidateIr.ref, linkStatus: result.status, diagnostics: result.diagnostics };
});
if (alternatives.some((row) => row.linkStatus !== "rejected" || !row.diagnostics.some((diagnostic) => diagnostic.code === "process-not-qualified"))) throw new Error("an unqualified candidate process escaped the linker");

const article = {
  schema: "bantam.factory.process-compiler-shadow-lab.v1",
  kind: "bantam.factory-process-compiler-shadow-lab",
  authority: "observe-only",
  processRegistry: { root: factoryRoot, head: processState.head, events: processState.events, processes: processState.processes.length, qualifications: processState.qualifications.length },
  selection,
  selectedProcess: selected,
  processIr: selectedIr,
  link: linked,
  rejectedAlternatives: alternatives,
  findings: [
    "The same retained evidence that qualified the columns die now controls whether the graph can link.",
    "Candidate bit and verbose processes resolve to real installed machinery but fail linking because their exact passports are not qualified.",
    "The linked artifact is also a strict factory blueprint; backend material types and the rendered graph are one object.",
    "The link remains observe-only. Execution requires adapters, material, permits, and a separately authorized dispatch step.",
  ],
};

await Promise.all([mkdir(dirname(irOutput), { recursive: true }), mkdir(dirname(output), { recursive: true }), mkdir(dirname(htmlOutput), { recursive: true })]);
await Promise.all([
  writeFile(irOutput, `${JSON.stringify(selectedIr, null, 2)}\n`),
  writeFile(output, `${JSON.stringify(article, null, 2)}\n`),
  writeFile(htmlOutput, renderFactoryProcessLinkReport(linked)),
]);
console.log(JSON.stringify({
  irOutput,
  output,
  htmlOutput,
  irRef: selectedIr.ref,
  linkStatus: linked.status,
  blueprintRef: linked.blueprintRef,
  routeRef: linked.routeRef,
  selectedProcess: selected.process.ref,
  rejectedAlternatives: alternatives.map((row) => ({ id: row.processId, diagnostics: row.diagnostics.map((item) => item.code) })),
}, null, 2));

function link(ir, qualifications) {
  return linkFactoryProcessIr({
    ir,
    stationRegistry,
    processQualifications: qualifications,
    installedGaugeRefs: [...new Set(installedGaugeRefs)],
    installedContextKitRefs: [...new Set(installedContextKitRefs)],
    installedRecoveryPolicyRefs: [...new Set(installedRecoveryPolicyRefs)],
    workerResources,
  });
}

function processIr(processRef, { intake, sensor, gauge, processRegistryHead, id }) {
  return {
    schema: 1,
    kind: "bantam.factory-process-ir",
    id,
    version: 1,
    title: "Reviewed semantic matrix production process",
    taskFamily: "semantic-matrix-inspection",
    basis: {
      chassisRef: "semantic-source-rack:retained-live-cohort-v2",
      factBasis: 0,
      workforceHead: null,
      processRegistryHead,
    },
    goal: {
      objective: "Manufacture a semantic decision matrix and prove every decision against independently reviewed truth.",
      acceptanceContractRef: "acceptance-contract:reviewed-semantic-matrix@1",
    },
    authority: ["workspace.read"],
    operations: [
      { id: "intake", kind: "deterministic", stationRef: intake.ref, taskFamily: "semantic-matrix-inspection", processRef: null, obligationIds: [] },
      { id: "sensor", kind: "bounded-judgment", stationRef: sensor.ref, taskFamily: "semantic-matrix-inspection", processRef, obligationIds: [] },
      { id: "reviewed-gauge", kind: "deterministic", stationRef: gauge.ref, taskFamily: "semantic-matrix-inspection", processRef: null, obligationIds: ["reviewed-exactness"] },
    ],
    edges: [
      { from: "intake", out: "source-rack", to: "sensor", in: "source-rack" },
      { from: "sensor", out: "matrix", to: "reviewed-gauge", in: "matrix" },
      { from: "intake", out: "reviewed-rack", to: "reviewed-gauge", in: "reviewed-rack" },
    ],
    proofObligations: [{ id: "reviewed-exactness", description: "Every semantic decision is exact against an independently reviewed rack.", gaugeOperationId: "reviewed-gauge" }],
    release: { operationId: "reviewed-gauge", outputPort: "evidence", obligationIds: ["reviewed-exactness"] },
    layout: { direction: "left-to-right", operations: [{ id: "intake", x: 0, y: 0 }, { id: "sensor", x: 1, y: 0 }, { id: "reviewed-gauge", x: 2, y: 0 }] },
  };
}

function semanticMatrixIntakeStationAsset() {
  return defineStationAsset({
    schema: 2,
    kind: "bantam.factory-station",
    id: "semantic-matrix-process-intake",
    version: 1,
    title: "Semantic source and review rack intake",
    purpose: "Bind immutable source and independently reviewed material before cognitive work.",
    worker: { kind: "tool", adapter: "bantam.factory.semantic-matrix-process-intake/v1" },
    inputs: [],
    outputs: [
      { name: "source-rack", artifactType: "bantam.semantic-source-rack/v1", required: true },
      { name: "reviewed-rack", artifactType: "bantam.semantic-reviewed-rack/v1", required: true },
    ],
    capabilities: ["material.semantic-rack.admit"],
    authority: ["workspace.read"],
    gauge: { id: "semantic-process-material-binding", version: 1, independent: true },
    dispositions: ["blocked", "contained", "released"],
    presentation: { group: "intake", icon: "dock", color: "amber" },
    standardWork: {
      operation: "Clamp immutable source and reviewed racks",
      instructions: ["Verify both rack identities.", "Keep reviewed decisions hidden from the model station."],
      fixtures: ["Content digest clamp", "Epistemic material partition"],
      prohibited: ["Do not expose reviewed answers upstream.", "Do not rewrite source material."],
      releaseCriteria: ["Both exact rack identities are bound and remain physically separate."],
    },
  });
}

function withoutRef(value) { const result = structuredClone(value); delete result.ref; return result; }
