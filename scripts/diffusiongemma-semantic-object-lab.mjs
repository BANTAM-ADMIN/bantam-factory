#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileSemanticObject, loadSemanticObject, planSemanticRecompile } from "../src/factory/semantic-object.js";

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const kitPath = resolve(option("kit", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v2.json"));
const acceptedOption = option("accepted", "examples/factory/diffusiongemma-mutation-accepted-facts.json");
const acceptedPath = acceptedOption === "none" ? null : resolve(acceptedOption);
const workspaceRoot = resolve(option("workspace", "."));
const artifactPath = resolve(option("artifact", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v1.json"));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-lab-v1.json"));
const pointIterations = positiveInteger(option("point-iterations", "1000000"), "point-iterations");
const pullIterations = positiveInteger(option("pull-iterations", "100000"), "pull-iterations");

const kit = JSON.parse(await readFile(kitPath, "utf8"));
const acceptedDocument = acceptedPath
  ? JSON.parse(await readFile(acceptedPath, "utf8"))
  : { schema: "bantam.factory.accepted-semantic-facts.none", facts: [] };
if (!Array.isArray(acceptedDocument.facts)) throw new TypeError("accepted manifest facts array required");

const compileStarted = performance.now();
const { artifact } = compileSemanticObject({ kit, workspaceRoot, accepted: acceptedDocument.facts });
const compileMs = performance.now() - compileStarted;
const serialized = `${JSON.stringify(artifact)}\n`;
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, serialized);

const loadStarted = performance.now();
const stored = JSON.parse(await readFile(artifactPath, "utf8"));
const db = loadSemanticObject(stored);
const loadMs = performance.now() - loadStarted;

const example = db.query("corroborated_lane", "?", "?")[0]
  ?? db.query("semantic_observation", "?", "?", "?")[0];
if (!example) throw new Error("experiment requires at least one semantic observation");
const [chunkId, lane] = example;
const [, sourcePath] = db.query("chunk_file", chunkId, "?")[0];
const impact = db.query("semantic_impact", "?", "?", "?")[0];
if (!impact) throw new Error("experiment requires at least one semantic dependency impact");
const [, impactSource, impactLane] = impact;

let pointChecksum = 0;
const pointStarted = performance.now();
for (let i = 0; i < pointIterations; i++) {
  pointChecksum += db.has("source_chunk", chunkId) ? 1 : 0;
  pointChecksum += db.has("semantic_observation", chunkId, lane, stored.kitRef) ? 1 : 0;
  pointChecksum += db.has("file_observed_lane", sourcePath, lane) ? 1 : 0;
  pointChecksum += db.has("observed_in_kit", chunkId, stored.kitRef) ? 1 : 0;
}
const pointMs = performance.now() - pointStarted;
const pointQuestions = pointIterations * 4;

let pullChecksum = 0;
const pullStarted = performance.now();
for (let i = 0; i < pullIterations; i++) {
  pullChecksum += db.query("chunk_file", chunkId, "?").length;
  pullChecksum += db.query("file_observed_lane", sourcePath, "?").length;
  pullChecksum += db.query("semantic_impact", "?", impactSource, impactLane).length;
}
const pullMs = performance.now() - pullStarted;
const pullQuestions = pullIterations * 3;

const changedKit = structuredClone(kit);
const first = changedKit.classified[0];
first.sha256 = first.sha256[0] === "a" ? `b${first.sha256.slice(1)}` : `a${first.sha256.slice(1)}`;
const recompilePlan = planSemanticRecompile(stored, changedKit);
const proofRelation = db.has("corroborated_lane", chunkId, lane) ? "corroborated_lane" : "semantic_observation";
const proofTerms = proofRelation === "corroborated_lane" ? [chunkId, lane] : [chunkId, lane, stored.kitRef];
const proof = db.explain(proofRelation, ...proofTerms);

const report = {
  schema: "bantam.factory.semantic-object-lab.v1",
  completedAt: new Date().toISOString(),
  inputs: { kitPath, acceptedPath, acceptedMode: acceptedPath ? "reviewed-manifest" : "model-observations-only", workspaceRoot },
  artifact: {
    path: artifactPath,
    artifactId: stored.artifactId,
    bytes: Buffer.byteLength(serialized),
    sourceUnits: stored.sourceUnits.length,
    relations: stored.datalog.relations.length,
    facts: stored.compileSummary.facts,
    storedProofEdges: stored.datalog.provenance.length,
    compileMs,
    loadMs,
    loadExecutedRules: db.rules.length,
    loadModelCalls: 0,
  },
  originalModelWork: stored.modelWork,
  storedComputation: {
    derivationsAlreadyPaid: stored.datalog.stats.derivations,
    fixpointIterationsAlreadyPaid: stored.datalog.stats.iterations,
    modelPromptTokensAvoidedPerFullReuse: stored.modelWork.promptTokens,
    modelElapsedMsAvoidedPerFullReuse: stored.modelWork.elapsedMs,
  },
  pointBenchmark: {
    questions: pointQuestions,
    ms: pointMs,
    questionsPerSecond: pointQuestions / (pointMs / 1000),
    checksum: pointChecksum,
  },
  pullBenchmark: {
    questions: pullQuestions,
    ms: pullMs,
    questionsPerSecond: pullQuestions / (pullMs / 1000),
    checksum: pullChecksum,
  },
  oneUnitChange: {
    previousUnits: recompilePlan.previousUnits,
    nextUnits: recompilePlan.nextUnits,
    reused: recompilePlan.reused,
    changed: recompilePlan.changed,
    added: recompilePlan.added,
    removed: recompilePlan.removed,
    modelRequired: recompilePlan.modelRequired,
    reusableFraction: recompilePlan.reusableFraction,
  },
  restoredProofExample: proof,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Semantic object: ${artifactPath}`);
console.log(`Evidence report: ${reportPath}`);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}
