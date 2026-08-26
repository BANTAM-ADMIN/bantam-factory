#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { spawnExternalAgent } from "../src/logic/external-agent.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const workspace = resolve(option("workspace", "."));
const kitPath = resolve(option("kit", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v4.json"));
const packetPath = resolve(option("packet", ".bantam/factory-benchmarks/semantic-authority-codex-packet-v1.json"));
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/codex-semantic-authority-ab-v1.json"));
const schemaPath = resolve(option("schema", ".bantam/factory-benchmarks/codex-semantic-authority-answer.schema.json"));
const model = option("model", "gpt-5.6-terra");
const effort = option("effort", "medium");
const order = option("order", "baseline-first");
const timeoutMs = Number(option("timeout-ms", "600000"));
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms must be at least 1000");
if (!["baseline-first", "assisted-first"].includes(order)) throw new Error("--order must be baseline-first or assisted-first");

const kit = JSON.parse(await readFile(kitPath, "utf8"));
const packet = JSON.parse(await readFile(packetPath, "utf8"));
if (kit.summary?.dieFailures || kit.summary?.classifiedChunks !== kit.summary?.chunks) throw new Error("complete matrix kit required");
const effectLanes = ["filesystem_write", "process_execution", "persistent_state_mutation"];
const rows = kit.classified.map((row) => ({
  path: row.path, startLine: row.startLine, endLine: row.endLine, sha256: row.sha256,
  lanes: Object.entries(row.lanes).filter(([, active]) => active).map(([lane]) => lane).sort(),
}));
const authorityFiles = new Set(rows.filter((row) => row.lanes.includes("authority_gate")).map((row) => row.path));
const gauge = rows.flatMap((row) => row.lanes
  .filter((lane) => effectLanes.includes(lane) && !authorityFiles.has(row.path))
  .map((lane) => candidate(row, lane))).sort(compareCandidates);
const compactPull = packet.candidates.map((row) => ({
  code: row.code, lane: row.lane, path: row.source.path, startLine: row.source.startLine,
  endLine: row.source.endLine, sha256: row.source.sha256,
  proofKinds: row.proofAudit.provenanceKinds,
})).sort(compareCandidates);
if (keys(gauge).join("\n") !== keys(compactPull).join("\n")) throw new Error("Datalog packet disagrees with independent deterministic gauge");

const answerSchema = {
  type: "object",
  properties: {
    candidates: { type: "array", items: { type: "object", properties: {
      code: { type: "string", enum: ["model-observed-authority-gap"] },
      lane: { type: "string", enum: effectLanes }, path: { type: "string" },
      startLine: { type: "integer" }, endLine: { type: "integer" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, required: ["code", "lane", "path", "startLine", "endLine", "sha256"], additionalProperties: false } },
  }, required: ["candidates"], additionalProperties: false,
};
await mkdir(dirname(schemaPath), { recursive: true });
await writeFile(schemaPath, `${JSON.stringify(answerSchema, null, 2)}\n`);

const instruction = [
  "Perform a read-only data-processing task using only the JSON supplied below; do not call tools or inspect the workspace.",
  "Return every candidate exactly once, sorted by path, then startLine, then endLine, then lane.",
  "A candidate has code model-observed-authority-gap.",
  "Do not reinterpret the observations as ground truth and do not add prose.",
].join(" ");
const baselinePrompt = `${instruction}\n\nCompute candidates from SOURCE_ROWS. An effect row is each active lane in ${JSON.stringify(effectLanes)}. A file has authority when any row for that path has authority_gate. Emit every effect row only when its file has no authority row. Preserve its exact path, lines, and hash.\n\nSOURCE_ROWS=${JSON.stringify(rows)}`;
const assistedPrompt = `${instruction}\n\nThe factory has already evaluated the rule and Pull-projected the candidates with exact source addresses. Copy the six answer fields from every PULLED_CANDIDATE; proofKinds are context only and must not appear in the answer.\n\nPULLED_CANDIDATES=${JSON.stringify(compactPull)}`;

const arms = [];
const schedule = order === "baseline-first"
  ? [["bare-codex-source-matrix", baselinePrompt], ["codex-with-factory-pull", assistedPrompt]]
  : [["codex-with-factory-pull", assistedPrompt], ["bare-codex-source-matrix", baselinePrompt]];
for (const [name, prompt] of schedule) {
  const run = await spawnExternalAgent("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--model", model, "-c", `model_reasoning_effort=\"${effort}\"`, "--sandbox", "read-only", "--output-schema", schemaPath, "--json", prompt], { cwd: workspace, timeoutMs });
  const parsed = parseCodex(run.stdout);
  const score = scoreAnswer(parsed.answer, gauge);
  arms.push({ name, model, effort, prompt: { bytes: Buffer.byteLength(prompt), approximateTokens: Math.ceil(Buffer.byteLength(prompt) / 4), sha256: sha256(prompt) }, run: { code: run.code, timedOut: run.timedOut, durationMs: run.durationMs, usage: parsed.usage, stderrTail: run.stderr.slice(-1000) }, score, answer: parsed.answer });
  console.log(JSON.stringify({ arm: name, durationMs: run.durationMs, promptBytes: Buffer.byteLength(prompt), score, usage: parsed.usage }));
}
const reportBody = {
  schema: "bantam.factory.codex-semantic-authority-ab.v1", completedAt: new Date().toISOString(),
  question: "Can stored Datalog computation reduce the context/work required by the same external Codex model for an exact semantic set-difference query?",
  caveat: "This evaluates reuse of DiffusionGemma observations, not the truth of those observations and not autonomous mutation authority.",
  inputs: { kitPath, packetPath, model, effort, order, matrixRows: rows.length, expectedCandidates: gauge.length },
  gauge: { implementation: "independent set construction from matrix rows", sha256: sha256(JSON.stringify(gauge)) },
  arms,
};
const report = { ...reportBody, reportId: `codex-semantic-authority-ab:sha256:${sha256(JSON.stringify(reportBody))}` };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`A/B evidence report: ${outputPath}`);

function candidate(row, lane) { return { code: "model-observed-authority-gap", lane, path: row.path, startLine: row.startLine, endLine: row.endLine, sha256: row.sha256 }; }
function compareCandidates(a, b) { return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine || a.lane.localeCompare(b.lane); }
function key(row) { return [row.code, row.lane, row.path, row.startLine, row.endLine, row.sha256].join("\0"); }
function keys(value) { return value.map(key).sort(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parseCodex(stdout) {
  let answer = null; let usage = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "item.completed" && event.item?.type === "agent_message") { try { answer = JSON.parse(event.item.text); } catch { /* scored malformed */ } }
    if (event.type === "turn.completed") usage = event.usage ?? usage;
  }
  return { answer, usage };
}
function scoreAnswer(answer, expected) {
  if (!answer || !Array.isArray(answer.candidates)) return { validJson: false, expected: expected.length, returned: 0, truePositive: 0, falsePositive: 0, falseNegative: expected.length, precision: 0, recall: 0, exact: false };
  const expectedKeys = new Set(keys(expected)); const returnedKeys = keys(answer.candidates); const returnedSet = new Set(returnedKeys);
  const truePositive = [...returnedSet].filter((item) => expectedKeys.has(item)).length;
  const falsePositive = [...returnedSet].filter((item) => !expectedKeys.has(item)).length;
  const falseNegative = [...expectedKeys].filter((item) => !returnedSet.has(item)).length;
  return { validJson: true, expected: expected.length, returned: answer.candidates.length, uniqueReturned: returnedSet.size, truePositive, falsePositive, falseNegative, precision: returnedSet.size ? truePositive / returnedSet.size : 0, recall: expectedKeys.size ? truePositive / expectedKeys.size : 1, exact: falsePositive === 0 && falseNegative === 0 && returnedKeys.length === returnedSet.size };
}
