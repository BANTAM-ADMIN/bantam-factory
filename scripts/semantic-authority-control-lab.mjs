#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { planSemanticRecompile, projectMutationAuthorityControl } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const workspace = resolve(option("workspace", "."));
const kitPath = resolve(option("kit", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v15.json"));
const artifactPath = resolve(option("artifact", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v10.json"));
const reportPath = resolve(option("report", ".bantam/factory-benchmarks/semantic-authority-control-lab-v8.json"));
const packetPath = resolve(option("packet", ".bantam/factory-benchmarks/semantic-authority-codex-packet-v8.json"));

const kit = JSON.parse(await readFile(kitPath, "utf8"));
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
if (kit.summary?.dieFailures !== 0 || kit.summary?.classifiedChunks !== kit.summary?.chunks) {
  throw new Error("semantic evidence kit is incomplete; authority control refuses to run");
}
const recompile = planSemanticRecompile(artifact, kit);
if (recompile.modelRequired || recompile.removed || recompile.reused !== artifact.sourceUnits.length) {
  throw new Error(`semantic object does not exactly bind the supplied kit: ${JSON.stringify(recompile)}`);
}

const workspaceChecks = [];
for (const unit of artifact.sourceUnits) {
  const sourcePath = resolve(workspace, unit.path);
  const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
  const text = lines.slice(unit.startLine - 1, unit.endLine).join("\n").trim();
  const actual = sha256(text);
  workspaceChecks.push({ chunkId: unit.chunkId, path: unit.path, startLine: unit.startLine, endLine: unit.endLine, expectedSha256: unit.sha256, actualSha256: actual, matches: actual === unit.sha256 });
}
const stale = workspaceChecks.filter((row) => !row.matches);
if (stale.length) throw new Error(`semantic object is stale against the workspace (${stale.length} unit(s)); first mismatch: ${stale[0].path}:${stale[0].startLine}-${stale[0].endLine}`);

const started = performance.now();
const control = projectMutationAuthorityControl({ artifact });
const controlMs = performance.now() - started;
const kitByLocation = new Map(kit.classified.map((row) => [location(row), row]));
const unitById = new Map(artifact.sourceUnits.map((row) => [row.chunkId, row]));
const evidence = control.exceptions.map((exception) => {
  const unit = unitById.get(exception.chunkId);
  const source = kitByLocation.get(location(unit));
  if (!source || source.sha256 !== unit.sha256) throw new Error(`missing exact source for ${exception.chunkId}`);
  const proofLeaves = flattenLeaves(exception.proof);
  return {
    exceptionId: exception.exceptionId,
    code: exception.code,
    severity: exception.severity,
    epistemicStatus: exception.epistemicStatus,
    lane: exception.lane,
    source: { path: unit.path, startLine: unit.startLine, endLine: unit.endLine, sha256: unit.sha256, text: source.text },
    proofAudit: {
      leaves: proofLeaves.length,
      provenanceKinds: [...new Set(proofLeaves.flatMap((leaf) => leaf.datoms.map((datom) => datom.kind)))].sort(),
      complete: requiredKinds(exception).every((kind) => proofLeaves.some((leaf) => leaf.datoms.some((datom) => datom.kind === kind))),
    },
  };
});
if (evidence.some((row) => !row.proofAudit.complete)) throw new Error("one or more authority conclusions have an incomplete proof envelope");

const grouped = groupExceptions(evidence);
const packetBody = {
  schema: "bantam.factory.semantic-authority-codex-packet.v1",
  purpose: "Read-only review candidates. Model observations are not accepted facts and this packet grants no mutation authority.",
  basis: control.basis,
  controlArtifactId: control.artifactId,
  summary: control.summary,
  candidates: evidence,
};
const packet = { ...packetBody, packetId: `semantic-authority-packet:sha256:${sha256(JSON.stringify(packetBody))}` };
const report = {
  schema: "bantam.factory.semantic-authority-control-lab.v1",
  completedAt: new Date().toISOString(),
  inputs: { workspace, kitPath, artifactPath },
  gates: {
    completeSemanticDie: true,
    kitObjectBinding: { exact: true, ...summaryRecompile(recompile) },
    workspaceBinding: { exact: true, checkedUnits: workspaceChecks.length, staleUnits: 0 },
    proofCompleteness: { exact: true, checkedExceptions: evidence.length },
  },
  performance: { controlMs },
  result: { artifactId: control.artifactId, authority: control.authority, summary: control.summary, byCode: grouped.byCode, byLane: grouped.byLane, byFile: grouped.byFile },
  packet: { path: packetPath, packetId: packet.packetId, bytes: Buffer.byteLength(`${JSON.stringify(packet, null, 2)}\n`) },
};
await mkdir(dirname(reportPath), { recursive: true });
await mkdir(dirname(packetPath), { recursive: true });
await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function location(row) { return `${row.path}\0${row.startLine}\0${row.endLine}`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function flattenLeaves(proof) { return proof.base ? [proof] : proof.parents.flatMap(flattenLeaves); }
function requiredKinds(exception) {
  return ["exact-source-unit", "reviewed-policy", "deterministic-presence-at-semantic-basis", exception.code.startsWith("accepted-") ? "reviewed-acceptance" : "model-observation"];
}
function summaryRecompile(plan) { return Object.fromEntries(["previousUnits", "nextUnits", "reused", "changed", "added", "removed", "modelRequired", "reusableFraction"].map((key) => [key, plan[key]])); }
function groupExceptions(rows) {
  const count = (read) => Object.fromEntries([...rows.reduce((map, row) => { const key = read(row); return map.set(key, (map.get(key) ?? 0) + 1); }, new Map())].sort(([a], [b]) => a.localeCompare(b)));
  return { byCode: count((row) => row.code), byLane: count((row) => row.lane), byFile: count((row) => row.source.path) };
}
