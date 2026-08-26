#!/usr/bin/env node
// Run the die-binding gauge against a live endpoint.
//
// Decisive by construction: the die permits only a sentinel, the prompt demands
// a different obvious answer, and whichever wins tells you whether the sampler
// is enforcing. The `none` row is the control — if it does not follow the prompt,
// the probe is broken and no other row means anything.
//
//   node scripts/die-binding-probe.mjs [--endpoint URL] [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { classifyDieBindingHttpFailure, dieBindingRequest, dieBindingVerdict, readDieBinding } from "../src/factory/die-binding-gauge.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const EVIDENCE = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"), "evidence/die-binding.json");
// Current vLLM, removed legacy vLLM, and llama.cpp mechanisms are all probed.
// Seeing the mechanisms separately distinguishes removal/dialect mismatch from
// enforcement failure and from a serving crash.
const CONSTRAINTS = [
  "none",
  "structured_json", "structured_grammar", "structured_choice", "structured_regex",
  "guided_json", "guided_grammar", "guided_choice", "guided_regex",
  "grammar", "response_format_schema", "json_schema",
  "prefill",
];

async function probe(model, constraint) {
  const body = dieBindingRequest({ model, constraint });
  const started = performance.now();
  let response;
  try {
    response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    return { constraint, transport: "error", httpStatus: null, bound: false, verdict: "transport-error", detail: error.message, ms: 0 };
  }
  const raw = await response.text();
  const ms = Math.round(performance.now() - started);
  if (!response.ok) {
    const failure = classifyDieBindingHttpFailure(response.status);
    return { constraint, ...failure, httpStatus: response.status, bound: false, detail: raw.slice(0, 160), ms };
  }
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";
  return { constraint, transport: "accepted", httpStatus: 200, ms, ...readDieBinding({ constraint, content }) };
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 3 : Number(process.argv[flag + 1]);
  let model;
  try {
    const listed = await (await fetch(MODELS_URL)).json();
    // vLLM returns {data:[...]}, llama.cpp returns {models:[...]}. Assuming one
    // shape is how I mistook a loaded server for a failed launch.
    model = listed.data?.[0]?.id ?? listed.models?.[0]?.model ?? listed.models?.[0]?.name;
    if (!model) throw new Error("no model served");
  } catch (error) {
    process.stderr.write(`die-binding: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`endpoint: ${ENDPOINT}\nmodel: ${model}\n\n`);

  const readings = [];
  for (let r = 0; r < repetitions; r += 1) for (const constraint of CONSTRAINTS) readings.push(await probe(model, constraint));
  const verdict = dieBindingVerdict(readings);

  const evidence = {
    schema: 1, kind: "bantam.factory-die-binding-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/die-binding-probe.mjs", "src/factory/die-binding-gauge.js"],
    endpoint: ENDPOINT, model, repetitions,
    method: "the die permits only a sentinel and the prompt demands a different obvious answer; only unanimous sentinel membership under a passing no-die control establishes enforcement",
    verdict, readings,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  process.stdout.write(`  ${"constraint".padEnd(16)} ${"http".padEnd(6)} ${"binding".padEnd(13)} verdicts\n`);
  for (const row of verdict.mechanisms) {
    const http = readings.find((x) => x.constraint === row.constraint)?.transport ?? "-";
    process.stdout.write(`  ${row.constraint.padEnd(16)} ${http.padEnd(6)} ${row.binding.padEnd(13)} ${row.verdicts.join(", ")}\n`);
  }
  process.stdout.write(`\n  control (no die): follows the prompt in ${Math.round(verdict.controlPassRate * verdict.controlTrials)}/${verdict.controlTrials} trials (${(verdict.controlPassRate * 100).toFixed(0)}%)\n`);
  process.stdout.write(`  probe valid: ${verdict.probeValid}   any mechanism binds: ${verdict.anyBound}   dieBound: ${verdict.dieBound}\n`);
  process.stdout.write(`  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}\n\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) process.exit(await main());
