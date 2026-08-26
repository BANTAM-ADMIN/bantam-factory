#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { evaluateSemanticSensorQualification } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const artifactPaths = option("artifacts", [
  ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v3.json",
  ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v4.json",
  ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v8.json",
].join(",")).split(",").map((file) => resolve(file.trim()));
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/semantic-sensor-qualification-lab-v1.json"));
if (artifactPaths.length < 2) throw new Error("semantic sensor qualification lab requires at least two article paths");

const artifacts = await Promise.all(artifactPaths.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
const started = performance.now();
// Intentionally empty. Agreement between model runs is repeatability evidence,
// not reviewed truth. This live report must remain candidate until a separately
// reviewed positive/negative gauge corpus is supplied.
const qualification = evaluateSemanticSensorQualification({ artifacts, reviewed: [] });
const evaluationMs = performance.now() - started;
const report = {
  schema: "bantam.factory.semantic-sensor-qualification-lab.v1",
  completedAt: new Date().toISOString(),
  purpose: "Qualification article for the live DiffusionGemma semantic inspector. Candidate is the correct disposition until independent reviewed decisions exist and every policy die passes.",
  inputs: { artifactPaths, reviewedFacts: 0 },
  evaluationMs,
  result: qualification,
  interpretation: {
    released: qualification.status === "qualified",
    modelAgreementIsNotGroundTruth: true,
    productionAuthorityGranted: false,
    nextOperation: qualification.status === "qualified" ? "Import this content-addressed report into workforce certification." : "Build and independently review a balanced positive/negative semantic gauge rack, then rerun the same die.",
  },
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, evaluationMs, status: qualification.status, blockers: qualification.blockers, repeatability: qualification.repeatability.lanes }, null, 2));
