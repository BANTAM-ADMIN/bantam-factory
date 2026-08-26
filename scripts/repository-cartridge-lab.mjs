#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { inspectRepositoryChangeImpact } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const options = (name) => argv.flatMap((entry, index) => entry === `--${name}` ? [argv[index + 1]] : []).filter(Boolean);
const root = resolve(option("root", "."));
const changedPaths = options("changed");
if (!changedPaths.length) changedPaths.push("src/factory/fact-bus.js");
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-cartridge-lab-v1.json"));

const started = performance.now();
const result = inspectRepositoryChangeImpact({ root, changedPaths });
const elapsedMs = performance.now() - started;
const report = { ...result, completedAt: new Date().toISOString(), elapsedMs };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const affected = result.evaluation.conclusions.filter((row) => row.predicate === "affected_by_change");
const tests = result.evaluation.conclusions.filter((row) => row.predicate === "affected_test");
console.log(JSON.stringify({
  status: "inspected",
  cartridgeRef: result.cartridge.ref,
  evaluationId: result.evaluation.evaluationId,
  elapsedMs,
  sourceFiles: result.source.stats.files,
  structuralFacts: result.source.operationCount,
  changed: result.source.changed,
  affectedMaterials: affected.length,
  affectedTests: [...new Set(tests.map((row) => row.tuple.test))].sort(),
  semanticAndons: result.evaluation.signals.map(({ signalId, subscriptionId, severity, message, count }) => ({ signalId, subscriptionId, severity, message, count })),
  contextPackets: result.evaluation.packets["codex-impact-context"].length,
  reportPath,
}, null, 2));
