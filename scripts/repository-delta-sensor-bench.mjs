#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { RepositoryGovernanceCell } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const root = resolve(option("root", "."));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-delta-sensor-bench-v1.json"));
const changed = "src/factory/fact-bus.js";
const governance = { requirement: "requirement:fact-bus-preserves-epistemic-lanes", component: changed, test: "test/factory-fact-fabric.test.js", authority: "authority:factory-release-board", fingerprint: "current" };
const cell = new RepositoryGovernanceCell({ root });
let cursor = 1;
const coldStart = performance.now();
const cold = cell.cycleDelta({ delta: { cursor: `bench:${cursor}`, previousCursor: null, changedPaths: [changed] }, governance });
const coldMs = performance.now() - coldStart;
const fingerprint = cold.source.fingerprint;

const deltaPasses = [];
for (let index = 0; index < 12; index += 1) {
  const previousCursor = `bench:${cursor}`; cursor += 1;
  const basis = cell.bus.basis(), tick = performance.now();
  const cycle = cell.cycleDelta({ delta: { cursor: `bench:${cursor}`, previousCursor, changedPaths: [changed] }, governance });
  deltaPasses.push({ elapsedMs: performance.now() - tick, refreshed: cycle.source.sensor.refreshed.length, sourceWrites: cycle.source.operationCount, factBusUnchanged: JSON.stringify(basis) === JSON.stringify(cell.bus.basis()), fingerprintStable: cycle.source.fingerprint === fingerprint });
}

const fullAudits = [];
for (let index = 0; index < 3; index += 1) {
  const previousCursor = `bench:${cursor}`; cursor += 1;
  const basis = cell.bus.basis(), tick = performance.now();
  const cycle = cell.cycleDelta({ delta: { cursor: `bench:${cursor}`, previousCursor, changedPaths: [changed], fullAudit: true }, governance });
  fullAudits.push({ elapsedMs: performance.now() - tick, refreshed: cycle.source.sensor.refreshed.length, sourceWrites: cycle.source.operationCount, factBusUnchanged: JSON.stringify(basis) === JSON.stringify(cell.bus.basis()), fingerprintStable: cycle.source.fingerprint === fingerprint });
}

const deltaStats = stats(deltaPasses.map((row) => row.elapsedMs)), auditStats = stats(fullAudits.map((row) => row.elapsedMs));
const report = {
  schema: "bantam.factory.repository-delta-sensor-bench.v1",
  completedAt: new Date().toISOString(),
  repository: { root, fingerprint, indexedFiles: cold.source.sensor.refreshed.length },
  cold: { elapsedMs: coldMs, sensor: cold.source.sensor },
  changedFilePasses: { samples: deltaPasses.length, stats: deltaStats, rows: deltaPasses },
  fullAuditPasses: { samples: fullAudits.length, stats: auditStats, rows: fullAudits },
  medianSpeedup: auditStats.median / deltaStats.median,
  invariants: { allZeroWrite: [...deltaPasses, ...fullAudits].every((row) => row.sourceWrites === 0 && row.factBusUnchanged), allFingerprintStable: [...deltaPasses, ...fullAudits].every((row) => row.fingerprintStable), oneRecordPerDelta: deltaPasses.every((row) => row.refreshed === 1) },
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const status = Object.values(report.invariants).every(Boolean) ? "proved" : "failed";
console.log(JSON.stringify({ status, repository: report.repository, coldMs, changedFileLatencyMs: deltaStats, fullAuditLatencyMs: auditStats, medianSpeedup: report.medianSpeedup, invariants: report.invariants, honestBoundary: "Cursor continuity detects gaps; scheduled full audits remain required to detect a faulty watcher that emits a continuous but incomplete stream.", reportPath }, null, 2));
if (status !== "proved") process.exitCode = 1;

function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: percentile(sorted, .5), p95: percentile(sorted, .95), max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length }; }
function percentile(sorted, fraction) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]; }
