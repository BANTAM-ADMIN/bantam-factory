#!/usr/bin/env node

import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { projectFactoryBlueprint, runStationFoundryArticle, stationFoundryLine, writeFactoryBlueprintReport } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const orderPath = resolve(option("order", "examples/factory/semantic-reviewed-gauge-change-order.json"));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/station-foundry-lab-v1.json"));
const visualPath = resolve(option("visual", ".bantam/factory-reports/station-foundry.html"));
const order = JSON.parse(await readFile(orderPath, "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "bantam-station-foundry-lab-"));
try {
  const started = performance.now();
  const result = await runStationFoundryArticle({ root: temporaryRoot, order, jobId: "station-foundry-lab-v1" });
  const elapsedMs = performance.now() - started;
  if (result.status !== "released" || !result.product?.reproduction?.exact) throw new Error(`station foundry lab did not release: ${result.status}`);
  const projection = projectFactoryBlueprint(stationFoundryLine(), { events: result.line.events });
  writeFactoryBlueprintReport(visualPath, projection);
  const report = {
    schema: "bantam.factory.station-foundry-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Demonstrate that the factory can manufacture a real, pluggable quality station from a typed change order using the same JSON route shown on the visual floor.",
    input: { orderPath, orderRef: result.order.ref },
    factory: { blueprintRef: result.blueprintRef, routeRef: result.routeRef, jobId: result.jobId, status: result.status, elapsedMs, stations: projection.nodes.map((node) => ({ id: node.id, stationRef: node.stationRef, state: node.state, gaugeStatus: node.gaugeStatus })) },
    product: result.product,
    visual: { path: visualPath, liveProjection: true },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, visualPath, status: result.status, elapsedMs, stationRef: result.product.station.ref, manufacturingRecord: result.product.artifactId, dies: result.product.inspection.dies }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
