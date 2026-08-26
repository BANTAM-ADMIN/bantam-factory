#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { renderRepositoryProductionFilm, RepositoryGovernanceCell, RepositoryProductionLoop } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/repository-closed-loop-lab-v1.json"));
const filmPath = resolve(option("film", ".bantam/factory-reports/repository-closed-loop-film.html"));
const root = await mkdtemp(join(tmpdir(), "bantam-closed-loop-lab-"));
const governance = { requirement: "requirement:core-remains-available", component: "src/core.js", test: "test/api.test.js", authority: "authority:release-board", fingerprint: "current" };

try {
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n");
  await writeFile(join(root, "src", "core.js"), "export function core() { return 7; }\n");
  await writeFile(join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  await writeFile(join(root, "test", "api.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { api } from '../src/api.js';\ntest('current core is wired through API', () => assert.equal(api(), 8));\n");
  const cell = new RepositoryGovernanceCell({ root });
  const original = cell.cycle({ changedPaths: ["src/core.js"], governance });
  await writeFile(join(root, "src", "core.js"), "export function core() { return 8; }\n");
  const changed = cell.cycle({ changedPaths: ["src/core.js"] });
  const loop = new RepositoryProductionLoop({
    cell,
    task: "Restore the changed core requirement to governed release readiness.",
    focus: { paths: ["src/core.js"], requirements: [governance.requirement] },
  });
  const blocked = loop.packet();
  const verified = await loop.dispatch({ packet: blocked, operation: "refresh-evidence" });
  const approved = await loop.dispatch({
    packet: verified.packet,
    operation: "request-approval",
    approval: { grant: "release.approve", by: governance.authority, evidenceRef: "review:closed-loop-lab:release-board" },
  });
  const report = {
    schema: "bantam.factory.repository-closed-loop-lab.v1",
    completedAt: new Date().toISOString(),
    purpose: "Prove a complete semantic-to-physical-to-semantic repair loop with a real Node test process, independently gauged evidence admission, explicit revision approval, and exocortex interface replacement.",
    revisions: { original: original.source.fingerprint, changed: changed.source.fingerprint },
    packets: { blocked, afterVerification: verified.packet, restored: approved.packet },
    dispatches: loop.dispatches,
    busBasis: cell.bus.basis(),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const frames = [
    { label: "Change detected — evidence and authority stale", projection: changed.projection, packet: blocked, dispatch: null },
    { label: "Real verification passed — evidence restored, authority still stale", projection: verified.projection, packet: verified.packet, dispatch: verified },
    { label: "Explicit approval admitted — release wicket reopened", projection: approved.projection, packet: approved.packet, dispatch: approved },
  ];
  await mkdir(dirname(filmPath), { recursive: true });
  await writeFile(filmPath, renderRepositoryProductionFilm({ frames }));
  console.log(JSON.stringify({
    status: approved.disposition === "ready-for-authority-review" ? "proved" : "failed",
    chassis: { original: original.source.fingerprint, changed: changed.source.fingerprint },
    stage1Blocked: { disposition: blocked.summary.releaseDisposition, andons: blocked.andons.map((row) => row.code), buttons: blocked.buttons.map((row) => row.operation) },
    stage2RealTest: { artifactId: verified.measurement.artifactId, command: verified.measurement.command, status: verified.measurement.status, durationMs: verified.measurement.durationMs, evidenceReceipts: verified.evidenceReceiptIds.length, disposition: verified.disposition, remainingAndons: verified.packet.andons.map((row) => row.code) },
    stage3ExplicitApproval: { approvalReceiptId: approved.approvalReceiptId, disposition: approved.disposition, buttons: approved.packet.buttons.map((row) => row.operation) },
    factBusBasis: cell.bus.basis(),
    reportPath,
    filmPath,
  }, null, 2));
  if (approved.disposition !== "ready-for-authority-review") process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
