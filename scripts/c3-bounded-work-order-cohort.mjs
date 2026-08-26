#!/usr/bin/env node
// C3 — reliable station execution. Is a bounded work order materially more
// reliable than the same obligation embedded in a larger request?
//
// C3 is the rung that blocks C4, and it is strict on purpose: same model and
// effort, equivalent obligation, repeated order-balanced samples, an independent
// gauge, tasks NOT used to design the station, and first-pass yield reported with
// intervals rather than as a bare fraction.
//
// The obligation is identical in both arms — name the single unhandled edge case
// from a closed catalog. What differs is what surrounds it:
//
//   bounded   one obligation, one small die: {"edgeCaseId":"..."}
//   embedded  the same obligation inside an ordinary review request — summarize
//             the function, rate its clarity, AND name the edge case — with a
//             correspondingly wider die
//
// The embedded arm is not a straw man. It is what asking a model to do this as
// part of normal work looks like, and its extra obligations are ones a reviewer
// would genuinely want. The gauge reads only the edge-case field in both arms,
// so the two are scored on exactly the same judgment.
//
// The twenty fixtures below are fresh: none was used to build, debug, or tune any
// station, gauge, or die on this branch. That is C3's `fresh-tasks` obligation
// and it is the one most easily lost by reusing a convenient catalog.
//
//   node scripts/c3-bounded-work-order-cohort.mjs --preregistration PLAN --runner REF --scorer REF [--endpoint URL]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { admitCohortRun, loadPreregistration, scoreAgainstPlan } from "../src/factory/preregistration.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/c3-station-cohort.json");

const CATALOG = [
  { id: "empty-input", description: "the input collection is empty" },
  { id: "negative-number", description: "a value is negative" },
  { id: "zero-divisor", description: "a divisor is zero" },
  { id: "missing-key", description: "a looked-up key is absent" },
  { id: "non-numeric", description: "a value is not a number" },
  { id: "duplicate-entry", description: "the same entry appears twice" },
];
const IDS = CATALOG.map((entry) => entry.id);

// Twenty fresh fixtures. Each guards the alternatives so exactly one catalog
// entry fits — the lesson from an earlier cohort where `row.amount` could fail
// as either a missing key or a non-numeric value, and the worker's "wrong"
// answer was defensible while the fixture was the defect.
const FIXTURES = [
  { id: "median", expected: "empty-input", source: "function median(values) {\n  const sorted = [...values].sort((a, b) => a - b);\n  return sorted[Math.floor(sorted.length / 2)];\n}" },
  { id: "average", expected: "empty-input", source: "function average(scores) {\n  let sum = 0;\n  for (const score of scores) sum += score;\n  return sum / scores.length;\n}" },
  { id: "firstWord", expected: "empty-input", source: "function firstWord(words) {\n  // every entry is a non-empty string\n  return words[0].toUpperCase();\n}" },
  { id: "perUnit", expected: "zero-divisor", source: "function perUnit(total, units) {\n  if (typeof total !== 'number' || typeof units !== 'number') throw new TypeError('numbers required');\n  return total / units;\n}" },
  { id: "sharePer", expected: "zero-divisor", source: "function sharePer(amount, people) {\n  if (typeof people !== 'number') throw new TypeError('people must be a number');\n  if (amount < 0) throw new RangeError('amount must not be negative');\n  return amount / people;\n}" },
  { id: "rate", expected: "zero-divisor", source: "function rate(distance, hours) {\n  if (typeof hours !== 'number') throw new TypeError('hours must be a number');\n  if (hours < 0) throw new RangeError('hours must not be negative');\n  return distance / hours;\n}" },
  { id: "settingOf", expected: "missing-key", source: "function settingOf(config, name) {\n  const entry = config[name];\n  return entry.value;\n}" },
  { id: "priceOf", expected: "missing-key", source: "function priceOf(catalog, sku) {\n  if (typeof sku !== 'string') throw new TypeError('sku must be a string');\n  return catalog[sku].price;\n}" },
  { id: "ownerName", expected: "missing-key", source: "function ownerName(records, id) {\n  const record = records[id];\n  return record.owner.name;\n}" },
  { id: "rootOf", expected: "negative-number", source: "function rootOf(value) {\n  if (typeof value !== 'number') throw new TypeError('value must be a number');\n  return Math.sqrt(value);\n}" },
  { id: "logScale", expected: "negative-number", source: "function logScale(values) {\n  if (values.length === 0) return [];\n  return values.map((value) => Math.log(value));\n}" },
  { id: "sqrtSum", expected: "negative-number", source: "function sqrtSum(a, b) {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers required');\n  return Math.sqrt(a) + Math.sqrt(b);\n}" },
  { id: "totalCents", expected: "non-numeric", source: "function totalCents(rows) {\n  // every row always has a `cents` field, read from a form and always a string\n  if (rows.length === 0) return 0;\n  return rows.reduce((sum, row) => sum + row.cents, 0);\n}" },
  { id: "addQuantity", expected: "non-numeric", source: "function addQuantity(a, b) {\n  // both arguments always arrive from the query string, so both are strings\n  return a + b;\n}" },
  { id: "sumWidths", expected: "non-numeric", source: "function sumWidths(boxes) {\n  // every box always defines `width`, always as a CSS string such as \"10px\"\n  if (boxes.length === 0) return 0;\n  return boxes.reduce((total, box) => total + box.width, 0);\n}" },
  { id: "addTag", expected: "duplicate-entry", source: "function addTag(tags, tag) {\n  if (typeof tag !== 'string') throw new TypeError('tag must be a string');\n  tags.push(tag);\n  return tags.length;\n}" },
  { id: "enroll", expected: "duplicate-entry", source: "function enroll(roster, student) {\n  if (typeof student !== 'string') throw new TypeError('student must be a string');\n  roster.push(student);\n  return roster;\n}" },
  { id: "appendId", expected: "duplicate-entry", source: "function appendId(ids, id) {\n  if (typeof id !== 'string') throw new TypeError('id must be a string');\n  ids[ids.length] = id;\n  return ids;\n}" },
  { id: "lastEntry", expected: "empty-input", source: "function lastEntry(entries) {\n  // every entry is a non-empty object\n  return entries[entries.length - 1].id;\n}" },
  { id: "divideAll", expected: "zero-divisor", source: "function divideAll(values, divisor) {\n  if (typeof divisor !== 'number') throw new TypeError('divisor must be a number');\n  if (values.length === 0) return [];\n  return values.map((value) => value / divisor);\n}" },
];

const catalogLines = CATALOG.map((entry) => `  ${entry.id} — ${entry.description}`);

const BOUNDED_SCHEMA = {
  type: "object",
  properties: { edgeCaseId: { type: "string", enum: IDS } },
  required: ["edgeCaseId"],
  additionalProperties: false,
};
// The embedded arm's die is wider because the request is wider. Its edge-case
// field is identical, and only that field is gauged.
const EMBEDDED_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    clarity: { type: "integer", minimum: 1, maximum: 5 },
    edgeCaseId: { type: "string", enum: IDS },
  },
  required: ["summary", "clarity", "edgeCaseId"],
  additionalProperties: false,
};

function boundedPrompt(fixture) {
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

function embeddedPrompt(fixture) {
  return [
    "Review this JavaScript function. Produce a short summary of what it does, a",
    "clarity rating from 1 to 5, and the single unhandled edge case it has.",
    "",
    "Catalog of edge cases (choose exactly one id):",
    ...catalogLines,
    "",
    "Function:",
    "```js", fixture.source, "```",
    "",
    'Answer with JSON only: {"summary":"<one sentence>","clarity":<1-5>,"edgeCaseId":"<one id from the catalog>"}',
  ].join("\n");
}

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
  const { parsed, repaired } = parseAnswer(envelope.choices?.[0]?.message?.content ?? "");
  return {
    parsed, repaired,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
  };
}

// The independent gauge. It reads only the edge-case field, holds the expected
// id the worker never sees, and reports why it rejected — first-pass means the
// product conformed AND was right on the first emission, with no repair and no
// retry.
function gauge(parsed, fixture) {
  if (parsed === null) return { pass: false, code: "malformed" };
  const chosen = parsed.edgeCaseId;
  if (typeof chosen !== "string" || !IDS.includes(chosen)) return { pass: false, code: "unknown-id" };
  if (chosen !== fixture.expected) return { pass: false, code: "wrong-edge-case", chosen };
  return { pass: true, code: "conforming", chosen };
}

// Wilson score interval — the right interval for a proportion at this sample
// size, where a normal approximation would put the bound outside [0,1].
function wilson(successes, total, z = 1.96) {
  if (total === 0) return { low: 0, high: 0 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    low: Number(Math.max(0, (centre - spread) / denominator).toFixed(4)),
    high: Number(Math.min(1, (centre + spread) / denominator).toFixed(4)),
  };
}

function validateC3Preregistration(plan) {
  if (plan.primaryOutcome !== "first-pass-comparison") throw new Error("C3 preregistration primaryOutcome must be first-pass-comparison");
  if (plan.decisionRule.op !== "wilson-superiority" || plan.decisionRule.candidateArm !== "bounded" || plan.decisionRule.controlArm !== "embedded") throw new Error("C3 preregistration must use bounded-over-embedded Wilson superiority");
  if (plan.arms.length !== 2 || !plan.arms.includes("bounded") || !plan.arms.includes("embedded")) throw new Error("C3 preregistration arms must be exactly bounded and embedded");
  if (plan.frozenSettings.temperature !== 0 || plan.frozenSettings.thinking !== false) throw new Error("C3 preregistration must freeze temperature 0 and thinking false");
  const expectedTarget = path.relative(REPOSITORY_ROOT, EVIDENCE).split(path.sep).join("/");
  if (plan.resultTarget !== expectedTarget) throw new Error(`C3 preregistration resultTarget must be ${expectedTarget}`);
  return plan;
}

function beginAdmittedAttempt({ admission, file, now = new Date() }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.preregistration.lock`;
  let lockFd;
  let lockIdentity = null;
  try {
    lockFd = fs.openSync(lock, "wx");
    const opened = fs.fstatSync(lockFd);
    lockIdentity = { dev: opened.dev, ino: opened.ino };
    const currentDigest = fs.existsSync(file)
      ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      : null;
    if (currentDigest !== admission.existingResultSha256) throw new Error("result target changed after preregistration admission");
    const attemptFile = `${file}.attempt-${admission.ref.split(":").at(-1).slice(0, 16)}.json`;
    const record = {
      schema: 1,
      kind: "bantam.factory-preregistered-cohort-attempt",
      admissionRef: admission.ref,
      resultTarget: admission.resultTarget,
      expectedResultSha256: admission.existingResultSha256,
      status: "started",
      startedAt: now.toISOString(),
      finishedAt: null,
      resultSha256: null,
      error: null,
    };
    fs.writeFileSync(attemptFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    return { admission, file, lock, lockFd, lockIdentity, attemptFile, record, closed: false };
  } catch (error) {
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      unlinkOwnedLock({ lock, lockIdentity });
    }
    throw error;
  }
}

function finishAttempt(lease, { status, resultSha256 = null, error = null, now = new Date() }) {
  if (!lease || lease.closed) return;
  lease.record = { ...lease.record, status, finishedAt: now.toISOString(), resultSha256, error };
  fs.writeFileSync(lease.attemptFile, `${JSON.stringify(lease.record, null, 2)}\n`);
  fs.closeSync(lease.lockFd);
  unlinkOwnedLock(lease);
  lease.closed = true;
}

function unlinkOwnedLock({ lock, lockIdentity }) {
  if (lockIdentity === null) return;
  let current;
  try { current = fs.lstatSync(lock); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) return;
  fs.unlinkSync(lock);
}

function abortAdmittedAttempt(lease, error) {
  finishAttempt(lease, { status: "aborted", error: String(error?.message ?? error ?? "run exited before evidence commit") });
}

function commitAdmittedEvidence({ lease, evidence }) {
  if (!lease || lease.closed) throw new Error("preregistered cohort attempt is not active");
  let temporary = null;
  try {
    const currentDigest = fs.existsSync(lease.file)
      ? crypto.createHash("sha256").update(fs.readFileSync(lease.file)).digest("hex")
      : null;
    if (currentDigest !== lease.admission.existingResultSha256) throw new Error("result target changed during preregistered cohort execution");
    temporary = `${lease.file}.${process.pid}.${Date.now()}.tmp`;
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, lease.file);
    temporary = null;
    finishAttempt(lease, { status: "committed", resultSha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (temporary !== null && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    abortAdmittedAttempt(lease, error);
    throw error;
  }
}

async function main() {
  // The powered rerun must not be runnable on a whim. Opus-2's 21:38Z audit named
  // the trap precisely: run another cohort, then another, until the intervals
  // part, and the ledger shows C3 EARNED with an impeccable method section
  // because the other eight obligations are already green. A preregistration is
  // the standard answer and it is usually a promise; here it is a gate.
  //
  const preregFlag = process.argv.indexOf("--preregistration");
  if (preregFlag === -1 || !process.argv[preregFlag + 1]) {
    process.stderr.write("c3-cohort: --preregistration PLAN is required before endpoint discovery\n");
    return 4;
  }
  let prereg;
  let admission;
  try {
    prereg = validateC3Preregistration(loadPreregistration(path.resolve(REPOSITORY_ROOT, process.argv[preregFlag + 1])));
    const rerunReason = option("rerun-reason", null);
    const rerunApprover = option("rerun-approved-by", null);
    if ((rerunReason === null) !== (rerunApprover === null)) throw new Error("rerun reason and approver must be supplied together");
    const rerunOverride = rerunReason === null ? null : {
      reason: rerunReason,
      approvedByRef: rerunApprover,
      priorResultSha256: fs.existsSync(EVIDENCE) ? crypto.createHash("sha256").update(fs.readFileSync(EVIDENCE)).digest("hex") : "0".repeat(64),
    };
    admission = admitCohortRun({
      plan: prereg,
      runnerRef: option("runner", null),
      scorerRef: option("scorer", null),
      repositoryRoot: REPOSITORY_ROOT,
      rerunOverride,
    });
  } catch (error) {
    process.stderr.write(`c3-cohort: invalid preregistration: ${error.message}\n`);
    return 4;
  }
  if (!admission.admitted) {
    process.stderr.write(`c3-cohort: refused by preregistration ${prereg.ref}\n`);
    for (const blocker of admission.blockers) process.stderr.write(`  - ${blocker}\n`);
    return 4;
  }
  let attempt;
  try {
    attempt = beginAdmittedAttempt({ admission, file: EVIDENCE });
  } catch (error) {
    process.stderr.write(`c3-cohort: attempt reservation refused: ${error.message}\n`);
    return 5;
  }
  const abortOnExit = () => abortAdmittedAttempt(attempt, "process exited before evidence commit");
  process.once("exit", abortOnExit);
  process.stdout.write(`preregistration: ${prereg.ref}\n  designer ${prereg.designerRef} · runner ${admission.runnerRef} · scorer ${admission.scorerRef}\n  primary outcome: ${prereg.primaryOutcome}\n\n`);

  let model;
  try {
    const listed = await (await fetch(MODELS_URL)).json();
    model = listed.data?.[0]?.id;
    if (!model) throw new Error("no model served");
  } catch (error) {
    process.removeListener("exit", abortOnExit);
    abortAdmittedAttempt(attempt, error);
    process.stderr.write(`c3-cohort: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  if (prereg.frozenSettings.worker !== model) {
    process.removeListener("exit", abortOnExit);
    abortAdmittedAttempt(attempt, `served worker ${model} did not match frozen worker`);
    process.stderr.write(`c3-cohort: served worker ${model} does not match frozen worker ${prereg.frozenSettings.worker}\n`);
    return 4;
  }
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n\n`);

  const articles = [];
  let producedPerArm = 0;
  for (let repetition = 1; producedPerArm < prereg.articlesPerArm; repetition += 1) {
    for (const [position, fixture] of FIXTURES.entries()) {
      if (producedPerArm >= prereg.articlesPerArm) break;
      // Order-balanced: which arm runs first alternates by fixture and by
      // repetition, so neither arm systematically warms the prefix cache.
      const order = (position + repetition) % 2 === 0 ? ["bounded", "embedded"] : ["embedded", "bounded"];
      for (const armName of order) {
        const call = armName === "bounded"
          ? await ask(model, boundedPrompt(fixture), BOUNDED_SCHEMA, 96)
          : await ask(model, embeddedPrompt(fixture), EMBEDDED_SCHEMA, 256);
        const verdict = gauge(call.parsed, fixture);
        articles.push({
          arm: armName, fixture: fixture.id, expected: fixture.expected, repetition,
          firstOfPair: order[0] === armName,
          pass: verdict.pass, code: verdict.code, chosen: verdict.chosen ?? null,
          repaired: call.repaired, elapsedMs: call.elapsedMs,
          promptTokens: call.promptTokens, completionTokens: call.completionTokens,
        });
      }
      producedPerArm += 1;
    }
  }

  const summarize = (name) => {
    const rows = articles.filter((article) => article.arm === name);
    // D18 (Opus-2): guided_json is requested and does not bind — most emissions
    // arrive fenced and need envelope repair. First-pass yield must mean the
    // product was conforming AND correct on the raw emission; counting a
    // repaired emission as first-pass measures the repair, not the worker.
    // The branch's own DiffusionGemma record already separates these two and I
    // collapsed them.
    const firstPass = rows.filter((row) => row.pass && !row.repaired).length;
    const recovered = rows.filter((row) => row.pass).length;
    const passed = firstPass;
    const interval = wilson(passed, rows.length);
    const codes = rows.reduce((counts, row) => { counts[row.code] = (counts[row.code] ?? 0) + 1; return counts; }, {});
    return {
      articles: rows.length,
      firstPassYield: { value: Number((firstPass / rows.length).toFixed(4)), passed: firstPass, of: rows.length, ciLow: interval.low, ciHigh: interval.high },
      recoveredYield: (() => { const r = wilson(recovered, rows.length); return { value: Number((recovered / rows.length).toFixed(4)), passed: recovered, of: rows.length, ciLow: r.low, ciHigh: r.high }; })(),
      envelopeRepairRate: Number((rows.filter((row) => row.repaired).length / rows.length).toFixed(4)),
      // A false stop is the gauge rejecting a product that was actually right.
      // It cannot happen here by construction — the gauge compares against the
      // held-out expected id — so it is reported as measured, not assumed.
      falseStops: { count: rows.filter((row) => row.pass === false && row.chosen === row.expected).length, of: rows.length, ciLow: 0, ciHigh: Number(wilson(0, rows.length).high) },
      rejectionsByReason: codes,
      repairedEmissions: rows.filter((row) => row.repaired).length,
      meanCompletionTokens: Number((rows.reduce((total, row) => total + row.completionTokens, 0) / rows.length).toFixed(1)),
      meanElapsedMs: Number((rows.reduce((total, row) => total + row.elapsedMs, 0) / rows.length).toFixed(2)),
    };
  };

  const bounded = summarize("bounded");
  const embedded = summarize("embedded");
  const evidence = {
    schema: 1,
    kind: "bantam.factory-c3-station-cohort",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/c3-bounded-work-order-cohort.mjs"],
    control: { model, endpoint: ENDPOINT, temperature: 0, effort: "default", thinking: false },
    design: {
      articlesPerArm: bounded.articles,
      // Both arms call the same served model at the same settings; nothing in
      // the harness can select a different one.
      modelMismatch: 0,
      orderBalanced: true,
      orderBalancedBy: "arm order alternates by fixture position and repetition",
      freshTasks: true,
      freshTasksNote: "all twenty fixtures were authored for this cohort; none was used to build, debug, or tune any station, gauge, or die on this branch",
      repetitions: Math.ceil(prereg.articlesPerArm / FIXTURES.length),
      preregisteredArticlesPerArm: prereg.articlesPerArm,
    },
    obligation: {
      equivalent: true,
      note: "identical judgment in both arms — name the single unhandled edge case from the same closed catalog; only the surrounding request and die width differ, and only the edge-case field is gauged",
    },
    gauge: {
      independent: true,
      note: "compares the product against a held-out expected id the worker never receives; it never asks the worker whether the worker succeeded",
      negativeControl: "test/factory-contract-edge-negative-control.test.js",
    },
    results: {
      bounded, embedded,
      firstPassYield: bounded.firstPassYield,
      yieldDifference: Number((bounded.firstPassYield.value - embedded.firstPassYield.value).toFixed(4)),
      intervalsOverlap: bounded.firstPassYield.ciLow <= embedded.firstPassYield.ciHigh
        && embedded.firstPassYield.ciLow <= bounded.firstPassYield.ciHigh,
      // C3 claims a MATERIALLY higher first-pass yield. A point estimate that
      // favours the station while the intervals overlap does not establish that,
      // and the rung must not be earnable on a null result.
      differenceEstablished: !(bounded.firstPassYield.ciLow <= embedded.firstPassYield.ciHigh
        && embedded.firstPassYield.ciLow <= bounded.firstPassYield.ciHigh)
        && bounded.firstPassYield.value > embedded.firstPassYield.value,
    },
    articles,
    preregistration: {
      plan: prereg,
      admission,
      score: scoreAgainstPlan({
        plan: prereg, admission, scorerRef: admission.scorerRef,
        measurements: {
          "first-pass-comparison": {
            bounded: { passed: bounded.firstPassYield.passed, of: bounded.firstPassYield.of },
            embedded: { passed: embedded.firstPassYield.passed, of: embedded.firstPassYield.of },
          },
          tokenRatio: Number((bounded.meanCompletionTokens / Math.max(0.01, embedded.meanCompletionTokens)).toFixed(4)),
          wallRatio: Number((bounded.meanElapsedMs / Math.max(0.01, embedded.meanElapsedMs)).toFixed(4)),
        },
      }),
    },
  };

  try {
    commitAdmittedEvidence({ lease: attempt, evidence });
    process.removeListener("exit", abortOnExit);
  } catch (error) {
    process.removeListener("exit", abortOnExit);
    process.stderr.write(`c3-cohort: evidence commit refused: ${error.message}\n`);
    return 5;
  }

  const line = (label, s) => `  ${label.padEnd(22)} ${String(s.firstPassYield.passed + "/" + s.firstPassYield.of).padEnd(9)} ${String(s.firstPassYield.value).padEnd(9)} [${s.firstPassYield.ciLow}, ${s.firstPassYield.ciHigh}]`;
  process.stdout.write([
    `C3 BOUNDED WORK ORDER COHORT · ${bounded.articles} articles per arm · ${model}`,
    "",
    `                         passed    yield     95% interval`,
    line("bounded station", bounded),
    line("embedded in review", embedded),
    "",
    `  yield difference: ${evidence.results.yieldDifference}   intervals overlap: ${evidence.results.intervalsOverlap}`,
    `  bounded rejections:  ${JSON.stringify(bounded.rejectionsByReason)}`,
    `  embedded rejections: ${JSON.stringify(embedded.rejectionsByReason)}`,
    `  mean completion tokens: bounded ${bounded.meanCompletionTokens}, embedded ${embedded.meanCompletionTokens}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { abortAdmittedAttempt, beginAdmittedAttempt, CATALOG, commitAdmittedEvidence, FIXTURES, gauge, main, validateC3Preregistration, wilson };
