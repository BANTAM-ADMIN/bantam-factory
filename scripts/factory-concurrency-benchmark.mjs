#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const args = parse(process.argv.slice(2));
const endpoint = String(args.endpoint ?? "http://127.0.0.1:8085").replace(/\/$/, "");
const concurrency = positive(args.concurrency ?? 1, "concurrency");
const rounds = positive(args.rounds ?? 3, "rounds");
const promptChars = positive(args["prompt-chars"] ?? 8192, "prompt-chars");
const nPredict = positive(args.predict ?? 64, "predict");
const mode = args.mode ?? "cold";
if (!new Set(["cold", "shared-prefix"]).has(mode)) throw new Error("mode must be cold or shared-prefix");
const output = args.output ? String(args.output) : null;

const seedText = [
  "BANTAMFACTORY MATERIAL LOT. Inspect the supplied record and identify the applicable routing facts. ",
  "The worker has read-only authority. Do not modify material. Evidence must remain attributable to its source. ",
  "A missing key returns null. Surrounding whitespace is ignored. Keys compare without letter-case sensitivity. ",
].join("");
const filler = seedText.repeat(Math.ceil(promptChars / seedText.length)).slice(0, promptChars);
const samples = [];

await health();
for (let round = 0; round < rounds; round += 1) {
  const started = performance.now();
  const batch = await Promise.all(Array.from({ length: concurrency }, (_, lane) => request(round, lane)));
  const elapsedMs = performance.now() - started;
  samples.push({ round, elapsedMs, requests: batch });
}

const requests = samples.flatMap((row) => row.requests);
const totalWallMs = samples.reduce((sum, row) => sum + row.elapsedMs, 0);
const totalPromptTokens = sum(requests, "promptTokens");
const totalPredictedTokens = sum(requests, "predictedTokens");
const latencies = requests.map((row) => row.elapsedMs).sort((a, b) => a - b);
const result = {
  schema: 1,
  kind: "bantam.factory-concurrency-benchmark",
  measuredAt: new Date().toISOString(),
  endpoint,
  configuration: { concurrency, rounds, promptChars, nPredict, mode },
  totals: {
    requests: requests.length,
    promptTokens: totalPromptTokens,
    predictedTokens: totalPredictedTokens,
    wallMs: round(totalWallMs),
  },
  throughput: {
    articlesPerSecond: round(requests.length / (totalWallMs / 1000)),
    articlesPerMinute: round(60 * requests.length / (totalWallMs / 1000)),
    aggregatePromptTokensPerSecond: round(totalPromptTokens / (totalWallMs / 1000)),
    aggregatePredictedTokensPerSecond: round(totalPredictedTokens / (totalWallMs / 1000)),
  },
  latencyMs: { p50: round(percentile(latencies, 0.5)), p95: round(percentile(latencies, 0.95)), max: round(latencies.at(-1) ?? 0) },
  rounds: samples.map((row) => ({ round: row.round, wallMs: round(row.elapsedMs), promptTokens: sum(row.requests, "promptTokens"), predictedTokens: sum(row.requests, "predictedTokens") })),
};
const rendered = `${JSON.stringify(result, null, 2)}\n`;
if (output) fs.writeFileSync(output, rendered, { mode: 0o600 });
process.stdout.write(rendered);

async function health() {
  const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`health failed: HTTP ${response.status}`);
}

async function request(roundIndex, lane) {
  const nonce = crypto.createHash("sha256").update(`${process.pid}:${roundIndex}:${lane}:${Math.random()}`).digest("hex");
  const fixed = "\n\nReturn a concise inspection note followed by a routing recommendation.";
  const prompt = mode === "shared-prefix" ? `${filler}\nARTICLE ${nonce}${fixed}` : `ARTICLE ${nonce}\n${filler}${fixed}`;
  const started = performance.now();
  const response = await fetch(`${endpoint}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, n_predict: nPredict, ignore_eos: true, cache_prompt: true, seed: lane + roundIndex * concurrency, temperature: 0.6, top_p: 0.95, top_k: 20 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`completion failed: ${JSON.stringify(body.error ?? body)}`);
  return {
    elapsedMs: performance.now() - started,
    promptTokens: Number(body.timings?.prompt_n ?? 0),
    predictedTokens: Number(body.timings?.predicted_n ?? 0),
    serverPromptTps: Number(body.timings?.prompt_per_second ?? 0),
    serverPredictedTps: Number(body.timings?.predicted_per_second ?? 0),
  };
}

function parse(argv) {
  const value = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
    value[key] = next;
    index += 1;
  }
  return value;
}
function positive(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`); return number; }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0); }
function percentile(sorted, q) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]; }
function round(value) { return Math.round(value * 1000) / 1000; }
