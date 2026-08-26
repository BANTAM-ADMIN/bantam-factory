#!/usr/bin/env node

/** Extensive DiffusionGemma stable-prefix, progressive-prefix, and decision-canvas lab. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const base = option("base", "http://127.0.0.1:8001");
const model = option("model", "dg-awq");
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-prefix-swarm-v1.json"));

const semanticNeedles = [
  ["customer shipment must stop immediately", "A confirmed defect has entered customer-bound output, so shipment must halt immediately."],
  ["calibration evidence is absent", "The measurement has no traceable calibration certificate or signed evidence packet."],
  ["instructions conflict about lockout", "Two active instructions conflict: one permits operation while the other requires lockout."],
  ["a dependency is stale", "Downstream release still relies on an obsolete acceptance result from a superseded revision."],
  ["authority has been revoked", "The previously issued release authority was explicitly revoked before this operation began."],
  ["rollback left partial live state", "A failed rollback restored only part of the article and left live state partially mutated."],
  ["the worker has no quota", "The assigned model worker has exhausted its service quota and cannot accept another dispatch."],
  ["the result lacks independent verification", "The article completed, but no independent gauge or acceptance evidence exists."],
  ["thermal behavior is accelerating", "Temperature is accelerating upward despite a controller command to cool the loop."],
  ["an alloy substitution lacks approval", "An alternate alloy was installed without the required engineering approval."],
  ["valid source records were silently dropped", "The transformation silently discarded valid input records without an error."],
  ["two supervisors claim incompatible authority", "Two supervisors assert mutually incompatible release authority over the same revision."],
  ["a required signature is missing", "The mandatory pre-release supervisor signature is absent from the traveler."],
  ["the evidence targets the wrong revision", "The passing test evidence was measured against a different repository revision."],
  ["a symlink escapes the workspace", "A candidate path traverses a symbolic link whose target lies outside the authorized workspace."],
  ["the target changed after inspection", "The target bytes changed after inspection but before the authorized actuator moved."],
  ["the parser accepted an unknown operation", "The action parser admitted a verb that is absent from the installed operation catalog."],
  ["the process graph contains a cycle", "The compiled dependency graph contains a cycle and therefore has no valid execution order."],
  ["a gauge modified the article", "The supposedly read-only verification gauge changed authored chassis bytes during inspection."],
  ["the endpoint is reachable but unqualified", "The model endpoint is healthy, but this worker has no qualification for the requested role."],
  ["the cache prefix was accidentally churned", "A volatile timestamp was placed before stable instructions and destroyed prefix reuse."],
  ["an approval became stale", "A newer chassis revision was created after approval, making the old grant stale."],
  ["the output exceeded its die", "The worker emitted an extra field outside the station's closed output contract."],
  ["the candidate altered a hidden test", "The proposed change modified protected hidden verification material."],
  ["a required dependency disappeared", "A declared prerequisite edge was removed while dependent work remained scheduled."],
  ["the worker repeatedly returned empty output", "Three bounded attempts produced an empty model response and exhausted retry policy."],
  ["the process consumed unexpected scope", "A single-target operation wrote an additional file outside its dispatch permit."],
  ["the evidence has no provenance", "The reported measurement cannot be traced to a source, instrument, or producing operation."],
  ["the local model is responding slowly", "Worker latency exceeded its qualified p95 for five consecutive articles."],
  ["a candidate rule contradicts a policy fact", "The proposed rule derives release while an accepted policy fact requires containment."],
  ["the context kit omitted a required clause", "The station packet omitted a contract clause required to judge the assigned obligation."],
  ["the same permit was reused", "A one-use actuation permit was presented a second time after successful consumption."],
];

function makeRecords(count, salt) {
  const specialSlots = new Map();
  semanticNeedles.forEach((entry, index) => specialSlots.set(2 + index * Math.max(1, Math.floor((count - 4) / semanticNeedles.length)), { index, sentence: entry[1] }));
  return Array.from({ length: count }, (_, index) => {
    const point = `${salt}-${String(index + 1).padStart(4, "0")}`;
    const special = specialSlots.get(index);
    const text = special
      ? special.sentence
      : `Routine record ${index + 1}: readings remain inside tolerance, instructions agree, evidence is current, authority is valid, and no customer material is exposed.`;
    return { point, text, needle: special?.index ?? null };
  });
}
const render = (records) => records.map((row) => `[${row.point}] ${row.text}`).join("\n");
const rotate = (records, by) => [...records.slice(by % records.length), ...records.slice(0, by % records.length)];

function metrics(text) {
  const selected = {
    prefixQueries: ["vllm:prefix_cache_queries_total", null],
    prefixHits: ["vllm:prefix_cache_hits_total", null],
    promptCompute: ["vllm:prompt_tokens_by_source_total", 'source="local_compute"'],
    promptCacheHit: ["vllm:prompt_tokens_by_source_total", 'source="local_cache_hit"'],
    generationTokens: ["vllm:generation_tokens_total", null],
    diffusionCommitted: ["vllm:diffusion_num_committed_tokens_total", null],
    diffusionSteps: ["vllm:diffusion_num_denoising_steps_total", null],
    canvasPositions: ["vllm:diffusion_num_canvas_positions_total", null],
  };
  const result = {};
  for (const [key, [name, label]] of Object.entries(selected)) {
    const line = text.split("\n").find((row) => row.startsWith(`${name}{`) && (!label || row.includes(label)));
    result[key] = line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
  }
  return result;
}
async function snapshot() { return metrics(await (await fetch(`${base}/metrics`)).text()); }
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));

async function toolAsk(prompt, { name, description, parameters }, maxTokens = 2048) {
  const before = await snapshot(), started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: { name, description, parameters } }],
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const rawEnvelope = await response.text(), elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawEnvelope.slice(0, 500)}`);
  const envelope = JSON.parse(rawEnvelope), message = envelope.choices?.[0]?.message ?? {};
  const call = message.tool_calls?.find((row) => row.function?.name === name);
  let answer = null;
  try { answer = JSON.parse(call?.function?.arguments ?? ""); } catch { /* scored as invalid */ }
  const after = await snapshot();
  return {
    answer,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    usage: envelope.usage ?? {},
    toolName: call?.function?.name ?? null,
    finishReason: envelope.choices?.[0]?.finish_reason ?? null,
    metricDelta: delta(after, before),
  };
}

const pointTool = {
  name: "select_point",
  description: "Select the one issued point that answers the inspection question.",
  parameters: { type: "object", properties: { point: { type: "string" } }, required: ["point"], additionalProperties: false },
};
const answerTool = {
  name: "submit_answers",
  description: "Submit one issued point for every question id.",
  parameters: {
    type: "object",
    properties: { answers: { type: "array", items: { type: "object", properties: { q: { type: "integer" }, point: { type: "string" } }, required: ["q", "point"], additionalProperties: false } } },
    required: ["answers"],
    additionalProperties: false,
  },
};

function expectedPoint(records, needleIndex) { return records.find((row) => row.needle === needleIndex)?.point ?? null; }
function queryTail(index) { return `INSPECTION QUESTION: Select the ONE point whose record means that ${semanticNeedles[index][0]}. Negated or merely routine records do not qualify. Use select_point.`; }
const sumMetrics = (rows) => Object.fromEntries(Object.keys(rows[0]?.metricDelta ?? {}).map((key) => [key, rows.reduce((sum, row) => sum + row.metricDelta[key], 0)]));
const summarizeCalls = (rows) => ({
  calls: rows.length,
  exact: rows.filter((row) => row.exact).length,
  wallMs: Number(rows.reduce((sum, row) => sum + row.elapsedMs, 0).toFixed(2)),
  meanMs: Number((rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length).toFixed(2)),
  promptTokens: rows.reduce((sum, row) => sum + (row.usage.prompt_tokens ?? 0), 0),
  completionTokens: rows.reduce((sum, row) => sum + (row.usage.completion_tokens ?? 0), 0),
  metrics: sumMetrics(rows),
});

// Experiment 1: churned versus byte-stable rotary questions at four corpus sizes.
const rotary = [];
for (const count of [64, 192, 384, 576]) {
  const records = makeRecords(count, `R${count}`), queryCount = 8;
  const churned = [], stable = [];
  for (let index = 0; index < queryCount; index += 1) {
    const ordered = rotate(records, index * 17 + 3);
    const response = await toolAsk(`POINTED MATERIAL REGISTRY\n${render(ordered)}\n\n${queryTail(index)}`, pointTool, 128);
    churned.push({ query: index, expected: expectedPoint(records, index), actual: response.answer?.point ?? null, exact: response.answer?.point === expectedPoint(records, index), ...response });
  }
  const prefix = `POINTED MATERIAL REGISTRY\n${render(records)}\n\n`;
  for (let index = 0; index < queryCount; index += 1) {
    const response = await toolAsk(`${prefix}${queryTail(index)}`, pointTool, 128);
    stable.push({ query: index, expected: expectedPoint(records, index), actual: response.answer?.point ?? null, exact: response.answer?.point === expectedPoint(records, index), ...response });
  }
  rotary.push({ count, churned, stable, summary: { churned: summarizeCalls(churned), stable: summarizeCalls(stable) } });
  console.log(`rotary ${count}: churned ${rotary.at(-1).summary.churned.wallMs} ms, stable ${rotary.at(-1).summary.stable.wallMs} ms, exact ${rotary.at(-1).summary.stable.exact}/${queryCount}`);
}

// Experiment 2: grow one material prefix; each stage should compute only its appended suffix.
const progressiveRecords = makeRecords(512, "GROW"), progressive = [];
for (const count of [128, 256, 384, 512]) {
  const records = progressiveRecords.slice(0, count), available = records.filter((row) => row.needle !== null);
  const needle = available.at(-1).needle, response = await toolAsk(`GROWING KNOWLEDGE REGISTRY\n${render(records)}\n\n${queryTail(needle)}`, pointTool, 128);
  progressive.push({ count, query: needle, expected: expectedPoint(records, needle), actual: response.answer?.point ?? null, exact: response.answer?.point === expectedPoint(records, needle), ...response });
  console.log(`progressive ${count}: ${response.elapsedMs} ms, compute ${response.metricDelta.promptCompute}, cache ${response.metricDelta.promptCacheHit}`);
}

// Experiment 3: same 32 questions as 32 micro-calls, four lots, and one canvas.
async function topology(name, groups) {
  const records = makeRecords(384, name.toUpperCase()), material = `POINTED MATERIAL REGISTRY\n${render(records)}\n\n`;
  const calls = [];
  for (const indices of groups) {
    if (indices.length === 1) {
      const index = indices[0], response = await toolAsk(`${material}${queryTail(index)}`, pointTool, 128);
      calls.push({ indices, exact: response.answer?.point === expectedPoint(records, index), expected: [expectedPoint(records, index)], actual: [response.answer?.point ?? null], ...response });
      continue;
    }
    const questions = indices.map((index) => `Q${index + 1}: Which ONE point means that ${semanticNeedles[index][0]}?`).join("\n");
    const response = await toolAsk(`${material}Answer every question exactly once with its integer q id and issued point.\n${questions}\nUse submit_answers.`, answerTool, 4096);
    const answers = response.answer?.answers ?? [], byQ = new Map(Array.isArray(answers) ? answers.map((row) => [row.q, row.point]) : []);
    const exact = indices.every((index) => byQ.get(index + 1) === expectedPoint(records, index)) && byQ.size === indices.length;
    calls.push({ indices, exact, expected: indices.map((index) => expectedPoint(records, index)), actual: indices.map((index) => byQ.get(index + 1) ?? null), ...response });
  }
  return { name, calls, summary: { ...summarizeCalls(calls), decisions: 32, exactDecisions: calls.reduce((sum, row) => sum + row.actual.filter((point, i) => point === row.expected[i]).length, 0) } };
}
const indices = Array.from({ length: 32 }, (_, index) => index);
const topologies = [
  await topology("micro-32x1", indices.map((index) => [index])),
  await topology("lots-4x8", Array.from({ length: 4 }, (_, group) => indices.slice(group * 8, group * 8 + 8))),
  await topology("canvas-1x32", [indices]),
];
for (const row of topologies) console.log(`${row.name}: ${row.summary.wallMs} ms, ${row.summary.exactDecisions}/32 exact decisions`);

const report = {
  schema: "bantam.factory.diffusiongemma-prefix-swarm-lab.v1",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  endpoint: base,
  model,
  protocol: "native-gemma-tool-call",
  rotary,
  progressive,
  progressiveSummary: summarizeCalls(progressive),
  topologies,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`prefix swarm evidence: ${output}`);
