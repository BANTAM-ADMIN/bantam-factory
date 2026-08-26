import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { graderRejectionTargets, taskStatesRejection, auditSpecCoverage, formatSpecCoverage } from "../src/logic/spec-coverage.js";

// Measured 2026-07-30: adapter-migration's hidden grader asserts TypeError
// rejections for normalizeTags and normalizeHeaders that its task text never
// asks for. Writing the requirement in took the same code from 0/3 to 2/3 with
// no gate -- so a grader testing what the spec omits inflates any mechanism
// measured against it, and measures spec-reading luck as much as capability.
// See docs/superpowers/reports/2026-07-30-specification-beats-the-gate.md

const GRADER = `
const rejectsTypeError = (fn) => assert.throws(fn, TypeError);
test("contract", async () => {
  const { normalizeTags, normalizeId } = await load();
  for (const value of [null, "a"]) rejectsTypeError(() => normalizeTags(value));
  assert.deepEqual(normalizeId(" x "), "x");
  assert.throws(() => normalizeHeaders([]), TypeError);
});
`;

test("finds the functions a grader asserts must throw", () => {
  const targets = graderRejectionTargets(GRADER);
  assert.deepEqual([...targets].sort(), ["normalizeHeaders", "normalizeTags"]);
  // normalizeId is only asserted for its return value, not for throwing.
  assert.equal(targets.has("normalizeId"), false);
});

test("detects whether the task states a rejection requirement per function", () => {
  const task = "normalizeTags accepts an array of strings and never mutates the input. "
    + "normalizeHeaders accepts a plain object and rejects non-string values with TypeError.";
  const targets = ["normalizeTags", "normalizeHeaders"];
  assert.equal(taskStatesRejection(task, "normalizeHeaders", targets), true);
  assert.equal(taskStatesRejection(task, "normalizeTags", targets), false);
});

test("counts a function the task never names as uncovered", () => {
  assert.equal(taskStatesRejection("something unrelated entirely.", "normalizeTags"), false);
});

// Real fixtures name a function once and then describe it over several sentences.
// range-parser says "malformed tokens ... throw TypeError" in a sentence that
// never repeats `parseRanges`; strict clause-scoping called that a gap, which was
// a false positive. A sentence that names no OTHER audited function is
// unambiguous in context and must count.
test("credits a rejection stated in a later sentence of a single-function task", () => {
  const task = "parseRanges(text) parses a comma-separated list. "
    + "Empty input returns []; malformed tokens and unsafe integers throw TypeError.";
  assert.equal(taskStatesRejection(task, "parseRanges", ["parseRanges"]), true);
});

test("does not let one function's clause cover another in a multi-function task", () => {
  const task = "normalizeTags accepts an array of strings and never mutates the input. "
    + "parseCount rejects everything else with TypeError.";
  const targets = ["normalizeTags", "parseCount"];
  assert.equal(taskStatesRejection(task, "parseCount", targets), true);
  assert.equal(taskStatesRejection(task, "normalizeTags", targets), false,
    "parseCount's clause must not cover normalizeTags");
});

function fixture(t, task, grader) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-spec-coverage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "grader"), { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ name: "f", task }));
  fs.writeFileSync(path.join(dir, "grader", "contract.test.cjs"), grader);
  return dir;
}

test("reports a gap when the grader demands a throw the task never asks for", (t) => {
  const dir = fixture(t,
    "normalizeTags accepts an array of strings and never mutates the input.",
    'const rejectsTypeError = (fn) => assert.throws(fn, TypeError);\nrejectsTypeError(() => normalizeTags(null));');
  const audit = auditSpecCoverage(dir);
  assert.deepEqual(audit.gaps.map((g) => g.fn), ["normalizeTags"]);
  assert.equal(audit.covered.length, 0);
});

test("reports no gap when the task states the requirement", (t) => {
  const dir = fixture(t,
    "normalizeTags accepts an array of strings and rejects everything else with TypeError.",
    'const rejectsTypeError = (fn) => assert.throws(fn, TypeError);\nrejectsTypeError(() => normalizeTags(null));');
  const audit = auditSpecCoverage(dir);
  assert.deepEqual(audit.gaps, []);
  assert.deepEqual(audit.covered.map((g) => g.fn), ["normalizeTags"]);
});

// The check is sound as a warning and unsound as an all-clear: it works at
// function granularity while a contract lives at rejection-kind granularity.
// adapter-migration's normalizeHeaders states "rejects non-string values" and is
// reported covered, yet never says an array is not a plain object -- the case the
// model actually got wrong. The clean-report wording must not imply completeness.
test("clean output does not claim the spec is complete", (t) => {
  const dir = fixture(t,
    "normalizeTags accepts an array of strings and rejects everything else with TypeError.",
    'assert.throws(() => normalizeTags(null), TypeError);');
  const audit = auditSpecCoverage(dir);
  assert.deepEqual(audit.gaps, []);
  assert.equal(formatSpecCoverage(audit), "", "no warning when nothing is wholly unstated");
  assert.equal(audit.covered.length, 1);
});

test("formats gaps as a benchmark warning, and stays quiet when clean", (t) => {
  const dirty = fixture(t, "normalizeTags accepts an array of strings.",
    'assert.throws(() => normalizeTags(null), TypeError);');
  const text = formatSpecCoverage(auditSpecCoverage(dirty));
  assert.match(text, /normalizeTags/);
  assert.match(text, /grader|spec/i);

  const clean = fixture(t, "normalizeTags accepts an array of strings and rejects everything else with TypeError.",
    'assert.throws(() => normalizeTags(null), TypeError);');
  assert.equal(formatSpecCoverage(auditSpecCoverage(clean)), "");
});

// A semicolon continues a sentence about the SAME function; it does not start a
// new subject. Splitting on it severed "reject everything else with TypeError"
// from the `parseCount` that introduced it, so the audit reported a gap in a
// contract the task states in full. Measured on adapter-migration-explicit: two
// of the nine reported gaps were this false positive, which matters because the
// audit is what decides whether a fixture's spec needs work.
test("a rejection clause after a semicolon still belongs to the named function", () => {
  const task = "parseCount accepts a non-negative integer and returns a number; "
    + "reject everything else with TypeError. "
    + "normalizeLevel accepts a debug/info/warn/error string and returns lowercase.";
  const targets = ["parseCount", "normalizeLevel"];
  assert.equal(taskStatesRejection(task, "parseCount", targets), true);
  // The neighbouring function genuinely says nothing about rejection, and a
  // looser split must not leak parseCount's clause onto it.
  assert.equal(taskStatesRejection(task, "normalizeLevel", targets), false);
});

test("a full stop still separates one function's contract from the next", () => {
  const task = "alpha accepts a string and throws TypeError otherwise. beta accepts a number.";
  const targets = ["alpha", "beta"];
  assert.equal(taskStatesRejection(task, "alpha", targets), true);
  assert.equal(taskStatesRejection(task, "beta", targets), false);
});

// The extractor only matched `() => bareIdentifier(`. keyed-task-pool-strong's
// grader asserts rejection four times -- via `new KeyedTaskPool(...)`, twice via
// `pool.run(...)`, and via a direct `assert.rejects(runPlan([...]))` -- and the
// audit extracted ZERO targets from it, then reported the fixture "covered".
//
// Reporting "clean" when the real answer is "could not parse this grader" is the
// same defect as counting an absent metric as zero, which gate-engagement exists
// to prevent. A silent false negative in an auditing tool is worse than no tool.
test("recognises constructor, method and direct-call rejection assertions", () => {
  const grader = `
    assert.throws(() => new KeyedTaskPool({ concurrency }), RangeError);
    assert.throws(() => pool.run("", () => 1), TypeError);
    await assert.rejects(runPlan([{ key: "" }], fn), TypeError);
    rejectsTypeError(() => normalizeId(value));
  `;
  const targets = graderRejectionTargets(grader);
  for (const expected of ["KeyedTaskPool", "run", "runPlan", "normalizeId"]) {
    assert.ok(targets.has(expected), `missed ${expected} (got: ${[...targets].join(", ")})`);
  }
});

test("reports a grader it cannot parse instead of calling it covered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-cov-"));
  fs.mkdirSync(path.join(dir, "grader"));
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ task: "Do the thing." }));
  // A throw assertion in a shape the extractor does not understand.
  fs.writeFileSync(path.join(dir, "grader", "contract.test.cjs"),
    "assert.throws(someIndirectHelper, TypeError);\n");
  const audit = auditSpecCoverage(dir);
  assert.equal(audit.gaps.length, 0);
  assert.ok(audit.unparsedAssertions > 0, "must record that assertions went unparsed");
  assert.match(formatSpecCoverage(audit), /could not|unparsed|cannot be audited/i);
});

// The model's context is the task text AND the visible test suite. keyed-task-
// pool-strong's task says runPlan "validates its entire array before starting
// work" without naming TypeError, so a task-only audit calls that a gap -- but
// the public suite asserts `assert.rejects(runPlan(...), TypeError)` outright, so
// the requirement IS delivered. Reporting it as a gap would send someone
// rewriting a spec that already works.
test("a requirement the visible test suite asserts is not a spec gap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-cov-"));
  fs.mkdirSync(path.join(dir, "grader"));
  fs.mkdirSync(path.join(dir, "repo", "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"),
    JSON.stringify({ task: "runPlan validates its entire array before starting work." }));
  fs.writeFileSync(path.join(dir, "grader", "contract.test.cjs"),
    "await assert.rejects(runPlan([], fn), TypeError);\n");

  const audit = auditSpecCoverage(dir);
  assert.deepEqual(audit.gaps.map((g) => g.fn), ["runPlan"], "task text alone does not state it");

  fs.writeFileSync(path.join(dir, "repo", "test", "public.test.js"),
    "await assert.rejects(runPlan([{ key: '' }], worker), TypeError);\n");
  const withTests = auditSpecCoverage(dir);
  assert.deepEqual(withTests.gaps, [], "the visible suite delivers the requirement");
  assert.deepEqual(withTests.covered.map((c) => c.fn), ["runPlan"]);
});
