#!/usr/bin/env node
// Is the jig needed when the die actually binds?
//
// The poka-yoke result was measured on a stack where NOTHING binds — the vLLM
// build accepts every constraint type and silently discards it (D20). On that
// stack a prefill fixture is the only enforcement available, so of course it
// looked like a principle. The canary at 03:04Z showed Qwen's `grammar`,
// `json_schema` and `response_format` all bind. So the honest question is
// whether the fixture buys anything once the sampler is doing its job.
//
//   die       grammar constrains the whole emission at the sampler
//   jig       prefill opens the answer; the rest of the emission is free
//   bare      no constraint; the named fence repair cleans up afterwards
//
// This experiment can only shrink a finding I published, which is exactly why it
// is safe for me to run: bias runs toward flattering yourself, so the test that
// can only cost you is the one you can be trusted with.
//
//   node scripts/jig-vs-die-on-binding-stack.mjs [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8085/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const EVIDENCE = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"), "evidence/jig-vs-die.json");

const CATALOG = [
  { id: "status-200", description: "the request succeeded and a body is returned" },
  { id: "status-201", description: "a new resource was created" },
  { id: "status-401", description: "the caller is not authenticated" },
  { id: "status-403", description: "the caller is authenticated but not permitted" },
  { id: "status-404", description: "the addressed resource does not exist" },
  { id: "status-409", description: "the request conflicts with the resource's current state" },
  { id: "status-429", description: "the caller has exceeded a rate limit" },
];
const IDS = CATALOG.map((row) => row.id);

const ITEMS = [
  { id: "no-token", expected: "status-401", body: "A client calls GET /orders/17 with no Authorization header. The endpoint requires a bearer token." },
  { id: "wrong-role", expected: "status-403", body: "A client presents a valid bearer token for a reader account and calls DELETE /orders/17. Deletion requires an admin account." },
  { id: "absent-order", expected: "status-404", body: "An authenticated admin calls GET /orders/9999. No order with that identifier has ever existed." },
  { id: "created-order", expected: "status-201", body: "An authenticated client POSTs a valid order body to /orders. The server stores a new order and returns its location." },
  { id: "duplicate-submit", expected: "status-409", body: "An authenticated client POSTs an order carrying an idempotency key that was already used for a different order body." },
  { id: "too-many", expected: "status-429", body: "An authenticated client has made 400 requests this minute against a documented limit of 300 per minute." },
  { id: "plain-read", expected: "status-200", body: "An authenticated client calls GET /orders/17. The order exists and the client may read it." },
];

const prompt = (item) => [
  "You are choosing the single correct HTTP response status for one server situation.",
  "",
  "Catalog (choose exactly one id):",
  ...CATALOG.map((row) => `  ${row.id} — ${row.description}`),
  "",
  "Situation:",
  "```", item.body, "```",
  "",
  'Answer with JSON only: {"statusId":"<one id from the catalog>"}',
].join("\n");

// Thinking is frozen off across every arm. On this worker a one-word answer
// costs 2 tokens with thinking off and 161 with it on — an 80x multiplier that
// would swamp every difference this experiment is trying to measure.
const THINKING = false;

function bodyFor(model, item, arm) {
  const messages = [{ role: "user", content: prompt(item) }];
  const body = { model, messages, temperature: 0, max_tokens: 200, chat_template_kwargs: { enable_thinking: THINKING } };
  if (arm === "die") {
    // The whole emission is constrained at the sampler.
    body.grammar = `root ::= "{\\"statusId\\":\\"" id "\\"}"\nid ::= ${IDS.map((i) => `"${i}"`).join(" | ")}`;
  } else if (arm === "jig") {
    messages.push({ role: "assistant", content: '{"statusId":"' });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  }
  return body;
}

function read(arm, content) {
  const text = String(content ?? "");
  if (arm === "jig") {
    // Prefill has a DIALECT, same as the constraint parameters. vLLM returns the
    // continuation only (`status-401"}`); llama.cpp echoes the whole message back
    // (`{"statusId":"status-401"}`). A reader that assumes one shape reads the
    // leading brace as the answer and scores a working fixture at zero — which is
    // exactly what this experiment did on its first run.
    const whole = tryJson(text);
    if (whole && typeof whole.statusId === "string") return { chosen: whole.statusId, repaired: false, echoed: true };
    const match = /^([^"\\]*)"/.exec(text);
    return { chosen: match ? match[1] : null, repaired: false, echoed: false };
  }
  const direct = tryJson(text);
  if (direct) return { chosen: direct.statusId ?? null, repaired: false };
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  if (fence) {
    const inner = tryJson(fence[1]);
    if (inner) return { chosen: inner.statusId ?? null, repaired: true };
  }
  return { chosen: null, repaired: false };
}

function tryJson(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}

async function call(model, item, arm) {
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyFor(model, item, arm)),
  });
  const raw = await response.text();
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? "";
  const { chosen, repaired } = read(arm, content);
  return {
    chosen, repaired,
    correct: chosen === item.expected,
    // First pass: usable straight off the wire, no fitting of any kind.
    firstPass: chosen === item.expected && !repaired,
    inCatalog: typeof chosen === "string" && IDS.includes(chosen),
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    ms: Number(ms.toFixed(1)),
  };
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 4 : Number(process.argv[flag + 1]);
  let model;
  try {
    const listed = await (await fetch(MODELS_URL)).json();
    model = listed.data?.[0]?.id ?? listed.models?.[0]?.model ?? listed.models?.[0]?.name;
    if (!model) throw new Error("no model served");
  } catch (error) {
    process.stderr.write(`jig-vs-die: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  process.stdout.write(`worker: ${model}\nendpoint: ${ENDPOINT}\nthinking: ${THINKING} (frozen across arms)\n\n`);

  const ARMS = ["bare", "jig", "die"];
  const articles = [];
  for (let r = 1; r <= repetitions; r += 1) {
    for (const [position, item] of ITEMS.entries()) {
      const order = (position + r) % 2 === 0 ? ARMS : [...ARMS].reverse();
      for (const arm of order) articles.push({ arm, item: item.id, expected: item.expected, ...await call(model, item, arm) });
    }
  }

  const summarize = (arm) => {
    const rows = articles.filter((a) => a.arm === arm);
    return {
      articles: rows.length,
      firstPassYield: Number((rows.filter((a) => a.firstPass).length / rows.length).toFixed(4)),
      recoveredYield: Number((rows.filter((a) => a.correct).length / rows.length).toFixed(4)),
      repairRate: Number((rows.filter((a) => a.repaired).length / rows.length).toFixed(4)),
      outOfCatalog: rows.filter((a) => a.chosen !== null && !a.inCatalog).length,
      malformed: rows.filter((a) => a.chosen === null).length,
      meanCompletionTokens: Number(mean(rows.map((a) => a.completionTokens)).toFixed(2)),
      meanTotalTokens: Number(mean(rows.map((a) => a.completionTokens + a.promptTokens)).toFixed(2)),
      meanMs: Number(mean(rows.map((a) => a.ms)).toFixed(1)),
    };
  };

  const bare = summarize("bare");
  const jig = summarize("jig");
  const die = summarize("die");
  const evidence = {
    schema: 1, kind: "bantam.factory-jig-vs-die-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/jig-vs-die-on-binding-stack.mjs"],
    worker: { model, endpoint: ENDPOINT, thinking: THINKING, temperature: 0 },
    question: "does the prefill fixture buy anything once the sampler actually enforces?",
    results: {
      bare, jig, die,
      dieMatchesJigOnFirstPass: die.firstPassYield >= jig.firstPassYield,
      dieCheaperThanJig: die.meanCompletionTokens <= jig.meanCompletionTokens,
      // The claim under test, stated so it can fail.
      jigStillNeeded: jig.firstPassYield > die.firstPassYield,
    },
    articles,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (l, s) => `  ${l.padEnd(6)} ${String(s.firstPassYield).padEnd(11)} ${String(s.recoveredYield).padEnd(11)} ${String(s.repairRate).padEnd(11)} ${String(s.malformed).padEnd(6)} ${String(s.meanCompletionTokens).padEnd(9)} ${s.meanMs}`;
  process.stdout.write([
    `JIG VS DIE ON A BINDING STACK · ${bare.articles} articles per arm`,
    "",
    `         first-pass  recovered   repair-rate malf   out-tok   ms`,
    row("bare", bare), row("jig", jig), row("die", die),
    "",
    `  die matches jig on first pass: ${evidence.results.dieMatchesJigOnFirstPass}`,
    `  die cheaper than jig:          ${evidence.results.dieCheaperThanJig}`,
    `  jig still needed:              ${evidence.results.jigStillNeeded}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) process.exit(await main());
