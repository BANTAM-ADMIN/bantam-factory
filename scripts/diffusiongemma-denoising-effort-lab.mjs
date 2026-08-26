#!/usr/bin/env node

/** Measure useful factory throughput at one DiffusionGemma denoising-step cap. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const base = option("base", "http://127.0.0.1:8001");
const model = option("model", "dg-awq");
const cap = Number(option("cap", "48"));
const rounds = Number(option("rounds", "8"));
const output = resolve(option("output", `.bantam/factory-benchmarks/diffusiongemma-denoising-cap-${cap}.json`));

const metricNames = {
  denoising: "vllm:diffusion_num_denoising_steps_total",
  canvasPositions: "vllm:diffusion_num_canvas_positions_total",
  committed: "vllm:diffusion_num_committed_tokens_total",
};

function parseMetrics(text) {
  const result = {};
  for (const [key, metric] of Object.entries(metricNames)) {
    const line = text.split("\n").find((row) => row.startsWith(metric));
    result[key] = line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
  }
  return result;
}

async function snapshot() {
  return parseMetrics(await (await fetch(`${base}/metrics`)).text());
}

const subtract = (after, before) => Object.fromEntries(
  Object.keys(after).map((key) => [key, after[key] - before[key]]),
);

async function invoke({ prompt, tool, maxTokens = 2048 }) {
  const before = await snapshot();
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
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  const after = await snapshot();
  if (!response.ok) return { ok: false, status: response.status, raw: raw.slice(0, 1000), elapsedMs, metrics: subtract(after, before) };
  const envelope = JSON.parse(raw);
  const message = envelope.choices?.[0]?.message ?? {};
  const call = message.tool_calls?.find((entry) => entry.function?.name === tool.name);
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ""); } catch { /* Invalid is measured yield loss. */ }
  return {
    ok: true,
    args,
    elapsedMs,
    metrics: subtract(after, before),
    usage: envelope.usage ?? {},
    finishReason: envelope.choices?.[0]?.finish_reason ?? null,
  };
}

const routeCases = Array.from({ length: 32 }, (_, index) => {
  const kinds = ["release", "contain", "inspect", "retry"];
  const kind = kinds[index % kinds.length];
  const text = {
    release: "All required evidence is current, independent, passing, and authorized.",
    contain: "Customer-bound output includes a confirmed defect and shipment must stop.",
    inspect: "Evidence is incomplete, no defect is confirmed, and an independent gauge is required.",
    retry: "The qualified endpoint returned an empty response once and retry budget remains.",
  }[kind];
  return { id: `R${String(index + 1).padStart(2, "0")}`, kind, text };
});

const routeTool = {
  name: "submit_routes",
  description: "Submit exactly one route for every issued case.",
  parameters: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            route: { type: "string", enum: ["release", "contain", "inspect", "retry"] },
          },
          required: ["id", "route"],
          additionalProperties: false,
        },
      },
    },
    required: ["routes"],
    additionalProperties: false,
  },
};

const facts = Array.from({ length: 24 }, (_, index) => {
  const severity = ["low", "medium", "high"][index % 3];
  const subsystem = ["cache", "worker", "evidence", "scheduler"][index % 4];
  return {
    id: `E${String(index + 1).padStart(2, "0")}`,
    severity,
    subsystem,
    text: `Event ${index + 1} affects ${subsystem}; declared severity is ${severity}; occurrence count is ${index + 3}.`,
    count: index + 3,
  };
});

const factTool = {
  name: "submit_facts",
  description: "Extract one exact fact tuple for every event.",
  parameters: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            subsystem: { type: "string", enum: ["cache", "worker", "evidence", "scheduler"] },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            count: { type: "integer" },
          },
          required: ["id", "subsystem", "severity", "count"],
          additionalProperties: false,
        },
      },
    },
    required: ["facts"],
    additionalProperties: false,
  },
};

const needles = Array.from({ length: 192 }, (_, index) => ({
  point: `P${String(index + 1).padStart(3, "0")}`,
  text: index === 137
    ? "The release evidence targets a superseded revision rather than the current article."
    : `Routine observation ${index + 1}: current evidence agrees with the active revision and all readings are nominal.`,
}));
const pointTool = {
  name: "select_point",
  description: "Select the one issued point satisfying the question.",
  parameters: {
    type: "object",
    properties: { point: { type: "string" } },
    required: ["point"],
    additionalProperties: false,
  },
};

const workloads = [
  {
    name: "closed-routing-32",
    decisions: 32,
    prompt: `Route every case.\n${routeCases.map((row) => `[${row.id}] ${row.text}`).join("\n")}\nUse submit_routes.`,
    tool: routeTool,
    score(args) {
      const values = new Map(Array.isArray(args?.routes) ? args.routes.map((row) => [row.id, row.route]) : []);
      return routeCases.filter((row) => values.get(row.id) === row.kind).length;
    },
  },
  {
    name: "typed-fact-extraction-24",
    decisions: 24,
    prompt: `Extract the literal typed facts from every event.\n${facts.map((row) => `[${row.id}] ${row.text}`).join("\n")}\nUse submit_facts.`,
    tool: factTool,
    score(args) {
      const values = new Map(Array.isArray(args?.facts) ? args.facts.map((row) => [row.id, row]) : []);
      return facts.filter((row) => {
        const got = values.get(row.id);
        return got?.subsystem === row.subsystem && got?.severity === row.severity && got?.count === row.count;
      }).length;
    },
  },
  {
    name: "semantic-pointing-1-of-192",
    decisions: 1,
    prompt: `POINTED REGISTRY\n${needles.map((row) => `[${row.point}] ${row.text}`).join("\n")}\nSelect the ONE point showing that evidence targets the wrong revision. Use select_point.`,
    tool: pointTool,
    maxTokens: 128,
    score(args) { return args?.point === "P138" ? 1 : 0; },
  },
];

const startedAt = new Date().toISOString();
const runs = [];
for (const workload of workloads) {
  for (let round = 1; round <= rounds; round += 1) {
    const result = await invoke(workload);
    const accepted = result.ok ? workload.score(result.args) : 0;
    const canvases = result.metrics.committed > 0 ? result.metrics.committed / 256 : 0;
    const actualDenoising = Math.max(0, result.metrics.denoising - canvases);
    runs.push({
      workload: workload.name,
      round,
      decisions: workload.decisions,
      accepted,
      exact: accepted === workload.decisions,
      ...result,
      derived: {
        canvases,
        actualDenoising,
        stepsPerCanvas: canvases ? actualDenoising / canvases : null,
      },
    });
    console.log(`cap ${cap} ${workload.name} ${round}/${rounds}: ${accepted}/${workload.decisions} accepted, ${result.elapsedMs.toFixed(1)} ms, ${actualDenoising} denoise passes`);
  }
}

function summarize(rows) {
  const wallMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
  const decisions = rows.reduce((sum, row) => sum + row.decisions, 0);
  const accepted = rows.reduce((sum, row) => sum + row.accepted, 0);
  const denoising = rows.reduce((sum, row) => sum + row.derived.actualDenoising, 0);
  const canvases = rows.reduce((sum, row) => sum + row.derived.canvases, 0);
  return {
    calls: rows.length,
    exactCalls: rows.filter((row) => row.exact).length,
    wallMs,
    decisions,
    accepted,
    rejected: decisions - accepted,
    yield: decisions ? accepted / decisions : 0,
    rawDecisionsPerSecond: wallMs ? decisions / (wallMs / 1000) : 0,
    acceptedDecisionsPerSecond: wallMs ? accepted / (wallMs / 1000) : 0,
    denoisingPasses: denoising,
    canvases,
    meanDenoisingPassesPerCanvas: canvases ? denoising / canvases : null,
  };
}

const report = {
  schema: "bantam.factory.diffusiongemma-denoising-effort-lab.v1",
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint: base,
  model,
  configuredMaxDenoisingSteps: cap,
  rounds,
  protocol: "forced-native-gemma-tool-call-with-independent-exact-gauge",
  summary: summarize(runs),
  workloads: Object.fromEntries(workloads.map((workload) => [
    workload.name,
    summarize(runs.filter((row) => row.workload === workload.name)),
  ])),
  runs,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`denoising evidence: ${output}`);
