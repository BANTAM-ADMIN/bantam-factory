#!/usr/bin/env node

/** Adversarial holdout for exact-source DiffusionGemma anchor localization. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createVerbatimAnchorLocator } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const base = option("base", "http://127.0.0.1:8001");
const model = option("model", "dg-awq");
const trials = Number(option("trials", "10"));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-anchor-holdout-v1.json"));
const neighborCounts = [0, 1, 2, 4, 8, 16];

const targetText = "Release evidence targets a superseded revision rather than the current article.";
const neighborText = [
  "Release evidence targets the current approved revision rather than a superseded article.",
  "Archived evidence targets a superseded revision rather than the current release article.",
  "Release evidence targets a superseded calibration certificate rather than the current instrument.",
  "Release authorization references a superseded revision but the evidence targets the current article.",
  "Release evidence mentions a superseded revision while still targeting the current article.",
  "Customer evidence targets a superseded revision rather than the current release article.",
  "Release evidence targets a superseded requirement rather than the current revision.",
  "Release evidence rejects a superseded revision and targets the current article.",
  "Release evidence targets the previous article rather than its current revision.",
  "Inspection evidence targets a superseded revision rather than the current article.",
  "Release evidence targets a superseded revision rather than the current instrument.",
  "Release evidence targets a pending revision rather than the current article.",
  "Release evidence targets a superseded revision and the current article simultaneously.",
  "Release evidence targets a superseded revision rather than the archived article.",
  "Draft evidence targets a superseded revision rather than the current article.",
  "Release evidence targets the superseded article rather than the current revision.",
];

const tool = {
  name: "locate_evidence",
  description: "Copy one short, exact, case-sensitive verbatim phrase unique to the matching source record. Do not return its point id.",
  parameters: {
    type: "object",
    properties: { anchor: { type: "string" } },
    required: ["anchor"],
    additionalProperties: false,
  },
};

function makeRecords(neighbors, trial) {
  const targetPosition = [3, 17, 31, 47][trial % 4];
  const special = [targetText, ...neighborText.slice(0, neighbors)];
  const records = Array.from({ length: 64 }, (_, index) => ({
    point: `H${String(trial + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    text: `Routine observation ${trial + 1}-${index + 1}: thermal readings are nominal, calibration is current, and no release evidence exception exists.`,
    target: false,
  }));
  const positions = [targetPosition];
  for (let cursor = 0; positions.length < special.length; cursor += 1) {
    const candidate = (targetPosition + 7 + cursor * 11) % records.length;
    if (!positions.includes(candidate)) positions.push(candidate);
  }
  for (let index = 0; index < special.length; index += 1) records[positions[index]] = { ...records[positions[index]], text: special[index], target: index === 0 };
  // Rotate physical layout independently of logical point identity.
  const by = (trial * 13 + neighbors * 3) % records.length;
  return [...records.slice(by), ...records.slice(0, by)];
}

async function snapshot() {
  const text = await (await fetch(`${base}/metrics`)).text();
  const value = (name) => {
    const line = text.split("\n").find((row) => row.startsWith(name));
    return line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
  };
  return { steps: value("vllm:diffusion_num_denoising_steps_total"), committed: value("vllm:diffusion_num_committed_tokens_total") };
}

async function ask(records) {
  const before = await snapshot();
  const prompt = `ISSUED SOURCE REGISTRY\n${records.map((row) => `[${row.point}] ${row.text}`).join("\n")}\n\nFind the ONE record which states that release evidence targets a superseded revision rather than the current article. Copy a short, exact, case-sensitive verbatim phrase unique to that record. Do not output a point id. Use locate_evidence.`;
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: tool }],
      tool_choice: { type: "function", function: { name: tool.name } },
      temperature: 0.3,
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  const after = await snapshot();
  if (!response.ok) return { ok: false, status: response.status, raw: raw.slice(0, 1000), elapsedMs, anchor: null, usage: {}, sampler: null };
  const envelope = JSON.parse(raw);
  const call = envelope.choices?.[0]?.message?.tool_calls?.find((entry) => entry.function?.name === tool.name);
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ""); } catch { /* measured malformed output */ }
  const canvases = (after.committed - before.committed) / 256;
  const passes = Math.max(0, after.steps - before.steps - canvases);
  return { ok: true, elapsedMs, anchor: typeof args?.anchor === "string" ? args.anchor : null, rawArguments: call?.function?.arguments ?? null, usage: envelope.usage ?? {}, sampler: { canvases, passes, passesPerCanvas: canvases ? passes / canvases : null } };
}

const startedAt = new Date().toISOString();
const runs = [];
for (const neighbors of neighborCounts) {
  for (let trial = 0; trial < trials; trial += 1) {
    const records = makeRecords(neighbors, trial);
    const target = records.find((row) => row.target);
    const locator = createVerbatimAnchorLocator(records, { requireSeparable: false });
    if (!locator.audit.separable) {
      runs.push({ neighbors, trial: trial + 1, target: target.point, location: null, outcome: "registry-rejected", registryAudit: locator.audit, ok: false, elapsedMs: 0, anchor: null, usage: {}, sampler: null });
      console.log(`neighbors ${neighbors} trial ${trial + 1}/${trials}: registry-rejected (${locator.audit.inseparable.join(",")})`);
      continue;
    }
    const response = await ask(records);
    const location = locator.locate(response.anchor);
    const outcome = location.disposition !== "located"
      ? location.disposition
      : location.id === target.point ? "correct-location" : "wrong-location-escape";
    runs.push({ neighbors, trial: trial + 1, target: target.point, location, outcome, registryAudit: locator.audit, ...response });
    console.log(`neighbors ${neighbors} trial ${trial + 1}/${trials}: ${outcome}, ${response.elapsedMs.toFixed(1)} ms, anchor=${JSON.stringify(response.anchor)}`);
  }
}

function summarize(rows) {
  const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
  const wallMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
  const canvases = rows.reduce((sum, row) => sum + (row.sampler?.canvases ?? 0), 0);
  const passes = rows.reduce((sum, row) => sum + (row.sampler?.passes ?? 0), 0);
  return {
    trials: rows.length,
    correct: count("correct-location"),
    wrongLocationEscapes: count("wrong-location-escape"),
    unmatched: count("unmatched"),
    ambiguous: count("ambiguous"),
    malformed: count("malformed"),
    registryRejected: count("registry-rejected"),
    correctRate: count("correct-location") / rows.length,
    escapeRate: count("wrong-location-escape") / rows.length,
    wallMs,
    meanMs: wallMs / rows.length,
    canvases,
    passes,
    meanPassesPerCanvas: canvases ? passes / canvases : null,
  };
}

const report = {
  schema: "bantam.factory.diffusiongemma-anchor-holdout.v1",
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint: base,
  model,
  trialsPerNeighborCount: trials,
  protocol: "native-gemma-tool; exact-case-sensitive-unique-substring-location; hidden-answer-semantic-gauge",
  summary: summarize(runs),
  byNeighborCount: Object.fromEntries(neighborCounts.map((count) => [count, summarize(runs.filter((row) => row.neighbors === count))])),
  runs,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ summary: report.summary, byNeighborCount: report.byNeighborCount }, null, 2));
console.log(`anchor holdout evidence: ${output}`);
