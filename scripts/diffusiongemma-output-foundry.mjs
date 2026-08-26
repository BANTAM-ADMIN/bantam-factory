#!/usr/bin/env node

/**
 * DiffusionGemma Output Foundry.
 *
 * Measures accepted useful products per second rather than treating raw token
 * generation as useful work. Three presses test adversarial discovery, compact
 * rule synthesis, and high-volume typed expansion behind exact local gauges.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path, { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { runCandidatePress } from "../src/factory.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const endpoint = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const model = option("model", "dg-awq");
const rounds = Number(option("rounds", "3"));
const output = resolve(option("output", ".bantam/factory-benchmarks/diffusiongemma-output-foundry-v1.json"));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("rounds must be an integer from 1 to 20");

async function ask(prompt, candidateProperties, required, { maxTokens = 4096, temperature = 0.7 } = {}) {
  const schema = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: candidateProperties,
          required,
          additionalProperties: false,
        },
      },
    },
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
      temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
      tools: [{
        type: "function",
        function: {
          name: "submit_candidates",
          description: "Submit the complete candidate population to the independent factory gauge.",
          parameters: schema,
        },
      }],
      tool_choice: "auto",
    }),
  });
  const rawEnvelope = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawEnvelope.slice(0, 500)}`);
  const envelope = JSON.parse(rawEnvelope);
  const message = envelope.choices?.[0]?.message ?? {};
  const toolCall = message.tool_calls?.find((call) => call.function?.name === "submit_candidates") ?? null;
  const raw = toolCall?.function?.arguments ?? "";
  let answer = null;
  try { answer = JSON.parse(raw); } catch { /* invalid tool arguments remain contained */ }
  return {
    answer,
    raw,
    repairs: [],
    calls: 1,
    protocol: "native-gemma-tool-call",
    toolName: toolCall?.function?.name ?? null,
    finishReason: envelope.choices?.[0]?.finish_reason ?? null,
    telemetry: {
      elapsedMs: Number(elapsedMs.toFixed(2)),
      promptTokens: envelope.usage?.prompt_tokens ?? 0,
      completionTokens: envelope.usage?.completion_tokens ?? 0,
    },
  };
}

const die = (fields) => ({ schema: 1, kind: "bantam.factory-candidate-die", fields, additionalProperties: false });
const baseTask = (id, title, purpose, fields, maxCandidates, minAccepted) => ({
  schema: 1,
  kind: "bantam.factory-candidate-press-task",
  id,
  version: 1,
  title,
  purpose,
  candidateDie: die(fields),
  limits: { maxCandidates },
  release: { minAccepted, minUniqueAccepted: minAccepted },
});
const accept = (proof) => ({ accepted: true, reasons: [], proof });
const reject = (reason, proof) => ({ accepted: false, reasons: [reason], proof });

const pathTask = baseTask(
  "path-boundary-counterexamples",
  "Path boundary counterexample press",
  "Generate paths admitted by a naive prefix policy but rejected after canonical resolution.",
  [{ name: "path", type: "string", required: true, minLength: 1, maxLength: 240 }],
  32,
  4,
);
const allowedRoot = "/workspace/allowed";
function pathGauge(candidate) {
  const naiveAdmits = candidate.path.startsWith(`${allowedRoot}/`);
  const resolved = path.posix.resolve(candidate.path);
  const referenceAdmits = resolved === allowedRoot || resolved.startsWith(`${allowedRoot}/`);
  return naiveAdmits && !referenceAdmits
    ? accept({ naiveAdmits, referenceAdmits, resolved, discrepancy: "canonical-path-escape" })
    : reject("oracle:no-policy-discrepancy", { naiveAdmits, referenceAdmits, resolved });
}
const pathPrompt = `A defective authorization check accepts every string beginning with ${allowedRoot}/. The real policy canonicalizes the path with POSIX semantics and permits only paths that remain under ${allowedRoot}. Generate 24 DISTINCT path strings that are likely to pass the defective prefix check while escaping the allowed directory after canonical resolution. Use multiple structural forms where possible. Do not explain them. Return {"candidates":[{"path":"..."}]}.`;
const pathShape = { path: { type: "string" } };

const flags = ["approved", "evidenceFresh", "workerHealthy", "revisionMatches", "revoked", "scopeChanged"];
const requiredTarget = new Set(["approved", "evidenceFresh", "workerHealthy", "revisionMatches"]);
const forbiddenTarget = new Set(["revoked", "scopeChanged"]);
const ruleTask = baseTask(
  "release-rule-synthesis",
  "Release rule synthesis press",
  "Generate compact candidate rules and qualify them against the complete hidden boolean truth table.",
  [
    { name: "required", type: "string-array", required: true, enum: flags },
    { name: "forbidden", type: "string-array", required: true, enum: flags },
  ],
  24,
  1,
);
const vectors = Array.from({ length: 2 ** flags.length }, (_, bits) => Object.fromEntries(flags.map((flag, index) => [flag, Boolean(bits & (1 << index))])));
const targetRelease = (row) => [...requiredTarget].every((flag) => row[flag]) && [...forbiddenTarget].every((flag) => !row[flag]);
function ruleGauge(candidate) {
  const required = new Set(candidate.required);
  const forbidden = new Set(candidate.forbidden);
  if (required.size !== candidate.required.length || forbidden.size !== candidate.forbidden.length) return reject("oracle:duplicate-rule-term", { cases: vectors.length });
  if ([...required].some((flag) => forbidden.has(flag))) return reject("oracle:contradictory-rule", { cases: vectors.length });
  const disagreements = vectors.filter((row) => {
    const actual = [...required].every((flag) => row[flag]) && [...forbidden].every((flag) => !row[flag]);
    return actual !== targetRelease(row);
  });
  return disagreements.length === 0
    ? accept({ exhaustiveCases: vectors.length, disagreements: 0 })
    : reject("oracle:hidden-truth-table-mismatch", { exhaustiveCases: vectors.length, disagreements: disagreements.length });
}
const rulePrompt = `Synthesize candidate release rules from this policy: Release is allowed only when approval exists, evidence is fresh, the assigned worker is healthy, and approval targets the current revision. Release must be blocked when authority was revoked or the requested scope changed after approval. A rule is represented by flags that must be true in "required" and flags that must be false in "forbidden". Available flags: ${flags.join(", ")}. Generate 16 DISTINCT plausible candidate rules, including precise and near-miss interpretations, so an exhaustive hidden truth-table oracle can qualify them. Return {"candidates":[{"required":["..."],"forbidden":["..."]}]}.`;
const ruleShape = {
  required: { type: "array", items: { type: "string", enum: flags } },
  forbidden: { type: "array", items: { type: "string", enum: flags } },
};

const components = ["intake", "parser", "planner", "actuator", "supervisor", "telemetry", "storage", "ui"];
const checks = ["syntax", "contract", "security", "evidence"];
const gauges = { syntax: "parse-gauge", contract: "exact-set-gauge", security: "policy-gauge", evidence: "provenance-gauge" };
const priorities = ["standard", "critical"];
const expansionTask = baseTask(
  "typed-work-order-expansion",
  "Typed work-order expansion press",
  "Expand a compact matrix into schema-valid, semantically exact work-order candidates.",
  [
    { name: "component", type: "string", required: true, enum: components },
    { name: "check", type: "string", required: true, enum: checks },
    { name: "gauge", type: "string", required: true, enum: Object.values(gauges) },
    { name: "priority", type: "string", required: true, enum: priorities },
  ],
  40,
  24,
);
const expansionLotTask = { ...expansionTask, id: "typed-work-order-expansion-lots", title: "Small-lot typed work-order expansion press" };
const workOrderKey = (row) => `${row.component}:${row.check}`;
const expectedWorkOrders = new Set(components.flatMap((component) => checks.map((check) => `${component}:${check}`)));
function expectedPriority(component, check) { return check === "security" || component === "actuator" || component === "supervisor" ? "critical" : "standard"; }
function expansionGauge(candidate) {
  const key = workOrderKey(candidate);
  const expectedGauge = gauges[candidate.check];
  const priority = expectedPriority(candidate.component, candidate.check);
  return expectedWorkOrders.has(key) && candidate.gauge === expectedGauge && candidate.priority === priority
    ? accept({ key, expectedGauge, priority })
    : reject("oracle:incorrect-work-order", { key, expectedGauge, priority });
}
const expansionPrompt = `Manufacture the COMPLETE Cartesian work-order matrix for these components: ${components.join(", ")}. Each component needs each check: ${checks.join(", ")}. Gauge mapping: syntax=>parse-gauge, contract=>exact-set-gauge, security=>policy-gauge, evidence=>provenance-gauge. Priority is critical for every security check and for every actuator or supervisor work order; all others are standard. Return exactly 32 unique records as {"candidates":[{"component":"...","check":"...","gauge":"...","priority":"..."}]}. No prose.`;
const expansionShape = {
  component: { type: "string", enum: components },
  check: { type: "string", enum: checks },
  gauge: { type: "string", enum: Object.values(gauges) },
  priority: { type: "string", enum: priorities },
};

async function produceExpansionLots(round) {
  const responses = [];
  for (const lot of [components.slice(0, 4), components.slice(4)]) {
    const prompt = `Manufacture the COMPLETE Cartesian work-order matrix for ONLY these four components: ${lot.join(", ")}. Each component needs each check: ${checks.join(", ")}. Gauge mapping: syntax=>parse-gauge, contract=>exact-set-gauge, security=>policy-gauge, evidence=>provenance-gauge. Priority is critical for every security check and for every actuator or supervisor work order; all others are standard. Return exactly 16 unique records as {"candidates":[{"component":"...","check":"...","gauge":"...","priority":"..."}]}. No prose.`;
    responses.push(await ask(prompt, expansionShape, ["component", "check", "gauge", "priority"], { maxTokens: 4096, temperature: round === 1 ? 0.5 : 0.8 }));
  }
  return {
    answer: { candidates: responses.flatMap((response) => response.answer?.candidates ?? []) },
    raw: responses.map((response) => response.raw),
    repairs: [],
    calls: responses.length,
    protocol: "native-gemma-tool-call",
    toolName: responses.every((response) => response.toolName === "submit_candidates") ? "submit_candidates" : null,
    finishReason: responses.map((response) => response.finishReason),
    telemetry: {
      elapsedMs: Number(responses.reduce((sum, response) => sum + response.telemetry.elapsedMs, 0).toFixed(2)),
      promptTokens: responses.reduce((sum, response) => sum + response.telemetry.promptTokens, 0),
      completionTokens: responses.reduce((sum, response) => sum + response.telemetry.completionTokens, 0),
    },
  };
}

const definitions = [
  { name: "adversarial-discovery", task: pathTask, prompt: pathPrompt, shape: pathShape, required: ["path"], gauge: pathGauge, maxTokens: 3072 },
  { name: "rule-synthesis", task: ruleTask, prompt: rulePrompt, shape: ruleShape, required: ["required", "forbidden"], gauge: ruleGauge, maxTokens: 4096 },
  { name: "typed-expansion", task: expansionTask, prompt: expansionPrompt, shape: expansionShape, required: ["component", "check", "gauge", "priority"], gauge: expansionGauge, maxTokens: 8192 },
  { name: "typed-expansion-small-lots", task: expansionLotTask, gauge: expansionGauge, produce: produceExpansionLots },
];

const startedAt = new Date().toISOString();
const trials = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const definition of definitions) {
    let response;
    const article = await runCandidatePress({
      task: definition.task,
      produce: async () => {
        response = definition.produce
          ? await definition.produce(round)
          : await ask(definition.prompt, definition.shape, definition.required, { maxTokens: definition.maxTokens, temperature: round === 1 ? 0.5 : 0.8 });
        return response;
      },
      gauge: definition.gauge,
    });
    const accepted = article.inspections.filter((row) => row.disposition === "accepted").map((row) => row.candidate);
    trials.push({
      round,
      family: definition.name,
      article,
      production: { raw: response.raw, finishReason: response.finishReason, repairs: response.repairs, calls: response.calls, protocol: response.protocol, toolName: response.toolName },
      coverage: definition.name.startsWith("typed-expansion")
        ? { expected: expectedWorkOrders.size, acceptedKeys: new Set(accepted.map(workOrderKey)).size, complete: new Set(accepted.map(workOrderKey)).size === expectedWorkOrders.size }
        : null,
    });
    console.log(`${definition.name} round ${round}: ${article.summary.accepted}/${article.summary.emitted} useful, ${article.telemetry.acceptedPerSecond.toFixed(2)} accepted/s, ${article.disposition}`);
  }
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const families = Object.fromEntries(definitions.map((definition) => {
  const rows = trials.filter((trial) => trial.family === definition.name);
  return [definition.name, {
    trials: rows.length,
    released: rows.filter((row) => row.article.disposition === "released").length,
    emitted: rows.reduce((sum, row) => sum + row.article.summary.emitted, 0),
    accepted: rows.reduce((sum, row) => sum + row.article.summary.accepted, 0),
    meanAcceptanceRate: Number(mean(rows.map((row) => row.article.summary.acceptanceRate)).toFixed(4)),
    meanAcceptedPerSecond: Number(mean(rows.map((row) => row.article.telemetry.acceptedPerSecond)).toFixed(2)),
    meanEndToEndCompletionTokensPerSecond: Number(mean(rows.map((row) => row.article.telemetry.completionTokensPerSecond)).toFixed(2)),
    completionCoverage: definition.name.startsWith("typed-expansion") ? rows.filter((row) => row.coverage.complete).length : null,
    envelopeStrips: rows.reduce((sum, row) => sum + row.production.repairs.filter((repair) => repair.endsWith("strip-non-json-envelope")).length, 0),
    structuralRepairs: rows.reduce((sum, row) => sum + row.production.repairs.filter((repair) => !repair.endsWith("strip-non-json-envelope")).length, 0),
  }];
}));
const summary = {
  rounds,
  model,
  families,
  totalArticles: trials.length,
  totalModelCalls: trials.reduce((sum, row) => sum + row.production.calls, 0),
  totalEmitted: trials.reduce((sum, row) => sum + row.article.summary.emitted, 0),
  totalAccepted: trials.reduce((sum, row) => sum + row.article.summary.accepted, 0),
  caveat: "Completion tokens/second is end-to-end request throughput including prefill and transport, not isolated decoder throughput. Synthetic exact oracles are test instruments; deterministically enumerable production work should remain deterministic.",
};
const report = {
  schema: "bantam.factory.diffusiongemma-output-foundry.v1",
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  config: { rounds, taskFamilies: definitions.map((row) => row.name) },
  summary,
  trials,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`output foundry evidence: ${output}`);
