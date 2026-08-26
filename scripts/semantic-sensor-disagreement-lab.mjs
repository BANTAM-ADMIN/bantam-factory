#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { projectSemanticSensorDisagreement } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const leftPath = resolve(option("left", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v3.json"));
const rightPath = resolve(option("right", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v4.json"));
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/semantic-sensor-disagreement-lab-v1.json"));
const left = JSON.parse(await readFile(leftPath, "utf8"));
const right = JSON.parse(await readFile(rightPath, "utf8"));
const started = performance.now();
const control = projectSemanticSensorDisagreement({ leftArtifact: left, rightArtifact: right });
const evaluationMs = performance.now() - started;
const shared = sharedUnits(left, right);
const lanes = control.comparison.comparedLanes;
const metrics = Object.fromEntries(left.rubric.map(({ key: lane }) => {
  const leftPositive = positives(left, shared, lane), rightPositive = positives(right, shared, lane);
  const intersection = [...leftPositive].filter((chunk) => rightPositive.has(chunk)).length;
  const disagreements = control.summary.byLane[lane] ?? 0;
  return [lane, { leftPositive: leftPositive.size, rightPositive: rightPositive.size, intersection, disagreements, agreement: (shared.size - disagreements) / shared.size, positiveJaccard: intersection / (leftPositive.size + rightPositive.size - intersection || 1) }];
}));
const proofComplete = control.exceptions.every((row) => {
  const kinds = flattenLeaves(row.proof).flatMap((leaf) => leaf.datoms.map((datom) => datom.kind));
  return kinds.filter((kind) => kind === "model-lane-decision").length >= 2 && kinds.includes("exact-source-unit") && kinds.includes("reviewed-policy");
});
if (!proofComplete) throw new Error("semantic sensor disagreement proof is incomplete");
const report = {
  schema: "bantam.factory.semantic-sensor-disagreement-lab.v1", completedAt: new Date().toISOString(),
  inputs: { leftPath, rightPath }, basis: control.basis, authority: control.authority,
  comparison: { ...control.comparison, expectedDecisions: shared.size * lanes, exactSharedUnitJoin: true, proofComplete, evaluationMs },
  result: { artifactId: control.artifactId, summary: control.summary, laneMetrics: metrics },
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function relation(artifact, name) { return artifact.datalog.relations.find((row) => row.name === name)?.rows ?? []; }
function sharedUnits(a, b) { const right = new Set(b.sourceUnits.map((row) => row.chunkId)); return new Set(a.sourceUnits.map((row) => row.chunkId).filter((row) => right.has(row))); }
function positives(artifact, shared, lane) { return new Set(relation(artifact, "semantic_observation").filter(([chunk, value]) => shared.has(chunk) && value === lane).map(([chunk]) => chunk)); }
function flattenLeaves(proof) { return proof.base ? [proof] : proof.parents.flatMap(flattenLeaves); }
