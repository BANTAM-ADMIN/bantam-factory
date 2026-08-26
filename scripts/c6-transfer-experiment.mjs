#!/usr/bin/env node
// C6 — transfer and compounding. Does a proven station run a job it was not
// built for, and does reusing it cost less than building a new one?
//
// This is the thesis's real test. Every other rung asks whether the factory works
// on the job it was designed around; C6 asks whether anything accumulates. A
// station that must be rewritten for each new job is a pattern, not an asset.
//
// The station is `src/factory/stations/bounded-selection.js`, extracted from the
// operation exercised most on this branch. Its definition is code; a domain is
// data. That is the whole design: **if transfer required editing the station,
// transfer would have failed, and here that is structurally visible rather than a
// promise.** The station's content-addressed identity is compared across domains.
//
//   origin     JavaScript edge-case selection — what the station was built on
//   held-out   HTTP response-status selection — a domain with no shared
//              vocabulary, no shared catalog, and no shared fixtures
//   envelope   items deliberately outside the station's capability envelope,
//              run so that the failures are reported rather than avoided
//
//   node scripts/c6-transfer-experiment.mjs [--endpoint URL] [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  boundedSelectionCell,
  boundedSelectionDomain,
  boundedSelectionStationRef,
  gaugeSelection,
  recoverSelection,
  selectionPrompt,
  selectionSchema,
} from "../src/factory/stations/bounded-selection.js";
import { FactoryLineController } from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/c6-transfer.json");
const RUNS = path.join(OUT, "runs/c6-transfer");
const STATION_MODULE = "src/factory/stations/bounded-selection.js";

// The origin domain. The station has been run on this shape throughout the
// branch; it is here as the control that the extraction did not break anything.
const ORIGIN = boundedSelectionDomain({
  id: "javascript-edge-cases",
  answerKey: "edgeCaseId",
  instruction: "You are inspecting one JavaScript function for a single unhandled edge case.",
  catalog: [
    { id: "empty-input", description: "the input collection is empty" },
    { id: "zero-divisor", description: "a divisor is zero" },
    { id: "missing-key", description: "a looked-up key is absent" },
    { id: "negative-number", description: "a value is negative" },
  ],
  items: [
    { id: "mean", expected: "empty-input", body: "function mean(values) {\n  let total = 0;\n  for (const value of values) total += value;\n  return total / values.length;\n}" },
    { id: "perUnit", expected: "zero-divisor", body: "function perUnit(total, units) {\n  if (typeof units !== 'number') throw new TypeError('units must be a number');\n  return total / units;\n}" },
    { id: "settingOf", expected: "missing-key", body: "function settingOf(config, name) {\n  const entry = config[name];\n  return entry.value;\n}" },
    { id: "rootOf", expected: "negative-number", body: "function rootOf(value) {\n  if (typeof value !== 'number') throw new TypeError('value must be a number');\n  return Math.sqrt(value);\n}" },
  ],
});

// The held-out domain. Deliberately shares nothing with the origin: different
// subject matter, different catalog, different answer key, different item shape.
// If the station only works on JavaScript, this is where that shows.
const HELD_OUT = boundedSelectionDomain({
  id: "http-response-status",
  answerKey: "statusId",
  instruction: "You are choosing the single correct HTTP response status for one server situation.",
  catalog: [
    { id: "status-200", description: "the request succeeded and a body is returned" },
    { id: "status-201", description: "a new resource was created" },
    { id: "status-401", description: "the caller is not authenticated" },
    { id: "status-403", description: "the caller is authenticated but not permitted" },
    { id: "status-404", description: "the addressed resource does not exist" },
    { id: "status-409", description: "the request conflicts with the resource's current state" },
    { id: "status-429", description: "the caller has exceeded a rate limit" },
  ],
  items: [
    { id: "no-token", expected: "status-401", body: "A client calls GET /orders/17 with no Authorization header. The endpoint requires a bearer token." },
    { id: "wrong-role", expected: "status-403", body: "A client presents a valid bearer token for a reader account and calls DELETE /orders/17. Deletion requires an admin account." },
    { id: "absent-order", expected: "status-404", body: "An authenticated admin calls GET /orders/9999. No order with that identifier has ever existed." },
    { id: "created-order", expected: "status-201", body: "An authenticated client POSTs a valid order body to /orders. The server stores a new order and returns its location." },
    { id: "duplicate-submit", expected: "status-409", body: "An authenticated client POSTs an order carrying an idempotency key that was already used for a different order body." },
    { id: "too-many", expected: "status-429", body: "An authenticated client has made 400 requests this minute against a documented limit of 300 per minute." },
    { id: "plain-read", expected: "status-200", body: "An authenticated client calls GET /orders/17. The order exists and the client may read it." },
  ],
});

// Items the station is expected to fail. C6 requires failures outside the
// demonstrated envelope to be stated explicitly, so they are run rather than
// omitted: each is a situation whose correct answer is genuinely not in the
// catalog, and the station's only honest output is a wrong selection.
const ENVELOPE_PROBES = [
  { id: "gateway-timeout", body: "An authenticated client calls GET /orders/17. The upstream inventory service did not respond within the gateway's timeout." },
  { id: "unsupported-media", body: "An authenticated client POSTs an order body with Content-Type: application/xml. The endpoint accepts only application/json." },
];

async function ask(model, promptText, schema, maxTokens = 96) {
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
  const { parsed, repaired } = recoverSelection(envelope.choices?.[0]?.message?.content ?? "");
  return {
    parsed, repaired,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    completionTokens: envelope.usage?.completion_tokens ?? 0,
  };
}

// The unchanged station, executed through the real controller. Nothing in here
// is domain-aware; the domain arrives as data.
async function runArticle({ root, jobId, model, domain, item }) {
  const { registry, route, assets, gaugeRefFor } = boundedSelectionCell();
  const observed = { call: null, published: false };
  const result = await new FactoryLineController({
    root, jobId,
    task: domain.instruction,
    initialProductRevision: "artifact:issued",
    route, registry,
    authority: ["workspace.read"],
    adapters: {
      "tool.intake/v1": async () => ({ productRevision: "artifact:issued", outputs: { product: { itemId: item.id } } }),
      "model.select/v1": async () => {
        observed.call = await ask(model, selectionPrompt(domain, item), selectionSchema(domain));
        return {
          productRevision: `artifact:selected-${item.id}`,
          outputs: { product: { itemId: item.id, parsed: observed.call.parsed } },
        };
      },
      "tool.publish/v1": async (order) => {
        observed.published = true;
        return { productRevision: "artifact:published", outputs: { product: order.inputs[0].value } };
      },
    },
    gauges: new Map([
      [gaugeRefFor("intake"), async () => ({ status: "pass", evidence: [{ issued: item.id }] })],
      [gaugeRefFor("publish"), async () => ({ status: "pass", evidence: [{ published: true }] })],
      [gaugeRefFor("select"), async (inspection) => {
        const verdict = gaugeSelection({ domain, item, parsed: inspection.outputs[0].value.parsed });
        return verdict.pass
          ? { status: "pass", evidence: [{ chosen: verdict.chosen }] }
          : { status: "fail", evidence: [{ code: verdict.code, chosen: verdict.chosen, expected: item.expected }] };
      }],
    ]),
  }).run();

  const verdict = gaugeSelection({ domain, item, parsed: observed.call?.parsed ?? null });
  return {
    domain: domain.id, item: item.id, expected: item.expected,
    chosen: verdict.chosen, pass: verdict.pass, code: verdict.code,
    released: result.supervisor.status === "released",
    publishedDownstream: observed.published,
    repaired: observed.call?.repaired ?? false,
    elapsedMs: observed.call?.elapsedMs ?? null,
    completionTokens: observed.call?.completionTokens ?? 0,
  };
}

function countLines(relative) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8").split("\n").filter((line) => line.trim()).length;
}

// The changeover artefact: the domain declaration a new job must author. Counted
// from this file's own source so the figure cannot drift from what was really
// written.
function changeoverLines() {
  const source = fs.readFileSync(path.join(REPOSITORY_ROOT, "scripts/c6-transfer-experiment.mjs"), "utf8");
  const start = source.indexOf("const HELD_OUT = boundedSelectionDomain({");
  const end = source.indexOf("});", source.indexOf("items: [", start));
  return source.slice(start, end).split("\n").filter((line) => line.trim()).length;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 2 : Number(process.argv[flag + 1]);
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
    process.stderr.write(`c6-transfer: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  // Station identity, captured before any domain touches it.
  const refBefore = boundedSelectionStationRef();

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const domain of [ORIGIN, HELD_OUT]) {
      for (const item of domain.items) {
        articles.push(await runArticle({
          root: path.join(RUNS, domain.id), jobId: `c6-${domain.id}-${item.id}-${repetition}`,
          model, domain, item,
        }));
      }
    }
  }

  // Envelope probes: correct answers genuinely absent from the catalog.
  const envelopeResults = [];
  for (const probe of ENVELOPE_PROBES) {
    const call = await ask(model, selectionPrompt(HELD_OUT, { ...probe, expected: null }), selectionSchema(HELD_OUT));
    envelopeResults.push({
      item: probe.id,
      chosen: call.parsed?.[HELD_OUT.answerKey] ?? null,
      // There is no right answer in the catalog, so any selection is wrong and
      // the station cannot know it. This is the envelope, stated.
      outcome: "no catalogued correct answer; the station selects confidently and is wrong",
    });
  }

  const refAfter = boundedSelectionStationRef();
  const forDomain = (id) => articles.filter((article) => article.domain === id);
  const summarize = (id) => {
    const rows = forDomain(id);
    const passed = rows.filter((row) => row.pass).length;
    return {
      articles: rows.length,
      released: rows.filter((row) => row.released).length,
      correct: passed,
      recoveredYield: Number((passed / Math.max(1, rows.length)).toFixed(4)),
      firstPassYield: Number((rows.filter((row) => row.pass && !row.repaired).length / Math.max(1, rows.length)).toFixed(4)),
      envelopeRepairRate: Number((rows.filter((row) => row.repaired).length / Math.max(1, rows.length)).toFixed(4)),
      wrongReleased: rows.filter((row) => row.released && !row.pass).length,
      meanCompletionTokens: Number(mean(rows.map((row) => row.completionTokens)).toFixed(1)),
    };
  };

  const origin = summarize(ORIGIN.id);
  const heldOut = summarize(HELD_OUT.id);
  const changeover = changeoverLines();
  const rebuild = countLines(STATION_MODULE);

  const evidence = {
    schema: 1,
    kind: "bantam.factory-c6-transfer-evidence",
    generatedAt: new Date().toISOString(),
    sources: [STATION_MODULE, "scripts/c6-transfer-experiment.mjs", path.relative(REPOSITORY_ROOT, RUNS)],
    worker: { model, endpoint: ENDPOINT, temperature: 0, thinking: false },
    experiment: {
      station: STATION_MODULE,
      originDomain: ORIGIN.id,
      heldOutDomain: HELD_OUT.id,
      sharedVocabulary: "none — different subject matter, catalog, answer key, and item shape",
      repetitions,
    },
    station: {
      // The property that makes this a transfer rather than a rewrite.
      refUnchanged: refBefore === refAfter,
      ref: refAfter,
      note: "the station's content-addressed identity is computed from its route and station assets and excludes the domain; a domain that changed it would not be running the same station",
    },
    heldOut: {
      articles: heldOut.articles,
      correct: heldOut.correct,
      recoveredYield: heldOut.recoveredYield,
      firstPassYield: heldOut.firstPassYield,
      wrongReleased: heldOut.wrongReleased,
    },
    origin,
    changeover: {
      // Objective and reproducible: the domain declaration a new job authors.
      newSourceLines: changeover,
      // C6's bullet asks for minutes. An agent cannot produce an honest minutes
      // figure — my authoring time is not an engineer's, and I would be inventing
      // the number that decides my own rung. Left null deliberately; the unit is
      // a question for DESIGN, exactly as C0's overhead witness was.
      minutes: null,
      minutesNote: "deliberately unmeasured; see FABLE.md 22:14Z. Source lines are the objective substitute and the obligation stays unmet until DESIGN chooses the unit",
    },
    rebuild: {
      newSourceLines: rebuild,
      minutes: null,
      note: "what a new domain would have to author from scratch without the station: the station module itself — die, repair, gauge, route, and identity",
    },
    envelope: {
      failures: envelopeResults,
      note: "situations whose correct answer is absent from the catalog; the station selects confidently and is wrong, and cannot detect this itself. A closed catalog is a capability boundary, not a safety property.",
    },
    results: {
      engineeringReduced: changeover < rebuild,
      reductionRatio: Number((rebuild / Math.max(1, changeover)).toFixed(2)),
      transferred: heldOut.articles >= 5 && heldOut.recoveredYield > 0 && refBefore === refAfter,
    },
    articles,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  process.stdout.write([
    `C6 TRANSFER · station ${STATION_MODULE}`,
    "",
    `                        origin(${ORIGIN.id})   held-out(${HELD_OUT.id})`,
    `  articles              ${String(origin.articles).padEnd(22)} ${heldOut.articles}`,
    `  correct               ${String(origin.correct).padEnd(22)} ${heldOut.correct}`,
    `  recovered yield       ${String(origin.recoveredYield).padEnd(22)} ${heldOut.recoveredYield}`,
    `  first-pass yield      ${String(origin.firstPassYield).padEnd(22)} ${heldOut.firstPassYield}`,
    `  envelope repair rate  ${String(origin.envelopeRepairRate).padEnd(22)} ${heldOut.envelopeRepairRate}`,
    `  wrong released        ${String(origin.wrongReleased).padEnd(22)} ${heldOut.wrongReleased}`,
    "",
    `  station ref unchanged across domains: ${evidence.station.refUnchanged}`,
    `  changeover ${changeover} new source lines vs rebuild ${rebuild} — ${evidence.results.reductionRatio}x less`,
    `  envelope probes (no catalogued answer): ${envelopeResults.map((row) => `${row.item}->${row.chosen}`).join(", ")}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { ENVELOPE_PROBES, HELD_OUT, ORIGIN };
