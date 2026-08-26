#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compileRepositoryShiftPacket, renderRepositoryExocortex, RepositoryGovernanceCell } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-exocortex-lab-v1.json"));
const htmlPath = resolve(option("html", ".bantam/factory-reports/repository-exocortex.html"));
const root = await mkdtemp(join(tmpdir(), "bantam-exocortex-lab-"));
const governance = { requirement: "requirement:core-remains-available", component: "src/core.js", test: "test/api.test.js", authority: "authority:release-board", fingerprint: "current" };

const compile = (cell) => compileRepositoryShiftPacket({
  task: "Safely assess the current core change and select the next governed operation.",
  bus: cell.bus,
  registry: cell.registry,
  cell: cell.cell,
  focus: { paths: ["src/core.js"], requirements: [governance.requirement] },
  limits: { maxProducts: 16, maxDependenciesPerProduct: 8 },
});

try {
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "core.js"), "export function core() { return 7; }\n");
  await writeFile(join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  await writeFile(join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");
  const cell = new RepositoryGovernanceCell({ root });
  cell.cycle({ changedPaths: ["src/core.js"], governance });
  const ready = compile(cell);
  await writeFile(join(root, "src", "core.js"), "export function core() { return 8; }\n");
  cell.cycle({ changedPaths: ["src/core.js"] });
  const stale = compile(cell);
  const stableReplay = compile(cell);
  const report = {
    schema: "bantam.factory.repository-exocortex-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Prove that stored repository computation compiles into bounded, safe, content-addressed worker shift packets whose buttons change with the governed chassis state.",
    ready,
    stale,
    stableReplay: { packetId: stableReplay.packetId, exact: stableReplay.packetId === stale.packetId && stableReplay.briefing === stale.briefing },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, renderRepositoryExocortex({ projection: cell.cycle({ changedPaths: ["src/core.js"] }).projection, packet: stale }));
  console.log(JSON.stringify({
    status: "proved",
    ready: { packetId: ready.packetId, disposition: ready.summary.releaseDisposition, estimatedTokens: ready.estimatedTokens, buttons: ready.buttons.map((row) => row.operation), andons: ready.andons.map((row) => row.code) },
    stale: { packetId: stale.packetId, disposition: stale.summary.releaseDisposition, estimatedTokens: stale.estimatedTokens, buttons: stale.buttons.map((row) => row.operation), andons: stale.andons.map((row) => row.code) },
    replayIsByteStable: report.stableReplay.exact,
    reportPath,
    htmlPath,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
