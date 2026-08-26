#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const priorPath = resolve(option("prior", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v15.json"));
const root = resolve(option("root", "src/factory"));
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v16.json"));
const deltaInputPath = resolve(option("delta-input", ".bantam/factory-benchmarks/diffusiongemma-semantic-delta-input-v6.json"));
const deltaOutputPath = resolve(option("delta-output", ".bantam/factory-benchmarks/diffusiongemma-semantic-delta-output-v6.json"));
const rubricPath = resolve(option("rubric", "examples/factory/diffusiongemma-mutation-rubric.json"));
const lotChunks = option("lot-chunks", "8");
const maxAttempts = option("max-attempts", "5");
const reuseDelta = argv.includes("--reuse-delta");
const extensions = new Set(option("extensions", ".js,.json").split(",").map((value) => value.trim()));
const prior = JSON.parse(await readFile(priorPath, "utf8"));
if (prior.fixture?.die !== "matrix" || !Array.isArray(prior.classified)) throw new Error("a complete prior matrix kit is required");
if (prior.summary?.dieFailures || prior.summary?.classifiedChunks !== prior.summary?.chunks) throw new Error("prior semantic kit is incomplete");
const linesPerChunk = prior.fixture.linesPerChunk;
if (!Number.isInteger(linesPerChunk) || linesPerChunk < 1) throw new Error("prior linesPerChunk is invalid");

const files = await walk(root);
const current = [];
for (const file of files) current.push(...chunkFile(file, await readFile(file, "utf8"), linesPerChunk));
const before = new Map(prior.classified.map((row) => [location(row), row]));
const afterLocations = new Set(current.map(location));
const reusable = new Map();
const modelRequired = [];
for (const row of current) {
  const previous = before.get(location(row));
  if (previous?.sha256 === row.sha256) reusable.set(location(row), previous);
  else modelRequired.push(row);
}
const removed = prior.classified.filter((row) => !afterLocations.has(location(row)));
const deltaInput = { schema: "bantam.factory.semantic-delta-input.v1", selected: modelRequired };
await mkdir(dirname(deltaInputPath), { recursive: true });
await writeFile(deltaInputPath, `${JSON.stringify(deltaInput, null, 2)}\n`);

let delta = { classified: [], selected: [], inspections: [], summary: { lots: 0, elapsedMs: 0, promptTokens: 0, completionTokens: 0, retries: 0, dieFailures: 0 } };
if (modelRequired.length) {
  if (!reuseDelta) {
    await run(process.execPath, [
      resolve("scripts/diffusiongemma-codex-coprocessor.mjs"), "--query", prior.query,
      "--input-kit", deltaInputPath, "--die", "matrix", "--rubric", rubricPath,
      "--lines-per-chunk", String(linesPerChunk), "--lot-chunks", lotChunks,
      "--max-attempts", maxAttempts, "--extensions", [...extensions].join(","), "--output", deltaOutputPath,
    ]);
  }
  delta = JSON.parse(await readFile(deltaOutputPath, "utf8"));
  if (delta.summary?.dieFailures || delta.classified?.length !== modelRequired.length) throw new Error("incremental model station returned an incomplete delta");
}
const deltaByLocation = new Map(delta.classified.map((row) => [location(row), row]));
const classified = current.map((row) => {
  const result = reusable.get(location(row)) ?? deltaByLocation.get(location(row));
  if (!result || result.sha256 !== row.sha256) throw new Error(`semantic linker missing current unit ${row.path}:${row.startLine}-${row.endLine}`);
  return { ...result, path: row.path, startLine: row.startLine, endLine: row.endLine, text: row.text, sha256: row.sha256 };
});
const selected = classified.filter((row) => Object.values(row.lanes).some(Boolean));
const totalChars = classified.reduce((sum, row) => sum + row.text.length, 0);
const selectedChars = selected.reduce((sum, row) => sum + row.text.length, 0);
const linked = {
  schema: prior.schema, startedAt: delta.startedAt ?? new Date().toISOString(), completedAt: new Date().toISOString(),
  endpoint: prior.endpoint, model: prior.model, query: prior.query, sourceRoot: root, inputKit: priorPath,
  sourceFingerprint: sha256(classified.map((row) => `${row.path}:${row.startLine}:${row.endLine}:${row.sha256}`).join("\n")),
  fixture: { ...prior.fixture, rubricPath, lotChunkLimit: Number(lotChunks), maxAttempts: Number(maxAttempts), incrementalLink: true },
  summary: {
    files: files.length, chunks: classified.length, lots: (prior.summary.lots ?? 0) + (delta.summary.lots ?? 0),
    modelSelectedChunks: selected.length, safetySelectedChunks: 0, selectedChunks: selected.length, classifiedChunks: classified.length,
    totalChars, selectedChars, materialReduction: Number((1 - selectedChars / totalChars).toFixed(4)),
    elapsedMs: (prior.summary.elapsedMs ?? 0) + (delta.summary.elapsedMs ?? 0),
    promptTokens: (prior.summary.promptTokens ?? 0) + (delta.summary.promptTokens ?? 0),
    completionTokens: (prior.summary.completionTokens ?? 0) + (delta.summary.completionTokens ?? 0),
    parseFailures: (prior.summary.parseFailures ?? 0) + (delta.summary.parseFailures ?? 0),
    firstPassParseFailures: (prior.summary.firstPassParseFailures ?? 0) + (delta.summary.firstPassParseFailures ?? 0),
    repairedLots: (prior.summary.repairedLots ?? 0) + (delta.summary.repairedLots ?? 0),
    retries: (prior.summary.retries ?? 0) + (delta.summary.retries ?? 0), dieFailures: 0,
    unknownHandles: (prior.summary.unknownHandles ?? 0) + (delta.summary.unknownHandles ?? 0),
    laneCounts: Object.fromEntries(prior.fixture.rubric.lanes.map(({ key }) => [key, selected.filter((row) => row.lanes[key]).length])),
    incremental: {
      priorUnits: prior.classified.length, currentUnits: classified.length, reused: reusable.size,
      modelRequired: modelRequired.length, removed: removed.length, reuseFraction: classified.length ? reusable.size / classified.length : 1,
      deltaModelWork: { lots: delta.summary.lots ?? 0, elapsedMs: delta.summary.elapsedMs ?? 0, promptTokens: delta.summary.promptTokens ?? 0, completionTokens: delta.summary.completionTokens ?? 0, retries: delta.summary.retries ?? 0 },
    },
  },
  selected, classified, inspections: delta.inspections ?? [],
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(linked, null, 2)}\n`);
console.log(JSON.stringify(linked.summary, null, 2));
console.log(`Incrementally linked semantic kit: ${outputPath}`);

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile() && extensions.has(extname(entry.name))) found.push(path);
  }
  return found.sort();
}
function chunkFile(file, content, size) {
  const lines = content.split(/\r?\n/), rows = [];
  for (let start = 0; start < lines.length; start += size) {
    const text = lines.slice(start, start + size).join("\n").trim();
    if (!text) continue;
    rows.push({ chunkId: `${relative(root, file)}:${String(rows.length + 1).padStart(4, "0")}`, path: relative(process.cwd(), file), startLine: start + 1, endLine: Math.min(start + size, lines.length), text, sha256: sha256(text) });
  }
  return rows;
}
function location(row) { return `${row.path}\0${row.startLine}\0${row.endLine}`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function run(command, args) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`incremental semantic worker exited ${code}`))); }); }
