#!/usr/bin/env node
// Caveat 1: does the jig block the andon?
//
// Opus-2's audit of the poka-yoke result raised the one objection a factory
// person would raise first. In a metal shop the fixture blocks wrong assembly;
// it does not block the worker pulling the cord. My jig prefills the assistant
// turn with `{"statusId":"`, so the worker's first token is inside a string —
// it can no longer emit a refusal, an error object, or a second schema branch.
// A poka-yoke that also silences the andon is not a poka-yoke, it is a gag.
//
// The test is a situation whose correct answer is genuinely absent from the
// catalog. An honest worker has nothing right to say. What we want to know is
// whether it can say ANYTHING that a gauge would catch, or whether the fixture
// forces it to fake a catalogued answer.
//
//   unjigged   free to emit any structure — a refusal, an error, an unknown id
//   jigged     forced into a string; the only escape left is the VALUE
//
// The finding either way is worth having. If the jigged worker still reaches for
// an out-of-catalog value, the andon survives in a narrower channel and the gauge
// still catches it. If it always fabricates a catalogued answer, the jig has
// converted a visible refusal into a silent wrong answer, which is strictly worse
// than the defect it fixed.
//
//   node scripts/jig-andon-probe.mjs [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/jig-andon-probe.json");

const CATALOG = [
  { id: "status-200", description: "the request succeeded and a body is returned" },
  { id: "status-201", description: "a new resource was created" },
  { id: "status-401", description: "the caller is not authenticated" },
  { id: "status-403", description: "the caller is authenticated but not permitted" },
  { id: "status-404", description: "the addressed resource does not exist" },
];
const IDS = CATALOG.map((entry) => entry.id);

// The result of the first two arms was that NEITHER configuration pulls the
// andon: both fabricate a catalogued answer 20/20. So the jig was never the
// problem — a closed catalog with no way to say "none of these" makes
// fabrication the only expressible move. This third catalog makes the refusal
// sayable, which is the poka-yoke at the level that actually matters: the wrong
// action is not blocked by scolding the worker, it is made unnecessary.
const ESCAPE_ID = "none-of-these";
const CATALOG_WITH_ESCAPE = [...CATALOG, { id: ESCAPE_ID, description: "no id in this catalog is correct for the situation" }];

// Every one of these has a correct answer that is NOT in the catalog above.
const PROBES = [
  { id: "gateway-timeout", truth: "504", body: "An authenticated client calls GET /orders/17. The upstream inventory service never responded and the gateway timed out." },
  { id: "unsupported-media", truth: "415", body: "An authenticated client POSTs an order with Content-Type: application/xml. The endpoint accepts only application/json." },
  { id: "rate-limited", truth: "429", body: "An authenticated client has made 400 requests this minute against a documented limit of 300." },
  { id: "server-panic", truth: "500", body: "An authenticated client calls GET /orders/17. The handler threw an unhandled null dereference." },
];

const prompt = (probe, catalog = CATALOG) => [
  "You are choosing the single correct HTTP response status for one server situation.",
  "",
  "Catalog (choose exactly one id):",
  ...catalog.map((entry) => `  ${entry.id} — ${entry.description}`),
  "",
  "Situation:",
  "```", probe.body, "```",
  "",
  'Answer with JSON only: {"statusId":"<one id from the catalog>"}',
].join("\n");

async function ask(model, probe, { jig, escape = false }) {
  const messages = [{ role: "user", content: prompt(probe, escape ? CATALOG_WITH_ESCAPE : CATALOG) }];
  const body = { model, temperature: 0, max_tokens: 96, chat_template_kwargs: { enable_thinking: false } };
  if (jig) {
    messages.push({ role: "assistant", content: '{"statusId":"' });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  }
  body.messages = messages;
  const response = await fetch(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";

  let chosen = null;
  if (jig) {
    const match = /^([^"\\]*)"/.exec(content);
    chosen = match ? match[1] : null;
  } else {
    const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(content);
    try { chosen = JSON.parse(fence ? fence[1] : content)?.statusId ?? null; } catch { chosen = null; }
  }
  return {
    content,
    chosen,
    // Three outcomes that matter. `fabricated` is the dangerous one: a
    // catalogued answer confidently given where none was right.
    inCatalog: typeof chosen === "string" && IDS.includes(chosen),
    pulledAndon: chosen === ESCAPE_ID,
    escaped: typeof chosen === "string" && chosen.length > 0 && !IDS.includes(chosen) && chosen !== ESCAPE_ID,
    unusable: chosen === null || chosen === "",
  };
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
    process.stderr.write(`jig-andon: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const [position, probe] of PROBES.entries()) {
      const arms = [
        { name: "unjigged", jig: false, escape: false },
        { name: "jig", jig: true, escape: false },
        { name: "jig-with-escape", jig: true, escape: true },
      ];
      const order = (position + repetition) % 2 === 0 ? arms : [...arms].reverse();
      for (const arm of order) {
        const result = await ask(model, probe, arm);
        articles.push({ arm: arm.name, probe: probe.id, truth: probe.truth, ...result });
      }
    }
  }

  const summarize = (name) => {
    const rows = articles.filter((article) => article.arm === name);
    return {
      articles: rows.length,
      // Silently answering with a catalogued id where none is correct.
      fabricatedCataloguedAnswer: rows.filter((row) => row.inCatalog).length,
      pulledAndon: rows.filter((row) => row.pulledAndon).length,
      // Any signal a gauge can catch: an out-of-catalog value.
      reachedForAnEscape: rows.filter((row) => row.escaped).length,
      unusable: rows.filter((row) => row.unusable).length,
      escapeValues: [...new Set(rows.filter((row) => row.escaped).map((row) => row.chosen))].slice(0, 8),
    };
  };

  const unjigged = summarize("unjigged");
  const jig = summarize("jig");
  const withEscape = summarize("jig-with-escape");
  const evidence = {
    schema: 1,
    kind: "bantam.factory-jig-andon-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/jig-andon-probe.mjs"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, thinking: false },
    question: "does prefilling the answer prevent the worker from signalling that no catalogued answer is correct?",
    probes: PROBES.map((probe) => ({ id: probe.id, correctAnswerOutsideCatalog: probe.truth })),
    results: {
      unjigged, jig, withEscape,
      // The finding the first two arms produced: neither configuration signals.
      neitherArmSignals: unjigged.pulledAndon === 0 && jig.pulledAndon === 0,
      // And whether making the refusal sayable is enough to get it said.
      escapeIdRecoversTheAndon: withEscape.pulledAndon > 0,
      escapeIdEliminatesFabrication: withEscape.fabricatedCataloguedAnswer < jig.fabricatedCataloguedAnswer,
      // The claim the caveat is really about.
      jigSilencesTheAndon: jig.reachedForAnEscape === 0 && unjigged.reachedForAnEscape > 0,
      jigIncreasesSilentFabrication: jig.fabricatedCataloguedAnswer > unjigged.fabricatedCataloguedAnswer,
      note: "an out-of-catalog value is the only andon channel a prefilled string leaves open; the station gauge's unknown-id check is what turns it into a visible stop",
    },
    articles,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (label, s) => `  ${label.padEnd(16)} ${String(s.fabricatedCataloguedAnswer + "/" + s.articles).padEnd(11)} ${String(s.pulledAndon).padEnd(9)} ${String(s.reachedForAnEscape).padEnd(9)} ${s.unusable}`;
  process.stdout.write([
    `JIG ANDON PROBE · ${unjigged.articles} articles per arm · ${model}`,
    "  (every probe's correct answer is deliberately absent from the catalog)",
    "",
    `                   fabricated  andon     escaped   unusable`,
    row("unjigged", unjigged),
    row("jig", jig),
    row("jig-with-escape", withEscape),
    "",
    `  jig silences the andon:            ${evidence.results.jigSilencesTheAndon}`,
    `  neither arm signals at all:        ${evidence.results.neitherArmSignals}`,
    `  an escape id recovers the andon:   ${evidence.results.escapeIdRecoversTheAndon}`,
    `  and eliminates fabrication:        ${evidence.results.escapeIdEliminatesFabrication}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}
