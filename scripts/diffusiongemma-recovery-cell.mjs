#!/usr/bin/env node

/** Test bounded recovery cells around DiffusionGemma's native tool protocol. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createVerbatimAnchorLocator, recoverPartialLots } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const base = option("base", "http://127.0.0.1:8001");
const model = option("model", "dg-awq");
const rounds = Number(option("rounds", "30"));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-recovery-cell-v2.json"));

async function invoke(prompt, tool, maxTokens = 2048) {
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
  if (!response.ok) return { ok: false, elapsedMs, status: response.status, raw: raw.slice(0, 1000), args: null };
  const envelope = JSON.parse(raw);
  const call = envelope.choices?.[0]?.message?.tool_calls?.find((entry) => entry.function?.name === tool.name);
  let args = null;
  try { args = JSON.parse(call?.function?.arguments ?? ""); } catch { /* rejected mechanically */ }
  return { ok: true, elapsedMs, raw, args, usage: envelope.usage ?? {}, finishReason: envelope.choices?.[0]?.finish_reason ?? null };
}

const facts = Array.from({ length: 24 }, (_, index) => {
  const severity = ["low", "medium", "high"][index % 3];
  const subsystem = ["cache", "worker", "evidence", "scheduler"][index % 4];
  return { id: `E${String(index + 1).padStart(2, "0")}`, severity, subsystem, count: index + 3 };
});
const factText = (row) => `[${row.id}] Event affects ${row.subsystem}; declared severity is ${row.severity}; occurrence count is ${row.count}.`;
const factTool = {
  name: "submit_facts",
  description: "Extract one exact fact tuple for every issued event.",
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

async function recoveredFactRun() {
  const recovery = await recoverPartialLots({
    issued: facts,
    maxAttempts: 3,
    reworkLotSize: 8,
    keyOf: (row) => row?.id,
    async produce(lot) {
      const prompt = `Extract every issued event literally. Return each id once.\n${lot.map(factText).join("\n")}\nUse submit_facts.`;
      const result = await invoke(prompt, factTool);
      return {
        candidates: result.args?.facts,
        raw: result.raw ?? null,
        telemetry: {
          ok: result.ok,
          elapsedMs: result.elapsedMs,
          status: result.status ?? 200,
          usage: result.usage ?? {},
          finishReason: result.finishReason ?? null,
        },
      };
    },
    gauge(candidate, truth) {
      const accepted = candidate?.subsystem === truth.subsystem
        && candidate?.severity === truth.severity
        && candidate?.count === truth.count;
      return accepted ? true : { accepted: false, reasons: ["fact-mismatch"] };
    },
  });
  return {
    accepted: recovery.summary.accepted,
    exact: recovery.disposition === "released",
    unresolved: recovery.unresolved,
    recoverySummary: recovery.summary,
    calls: recovery.calls,
  };
}

const records = Array.from({ length: 192 }, (_, index) => ({
  point: `P${String(index + 1).padStart(3, "0")}`,
  text: index === 137
    ? "The release evidence targets a superseded revision rather than the current article."
    : `Routine observation ${index + 1}: all readings are nominal and the evidence packet is internally consistent.`,
}));
const locateTool = {
  name: "locate_evidence",
  description: "Return a short verbatim anchor phrase from the matching record. Do not copy its point id.",
  parameters: {
    type: "object",
    properties: { anchor: { type: "string" } },
    required: ["anchor"],
    additionalProperties: false,
  },
};

const anchorLocator = createVerbatimAnchorLocator(records);

async function locatedPointRun() {
  const calls = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const prompt = `POINTED SOURCE\n${records.map((row) => `[${row.point}] ${row.text}`).join("\n")}\nFind the record showing that release evidence targets the wrong revision. Return a short VERBATIM phrase unique to that record, not its point id. Use locate_evidence.`;
    const result = await invoke(prompt, locateTool, 256);
    const resolution = anchorLocator.locate(result.args?.anchor);
    const resolved = resolution.disposition === "located" ? { point: resolution.id } : null;
    calls.push({ attempt, anchor: result.args?.anchor ?? null, resolved, ...result });
    if (resolved?.point === "P138") return { accepted: 1, exact: true, point: records.find((row) => row.point === resolved.point).point, calls };
  }
  return { accepted: 0, exact: false, point: null, calls };
}

const startedAt = new Date().toISOString();
const factRuns = [], pointRuns = [];
for (let round = 1; round <= rounds; round += 1) {
  const row = await recoveredFactRun();
  factRuns.push({ round, ...row });
  console.log(`facts ${round}/${rounds}: ${row.accepted}/24, ${row.calls.length} call(s)`);
}
for (let round = 1; round <= rounds; round += 1) {
  const row = await locatedPointRun();
  pointRuns.push({ round, ...row });
  console.log(`point ${round}/${rounds}: ${row.accepted}/1, ${row.calls.length} call(s), anchor=${JSON.stringify(row.calls.at(-1)?.anchor)}`);
}

function summarize(rows, decisionsPerRun, firstPassAccepted) {
  const calls = rows.flatMap((row) => row.calls);
  const wallMs = calls.reduce((sum, row) => sum + (row.elapsedMs ?? row.telemetry?.elapsedMs ?? 0), 0);
  const decisions = rows.length * decisionsPerRun;
  const accepted = rows.reduce((sum, row) => sum + row.accepted, 0);
  const firstPass = rows.reduce((sum, row) => sum + firstPassAccepted(row), 0);
  return {
    runs: rows.length,
    calls: calls.length,
    additionalCalls: calls.length - rows.length,
    exactRuns: rows.filter((row) => row.exact).length,
    decisions,
    firstPassAccepted: firstPass,
    firstPassYield: firstPass / decisions,
    accepted,
    recoveredYield: accepted / decisions,
    wallMs,
    acceptedDecisionsPerSecond: accepted / (wallMs / 1000),
  };
}
const report = {
  schema: "bantam.factory.diffusiongemma-recovery-cell.v2",
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint: base,
  model,
  rounds,
  methods: {
    extraction: "canonicalize-single-wrapper; gauge-each-fact; retry-unresolved-in-lots-of-eight",
    pointing: "model-emits-case-sensitive-verbatim-anchor; exact-unique-substring locator proposes source point; hidden answer-key gauge accepts semantics; bounded-redraw",
  },
  summary: {
    facts: summarize(factRuns, 24, (row) => row.calls.find((call) => call.attempt === 1)?.accepted.length ?? 0),
    points: summarize(pointRuns, 1, (row) => row.calls[0]?.resolved?.point === "P138" ? 1 : 0),
  },
  factRuns,
  pointRuns,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`recovery-cell evidence: ${output}`);
