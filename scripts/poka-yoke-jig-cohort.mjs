#!/usr/bin/env node
// Poka-yoke: correct the process that allowed the mistake.
//
// D18 measured that this worker emits a fenced JSON envelope on ~90% of calls
// even though a constrained decoder is requested. The branch's response — mine —
// was a named repair that strips the fence afterwards. That is inspection. The
// Ford line's actual lesson is the other thing: you do not teach the worker to
// drill straighter, you bolt on a fixture that makes the wrong hole impossible.
//
// The fixture here is one line. Prefill the assistant turn with the opening of
// the answer, so the worker's first token is already inside the JSON string and
// a fence cannot be emitted:
//
//   repair arm   worker writes  ```json\n{"edgeCaseId":"empty-input"}\n```
//   jig arm      worker writes  empty-input"}
//
// Two arms, same worker, same items, same catalog, same held-out gauge,
// order-balanced. The only difference is whether the wrong output is possible.
//
//   node scripts/poka-yoke-jig-cohort.mjs [--endpoint URL] [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  boundedSelectionDomain,
  gaugeSelection,
  readJiggedSelection,
  recoverSelection,
  selectionPrefill,
  selectionPrompt,
  selectionSchema,
} from "../src/factory/stations/bounded-selection.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/poka-yoke-jig.json");

const DOMAIN = boundedSelectionDomain({
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

// Three arms, not two. Opus-2's caveat 2: the first cut of this cohort deleted
// guided_json in the jig arm, so it compared "guided + fence-strip" against
// "prefill, no guided" — two variables moving at once. Guided decoding carries
// real per-token masking cost, so part of the saving may have come from
// switching off a decoder D18 already proved was not binding. The third arm
// holds the decoder constant and isolates the fixture.
async function call(model, item, { jig, guided = true }) {
  const prompt = selectionPrompt(DOMAIN, item);
  const messages = [{ role: "user", content: prompt }];
  const body = {
    model,
    temperature: 0,
    max_tokens: 64,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (guided) body.guided_json = selectionSchema(DOMAIN);
  if (jig) {
    // The fixture. The worker resumes an answer already opened for it.
    messages.push({ role: "assistant", content: selectionPrefill(DOMAIN) });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  }
  body.messages = messages;

  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";
  const read = jig ? readJiggedSelection(DOMAIN, content) : recoverSelection(content);
  return {
    content,
    parsed: read.parsed,
    repaired: read.repaired,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    // Caveat 3: the prefill moves the answer's opening from the completion side
    // to the prompt side. Those tokens did not vanish, they changed column, and
    // reporting only completion tokens overstates the saving.
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 4 : Number(process.argv[flag + 1]);
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
    process.stderr.write(`poka-yoke: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const [position, item] of DOMAIN.items.entries()) {
      const arms = [
        { name: "repair", jig: false, guided: true },
        { name: "jig", jig: true, guided: false },
        { name: "jig-guided", jig: true, guided: true },
      ];
      const order = (position + repetition) % 2 === 0 ? arms : [...arms].reverse();
      for (const arm of order) {
        const result = await call(model, item, arm);
        const verdict = gaugeSelection({ domain: DOMAIN, item, parsed: result.parsed });
        articles.push({
          arm: arm.name,
          item: item.id, expected: item.expected,
          chosen: verdict.chosen, pass: verdict.pass, code: verdict.code,
          repaired: result.repaired,
          // First pass means the raw emission was usable with no fitting at all.
          firstPass: verdict.pass && !result.repaired,
          completionTokens: result.completionTokens,
          promptTokens: result.promptTokens,
          totalTokens: result.completionTokens + result.promptTokens,
          elapsedMs: result.elapsedMs,
        });
      }
    }
  }

  const summarize = (name) => {
    const rows = articles.filter((article) => article.arm === name);
    return {
      articles: rows.length,
      firstPassYield: Number((rows.filter((row) => row.firstPass).length / rows.length).toFixed(4)),
      recoveredYield: Number((rows.filter((row) => row.pass).length / rows.length).toFixed(4)),
      envelopeRepairRate: Number((rows.filter((row) => row.repaired).length / rows.length).toFixed(4)),
      malformed: rows.filter((row) => row.code === "malformed").length,
      meanCompletionTokens: Number(mean(rows.map((row) => row.completionTokens)).toFixed(2)),
      meanPromptTokens: Number(mean(rows.map((row) => row.promptTokens)).toFixed(2)),
      meanTotalTokens: Number(mean(rows.map((row) => row.totalTokens)).toFixed(2)),
      meanElapsedMs: Number(mean(rows.map((row) => row.elapsedMs)).toFixed(2)),
    };
  };

  const repair = summarize("repair");
  const jig = summarize("jig");
  const jigGuided = summarize("jig-guided");
  const evidence = {
    schema: 1,
    kind: "bantam.factory-poka-yoke-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/poka-yoke-jig-cohort.mjs", "src/factory/stations/bounded-selection.js"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, thinking: false },
    experiment: {
      defect: "the worker emits a fenced JSON envelope the die did not ask for (D18)",
      repairArm: "ask for JSON, strip the fence afterwards — inspection",
      jigArm: "prefill the assistant turn with the opening of the answer so a fence cannot be emitted — mistake-proofing",
      itemsPerRepetition: DOMAIN.items.length,
      repetitions,
      ordering: "arm order alternates by item and repetition",
    },
    results: {
      repair, jig, jigGuided,
      firstPassGain: Number((jig.firstPassYield - repair.firstPassYield).toFixed(4)),
      repairRateRemoved: Number((repair.envelopeRepairRate - jig.envelopeRepairRate).toFixed(4)),
      completionTokenRatio: Number((jig.meanCompletionTokens / Math.max(0.01, repair.meanCompletionTokens)).toFixed(3)),
      // The claim: the defect stopped being possible, not merely stopped being
      // visible. Quality must not fall for that to count.
      defectEliminated: jig.envelopeRepairRate === 0,
      qualityHeld: jig.recoveredYield >= repair.recoveredYield,
      // With the decoder held constant, whatever remains is the fixture's doing.
      fixtureEffectWithDecoderHeld: {
        firstPassGain: Number((jigGuided.firstPassYield - repair.firstPassYield).toFixed(4)),
        totalTokenRatio: Number((jigGuided.meanTotalTokens / Math.max(0.01, repair.meanTotalTokens)).toFixed(3)),
      },
      // And the difference between the two jig arms is the decoder's own cost.
      decoderCost: {
        msDelta: Number((jigGuided.meanElapsedMs - jig.meanElapsedMs).toFixed(2)),
        totalTokenDelta: Number((jigGuided.meanTotalTokens - jig.meanTotalTokens).toFixed(2)),
      },
    },
    articles,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (label, s) => `  ${label.padEnd(12)} ${String(s.firstPassYield).padEnd(11)} ${String(s.recoveredYield).padEnd(11)} ${String(s.envelopeRepairRate).padEnd(11)} ${String(s.meanCompletionTokens).padEnd(9)} ${String(s.meanTotalTokens).padEnd(9)} ${s.meanElapsedMs}`;
  process.stdout.write([
    `POKA-YOKE JIG COHORT · ${repair.articles} articles per arm · ${model}`,
    "",
    `               first-pass  recovered   repair-rate out-tok   total-tok ms`,
    row("repair", repair),
    row("jig", jig),
    row("jig-guided", jigGuided),
    "",
    `  defect eliminated: ${evidence.results.defectEliminated}   quality held: ${evidence.results.qualityHeld}`,
    `  first-pass yield ${repair.firstPassYield} -> ${jig.firstPassYield}   output tokens ${evidence.results.completionTokenRatio}x`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { DOMAIN };
