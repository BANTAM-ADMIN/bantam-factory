#!/usr/bin/env node

/**
 * Use DiffusionGemma's native Gemma tool protocol to generate adversarial raw
 * completions for BANTAM's real action parser, then score them against hidden
 * seeded behavioral mutants. No generated input is trusted or executed.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { ActionSchema, parseAction } from "../src/actions.js";
import { runCandidatePress } from "../src/factory.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const endpoint = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const model = option("model", "dg-awq");
const rounds = Number(option("rounds", "3"));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-mutation-mill-v1.json"));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("rounds must be an integer from 1 to 10");

const [actionsSource, protocolSource] = await Promise.all([
  readFile(resolve("src/actions.js"), "utf8"),
  readFile(resolve("src/action-protocol.js"), "utf8"),
]);

const task = {
  schema: 1,
  kind: "bantam.factory-candidate-press-task",
  id: "action-parser-mutation-mill",
  version: 1,
  title: "Action parser mutation mill",
  purpose: "Generate inert raw completion fixtures that distinguish the real action parser from hidden seeded behavioral defects.",
  candidateDie: {
    schema: 1,
    kind: "bantam.factory-candidate-die",
    fields: [{ name: "input", type: "string", required: true, minLength: 1, maxLength: 2000 }],
    additionalProperties: false,
  },
  limits: { maxCandidates: 96 },
  release: { minAccepted: 1, minUniqueAccepted: 1 },
};

const readOnly = new Set(["read_file", "list_dir", "search"]);
const integerFields = ["start", "limit", "line", "end"];
const stringFields = ["p", "q", "old", "new", "content", "c", "summary", "text", "from", "to"];
const clone = (value) => structuredClone(value);
const schemaAccepts = (value) => ActionSchema.safeParse(value).success;
function wholeJson(raw) { try { return JSON.parse(raw.trim()); } catch { return null; } }

const mutants = [
  {
    id: "unknown-root-verb-accepted",
    detects: (raw) => { const row = wholeJson(raw); return row && !Array.isArray(row) && typeof row === "object" && typeof row.a === "string" && !schemaAccepts(row) && !["read_file", "list_dir", "search", "inspect", "replace", "edit_lines", "patch", "write_file", "delete_file", "move_file", "shell", "done", "respond", "query"].includes(row.a); },
  },
  {
    id: "missing-root-verb-accepted",
    detects: (raw) => { const row = wholeJson(raw); return row && !Array.isArray(row) && typeof row === "object" && !("a" in row); },
  },
  {
    id: "empty-required-string-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (!row || Array.isArray(row) || typeof row !== "object") return false; const repaired = clone(row); let changed = false; for (const key of stringFields) if (repaired[key] === "") { repaired[key] = "x"; changed = true; } return changed && schemaAccepts(repaired); },
  },
  {
    id: "string-field-coercion",
    detects: (raw) => { const row = wholeJson(raw); if (!row || Array.isArray(row) || typeof row !== "object") return false; const repaired = clone(row); let changed = false; for (const key of stringFields) if (typeof repaired[key] === "number" || typeof repaired[key] === "boolean") { repaired[key] = String(repaired[key]); changed = true; } return changed && schemaAccepts(repaired); },
  },
  {
    id: "nonpositive-integer-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (!row || Array.isArray(row) || typeof row !== "object") return false; const repaired = clone(row); let changed = false; for (const key of integerFields) if (Number.isInteger(repaired[key]) && repaired[key] <= 0) { repaired[key] = 1; changed = true; } return changed && schemaAccepts(repaired); },
  },
  {
    id: "fractional-integer-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (!row || Array.isArray(row) || typeof row !== "object") return false; const repaired = clone(row); let changed = false; for (const key of integerFields) if (typeof repaired[key] === "number" && Number.isFinite(repaired[key]) && repaired[key] > 0 && !Number.isInteger(repaired[key])) { repaired[key] = Math.max(1, Math.floor(repaired[key])); changed = true; } return changed && schemaAccepts(repaired); },
  },
  {
    id: "empty-inspect-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (row?.a !== "inspect" || !Array.isArray(row.ops) || row.ops.length !== 0) return false; const repaired = clone(row); repaired.ops = [{ a: "list_dir", p: "." }]; return schemaAccepts(repaired); },
  },
  {
    id: "wide-inspect-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (row?.a !== "inspect" || !Array.isArray(row.ops) || row.ops.length <= 6) return false; const repaired = clone(row); repaired.ops = repaired.ops.slice(0, 6); return schemaAccepts(repaired); },
  },
  {
    id: "write-inside-inspect-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (row?.a !== "inspect" || !Array.isArray(row.ops) || !row.ops.some((op) => op && typeof op.a === "string" && !readOnly.has(op.a))) return false; const repaired = clone(row); repaired.ops = repaired.ops.map((op) => op && readOnly.has(op.a) ? op : ({ a: "list_dir", p: "." })); return schemaAccepts(repaired); },
  },
  {
    id: "empty-patch-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (row?.a !== "patch" || !Array.isArray(row.edits) || row.edits.length !== 0) return false; const repaired = clone(row); repaired.edits = [{ p: "x", old: "a", new: "b" }]; return schemaAccepts(repaired); },
  },
  {
    id: "wide-patch-accepted",
    detects: (raw) => { const row = wholeJson(raw); if (row?.a !== "patch" || !Array.isArray(row.edits) || row.edits.length <= 16) return false; const repaired = clone(row); repaired.edits = repaired.edits.slice(0, 16); return schemaAccepts(repaired); },
  },
  {
    id: "array-root-accepted",
    detects: (raw) => { const row = wholeJson(raw); return Array.isArray(row) && row.length > 0 && schemaAccepts(row[0]); },
  },
  {
    id: "unterminated-object-auto-closed",
    detects: (raw) => { if (!raw.trim().startsWith("{") || parseAction(raw).kind !== "unterminated_json") return false; for (let count = 1; count <= 4; count += 1) { const repaired = `${raw}${"}".repeat(count)}`; const result = parseAction(repaired); if (result.ok) return true; } return false; },
  },
];

async function produce(prompt, temperature) {
  const parameters = {
    type: "object",
    properties: { candidates: { type: "array", items: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } } },
    required: ["candidates"],
    additionalProperties: false,
  };
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: { name: "submit_candidates", description: "Submit inert raw parser test fixtures.", parameters } }],
      tool_choice: "auto",
      temperature,
      max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const rawEnvelope = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawEnvelope.slice(0, 500)}`);
  const envelope = JSON.parse(rawEnvelope), message = envelope.choices?.[0]?.message ?? {};
  const call = message.tool_calls?.find((row) => row.function?.name === "submit_candidates");
  let answer = null;
  try { answer = JSON.parse(call?.function?.arguments ?? ""); } catch { /* contained by press */ }
  return {
    answer,
    telemetry: { elapsedMs: Number(elapsedMs.toFixed(2)), promptTokens: envelope.usage?.prompt_tokens ?? 0, completionTokens: envelope.usage?.completion_tokens ?? 0 },
    protocol: { toolName: call?.function?.name ?? null, finishReason: envelope.choices?.[0]?.finish_reason ?? null, rawArguments: call?.function?.arguments ?? "" },
  };
}

const sharedMaterial = `You are testing a real parser. Generate inert RAW STRING inputs; never execute them. Read the implementation and protocol below. Use the submit_candidates tool to return exactly 64 DISTINCT adversarial raw completion strings. Each candidate.input is the complete raw string passed to parseAction. Seek validation boundaries and parser disagreements, not ordinary valid examples.\n\nACTION PARSER:\n${actionsSource}\n\nACTION PROTOCOL:\n${protocolSource}`;
const promptVariants = [
  `${sharedMaterial}\n\nEmphasize type boundaries, missing and empty required fields, unknown actions, integer boundaries, and malformed or unusual JSON roots.`,
  `${sharedMaterial}\n\nEmphasize nested inspect operations, read-only enforcement, empty/overfull arrays, patch edit arrays, and invalid nested records.`,
  `${sharedMaterial}\n\nEmphasize adversarial raw serialization, truncated objects, arrays/scalars as roots, mixed valid and invalid shapes, and cases a permissive validator might accidentally accept.`,
];

const startedAt = new Date().toISOString();
const trials = [];
for (let round = 1; round <= rounds; round += 1) {
  for (let variant = 0; variant < promptVariants.length; variant += 1) {
    let production;
    const article = await runCandidatePress({
      task,
      produce: async () => { production = await produce(promptVariants[variant], [0.3, 0.5, 0.7][variant]); return production; },
      gauge: ({ input }) => {
        const reference = parseAction(input);
        const killed = reference.ok ? [] : mutants.filter((mutant) => mutant.detects(input)).map((mutant) => mutant.id);
        return killed.length
          ? { accepted: true, reasons: [], proof: { referenceKind: reference.kind, killedMutants: killed } }
          : { accepted: false, reasons: [reference.ok ? "oracle:reference-accepts" : "oracle:no-hidden-mutant-killed"], proof: { referenceKind: reference.kind ?? "accepted", killedMutants: [] } };
      },
    });
    const killed = [...new Set(article.inspections.flatMap((row) => row.proof?.killedMutants ?? []))].sort();
    trials.push({ round, variant: variant + 1, article, killedMutants: killed, protocol: production.protocol });
    console.log(`round ${round} rack ${variant + 1}: ${article.summary.accepted}/${article.summary.emitted} useful; killed ${killed.length}/${mutants.length} hidden mutants`);
  }
}

const allAccepted = trials.flatMap((trial) => trial.article.inspections.filter((row) => row.disposition === "accepted"));
const universe = new Set(mutants.map((mutant) => mutant.id));
const remaining = new Set(universe), minimal = [];
for (const row of [...allAccepted].sort((a, b) => (b.proof.killedMutants.length - a.proof.killedMutants.length))) {
  const novel = row.proof.killedMutants.filter((id) => remaining.has(id));
  if (!novel.length) continue;
  minimal.push({ input: row.candidate.input, killedMutants: novel });
  for (const id of novel) remaining.delete(id);
}
const killedMutants = [...universe].filter((id) => !remaining.has(id)).sort();
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const summary = {
  rounds,
  racksPerRound: promptVariants.length,
  modelCalls: trials.length,
  hiddenMutants: mutants.length,
  killedMutants: killedMutants.length,
  survivingMutants: [...remaining].sort(),
  mutationScore: killedMutants.length / mutants.length,
  emittedCandidates: trials.reduce((sum, trial) => sum + trial.article.summary.emitted, 0),
  usefulCandidates: trials.reduce((sum, trial) => sum + trial.article.summary.accepted, 0),
  meanUsefulCandidatesPerSecond: Number(mean(trials.map((trial) => trial.article.telemetry.acceptedPerSecond)).toFixed(2)),
  meanEndToEndCompletionTokensPerSecond: Number(mean(trials.map((trial) => trial.article.telemetry.completionTokensPerSecond)).toFixed(2)),
  minimalKillingSetSize: minimal.length,
};
const report = {
  schema: "bantam.factory.diffusiongemma-mutation-mill.v1",
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  source: { files: ["src/actions.js", "src/action-protocol.js"], characters: actionsSource.length + protocolSource.length },
  mutantCatalog: mutants.map(({ id }) => id),
  summary,
  minimalKillingSet: minimal,
  trials,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`mutation mill evidence: ${output}`);
