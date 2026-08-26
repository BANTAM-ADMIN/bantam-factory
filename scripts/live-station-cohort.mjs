#!/usr/bin/env node
// A real model doing real work inside a real factory route.
//
// Every other experiment I have run on this branch used a deterministic worker
// or a scripted model, which is right for proving mechanism and wrong for the
// question "does this help an actual model do actual work". This one puts the
// live local model at a station inside the FactoryLineController, with a finite
// output die, bounded context, and an independent gauge that never asks the
// worker whether the worker succeeded.
//
// The job: given one JavaScript function, decide which single edge case from a
// closed, published catalog that function fails to handle. Chosen because the
// answer is one token from a finite set, the expected answer is preregistered
// per fixture, and a wrong-but-well-formed answer is a real defect rather than a
// parse error — so the gauge measures judgment, not formatting.
//
// Two arms, same model, same fixtures:
//
//   bare      the whole catalog and the function, one call, answer directly
//   stationed the same call inside a station whose gauge independently checks
//             the answer against the held-out expected id, with containment
//
// The comparison is deliberately NOT "the factory makes the model smarter" —
// same model, same prompt content. What the station adds is that a wrong answer
// is caught and contained instead of released, which is measurable as escape
// rate rather than as accuracy.
//
//   node scripts/live-station-cohort.mjs [--endpoint URL] [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { FactoryLineController, StationRegistry, gaugeRef } from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/live-station-cohort.json");
const RUNS = path.join(OUT, "runs/live-station-cohort");

// The closed catalog. The model may answer with exactly one of these ids.
const CATALOG = [
  { id: "empty-input", description: "the input collection is empty" },
  { id: "negative-number", description: "a value is negative" },
  { id: "zero-divisor", description: "a divisor is zero" },
  { id: "missing-key", description: "a looked-up key is absent" },
  { id: "non-numeric", description: "a value is not a number" },
  { id: "duplicate-entry", description: "the same entry appears twice" },
];

// Each fixture fails exactly one catalogued edge case. The expected id is held
// out from the worker and used only by the gauge.
const FIXTURES = [
  {
    id: "mean",
    expected: "empty-input",
    source: "function mean(values) {\n  let total = 0;\n  for (const value of values) total += value;\n  return total / values.length;\n}",
  },
  {
    id: "ratio",
    expected: "zero-divisor",
    source: "function ratio(a, b) {\n  if (typeof a !== 'number') throw new TypeError('a must be a number');\n  if (typeof b !== 'number') throw new TypeError('b must be a number');\n  return a / b;\n}",
  },
  {
    id: "lookup",
    expected: "missing-key",
    source: "function lookup(table, key) {\n  const row = table[key];\n  return row.value;\n}",
  },
  {
    id: "sqrtAll",
    expected: "negative-number",
    source: "function sqrtAll(values) {\n  if (values.length === 0) return [];\n  return values.map((value) => Math.sqrt(value));\n}",
  },
];

const ANSWER_SCHEMA = {
  type: "object",
  properties: { edgeCaseId: { type: "string", enum: CATALOG.map((entry) => entry.id) } },
  required: ["edgeCaseId"],
  additionalProperties: false,
};

function prompt(fixture) {
  return [
    "You are inspecting one JavaScript function for a single unhandled edge case.",
    "",
    "Catalog of edge cases (choose exactly one id):",
    ...CATALOG.map((entry) => `  ${entry.id} — ${entry.description}`),
    "",
    "Function:",
    "```js",
    fixture.source,
    "```",
    "",
    'Answer with JSON only: {"edgeCaseId":"<one id from the catalog>"}',
  ].join("\n");
}

// This worker emits its JSON inside a markdown fence. Stripping the fence is a
// named, bounded fitting: it removes syntax the die did not ask for and cannot
// change which id was selected. The raw emission is retained alongside, because
// a repair that is not visible is indistinguishable from a worker that never
// needed one. The first run of this cohort lacked this and scored 23/24 answers
// as null — a measurement of my adapter, not of the model.
function parseAnswer(content) {
  const direct = tryJson(content);
  if (direct) return { parsed: direct, repaired: false };
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(content);
  if (fence) {
    const inner = tryJson(fence[1]);
    if (inner) return { parsed: inner, repaired: true };
  }
  return { parsed: null, repaired: false };
}

function tryJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

async function ask(model, fixture) {
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt(fixture) }],
      temperature: 0,
      max_tokens: 96,
      chat_template_kwargs: { enable_thinking: false },
      guided_json: ANSWER_SCHEMA,
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";
  const { parsed, repaired } = parseAnswer(content);
  return {
    content,
    repaired,
    answer: typeof parsed?.edgeCaseId === "string" ? parsed.edgeCaseId : null,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
  };
}

function station({ id, adapter, inputs, kind = "tool" }) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id,
    version: 1,
    title: id.replaceAll("-", " "),
    purpose: `Perform the ${id} operation of the live inspection cell.`,
    worker: { kind, adapter },
    inputs,
    outputs: [{ name: "product", artifactType: "bantam.edge-selection/v1", required: true }],
    capabilities: [`factory.${id}`],
    authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "live-cell", icon: "station", color: "amber" },
  };
}

const PORT = [{ name: "product", artifactType: "bantam.edge-selection/v1", required: true }];

function cell() {
  const registry = new StationRegistry();
  const intake = registry.install(station({ id: "intake", adapter: "tool.intake/v1", inputs: [] }));
  const select = registry.install(station({ id: "select-edge", adapter: "model.select/v1", inputs: PORT, kind: "model" }));
  const consume = registry.install(station({ id: "publish", adapter: "tool.publish/v1", inputs: PORT }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "live-inspection-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "select", station: select.ref },
      { id: "publish", station: consume.ref },
    ],
    edges: [
      { from: "intake", out: "product", to: "select", in: "product" },
      { from: "select", out: "product", to: "publish", in: "product" },
    ],
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: { intake, select, publish: consume } };
}

async function runStationed({ root, jobId, model, fixture }) {
  const { registry, route, assets } = cell();
  const observed = { call: null, published: false };
  const result = await new FactoryLineController({
    root,
    jobId,
    task: "Select the unhandled edge case.",
    initialProductRevision: "artifact:fixture",
    route,
    registry,
    authority: ["workspace.read"],
    adapters: {
      "tool.intake/v1": async () => ({
        productRevision: "artifact:fixture",
        // Bounded kit: the worker sees the function and the catalog, never the
        // expected answer.
        outputs: { product: { fixtureId: fixture.id, source: fixture.source } },
      }),
      "model.select/v1": async () => {
        observed.call = await ask(model, fixture);
        return {
          productRevision: `artifact:selection-${observed.call.answer ?? "malformed"}`,
          outputs: { product: { fixtureId: fixture.id, edgeCaseId: observed.call.answer } },
        };
      },
      "tool.publish/v1": async (order) => {
        observed.published = true;
        return { productRevision: "artifact:published", outputs: { product: order.inputs[0].value } };
      },
    },
    gauges: new Map([
      [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ admitted: true }] })],
      [gaugeRef(assets.publish), async () => ({ status: "pass", evidence: [{ published: true }] })],
      [gaugeRef(assets.select), async (inspection) => {
        // The independent gauge. It holds the expected id, which the worker
        // never saw, and it checks the product rather than asking the worker.
        const chosen = inspection.outputs[0].value.edgeCaseId;
        if (chosen === null) return { status: "fail", evidence: [{ reason: "malformed selection" }] };
        if (!CATALOG.some((entry) => entry.id === chosen)) return { status: "fail", evidence: [{ reason: "unknown id", chosen }] };
        if (chosen !== fixture.expected) return { status: "fail", evidence: [{ reason: "wrong edge case", chosen, expected: fixture.expected }] };
        return { status: "pass", evidence: [{ chosen }] };
      }],
    ]),
  }).run();

  return {
    arm: "stationed",
    fixture: fixture.id,
    expected: fixture.expected,
    answer: observed.call?.answer ?? null,
    correct: observed.call?.answer === fixture.expected,
    status: result.supervisor.status,
    released: result.supervisor.status === "released",
    publishedDownstream: observed.published,
    repaired: observed.call?.repaired ?? false,
    elapsedMs: observed.call?.elapsedMs ?? null,
    promptTokens: observed.call?.promptTokens ?? 0,
    completionTokens: observed.call?.completionTokens ?? 0,
  };
}

async function runBare({ model, fixture }) {
  const call = await ask(model, fixture);
  return {
    arm: "bare",
    fixture: fixture.id,
    expected: fixture.expected,
    answer: call.answer,
    correct: call.answer === fixture.expected,
    // Nothing checks a bare answer, so every well-formed answer is "released"
    // and a wrong one is published downstream.
    status: "released",
    released: true,
    publishedDownstream: true,
    repaired: call.repaired,
    elapsedMs: call.elapsedMs,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
  };
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 3 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }

  let model;
  try {
    const listed = await (await fetch(MODELS_URL)).json();
    model = listed.data?.[0]?.id;
    if (!model) throw new Error("no model served");
  } catch (error) {
    process.stderr.write(`live-station-cohort: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const fixture of FIXTURES) {
      // Order alternates so neither arm systematically warms the cache.
      const order = (repetition + FIXTURES.indexOf(fixture)) % 2 === 0 ? ["bare", "stationed"] : ["stationed", "bare"];
      for (const arm of order) {
        articles.push(arm === "bare"
          ? await runBare({ model, fixture })
          : await runStationed({ root: path.join(RUNS, "stationed"), jobId: `live-${fixture.id}-${repetition}`, model, fixture }));
      }
    }
  }

  const arm = (name) => articles.filter((article) => article.arm === name);
  const summarize = (name) => {
    const rows = arm(name);
    const wrong = rows.filter((row) => !row.correct);
    return {
      articles: rows.length,
      correct: rows.filter((row) => row.correct).length,
      wrong: wrong.length,
      // The number that matters: wrong answers that reached downstream.
      wrongReleased: rows.filter((row) => !row.correct && row.publishedDownstream).length,
      contained: rows.filter((row) => !row.released).length,
      falseStops: rows.filter((row) => row.correct && !row.released).length,
      meanElapsedMs: Number((rows.reduce((total, row) => total + (row.elapsedMs ?? 0), 0) / (rows.length || 1)).toFixed(2)),
      repairedEmissions: rows.filter((row) => row.repaired).length,
      meanCompletionTokens: Number((rows.reduce((total, row) => total + row.completionTokens, 0) / (rows.length || 1)).toFixed(2)),
    };
  };

  const evidence = {
    schema: 1,
    kind: "bantam.factory-live-station-evidence",
    generatedAt: new Date().toISOString(),
    sources: [path.relative(REPOSITORY_ROOT, RUNS), "scripts/live-station-cohort.mjs"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, guidedJson: true, thinking: false },
    experiment: {
      job: "select the single unhandled edge case from a closed catalog",
      fixtures: FIXTURES.map((fixture) => ({ id: fixture.id, expected: fixture.expected })),
      catalogSize: CATALOG.length,
      repetitions,
      arms: {
        bare: "one model call, answer released unchecked",
        stationed: "the same call inside a route whose independent gauge holds the expected id and contains a wrong answer",
      },
      note: "same model and same prompt in both arms; the station adds inspection, not intelligence",
    },
    summary: { bare: summarize("bare"), stationed: summarize("stationed") },
    articles,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const b = evidence.summary.bare;
  const s = evidence.summary.stationed;
  process.stdout.write([
    `LIVE STATION COHORT · ${b.articles} articles per arm · ${model}`,
    "",
    `                                bare      stationed`,
    `  correct answers               ${String(b.correct).padEnd(9)} ${s.correct}  / ${b.articles}`,
    `  wrong answers                 ${String(b.wrong).padEnd(9)} ${s.wrong}`,
    `  wrong answers released        ${String(b.wrongReleased).padEnd(9)} ${s.wrongReleased}`,
    `  contained before downstream   ${String(b.contained).padEnd(9)} ${s.contained}`,
    `  false stops on correct work   ${String(b.falseStops).padEnd(9)} ${s.falseStops}`,
    `  mean latency (ms)             ${String(b.meanElapsedMs).padEnd(9)} ${s.meanElapsedMs}`,
    "",
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));

  return 0;
}

// Importable so the output-die repair can be tested without a live worker.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { CATALOG, FIXTURES, parseAnswer };
