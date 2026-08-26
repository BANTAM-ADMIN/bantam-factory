#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { compareSemanticLotFrames, projectSemanticLotFrame, RepositoryIntelligenceCell } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-intelligence-cell-lab-v1.json"));
const root = await mkdtemp(join(tmpdir(), "bantam-intelligence-cell-"));

try {
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "core.js"), "export function core() { return 7; }\n");
  await writeFile(join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  await writeFile(join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");
  const cell = new RepositoryIntelligenceCell({ root });
  const started = performance.now();

  const original = cell.cycle({ changedPaths: ["src/core.js"] });
  const originalBases = { impact: original.impact.evaluation.derivedReceipt.transaction.basis, routing: original.verification.derivedReceipt.transaction.basis };
  await writeFile(join(root, "src", "unrelated.js"), "export const unrelated = true;\n");
  const unrelated = cell.cycle({ changedPaths: ["src/core.js"] });
  await writeFile(join(root, "src", "api.js"), "export function api() { return 9; }\n");
  const disconnected = cell.cycle({ changedPaths: ["src/core.js"] });

  const impactFrame = projectSemanticLotFrame(cell.bus, { cartridgeRef: cell.repository.cartridge.ref });
  const routingFrame = projectSemanticLotFrame(cell.bus, { cartridgeRef: cell.routingCartridge.ref });
  const impactComparison = compareSemanticLotFrames(cell.bus, { cartridgeRef: cell.repository.cartridge.ref, leftBasis: originalBases.impact, rightBasis: impactFrame.basis });
  const routingComparison = compareSemanticLotFrames(cell.bus, { cartridgeRef: cell.routingCartridge.ref, leftBasis: originalBases.routing, rightBasis: routingFrame.basis });
  const elapsedMs = performance.now() - started;
  const report = {
    schema: "bantam.factory.repository-intelligence-cell-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Prove typed cartridge-to-cartridge material flow, transitive primitive lineage, zero-rewrite reuse, and cascading semantic product recall.",
    elapsedMs,
    cartridges: { impact: cell.repository.cartridge.ref, verificationRouting: cell.routingCartridge.ref },
    cycles: { original, unrelated, disconnected },
    frames: { impact: impactFrame, verificationRouting: routingFrame },
    comparisons: { impact: impactComparison, verificationRouting: routingComparison },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "proved",
    elapsedMs,
    cell: [cell.repository.cartridge.ref, cell.routingCartridge.ref],
    original: { impactProducts: original.impact.evaluation.conclusions.length, verificationWorkOrders: original.verification.conclusions.length },
    unrelatedDelta: {
      impact: unrelated.impact.evaluation.transition,
      verificationRouting: unrelated.verification.transition,
    },
    removedDependency: {
      impact: impactComparison.summary,
      verificationRouting: routingComparison.summary,
      cascadedWorkOrderRecalls: disconnected.verification.transition.recalled.map((row) => ({ tuple: row.tuple, invalidatedDependencies: row.invalidatedDependencies.map((dependency) => ({ lane: dependency.lane, e: dependency.e, a: dependency.a, v: dependency.v })) })),
    },
    controlTower: { impact: impactFrame.summary, verificationRouting: routingFrame.summary },
    reportPath,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
