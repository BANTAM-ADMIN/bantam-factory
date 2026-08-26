#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildSemanticFactPlant } from "../src/factory/semantic-fact-plant.js";

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const kitPath = resolve(option("kit", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix.json"));
const workspaceRoot = resolve(option("workspace", "."));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-datalog-plant.json"));
const acceptedPath = option("accepted") ? resolve(option("accepted")) : null;
const kit = JSON.parse(await readFile(kitPath, "utf8"));
const acceptedDocument = acceptedPath ? JSON.parse(await readFile(acceptedPath, "utf8")) : { facts: [] };
if (!Array.isArray(acceptedDocument.facts)) throw new TypeError("accepted fact manifest must contain a facts array");
const plant = buildSemanticFactPlant({ kit, workspaceRoot, accepted: acceptedDocument.facts });

const laneFiles = Object.fromEntries((kit.fixture.rubric?.lanes ?? []).map((lane) => [
  lane.key,
  plant.db.query("file_observed_lane", "?", lane.key).map((row) => row[0]).sort(),
]));
const report = {
  schema: "bantam.factory.diffusiongemma-datalog-plant.v1",
  kitPath,
  acceptedPath,
  kitRef: plant.kitRef,
  completedAt: new Date().toISOString(),
  summary: plant.summary,
  candidateGaps: plant.candidateGaps,
  laneFiles,
  semanticImpactExamples: plant.db.query("semantic_impact", "?", "?", "?").slice(0, 100),
  corroboratedImpactExamples: plant.db.query("corroborated_impact", "?", "?", "?").slice(0, 100),
  corroborated: plant.db.query("corroborated_lane", "?", "?").map(([chunkId, lane]) => ({ chunkId, lane })),
  acceptedNotObserved: plant.acceptedFacts.filter((fact) => !plant.db.has("corroborated_lane", fact.chunkId, fact.lane)),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ summary: report.summary, candidateGaps: report.candidateGaps, laneFiles: Object.fromEntries(Object.entries(laneFiles).map(([lane, files]) => [lane, files.length])) }, null, 2));
console.log(`Datalog plant evidence: ${output}`);
