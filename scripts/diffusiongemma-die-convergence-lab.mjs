#!/usr/bin/env node

/** Compare output dies using accepted yield, committed canvases, and denoising passes. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const base = option("base", "http://127.0.0.1:8001");
const model = option("model", "dg-awq");
const rounds = Number(option("rounds", "20"));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-die-convergence-v1.json"));
const flags = ["mandatory", "anomaly", "missing", "shutdown", "impact", "dependency", "conflict"];
const records = Array.from({ length: 16 }, (_, index) => {
  const values = Object.fromEntries(flags.map((flag, flagIndex) => [flag, (index + flagIndex * 3) % (flagIndex + 3) === 0]));
  return { point: `D${String(index + 1).padStart(2, "0")}`, values, text: flags.map((flag) => `${flag}=${values[flag] ? "YES" : "NO"}`).join(" ") };
});
const material = `INSPECTION MATERIAL\n${records.map((row) => `[${row.point}] ${row.text}`).join("\n")}\n\nFlags in order: ${flags.join(", ")}. Read only explicit YES/NO values.`;

const verboseTool = {
  name: "submit_verbose_rows",
  description: "Submit every point with seven named boolean decisions.",
  parameters: {
    type: "object",
    properties: { rows: { type: "array", items: { type: "object", properties: { point: { type: "string" }, ...Object.fromEntries(flags.map((flag) => [flag, { type: "boolean" }])) }, required: ["point", ...flags], additionalProperties: false } } },
    required: ["rows"], additionalProperties: false,
  },
};
const columnTool = {
  name: "submit_sparse_columns",
  description: "For each flag, submit only points whose explicit value is YES.",
  parameters: {
    type: "object",
    properties: Object.fromEntries(flags.map((flag) => [flag, { type: "array", items: { type: "string" } }])),
    required: flags, additionalProperties: false,
  },
};
const bitTool = {
  name: "submit_bit_rows",
  description: "Submit every point with one seven-character 0/1 word in issued flag order.",
  parameters: {
    type: "object",
    properties: { rows: { type: "array", items: { type: "object", properties: { point: { type: "string" }, bits: { type: "string" } }, required: ["point", "bits"], additionalProperties: false } } },
    required: ["rows"], additionalProperties: false,
  },
};

const expectedColumns = Object.fromEntries(flags.map((flag) => [flag, records.filter((row) => row.values[flag]).map((row) => row.point)]));
const issuedPoints = new Set(records.map((row) => row.point));
const setEqual = (left, right) => Array.isArray(left) && left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const canonicalPoint = (value, repair) => {
  if (issuedPoints.has(value)) return value;
  const match = repair && typeof value === "string" ? value.match(/^\[(D\d{2})\]$/) : null;
  return match && issuedPoints.has(match[1]) ? match[1] : value;
};
const rowArray = (value, repair) => repair && Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
const dies = {
  verbose: {
    tool: verboseTool,
    instruction: "Use submit_verbose_rows. Include exactly one row for every issued point.",
    score(args, repair = false) {
      const rows = rowArray(args?.rows, repair);
      return Array.isArray(rows) && rows.length === records.length && rows.every((row) => {
        const source = records.find((record) => record.point === canonicalPoint(row.point, repair));
        return source && flags.every((flag) => row[flag] === source.values[flag]);
      });
    },
  },
  columns: {
    tool: columnTool,
    instruction: "Use submit_sparse_columns. Include all seven keys; each array contains exactly the issued points whose flag is YES.",
    score(args, repair = false) { return args && flags.every((flag) => setEqual(Array.isArray(args[flag]) ? args[flag].map((point) => canonicalPoint(point, repair)) : args[flag], expectedColumns[flag])); },
  },
  bits: {
    tool: bitTool,
    instruction: "Use submit_bit_rows. Include exactly one row per point and a seven-character bit word in issued flag order.",
    score(args, repair = false) {
      const rows = rowArray(args?.rows, repair);
      return Array.isArray(rows) && rows.length === records.length && rows.every((row) => {
        const source = records.find((record) => record.point === canonicalPoint(row.point, repair));
        return source && row.bits === flags.map((flag) => source.values[flag] ? "1" : "0").join("");
      });
    },
  },
};

async function snapshot() {
  const text = await (await fetch(`${base}/metrics`)).text();
  const value = (name) => {
    const line = text.split("\n").find((row) => row.startsWith(name));
    return line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
  };
  return { steps: value("vllm:diffusion_num_denoising_steps_total"), committed: value("vllm:diffusion_num_committed_tokens_total") };
}

async function press(name) {
  const die = dies[name];
  const before = await snapshot();
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${material}\n\n${die.instruction}` }],
      tools: [{ type: "function", function: die.tool }],
      tool_choice: { type: "function", function: { name: die.tool.name } },
      temperature: 0.3,
      max_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const rawEnvelope = await response.text();
  const elapsedMs = performance.now() - started;
  const after = await snapshot();
  const canvases = (after.committed - before.committed) / 256;
  const passes = Math.max(0, after.steps - before.steps - canvases);
  if (!response.ok) return { die: name, ok: false, accepted: false, status: response.status, rawEnvelope: rawEnvelope.slice(0, 1000), elapsedMs, usage: {}, sampler: { canvases, passes, passesPerCanvas: canvases ? passes / canvases : null } };
  const envelope = JSON.parse(rawEnvelope);
  const call = envelope.choices?.[0]?.message?.tool_calls?.find((entry) => entry.function?.name === die.tool.name);
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ""); } catch { /* rejected below */ }
  const strictAccepted = Boolean(die.score(args, false));
  const accepted = strictAccepted || Boolean(die.score(args, true));
  return {
    die: name, ok: true, strictAccepted, accepted, protocolFittingApplied: accepted && !strictAccepted, args, rawArguments: call?.function?.arguments ?? null,
    elapsedMs, usage: envelope.usage ?? {}, finishReason: envelope.choices?.[0]?.finish_reason ?? null,
    sampler: { canvases, passes, passesPerCanvas: canvases ? passes / canvases : null },
  };
}

const orders = [["verbose", "columns", "bits"], ["columns", "bits", "verbose"], ["bits", "verbose", "columns"]];
const startedAt = new Date().toISOString();
const runs = [];
for (let round = 0; round < rounds; round += 1) for (const name of orders[round % orders.length]) {
  const row = await press(name);
  runs.push({ round: round + 1, position: orders[round % orders.length].indexOf(name) + 1, ...row });
  console.log(`${name} ${round + 1}/${rounds}: ${row.accepted ? "accepted" : "rejected"}, ${row.elapsedMs.toFixed(1)} ms, ${row.usage.completion_tokens ?? 0} tokens, ${row.sampler.canvases} canvases, ${row.sampler.passes} passes`);
}

function summarize(rows) {
  const wallMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
  const canvases = rows.reduce((sum, row) => sum + row.sampler.canvases, 0);
  const passes = rows.reduce((sum, row) => sum + row.sampler.passes, 0);
  const completionTokens = rows.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0);
  const accepted = rows.filter((row) => row.accepted).length;
  return {
    calls: rows.length, strictAccepted: rows.filter((row) => row.strictAccepted).length,
    strictYield: rows.filter((row) => row.strictAccepted).length / rows.length,
    accepted, yield: accepted / rows.length, protocolFittings: rows.filter((row) => row.protocolFittingApplied).length, wallMs, meanMs: wallMs / rows.length,
    completionTokens, meanCompletionTokens: completionTokens / rows.length,
    canvases, meanCanvases: canvases / rows.length, passes, meanPasses: passes / rows.length,
    meanPassesPerCanvas: canvases ? passes / canvases : null,
    acceptedCallsPerSecond: accepted / (wallMs / 1000),
  };
}

const report = {
  schema: "bantam.factory.diffusiongemma-die-convergence.v1",
  startedAt, completedAt: new Date().toISOString(), endpoint: base, model, rounds,
  protocol: "forced-native-gemma-tools; counterbalanced-order; independent-exact-semantic-gauge; live-diffusion-metrics",
  summaries: Object.fromEntries(Object.keys(dies).map((name) => [name, summarize(runs.filter((row) => row.die === name))])),
  runs,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summaries, null, 2));
console.log(`die convergence evidence: ${output}`);
