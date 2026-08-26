#!/usr/bin/env node

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { compileRepositoryShiftPacket, RepositoryGovernanceCell } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const root = resolve(option("root", "."));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-cognitive-capital-bench-v1.json"));
const changed = "src/factory/fact-bus.js";
const governance = { requirement: "requirement:fact-bus-preserves-epistemic-lanes", component: changed, test: "test/factory-fact-fabric.test.js", authority: "authority:factory-release-board", fingerprint: "current" };
const focus = { paths: [changed], requirements: [governance.requirement] };
const limits = { maxProducts: 24, maxDependenciesPerProduct: 12 };

const started = performance.now();
const cell = new RepositoryGovernanceCell({ root });
const coldStart = performance.now();
const first = cell.cycle({ changedPaths: [changed], governance });
const coldMs = performance.now() - coldStart;
const firstPacketStart = performance.now();
const firstPacket = compile("Assess the current Fact Bus change and select the next governed operation.");
const firstPacketMs = performance.now() - firstPacketStart;

const sourceFiles = cell.bus.view("accepted").match({ a: "repo/file", v: true }).map((row) => row.e).sort();
let sourceBytes = 0;
for (const file of sourceFiles) {
  const location = join(root, file);
  try { sourceBytes += (await stat(location)).size; } catch { /* exact accepted index may contain a just-removed file only under a racing workspace */ }
}

const quietPasses = [];
for (let index = 0; index < 3; index += 1) {
  const before = cell.bus.basis(), tick = performance.now();
  const cycle = cell.cycle({ changedPaths: [changed], governance });
  const elapsedMs = performance.now() - tick, after = cell.bus.basis();
  quietPasses.push({ elapsedMs, sourceWrites: cycle.source.operationCount, governanceWrites: cycle.governanceReceipt ? cycle.governanceReceipt.transaction.operationCount : 0, factBusUnchanged: JSON.stringify(before) === JSON.stringify(after) });
}

const replayTimes = [], replayIds = new Set();
for (let index = 0; index < 100; index += 1) {
  const tick = performance.now(), packet = compile("Assess the current Fact Bus change and select the next governed operation.");
  replayTimes.push(performance.now() - tick); replayIds.add(packet.packetId);
}

const taskTimes = [], taskPackets = [], commonProductIdentity = firstPacket.products.map((row) => row.conclusionId).join("\0");
for (let index = 0; index < 25; index += 1) {
  const tick = performance.now(), packet = compile(`Supervisor question ${index + 1}: inspect the governed Fact Bus chassis without reconstructing repository impact.`);
  taskTimes.push(performance.now() - tick);
  taskPackets.push({ packetId: packet.packetId, sameSemanticProducts: packet.products.map((row) => row.conclusionId).join("\0") === commonProductIdentity });
}

const report = {
  schema: "bantam.factory.repository-cognitive-capital-bench.v1",
  completedAt: new Date().toISOString(),
  purpose: "Measure durable semantic reuse, quiet-wicket behavior, task-specific packet compilation, and bounded-context leverage without pretending that a retained source rescan is free.",
  repository: { root, fingerprint: first.source.fingerprint, sourceFiles: sourceFiles.length, sourceBytes },
  cold: { elapsedMs: coldMs, acceptedBasis: first.busBasis.accepted, derivedBasis: first.busBasis.derived, packetCompileMs: firstPacketMs, packetId: firstPacket.packetId, packetEstimatedTokens: firstPacket.estimatedTokens, admittedProducts: firstPacket.products.length, availableProducts: firstPacket.summary.availableProducts },
  quietPasses,
  identicalPacketReplay: { samples: replayTimes.length, uniquePacketIds: replayIds.size, latencyMs: stats(replayTimes) },
  crossTaskReuse: { samples: taskTimes.length, uniquePacketIds: new Set(taskPackets.map((row) => row.packetId)).size, allReuseSameSemanticProducts: taskPackets.every((row) => row.sameSemanticProducts), latencyMs: stats(taskTimes) },
  contextLeverage: { indexedSourceBytes: sourceBytes, sourceTokenUpperBound: Math.ceil(sourceBytes / 4), shiftPacketEstimatedTokens: firstPacket.estimatedTokens, byteToBriefingTokenRatio: sourceBytes / Math.max(1, firstPacket.estimatedTokens * 4) },
  totalElapsedMs: performance.now() - started,
  interpretation: {
    proved: ["unchanged semantic passes append zero Fact Bus history", "identical tasks compile one stable packet identity", "different tasks reuse identical semantic product identities", "bounded worker briefing is materially smaller than indexed source bytes"],
    notProved: ["a model would otherwise read every indexed source byte", "the current full repository sensor scan is incremental or free", "token reduction alone improves answer quality"],
  },
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const summary = {
  status: quietPasses.every((row) => row.factBusUnchanged) && replayIds.size === 1 && taskPackets.every((row) => row.sameSemanticProducts) ? "proved" : "failed",
  repository: report.repository,
  cold: report.cold,
  quietWickets: { passes: quietPasses.length, allZeroWrite: quietPasses.every((row) => row.factBusUnchanged), sensorLatencyMs: stats(quietPasses.map((row) => row.elapsedMs)) },
  identicalPacketReplay: report.identicalPacketReplay,
  crossTaskReuse: report.crossTaskReuse,
  contextLeverage: report.contextLeverage,
  honestLimit: "Quiet semantic wickets still pay for a full deterministic repository rescan; filesystem-delta sensing is the next optimization.",
  reportPath,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.status !== "proved") process.exitCode = 1;

function compile(task) { return compileRepositoryShiftPacket({ task, bus: cell.bus, registry: cell.registry, cell: cell.cell, focus, limits }); }
function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length }; }
function percentile(sorted, fraction) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]; }
