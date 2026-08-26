#!/usr/bin/env node

import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  certifySemanticSensorWorker,
  compileSemanticObject,
  defineSemanticReviewedRack,
  projectFactoryBlueprint,
  runSemanticReviewedGaugeArticle,
  semanticSensorQualificationLine,
  WorkforceRegistry,
  writeFactoryBlueprintReport,
} from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const articlePaths = option("articles", [1, 2, 3].map((version) => `.bantam/factory-benchmarks/diffusiongemma-semantic-qualification-article-v${version}.json`).join(",")).split(",").map((file) => resolve(file.trim()));
const reviewPath = resolve(option("review", "examples/factory/semantic-reviewed-rack-v1.json"));
const objectPrefix = resolve(option("object-prefix", ".bantam/factory-benchmarks/diffusiongemma-semantic-qualification-object-v"));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/diffusiongemma-semantic-qualification-cohort-v1.json"));
const visualPath = resolve(option("visual", ".bantam/factory-reports/semantic-sensor-qualification.html"));
if (articlePaths.length !== 3) throw new Error("semantic qualification cohort requires exactly three article paths");

const articles = await Promise.all(articlePaths.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
const rack = defineSemanticReviewedRack(JSON.parse(await readFile(reviewPath, "utf8")));
for (const [index, article] of articles.entries()) {
  if (article.summary?.dieFailures || article.summary?.classifiedChunks !== article.summary?.chunks) throw new Error(`semantic qualification article ${index + 1} is incomplete`);
}
const objects = articles.map((kit, index) => compileSemanticObject({ kit, accepted: [], compiledAt: kit.completedAt ?? `qualification-article-${index + 1}` }).artifact);
for (const [index, artifact] of objects.entries()) {
  const target = `${objectPrefix}${index + 1}.json`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(artifact)}\n`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "bantam-semantic-qualification-cohort-"));
try {
  const started = performance.now();
  const result = await runSemanticReviewedGaugeArticle({ root: temporaryRoot, artifacts: objects, rack, jobId: "diffusiongemma-semantic-qualification-v1" });
  const evaluationMs = performance.now() - started;
  if (result.status !== "released") throw new Error(`semantic reviewed gauge line failed: ${result.infrastructure?.message ?? result.status}`);

  const workforce = new WorkforceRegistry(temporaryRoot);
  const worker = workforce.install({
    schema: 1, kind: "bantam.factory-worker-profile", id: "diffusiongemma-dg-awq", version: 1,
    runtime: "local", provider: "plant", model: "dg-awq", reasoningEffort: null,
    transport: "diffusion-native", availabilityClass: "local-compute",
    capabilities: ["model.semantic-work", "semantic.matrix.classify"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
  workforce.qualify({ workerRef: worker.ref, stationRef: result.qualification.stationRef, taskFamily: result.qualification.taskFamily, status: "candidate", evidence: result.qualification.workforceEvidence, limits: { maxP95Ms: null, maxExpectedCostUsd: null, authority: ["workspace.read"] }, reason: `candidate evidence from ${result.qualification.artifactId}` });
  let certification = null;
  if (result.qualification.status === "qualified") certification = certifySemanticSensorWorker({ workforce, workerRef: worker.ref, report: result.qualification });
  const workerQualification = workforce.project().qualifications.find((row) => row.workerRef === worker.ref && row.stationRef === result.qualification.stationRef);

  const projection = projectFactoryBlueprint(semanticSensorQualificationLine(), { events: result.line.events });
  writeFactoryBlueprintReport(visualPath, projection);
  const report = {
    schema: "bantam.factory.diffusiongemma-semantic-qualification-cohort.v1",
    completedAt: new Date().toISOString(),
    purpose: "Three fresh byte-identical DiffusionGemma articles evaluated by the manufactured reviewed semantic gauge under the unchanged first-cohort policy.",
    inputs: { articlePaths, reviewPath, reviewedRackRef: rack.ref, exactUnitsPerArticle: objects[0].sourceUnits.length, reviewedUnits: rack.units.length },
    objects: objects.map((artifact, index) => ({ path: `${objectPrefix}${index + 1}.json`, artifactId: artifact.artifactId, kitRef: artifact.kitRef, modelWork: artifact.modelWork })),
    factory: { status: result.status, blueprintRef: result.blueprintRef, routeRef: result.routeRef, stationRef: result.stationRef, evaluationMs },
    qualification: result.qualification,
    workforce: { workerRef: worker.ref, status: workerQualification?.status ?? null, eventId: workerQualification?.eventId ?? null, certified: certification !== null },
    visual: { path: visualPath, liveProjection: true },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, visualPath, lineStatus: result.status, qualificationStatus: result.qualification.status, workforceStatus: workerQualification?.status ?? null, evaluationMs, repeatability: result.qualification.repeatability.lanes, reviewedAccuracy: result.qualification.reviewedAccuracy, blockers: result.qualification.blockers }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
