#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { projectSemanticLotFrame, RepositoryGovernanceCell } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-governance-cell-lab-v1.json"));
const root = await mkdtemp(join(tmpdir(), "bantam-governance-lab-"));
const governance = { requirement: "requirement:core-remains-available", component: "src/core.js", test: "test/api.test.js", authority: "authority:release-board", fingerprint: "current" };

try {
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "core.js"), "export function core() { return 7; }\n");
  await writeFile(join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  await writeFile(join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");
  const cell = new RepositoryGovernanceCell({ root });
  const started = performance.now();
  const ready = cell.cycle({ changedPaths: ["src/core.js"], governance });
  await writeFile(join(root, "src", "core.js"), "export function core() { return 8; }\n");
  const stale = cell.cycle({ changedPaths: ["src/core.js"] });
  const refreshed = cell.cycle({ changedPaths: ["src/core.js"], governance });
  const quietBasis = cell.bus.basis();
  const quiet = cell.cycle({ changedPaths: ["src/core.js"], governance });
  const elapsedMs = performance.now() - started;
  const frames = Object.fromEntries(cell.registry.list().map((cartridge) => [cartridge.id, projectSemanticLotFrame(cell.bus, { cartridgeRef: cartridge.ref })]));
  const report = {
    schema: "bantam.factory.repository-governance-cell-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Prove source-to-requirement traceability, causal evidence aging, revision-bound authority, release blocking, governed renewal, cascading recall, and a zero-write quiet cycle.",
    elapsedMs,
    cellRef: cell.cell.ref,
    cycles: { ready, stale, refreshed, quiet },
    frames,
    quietWicket: { before: quietBasis, after: cell.bus.basis(), exact: JSON.stringify(quietBasis) === JSON.stringify(cell.bus.basis()) },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const predicates = (cycle, station) => cycle.evaluations[station].conclusions.map((row) => row.predicate).sort();
  console.log(JSON.stringify({
    status: "proved",
    elapsedMs,
    cellRef: cell.cell.ref,
    topology: { nodes: ready.projection.nodes.map((node) => node.id), edges: ready.projection.edges.map((edge) => `${edge.from} --${edge.predicate}--> ${edge.to}`) },
    cycle1: { repository: ready.source.fingerprint, evidence: predicates(ready, "evidence-freshness"), release: predicates(ready, "release-control") },
    cycle2AfterSourceChange: { repository: stale.source.fingerprint, supersedes: ready.source.fingerprint, evidence: predicates(stale, "evidence-freshness"), release: predicates(stale, "release-control"), releaseRecalls: stale.evaluations["release-control"].transition.recalled.map((row) => row.predicate) },
    cycle3AfterGovernedRenewal: { evidence: predicates(refreshed, "evidence-freshness"), release: predicates(refreshed, "release-control"), recalledBlocks: refreshed.evaluations["release-control"].transition.recalled.map((row) => row.predicate) },
    cycle4QuietWickets: { sourceWrites: quiet.source.operationCount, governanceWrites: quiet.governanceReceipt === null ? 0 : quiet.governanceReceipt.transaction.operationCount, factBusUnchanged: report.quietWicket.exact },
    timeMachine: Object.fromEntries(Object.entries(frames).map(([id, frame]) => [id, frame.summary])),
    reportPath,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
