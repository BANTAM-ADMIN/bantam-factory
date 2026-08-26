#!/usr/bin/env node
// The thesis, on a live worker: a job the model fails whole and completes split.
//
// Everything before this measured mechanism. This measures the claim the branch
// exists for — that decomposing a job changes what a given model can actually
// deliver. Same model, same catalog, same functions, same total information.
// The only difference is whether the job arrives as one obligation or six.
//
//   monolith    one call: map all six functions to their edge cases at once
//   decomposed  six stations, one function each, independently gauged, then a
//               deterministic assembler joins the released selections
//
// The product is the complete mapping, and it is scored whole: five right out of
// six is a failed job, because a release manifest with one wrong row is wrong.
// That is what makes this a job-level result rather than an accuracy average.
//
//   node scripts/live-decomposition-cohort.mjs [--endpoint URL] [--repetitions N]

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
const EVIDENCE = path.join(OUT, "evidence/live-decomposition.json");
const RUNS = path.join(OUT, "runs/live-decomposition");

const CATALOG = [
  { id: "empty-input", description: "the input collection is empty" },
  { id: "negative-number", description: "a value is negative" },
  { id: "zero-divisor", description: "a divisor is zero" },
  { id: "missing-key", description: "a looked-up key is absent" },
  { id: "non-numeric", description: "a value is not a number" },
  { id: "duplicate-entry", description: "the same entry appears twice" },
];

const FIXTURES = [
  { id: "mean", expected: "empty-input", source: "function mean(values) {\n  let total = 0;\n  for (const value of values) total += value;\n  return total / values.length;\n}" },
  { id: "ratio", expected: "zero-divisor", source: "function ratio(a, b) {\n  if (typeof a !== 'number') throw new TypeError('a must be a number');\n  if (typeof b !== 'number') throw new TypeError('b must be a number');\n  return a / b;\n}" },
  { id: "lookup", expected: "missing-key", source: "function lookup(table, key) {\n  const row = table[key];\n  return row.value;\n}" },
  { id: "sqrtAll", expected: "negative-number", source: "function sqrtAll(values) {\n  if (values.length === 0) return [];\n  return values.map((value) => Math.sqrt(value));\n}" },
  // Every other fixture excludes the alternatives by guarding them. This one
  // originally did not: `row.amount` fails for a MISSING key just as much as for
  // a non-numeric one, so the worker answering `missing-key` was defensible and
  // the fixture was the defect. The comment pins the key as always present, so
  // exactly one catalog entry fits.
  { id: "sumParsed", expected: "non-numeric", source: "function sumParsed(rows) {\n  // Each row comes from the CSV reader, so `amount` is always present\n  // and is always a string such as \"12.50\".\n  if (rows.length === 0) return 0;\n  return rows.reduce((total, row) => total + row.amount, 0);\n}" },
  { id: "register", expected: "duplicate-entry", source: "function register(seen, name) {\n  if (typeof name !== 'string') throw new TypeError('name must be a string');\n  seen.push(name);\n  return seen.length;\n}" },
];

const IDS = CATALOG.map((entry) => entry.id);
const ONE_SCHEMA = {
  type: "object",
  properties: { edgeCaseId: { type: "string", enum: IDS } },
  required: ["edgeCaseId"],
  additionalProperties: false,
};
const ALL_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FIXTURES.map((fixture) => [fixture.id, { type: "string", enum: IDS }])),
  required: FIXTURES.map((fixture) => fixture.id),
  additionalProperties: false,
};

// Station ids are lowercase-kebab by contract; fixture ids are camelCase.
const slug = (id) => id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const catalogLines = CATALOG.map((entry) => `  ${entry.id} — ${entry.description}`);

// One obligation, but the sibling functions are present as context. This is the
// arm that separates "splitting the job" from "starving the station": same
// single answer, same information as the monolith.
function kittedPrompt(fixture) {
  return [
    "You are inspecting one JavaScript function for a single unhandled edge case.",
    "",
    "Catalog of edge cases (choose exactly one id):",
    ...catalogLines,
    "",
    "Related functions in the same job, for context only — do not answer about these:",
    ...FIXTURES.filter((other) => other.id !== fixture.id).flatMap((other) => ["```js", other.source, "```"]),
    "",
    `Answer about this function only (${fixture.id}):`,
    "```js", fixture.source, "```",
    "",
    'Answer with JSON only: {"edgeCaseId":"<one id from the catalog>"}',
  ].join("\n");
}

// One obligation, plus the selections the line has already released upstream.
// This is information the factory legitimately holds — it flows along the
// conveyor — and it is the only arm that can restore a constraint living
// between answers rather than inside any one function.
function sequencedPrompt(fixture, priorSelections) {
  const taken = Object.entries(priorSelections).filter(([, id]) => typeof id === "string");
  return [
    "You are inspecting one JavaScript function for a single unhandled edge case.",
    "",
    "Catalog of edge cases (choose exactly one id):",
    ...catalogLines,
    "",
    ...(taken.length
      ? ["Already released for other functions in this job:", ...taken.map(([name, id]) => `  ${name} -> ${id}`), ""]
      : []),
    "Function:",
    "```js", fixture.source, "```",
    "",
    'Answer with JSON only: {"edgeCaseId":"<one id from the catalog>"}',
  ].join("\n");
}

function onePrompt(fixture) {
  return [
    "You are inspecting one JavaScript function for a single unhandled edge case.",
    "",
    "Catalog of edge cases (choose exactly one id):",
    ...catalogLines,
    "",
    "Function:",
    "```js", fixture.source, "```",
    "",
    'Answer with JSON only: {"edgeCaseId":"<one id from the catalog>"}',
  ].join("\n");
}

function allPrompt() {
  return [
    "You are inspecting six JavaScript functions. For each one, decide which single",
    "edge case from the catalog it fails to handle.",
    "",
    "Catalog of edge cases (choose exactly one id per function):",
    ...catalogLines,
    "",
    ...FIXTURES.flatMap((fixture) => [`Function ${fixture.id}:`, "```js", fixture.source, "```", ""]),
    "Answer with JSON only, one key per function:",
    `{${FIXTURES.map((fixture) => `"${fixture.id}":"<id>"`).join(",")}}`,
  ].join("\n");
}

// The same named fitting the single-obligation cohort needed: this worker fences
// its JSON. It strips only the fence and cannot change a selection.
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

async function ask(model, promptText, schema, maxTokens) {
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: promptText }],
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
      guided_json: schema,
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";
  const { parsed, repaired } = parseAnswer(content);
  return {
    parsed,
    repaired,
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
    purpose: `Perform the ${id} operation.`,
    worker: { kind, adapter },
    inputs,
    outputs: [{ name: "product", artifactType: "bantam.edge-map/v1", required: true }],
    capabilities: [`factory.${id}`],
    authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "live-decomposition", icon: "station", color: "amber" },
  };
}

const PORT = [{ name: "product", artifactType: "bantam.edge-map/v1", required: true }];

// Six inspection stations in series, then a deterministic assembler. Each
// inspection station receives exactly one function; none of them ever sees the
// whole job.
function decomposedCell() {
  const registry = new StationRegistry();
  const installed = { intake: registry.install(station({ id: "intake", adapter: "tool.intake/v1", inputs: [] })) };
  for (const fixture of FIXTURES) {
    installed[slug(fixture.id)] = registry.install(station({ id: `inspect-${slug(fixture.id)}`, adapter: `model.inspect.${slug(fixture.id)}/v1`, inputs: PORT, kind: "model" }));
  }
  installed.assemble = registry.install(station({ id: "assemble", adapter: "tool.assemble/v1", inputs: PORT }));
  const order = ["intake", ...FIXTURES.map((fixture) => slug(fixture.id)), "assemble"];
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "live-decomposition-cell",
    stations: order.map((name) => ({ id: name, station: installed[name].ref })),
    edges: order.slice(0, -1).map((name, index) => ({ from: name, out: "product", to: order[index + 1], in: "product" })),
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: installed };
}

async function runDecomposed({ root, jobId, model, mode = "isolated" }) {
  const { registry, route, assets } = decomposedCell();
  const calls = [];
  const issued = [];

  const adapters = {
    "tool.intake/v1": async () => ({ productRevision: "artifact:kit", outputs: { product: { selections: {} } } }),
    "tool.assemble/v1": async (order) => ({
      productRevision: "artifact:mapping",
      outputs: { product: { selections: { ...order.inputs[0].value.selections } } },
    }),
  };
  for (const fixture of FIXTURES) {
    adapters[`model.inspect.${slug(fixture.id)}/v1`] = async (order) => {
      // The kit this station is issued. Recorded so the no-silent-delegation
      // property can be checked rather than asserted: one function, never six.
      const prior = order.inputs[0].value.selections;
      const kit = mode === "kitted" ? kittedPrompt(fixture)
        : mode === "sequenced" ? sequencedPrompt(fixture, prior)
        : onePrompt(fixture);
      issued.push({ station: fixture.id, kitChars: kit.length, functionsInKit: FIXTURES.filter((other) => kit.includes(other.source)).length });
      const call = await ask(model, kit, ONE_SCHEMA, 96);
      calls.push({ station: fixture.id, ...call, answer: call.parsed?.edgeCaseId ?? null });
      return {
        productRevision: `artifact:selection-${fixture.id}`,
        outputs: { product: { selections: { ...order.inputs[0].value.selections, [fixture.id]: call.parsed?.edgeCaseId ?? null } } },
      };
    };
  }

  const pass = async () => ({ status: "pass", evidence: [{ ok: true }] });
  const gauges = new Map([
    [gaugeRef(assets.intake), pass],
    [gaugeRef(assets.assemble), pass],
    ...FIXTURES.map((fixture) => [gaugeRef(assets[slug(fixture.id)]), async (inspection) => {
      // Independent, station-local, and holding only this station's expected id.
      const chosen = inspection.outputs[0].value.selections[fixture.id];
      if (chosen === null || !IDS.includes(chosen)) return { status: "fail", evidence: [{ reason: "malformed or unknown", chosen }] };
      if (chosen !== fixture.expected) return { status: "fail", evidence: [{ reason: "wrong edge case", chosen, expected: fixture.expected }] };
      return { status: "pass", evidence: [{ chosen }] };
    }]),
  ]);

  const started = process.hrtime.bigint();
  const result = await new FactoryLineController({
    root, jobId, task: "Map every function to its unhandled edge case.",
    initialProductRevision: "artifact:kit", route, registry,
    authority: ["workspace.read"], adapters, gauges,
  }).run();
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  const selections = Object.fromEntries(calls.map((call) => [call.station, call.answer]));
  const correctRows = FIXTURES.filter((fixture) => selections[fixture.id] === fixture.expected).length;
  // The line stops at the first failed gauge, so it attempts fewer rows than the
  // monolith. Comparing raw correct-row counts across arms would credit the
  // monolith for rows the line was never allowed to reach.
  const attemptedRows = calls.length;
  return {
    arm: mode === "isolated" ? "decomposed" : mode,
    released: result.supervisor.status === "released",
    // A released product must be a complete, entirely correct mapping.
    jobCorrect: result.supervisor.status === "released" && correctRows === FIXTURES.length,
    correctRows,
    attemptedRows,
    rows: FIXTURES.length,
    selections,
    firstAbnormal: result.supervisor.firstAbnormal?.detectedAtStation ?? null,
    stationsRun: calls.length,
    issued,
    repairedEmissions: calls.filter((call) => call.repaired).length,
    wallMs: Number(wallMs.toFixed(2)),
    promptTokens: calls.reduce((total, call) => total + call.promptTokens, 0),
    completionTokens: calls.reduce((total, call) => total + call.completionTokens, 0),
  };
}

async function runMonolith({ model }) {
  const started = process.hrtime.bigint();
  const call = await ask(model, allPrompt(), ALL_SCHEMA, 640);
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const selections = Object.fromEntries(FIXTURES.map((fixture) => [fixture.id, call.parsed?.[fixture.id] ?? null]));
  const correctRows = FIXTURES.filter((fixture) => selections[fixture.id] === fixture.expected).length;
  const attemptedRows = call.parsed === null ? 0 : FIXTURES.length;
  return {
    arm: "monolith",
    // Nothing inspects a monolithic answer, so it is released as produced.
    released: true,
    jobCorrect: correctRows === FIXTURES.length,
    correctRows,
    attemptedRows,
    malformed: call.parsed === null,
    rows: FIXTURES.length,
    selections,
    firstAbnormal: null,
    stationsRun: 1,
    issued: [{ station: "monolith", kitChars: allPrompt().length, functionsInKit: FIXTURES.length }],
    repairedEmissions: call.repaired ? 1 : 0,
    wallMs: Number(wallMs.toFixed(2)),
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 5 : Number(process.argv[flag + 1]);
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
    process.stderr.write(`live-decomposition-cohort: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  const articles = [];
  for (let index = 1; index <= repetitions; index += 1) {
    const order = index % 2 === 1
      ? ["monolith", "decomposed", "kitted", "sequenced"]
      : ["sequenced", "kitted", "decomposed", "monolith"];
    for (const armName of order) {
      if (armName === "monolith") articles.push(await runMonolith({ model }));
      else articles.push(await runDecomposed({
        root: path.join(RUNS, armName),
        jobId: `live-${armName}-${index}`,
        model,
        mode: armName === "decomposed" ? "isolated" : armName,
      }));
    }
  }

  const arm = (name) => articles.filter((article) => article.arm === name);
  const summarize = (name) => {
    const rows = arm(name);
    return {
      articles: rows.length,
      jobsCorrect: rows.filter((row) => row.jobCorrect).length,
      jobsReleased: rows.filter((row) => row.released).length,
      // A released job that is wrong is the failure that matters.
      wrongJobsReleased: rows.filter((row) => row.released && !row.jobCorrect).length,
      meanCorrectRows: Number(mean(rows.map((row) => row.correctRows)).toFixed(3)),
      // The comparable figure: of the rows an arm actually produced, how many
      // were right.
      rowsAttempted: rows.reduce((total, row) => total + row.attemptedRows, 0),
      rowsCorrect: rows.reduce((total, row) => total + row.correctRows, 0),
      perRowAccuracy: Number((rows.reduce((total, row) => total + row.correctRows, 0) / Math.max(1, rows.reduce((total, row) => total + row.attemptedRows, 0))).toFixed(4)),
      malformedArticles: rows.filter((row) => row.malformed).length,
      rowsPerJob: FIXTURES.length,
      meanWallMs: Number(mean(rows.map((row) => row.wallMs)).toFixed(2)),
      meanPromptTokens: Number(mean(rows.map((row) => row.promptTokens)).toFixed(1)),
      meanCompletionTokens: Number(mean(rows.map((row) => row.completionTokens)).toFixed(1)),
      repairedEmissions: rows.reduce((total, row) => total + row.repairedEmissions, 0),
    };
  };

  // no-silent-delegation, checked rather than believed: no station in the
  // decomposed arm may be issued more than one function.
  const decomposedKits = arm("decomposed").flatMap((article) => article.issued);
  const maxFunctionsInAnyStationKit = decomposedKits.reduce((most, kit) => Math.max(most, kit.functionsInKit), 0);

  const evidence = {
    schema: 1,
    kind: "bantam.factory-live-decomposition-evidence",
    generatedAt: new Date().toISOString(),
    sources: [path.relative(REPOSITORY_ROOT, RUNS), "scripts/live-decomposition-cohort.mjs"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, guidedJson: true, thinking: false },
    experiment: {
      job: "map six JavaScript functions to their unhandled edge cases; the product is the complete mapping",
      scoring: "job-level: every row must be right, because a mapping with one wrong row is a wrong mapping",
      arms: {
        monolith: "one call carrying all six functions and the catalog",
        decomposed: "six stations, one function each, independently gauged, then a deterministic assembler",
        kitted: "the same six stations, each still answering about one function, but issued the sibling functions as context",
      },
      informationParity: "both arms receive the same catalog and the same six functions in total",
      repetitions,
    },
    summary: { monolith: summarize("monolith"), decomposed: summarize("decomposed"), kitted: summarize("kitted"), sequenced: summarize("sequenced") },
    delegation: {
      // C4's no-silent-delegation obligation, as a measurement.
      maxFunctionsInAnyStationKit,
      stationKits: decomposedKits.length,
      noStationReceivedTheWholeJob: maxFunctionsInAnyStationKit === 1,
    },
    articles,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const m = evidence.summary.monolith;
  const d = evidence.summary.decomposed;
  const k = evidence.summary.kitted;
  const q = evidence.summary.sequenced;
  const col = (v) => String(v).padEnd(11);
  const arms = [["monolith", m], ["decomposed", d], ["kitted", k], ["sequenced", q]];
  process.stdout.write([
    `LIVE DECOMPOSITION COHORT · ${repetitions} per arm · ${model}`,
    "",
    `                                   ${arms.map(([name]) => col(name)).join("")}`,
    `  complete mappings correct (of ${repetitions})  ${arms.map(([, a]) => col(a.jobsCorrect)).join("")}`,
    `  per-row accuracy on rows tried   ${arms.map(([, a]) => col(a.perRowAccuracy)).join("")}`,
    `  rows attempted                   ${arms.map(([, a]) => col(a.rowsAttempted)).join("")}`,
    `  malformed articles               ${arms.map(([, a]) => col(a.malformedArticles ?? 0)).join("")}`,
    `  wrong mappings released          ${arms.map(([, a]) => col(a.wrongJobsReleased)).join("")}`,
    `  mean prompt tokens               ${arms.map(([, a]) => col(a.meanPromptTokens)).join("")}`,
    `  mean wall time (ms)              ${arms.map(([, a]) => col(a.meanWallMs)).join("")}`,
    "",
    `  no station received the whole job: ${evidence.delegation.noStationReceivedTheWholeJob} (max ${maxFunctionsInAnyStationKit} function per kit)`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { CATALOG, FIXTURES, allPrompt, onePrompt, parseAnswer };
