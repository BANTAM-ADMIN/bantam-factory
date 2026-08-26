#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { compareSemanticLotFrames, projectSemanticLotFrame, RepositoryTwin } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-twin-recall-lab-v1.json"));
const root = await mkdtemp(join(tmpdir(), "bantam-repository-twin-"));

try {
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "core.js"), "export function core() { return 7; }\n");
  await writeFile(join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  await writeFile(join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");

  const twin = new RepositoryTwin({ root });
  const started = performance.now();
  const original = twin.cycle({ changedPaths: ["src/core.js"] });
  const originalBasis = twin.bus.fabric("derived").basis;

  await writeFile(join(root, "src", "unrelated.js"), "export const unrelated = true;\n");
  const unrelated = twin.cycle({ changedPaths: ["src/core.js"] });
  const unrelatedBasis = twin.bus.fabric("derived").basis;

  await writeFile(join(root, "src", "api.js"), "export function api() { return 9; }\n");
  const disconnected = twin.cycle({ changedPaths: ["src/core.js"] });
  const finalFrame = projectSemanticLotFrame(twin.bus, { cartridgeRef: twin.cartridge.ref });
  const unrelatedComparison = compareSemanticLotFrames(twin.bus, { cartridgeRef: twin.cartridge.ref, leftBasis: originalBasis, rightBasis: unrelatedBasis });
  const recallComparison = compareSemanticLotFrames(twin.bus, { cartridgeRef: twin.cartridge.ref, leftBasis: originalBasis, rightBasis: finalFrame.basis });
  const elapsedMs = performance.now() - started;
  const report = {
    schema: "bantam.factory.repository-twin-recall-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Prove dependency-aware semantic product reuse, targeted recall, causal history, and time-travel frames across repository changes.",
    elapsedMs,
    cartridgeRef: twin.cartridge.ref,
    cycles: { original, unrelated, disconnected },
    comparisons: { unrelated: unrelatedComparison, recalled: recallComparison },
    finalFrame,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status: "proved",
    elapsedMs,
    cartridgeRef: twin.cartridge.ref,
    cycle1: { conclusions: original.evaluation.summary.conclusions, lotId: original.evaluation.transition.lotId },
    cycle2UnrelatedDelta: { source: unrelated.source.delta, semantic: unrelatedComparison.summary, rewrittenConclusions: unrelated.evaluation.transition.revised.length },
    cycle3DependencyRemoved: { source: disconnected.source.delta, semantic: recallComparison.summary, recalls: disconnected.evaluation.transition.recalled.map((row) => ({ predicate: row.predicate, tuple: row.tuple, invalidated: row.invalidatedDependencies.map((dependency) => [dependency.e, dependency.a, dependency.v]) })) },
    timeMachine: finalFrame.summary,
    reportPath,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
