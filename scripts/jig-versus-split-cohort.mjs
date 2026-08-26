#!/usr/bin/env node
// Jig the step, or split the step? The order-of-operations experiment.
//
// The branch's decomposed route beat the monolith 8/8 to 6/8 on this job — and
// the monolith's two failures were malformed emissions, not wrong judgments. Its
// per-row accuracy was 1.000. So the split was buying, at 7.1x the wall time,
// something a fixture might buy for nothing.
//
// The poka-yoke cohort showed a jig eliminating exactly that defect class on a
// SINGLE-key die: first-pass 0.46 -> 1.00, output halved, quality up. This asks
// the harder question, because a multi-key die is where a jig could plausibly
// hurt: prefilling the first key forces the worker to commit to its first answer
// as its opening tokens, with no freedom to order its own reasoning.
//
//   monolith        one call, all six obligations, fenced JSON repaired after
//   monolith-jig    the same call with the answer opened for it
//   decomposed      six stations, one obligation each, independently gauged
//
// A probe before writing this showed the jig cutting tokens 41% and preventing a
// truncation — and changing two answers. That is the risk this cohort exists to
// measure rather than assume away.
//
//   node scripts/jig-versus-split-cohort.mjs [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { CATALOG, FIXTURES, allPrompt, onePrompt, parseAnswer } from "./live-decomposition-cohort.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/jig-versus-split.json");

const IDS = CATALOG.map((entry) => entry.id);
const FIRST = FIXTURES[0].id;

async function post(body) {
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
  const envelope = JSON.parse(raw);
  return {
    content: envelope.choices?.[0]?.message?.content ?? "",
    elapsedMs: Number(elapsedMs.toFixed(2)),
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    finish: envelope.choices?.[0]?.finish_reason ?? null,
  };
}

function score(selections) {
  const correct = FIXTURES.filter((fixture) => selections?.[fixture.id] === fixture.expected).length;
  return { correct, jobCorrect: correct === FIXTURES.length, selections: selections ?? null };
}

async function monolith(model, { jig }) {
  const messages = [{ role: "user", content: allPrompt() }];
  const body = { model, temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false } };
  if (jig) {
    // The fixture: the answer is opened for the worker, so it cannot emit a
    // fence and cannot omit the first key.
    messages.push({ role: "assistant", content: `{"${FIRST}":"` });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  }
  body.messages = messages;
  const call = await post(body);

  let parsed = null;
  let repaired = false;
  if (jig) {
    // Reconstruct by restoring exactly the bytes the fixture supplied. This
    // cannot invent a value the worker did not write.
    try { parsed = JSON.parse(`{"${FIRST}":"${call.content}`); }
    catch { parsed = null; }
  } else {
    const read = parseAnswer(call.content);
    parsed = read.parsed;
    repaired = read.repaired;
  }
  const selections = parsed
    ? Object.fromEntries(FIXTURES.map((fixture) => [fixture.id, IDS.includes(parsed[fixture.id]) ? parsed[fixture.id] : null]))
    : null;
  return {
    arm: jig ? "monolith-jig" : "monolith",
    ...score(selections),
    malformed: parsed === null,
    repaired,
    truncated: call.finish === "length",
    completionTokens: call.completionTokens,
    wallMs: call.elapsedMs,
    calls: 1,
  };
}

// Opus-2's caveat 4: my first cut compared a JIGGED monolith against an UNJIGGED
// decomposed route, which is the same mistake in reverse — measuring the split
// against a baseline that skipped the fixture. If the order is jig, bound, then
// split, the comparison that matters is jigged against jigged.
async function decomposed(model, { jig }) {
  const selections = {};
  let tokens = 0;
  let wall = 0;
  let repairs = 0;
  for (const fixture of FIXTURES) {
    const messages = [{ role: "user", content: onePrompt(fixture) }];
    const body = { model, temperature: 0, max_tokens: 96, chat_template_kwargs: { enable_thinking: false } };
    if (jig) {
      messages.push({ role: "assistant", content: '{"edgeCaseId":"' });
      body.continue_final_message = true;
      body.add_generation_prompt = false;
    }
    body.messages = messages;
    const call = await post(body);
    let chosen = null;
    if (jig) {
      const match = /^([^"\\]*)"/.exec(call.content);
      chosen = match ? match[1] : null;
    } else {
      const read = parseAnswer(call.content);
      if (read.repaired) repairs += 1;
      chosen = read.parsed?.edgeCaseId ?? null;
    }
    selections[fixture.id] = IDS.includes(chosen) ? chosen : null;
    tokens += call.completionTokens;
    wall += call.elapsedMs;
  }
  return {
    arm: jig ? "decomposed-jig" : "decomposed",
    ...score(selections),
    malformed: Object.values(selections).some((value) => value === null),
    repaired: repairs > 0,
    truncated: false,
    completionTokens: tokens,
    wallMs: Number(wall.toFixed(2)),
    calls: FIXTURES.length,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 8 : Number(process.argv[flag + 1]);
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
    process.stderr.write(`jig-vs-split: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const order = repetition % 2 === 1
      ? ["monolith", "monolith-jig", "decomposed", "decomposed-jig"]
      : ["decomposed-jig", "decomposed", "monolith-jig", "monolith"];
    for (const arm of order) {
      articles.push(arm.startsWith("decomposed")
        ? await decomposed(model, { jig: arm === "decomposed-jig" })
        : await monolith(model, { jig: arm === "monolith-jig" }));
    }
  }

  const summarize = (name) => {
    const rows = articles.filter((article) => article.arm === name);
    return {
      articles: rows.length,
      jobsCorrect: rows.filter((row) => row.jobCorrect).length,
      meanCorrectRows: Number(mean(rows.map((row) => row.correct)).toFixed(3)),
      malformed: rows.filter((row) => row.malformed).length,
      truncated: rows.filter((row) => row.truncated).length,
      repaired: rows.filter((row) => row.repaired).length,
      meanCompletionTokens: Number(mean(rows.map((row) => row.completionTokens)).toFixed(1)),
      meanWallMs: Number(mean(rows.map((row) => row.wallMs)).toFixed(1)),
      callsPerArticle: rows[0]?.calls ?? 0,
    };
  };

  const plain = summarize("monolith");
  const jig = summarize("monolith-jig");
  const split = summarize("decomposed");
  const splitJig = summarize("decomposed-jig");
  const evidence = {
    schema: 1,
    kind: "bantam.factory-jig-versus-split-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/jig-versus-split-cohort.mjs", "scripts/live-decomposition-cohort.mjs"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, thinking: false },
    experiment: {
      question: "when a whole step fails on emission rather than judgment, is a fixture cheaper than a split?",
      arms: {
        monolith: "one call, fenced JSON repaired afterwards",
        "monolith-jig": "the same call with the answer opened for the worker",
        decomposed: "six stations, one obligation each",
      },
      risk: "a multi-key jig forces the worker to commit to its first answer as its opening tokens; a probe showed this changing two answers",
      obligations: FIXTURES.length,
      repetitions,
    },
    results: {
      monolith: plain, "monolith-jig": jig, decomposed: split, "decomposed-jig": splitJig,
      // The comparison that actually matters once a fixture exists.
      jiggedMonolithVersusJiggedSplit: {
        wallRatio: Number((jig.meanWallMs / Math.max(0.01, splitJig.meanWallMs)).toFixed(3)),
        tokenRatio: Number((jig.meanCompletionTokens / Math.max(0.01, splitJig.meanCompletionTokens)).toFixed(3)),
        yieldEqual: jig.jobsCorrect === splitJig.jobsCorrect,
      },
      jigFixedTheEmission: jig.malformed < plain.malformed || jig.truncated < plain.truncated,
      jigCostJudgment: jig.meanCorrectRows < plain.meanCorrectRows,
      jigVersusSplitWallRatio: Number((jig.meanWallMs / Math.max(0.01, split.meanWallMs)).toFixed(3)),
      jigVersusSplitTokenRatio: Number((jig.meanCompletionTokens / Math.max(0.01, split.meanCompletionTokens)).toFixed(3)),
      // The order-of-operations claim: jig first only if it reaches the split's
      // quality. If it does not, the split was buying judgment, not emission.
      jigSufficient: jig.jobsCorrect >= split.jobsCorrect,
    },
    articles,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (label, s) => `  ${label.padEnd(14)} ${String(s.jobsCorrect + "/" + s.articles).padEnd(8)} ${String(s.meanCorrectRows).padEnd(8)} ${String(s.malformed).padEnd(6)} ${String(s.truncated).padEnd(6)} ${String(s.meanCompletionTokens).padEnd(9)} ${String(s.meanWallMs).padEnd(9)} ${s.callsPerArticle}`;
  process.stdout.write([
    `JIG VERSUS SPLIT · ${repetitions} articles per arm · ${model}`,
    "",
    `                 jobs     rows/6   malf   trunc  out-tok   ms        calls`,
    row("monolith", plain),
    row("monolith-jig", jig),
    row("decomposed", split),
    row("decomposed-jig", splitJig),
    "",
    `  jig fixed the emission defect: ${evidence.results.jigFixedTheEmission}`,
    `  jig cost judgment quality:     ${evidence.results.jigCostJudgment}`,
    `  jig reaches the split's yield: ${evidence.results.jigSufficient}`,
    `  jig vs split — wall ${evidence.results.jigVersusSplitWallRatio}x, tokens ${evidence.results.jigVersusSplitTokenRatio}x`,
    `  JIGGED monolith vs JIGGED split — wall ${evidence.results.jiggedMonolithVersusJiggedSplit.wallRatio}x, tokens ${evidence.results.jiggedMonolithVersusJiggedSplit.tokenRatio}x, yield equal: ${evidence.results.jiggedMonolithVersusJiggedSplit.yieldEqual}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}
