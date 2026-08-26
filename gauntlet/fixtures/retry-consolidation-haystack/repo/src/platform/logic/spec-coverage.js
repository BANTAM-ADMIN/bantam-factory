// Does a fixture's task text state what its hidden grader tests?
//
// Measured 2026-07-30: `adapter-migration`'s grader asserts TypeError rejections
// for normalizeTags and normalizeHeaders that its task never asks for. Writing the
// requirement into the task took the SAME code from 0/3 to 2/3 with no mechanism
// at all, and matched the type_contract gate's pass rate at ~32% fewer turns.
//
// The consequence for measurement is the reason this check exists: a grader that
// asserts something the spec omits measures spec-reading luck as much as
// capability, and inflates any mechanism built against it. A large part of the
// type_contract gate's measured value turned out to be compensating for this one
// fixture defect rather than for the model.
//
// See docs/superpowers/reports/2026-07-30-specification-beats-the-gate.md
// and docs/superpowers/reports/2026-07-30-type-contract-done-gate.md
//
// Deliberately narrow: only the REJECTION contract is checked, because "must
// throw" is the one requirement that is both unambiguous in a grader and cheap to
// find in prose. Return-value expectations are not audited -- matching those to
// prose needs judgement, and a false warning about a benchmark is expensive.

import fs from "node:fs";
import path from "node:path";

// `rejectsTypeError(() => fn(x))`, `assert.throws(() => fn(x), TypeError)`, and
// the `assert.rejects` async form all reduce to: a call inside a throw assertion.
// A grader names the thing under test in four shapes, and matching only the
// first reported keyed-task-pool-strong -- which asserts rejection four times --
// as having zero rejection targets, hence "covered":
//
//   () => fn(x)                    bare call
//   () => new Ctor(x)              constructor
//   () => pool.run(x)              method on an instance
//   assert.rejects(fn(x), Type)    direct call, no arrow (async form)
//
// The receiver is dropped for the method form: the task describes `run(key,
// task)`, not `pool.run`.
const ASSERT_HEAD = "(?:assert\\s*\\.\\s*(?:throws|rejects)|rejects?[A-Za-z]*Error|expectThrows?)";
const CALLEE = "(?:new\\s+)?(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)";
const THROW_ASSERTION = new RegExp(
  `${ASSERT_HEAD}\\s*\\(\\s*(?:async\\s*)?(?:\\(\\s*\\)\\s*=>\\s*)?${CALLEE}\\s*\\(`,
  "g",
);

// Any throw assertion at all, regardless of whether a callee can be read out of
// it. If these appear and no targets do, the grader is unparseable rather than
// free of rejection contracts -- a distinction the audit must not collapse.
const ANY_THROW_ASSERTION = new RegExp(`${ASSERT_HEAD}\\s*\\(`, "g");

/** Functions the grader asserts must throw. */
export function graderRejectionTargets(source) {
  const out = new Set();
  for (const [, fn] of String(source ?? "").matchAll(THROW_ASSERTION)) out.add(fn);
  return out;
}

const REJECTS = /\b(?:reject(?:s|ing)?|throws?|throwing|TypeError|RangeError|must\s+fail|refuses?)\b/i;
const word = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

/**
 * Does the task state a rejection requirement for this function?
 *
 * A sentence counts when it names the function, OR when it names none of the
 * other audited functions — a real task names a function once and then describes
 * it across several sentences, so strict clause-scoping produced false gaps
 * (range-parser states "malformed tokens ... throw TypeError" without repeating
 * `parseRanges`; retry-policy states "Invalid attempts throws TypeError" without
 * repeating `retry`). Requiring the sentence to be unambiguous — naming no other
 * audited function — keeps one function's clause from covering another in a
 * multi-contract task like adapter-migration.
 */
export function taskStatesRejection(task, fn, allTargets = [fn]) {
  const others = [...new Set(allTargets)].filter((t) => t !== fn);
  // Split on the full stop only. A semicolon CONTINUES a sentence about the same
  // function ("parseCount accepts ...; reject everything else with TypeError"),
  // so treating it as a boundary orphans the rejection clause from its subject
  // and reports a gap in a contract the task states in full.
  for (const clause of String(task ?? "").split(/(?<=\.)\s+/)) {
    if (!REJECTS.test(clause)) continue;
    if (word(fn).test(clause)) return true;
    // A rejection sentence that names no function is unambiguous only when `fn`
    // is the SOLE audited function — then there is nothing else it could be
    // about (range-parser, retry-policy). With several audited functions a bare
    // "invalid input throws" could belong to any of them, and crediting all of
    // them would mark adapter-migration clean when it demonstrably is not.
    if (others.length === 0) return true;
  }
  return false;
}

/**
 * Audit one fixture directory (containing task.json and grader/).
 *
 * @returns {{fixture:string,gaps:Array<{fn:string}>,covered:Array<{fn:string}>}}
 */
export function auditSpecCoverage(fixtureDir) {
  let task = "";
  try {
    task = JSON.parse(fs.readFileSync(path.join(fixtureDir, "task.json"), "utf8")).task ?? "";
  } catch { /* no task, nothing to audit */ }

  let grader = "";
  const graderDir = path.join(fixtureDir, "grader");
  try {
    for (const f of fs.readdirSync(graderDir)) {
      if (/\.(?:c?js|mjs)$/.test(f)) grader += fs.readFileSync(path.join(graderDir, f), "utf8") + "\n";
    }
  } catch { /* no grader, nothing to audit */ }

  // The model's context is the task text AND the visible test suite. A contract
  // the public tests assert outright is delivered, whatever the prose omits --
  // keyed-task-pool-strong's task never names TypeError for runPlan, but its
  // public suite asserts `assert.rejects(runPlan(...), TypeError)`, so the
  // requirement reaches the model. Auditing prose alone reports a gap there and
  // sends the next reader rewriting a spec that already works.
  let visible = "";
  const testDir = path.join(fixtureDir, "repo", "test");
  try {
    for (const f of fs.readdirSync(testDir)) {
      if (/\.(?:c?js|mjs)$/.test(f)) visible += fs.readFileSync(path.join(testDir, f), "utf8") + "\n";
    }
  } catch { /* no visible suite */ }
  const assertedInTests = graderRejectionTargets(visible);

  const gaps = [];
  const covered = [];
  const targets = [...graderRejectionTargets(grader)].sort();
  for (const fn of targets) {
    const stated = taskStatesRejection(task, fn, targets) || assertedInTests.has(fn);
    (stated ? covered : gaps).push({ fn });
  }

  // Throw assertions the extractor could not attribute to a callee. Zero targets
  // from a grader that plainly asserts rejection means the audit did not run, and
  // saying "covered" there is a false clean bill.
  const asserted = (grader.match(ANY_THROW_ASSERTION) ?? []).length;
  const unparsedAssertions = Math.max(0, asserted - targets.length);

  return { fixture: path.basename(fixtureDir), gaps, covered, unparsedAssertions };
}

/** Warning text, or "" when the spec covers everything the grader asserts. */
export function formatSpecCoverage(audit) {
  if (!audit) return "";

  // Reported before any gap list, because it bounds what the gap list is worth:
  // assertions the extractor could not attribute were never audited at all, so
  // "no gaps" here means "none found among the ones I could read".
  if (audit.unparsedAssertions > 0) {
    const prefix = `[spec-coverage] ${audit.fixture}: ${audit.unparsedAssertions} throw assertion(s) `
      + "could not be attributed to a function and were NOT audited. "
      + "Treat this fixture as unchecked, not as covered.";
    return audit.gaps.length ? `${prefix}\n${formatGaps(audit)}` : prefix;
  }

  if (!audit.gaps.length) return "";
  return formatGaps(audit);
}

function formatGaps(audit) {
  const names = audit.gaps.map((g) => g.fn).join(", ");
  return `[spec-coverage] ${audit.fixture}: the grader requires ${audit.gaps.length} function(s) `
    + `to throw that the task never asks for: ${names}.\n`
    + "A grader asserting what the spec omits measures spec-reading luck as much as capability, "
    + "and inflates any mechanism measured against it. Either state the requirement in the task "
    + "or drop it from the grader.";
}

// CLI: `node spec-coverage.js <fixtures-dir>` audits every fixture beneath it.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const root = process.argv[2] || "gauntlet/fixtures";
  let dirty = 0;
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const audit = auditSpecCoverage(dir);
    const text = formatSpecCoverage(audit);
    if (text) { dirty += 1; console.log(text + "\n"); }
    // NOT "ok": this check works at function granularity while a contract lives
    // at rejection-kind granularity, so a function can be stated for one rejection
    // and silent about another (adapter-migration's normalizeHeaders states
    // "rejects non-string values" and never says an array is not a plain object --
    // the case the model actually got wrong). Sound as a warning, unsound as an
    // all-clear, and the wording must not invite the stronger reading.
    else if (audit.covered.length) console.log(`[spec-coverage] ${audit.fixture}: no wholly unstated rejection contract (${audit.covered.length} stated; not a completeness check)`);
    else console.log(`[spec-coverage] ${audit.fixture}: no rejection contracts asserted`);
  }
  console.log(`\n${dirty} fixture(s) assert rejections their task does not state.`);
}
