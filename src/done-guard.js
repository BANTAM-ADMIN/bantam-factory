// Premature-done guard.
//
// In unattended runs the final verifier may be external to the model, so the loop's
// best signal before finishing is the model's own test output. A capable model will sometimes
// write a plausible solution, watch its own tests FAIL, and then call `done` anyway
// — declaring victory it has not earned. `done` must mean "verified working", not
// "I'm out of ideas".
//
// This guard inspects the recent trajectory when `done` is emitted. If the model's
// latest verdict was a failure, or it edited code after its last verification (and
// so never confirmed the change), we veto `done` and push it to keep going. Bounded
// by maxRejections so a false positive can never trap the run forever.
//
// NB: the objection strings below deliberately avoid the verdict tokens this same
// parser keys on (PASS/FAIL/passed/failed), so the fed-back objection can't be
// misread as a test result on the next turn.

import fs from "node:fs";
import path from "node:path";
import { editPaths, turnEditApplied } from "./edit-actions.js";
import { isDeliverableRun, isInlineEvalProbe, isTestCommand } from "./logic/deliverable-signals.js";

// Documentation files cannot be "exercised" by running anything; edits to them
// never anchor the oracle-silence gate. Code masquerading as docs is not a
// concern here — the gate's other callers still count every edit.
const DOC_FILE_RE = /\.(?:md|markdown|rst|txt|adoc)$/i;

/**
 * Did this turn change source? True for a successful edit action, OR a shell command that rewrote a
 * source file (stamped `sourceEditedByShell` by the agent). The latter closes a gap where a model
 * regresses just-verified code via `sed -i`/`>>`/a codegen script — invisible to the edit-action
 * gates — and then declares `done` over the unverified change.
 */
export function turnEditedSource(tn) {
  return turnEditApplied(tn) || tn?.sourceEditedByShell === true;
}

// Parse one observation for a test/verification verdict.
// Returns { isTest, failed }. isTest=false means "no verdict recognized here".
export function analyzeTestResult(text) {
  const t = String(text ?? "");

  // COUNT-based verdicts are authoritative — resolve them BEFORE the loose prose/crash
  // heuristics, so a passing run that merely logs "Error:" somewhere isn't misread.

  // "N / M tests passed"
  const nm = t.match(/(\d+)\s*\/\s*(\d+)\s+tests?\s+passed/i);
  if (nm) return { isTest: true, failed: Number(nm[1]) < Number(nm[2]) };

  // pytest/jest-style "N failed" — scan ALL matches. Multi-suite output can list several
  // counts, and an early "0 failed" must not mask a later "3 failed".
  const failedMatches = [...t.matchAll(/\b(\d+)\s+failed\b/gi)];
  if (failedMatches.length && /passed|error|test/i.test(t)) {
    return { isTest: true, failed: failedMatches.some((x) => Number(x[1]) > 0) };
  }

  // Node's built-in test runner reports TAP totals as "# pass N" / "# fail N".
  // A zero-failure summary is only a clean verdict when at least one test passed;
  // an all-skipped or empty suite must not clear an earlier failure.
  const tapFailMatches = [...t.matchAll(/^\s*#\s*fail\s+(\d+)\s*$/gim)];
  if (tapFailMatches.some((x) => Number(x[1]) > 0)) {
    return { isTest: true, failed: true };
  }
  if (tapFailMatches.length && /^\s*#\s*pass\s+[1-9]\d*\s*$/im.test(t)) {
    return { isTest: true, failed: false };
  }

  // Raw TAP with a plan and NO totals (perl Test::More, plain TAP emitters): "1..N" plus bare
  // ok / not ok lines. Anchored ^ so an all-pass run reads as a clean verdict and a single
  // `not ok` reads as failure — previously this shape produced no verdict at all.
  if (/^1\.\.\d+$/m.test(t)) {
    if (/^not ok \d+/m.test(t)) return { isTest: true, failed: true };
    if (/^ok \d+/m.test(t)) return { isTest: true, failed: false };
  }

  // bun test: bare " N pass" / " N fail" summary lines — no "passed"/"failed" words, lowercase
  // error/fail markers, so nothing above (or below) recognizes this shape.
  const bunFail = t.match(/^\s*(\d+) fail$/m);
  if (bunFail) {
    if (Number(bunFail[1]) > 0) return { isTest: true, failed: true };
    if (/^\s*[1-9]\d* pass$/m.test(t)) return { isTest: true, failed: false };
  }

  // Python's unittest runner is terse on success: dots, a "Ran N tests" line,
  // then "OK". Require a non-empty run so empty discovery cannot clear a
  // previously observed failure.
  if (/^Ran\s+[1-9]\d*\s+tests?\s+in\b/im.test(t)
      && /^OK(?:\s+\([^\n]*\))?\s*$/im.test(t)) {
    return { isTest: true, failed: false };
  }

  // Explicit passed-count with NO failed-count anywhere -> clean pass. Authoritative, so it
  // wins over the loose crash/prose heuristics below (a green run may still print "Error:").
  if (/\b\d+\s+passed\b/i.test(t) && !/\bfailed\b/i.test(t)) return { isTest: true, failed: false };

  // uppercase FAIL/FAILED verdict (case-sensitive: prose "failure" must not trip it)
  if (/(^|[\s:>✗x])FAIL(ED)?(\W|$)/.test(t)) return { isTest: true, failed: true };

  // crashes / assertion failures (reached only when no explicit count resolved the verdict)
  if (/Traceback \(most recent call last\)|AssertionError|panicked|\bError:\s/.test(t)) {
    return { isTest: true, failed: true };
  }

  // remaining clean-pass signals (only when nothing failure-y is present)
  const clean = !/\bfail|error/i.test(t);
  if (clean && /all tests? passed/i.test(t)) return { isTest: true, failed: false };
  if (clean && /(^|[\s:>])PASS(\W|$)/.test(t)) return { isTest: true, failed: false }; // uppercase PASS verdict

  return { isTest: false, failed: false };
}

/**
 * Resolve a turn's verification outcome from both runner output and the shell's
 * authoritative exit status. Some runners (notably `go test`) are silent when
 * successful, so output parsing alone cannot clear an earlier failure.
 * @returns {"pass"|"fail"|null}
 */
export function verificationVerdict(turn) {
  // A shell command that mutated protected grader/config/scope paths is never
  // valid verification evidence, even if its captured stdout looked green.
  // The transactional scope guard restores those paths and stamps the turn;
  // fail closed until the model fixes source and re-runs the original check.
  if (turn?.shellScopeRollback?.violations?.length) return "fail";

  // New turns carry an execution-bound record. Never reinterpret their rendered
  // commentary as runner evidence. Keep the old parser only for historical films.
  if (Object.hasOwn(turn ?? {}, "verificationEvidence")) {
    const status = turn.verificationEvidence?.status;
    return status === "pass" || status === "fail" ? status : null;
  }

  // Trusted provenance beats parsed text: if the HARNESS itself ran a scoped verification for this
  // turn (test-impact graph + framework registry), its stamped verdict is authoritative and cannot
  // be spoofed — the model authors observation text, never a turn field. See agent.js scoped-verify.
  const stamped = turn?.scopedVerify?.verdict;
  if (stamped === "pass" || stamped === "fail") return stamped;

  // Tool/edit/read observations are not test runs. In the Tetris replay, a
  // transactional edit refusal ending in `game.js:22:42 failed to parse`
  // accidentally matched the loose "N failed" parser and became a phantom red
  // suite. Keep cautious failure parsing for shell output, but require shell
  // provenance before prose can become a verdict.
  const action = turn?.action ?? turn?.parsedAction ?? {};
  if (action.a !== "shell") return null;

  const parsed = analyzeTestResult(turn?.observation);
  if (parsed.isTest) {
    // A failure-looking observation is real evidence of a problem, whatever produced it. But a PASS is
    // only trusted from an actual deliverable run (ranVerification): otherwise `echo "5 passed"` or a
    // `cat` of a stale results log would spoof the inner honesty gates (premature-done clearance and the
    // completion-audit precondition). This binds a trusted green to provenance, not to model-printed text.
    if (parsed.failed) return "fail";
    return ranVerification(turn) ? "pass" : null;
  }
  if (!ranVerification(turn)) return null;

  const exit = String(turn?.observation ?? "").match(/^\s*exit\s+(-?\d+)\s*$/mi);
  if (!exit) return null;
  return Number(exit[1]) === 0 ? "pass" : "fail";
}

// Automatic/scoped verification belongs to the runner that actually executed,
// not to the edit action that caused it. Historical films retain their stamp.
function verificationCommand(turn) {
  if (Object.hasOwn(turn ?? {}, "verificationEvidence")) {
    return String(turn.verificationEvidence?.command ?? "").trim();
  }
  return String(turn?.scopedVerify?.command
    ?? (turn?.action ?? turn?.parsedAction ?? {}).c ?? "").trim();
}

function isSuiteVerification(turn) {
  const evidence = turn?.verificationEvidence;
  return Boolean(evidence?.configuredCommand)
    || evidence?.source === "automatic" || evidence?.source === "scoped"
    || (!Object.hasOwn(turn ?? {}, "verificationEvidence")
      && (turn?.scopedVerify?.verdict === "pass" || turn?.scopedVerify?.verdict === "fail"))
    || isTestCommand(verificationCommand(turn));
}

function verificationIsCurrent(turn, workspaceGeneration) {
  // Older replay records have no generation; preserve index-based compatibility
  // for those alone. New receipts need a generation match when one is known.
  if (!Number.isInteger(workspaceGeneration)
      || !Object.hasOwn(turn ?? {}, "verificationEvidence")) return true;
  return Number.isInteger(turn.verificationEvidence?.generation)
    && turn.verificationEvidence.generation === workspaceGeneration;
}

const SECRET_CLEANUP_TASK_RE = /\b(?:sanitize|saniti[sz]e|remove|clean|redact|scrub)\b[\s\S]{0,120}\b(?:secrets?|credentials?|api\s*keys?|tokens?|passwords?|github|hugging\s*face|aws)\b|\b(?:secrets?|credentials?|api\s*keys?|tokens?|passwords?|github|hugging\s*face|aws)\b[\s\S]{0,120}\b(?:sanitize|saniti[sz]e|remove|clean|redact|scrub)\b/i;
const SECRET_SEARCH_RE = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{10,}|(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|HUGGINGFACE_TOKEN|HF_TOKEN)\s*[:=]\s*["']?[^"'\s<>]{8,})\b/i;
const SECRET_QUERY_RE = /\b(?:AKIA|AWS_ACCESS|AWS_SECRET|GITHUB_TOKEN|HUGGINGFACE|HF_TOKEN|ghp_|gho_|ghs_|ghu_|github_pat_|hf[_-])\b/i;
const HIGH_CONFIDENCE_SECRET_QUERY_RE = /AKIA\[[^\]]+\]\{16\}|hf_\[[^\]]+\]\{10,|github_pat_|gh[pousr]_\[[^\]]+\]/i;
const HIT_LINE_RE = /(?:^|\n)(?:\s*)(?:\.\/)?([^:\n]{1,260}):\d+(?::\d+)?:([^\n]*)/g;

/**
 * Decide whether to veto a `done` action. Returns an objection string to feed back,
 * or null to allow `done` through.
 * @param {Array<{action?:object, parsedAction?:object, observation?:string}>} turns
 * @param {number} alreadyRejected  how many times we have already vetoed done this run
 */
// A build task that changed nothing cannot be finished.
//
// v21 read for 28 turns, edited nothing, and emitted:
//   done: "I've implemented the `bantam exec` headless mode..."
// The workspace was pristine. Every gate let it through — premature_done bails
// out when the model never ran a test (`if (lastTestIdx === -1) return null`),
// and the run's verifier was `node --test test/`, which is of course GREEN on an
// untouched repo. Done plus a green suite read as success, so the harness
// certified a claim that was false on disk.
//
// Nothing about the model's confidence is evidence. The working tree is.
// "Make npm test pass by finishing two pieces of surgery" (card 20) carried
// none of the original verbs, so empty_done classified a five-module build
// job as a read-only ask and a blocked done sailed through on an untouched
// tree. Build work also arrives as make-X-pass / finishing / repairing.
const BUILD_TASK_RE = /\b(build|implement|add|create|write|fix|refactor|port|migrate|wire|finish(ing|ed)?|complet(e|ing|ed)|repair(ing|ed)?|patch(ing|ed)?|extend(ing|ed)?)\b|\bmake\b[^.!?]{0,80}\bpass(es|ing)?\b/i;

export function emptyDoneObjection(turns, alreadyRejected = 0, opts = {}) {
  const { task = "", maxRejections = 2 } = opts;
  if (alreadyRejected >= maxRejections) return null;      // never trap forever
  if (!BUILD_TASK_RE.test(String(task))) return null;      // a read-only ask may end with no edits
  if ((turns || []).some((tn) => turnEditedSource(tn))) return null;

  return "You called done, and this run has not written a single byte to the workspace. Not one edit has "
    + "landed on disk. Whatever you believe you implemented, it does not exist — you have been reading and "
    + "planning, and a plan is not a deliverable.\n\n"
    + "If the verifier passed, that proves nothing: it passed because the repository is UNCHANGED, exactly as "
    + "it was before you started.\n\n"
    + "Name the first file the task requires you to change, and edit it now.";
}

// A REPEAT of a byte-identical `done` is not a second attempt, and must not be
// paid for out of the same budget as one.
//
// The budget exists so a run is never trapped forever: after `maxRejections`
// objections, done stands. That is right for a model that reads the objection,
// tries something, and comes back. It is exactly wrong for one that re-sends
// the SAME summary verbatim -- that model has not engaged with the objection at
// all, and under a plain counter, repeating yourself is the FASTEST way to
// exhaust the gate and get through. The wrong move was the lit button.
//
// Measured across the 2026-08-21 sweep, on runs that claimed done and scored 0:
//   build-cython-ext   4 dones, 3 byte-identical
//   query-optimize     3 dones, 2 byte-identical
//   rstan-to-pystan    4 dones, 3 byte-identical  (repeating "sampling reached
//                      100%" about a BACKGROUND job whose log it never read)
//   dna-insert         3 dones, 1 byte-identical
//
// So verbatim repeats no longer consume the budget; only a CHANGED done does,
// which is the cheapest available proxy for "the model actually engaged". The
// anti-wedge property is preserved two ways: a run making genuine attempts
// still gets through after maxRejections, and a run that will only ever repeat
// itself is released after maxVerbatimRepeats so it cannot spin to the turn cap.
export function prematureDoneObjection(turns, alreadyRejected = 0, opts = {}) {
  const { maxRejections = 2, maxVerbatimRepeats = 4 } = opts;
  const all = turns || [];
  const summaries = all
    .map((tn) => (tn?.action ?? tn?.parsedAction ?? {}))
    .filter((a) => a.a === "done")
    .map((a) => String(a.summary ?? ""));
  let verbatimRepeats = 0;
  for (let i = 1; i < summaries.length; i++) {
    if (summaries[i] === summaries[i - 1]) verbatimRepeats++;
  }
  if (verbatimRepeats >= maxVerbatimRepeats) return null;      // never trap forever
  if (alreadyRejected - verbatimRepeats >= maxRejections) return null;

  const objection = prematureDoneCore(all, opts);
  if (!objection) return null;
  if (verbatimRepeats === 0) return objection;
  return objection
    + "\n\n[repeat] This is the same `done` summary you already sent, word for word. "
    + "Re-sending it does not answer the objection above and does not make it true — "
    + "the check named there has still never come back clean. Do not call done again "
    + "until you have RUN that command in a shell this turn and READ its output. "
    + "If the thing you are asserting happened in a BACKGROUND job, you have not seen it: "
    + "read the log or the output file itself (copy it into the workspace first if it lives "
    + "outside), and confirm the artifacts the task asked for actually exist and hold "
    + "sensible values.";
}

// Does the workspace visibly ship a test suite? Cheap, top-level-only checks:
// a package.json test script, or test files/dirs at the root. Used by the
// never-verified escape hatch above — absence keeps the untestable escape.
function workspaceShipsTests(workspace) {
  if (!workspace) return false;
  try {
    const pkgPath = path.join(workspace, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const t = pkg?.scripts?.test;
      if (t && !/no test specified/i.test(t)) return true;
    }
    const entries = fs.readdirSync(workspace);
    if (entries.some((e) => /^tests?$/i.test(e))) return true;
    if (entries.some((e) => /(\.test\.|\.spec\.|^test_).*\.(m?js|cjs|ts|py)$/.test(e) || /^test_.*\.py$/.test(e))) return true;
  } catch { /* unreadable -> keep the escape */ }
  return false;
}

function prematureDoneCore(turns, opts = {}) {
  // Scan the WHOLE trajectory for the most-recent verdict, not a trailing window: a test
  // that failed 12 turns ago and was never resolved must still block done, even after a
  // long recon/read-only tail pushed it out of any fixed lookback.
  const all = turns || [];
  // Two tiers of verdict. Once the model has run a REAL test command anywhere in
  // the trajectory, only real test commands may update the verdict — a
  // deliverable run echoing `exit: 0` must not outrank the suite. The joblog
  // refactor (.bantam/runs/2026-08-17T16-43-41-374Z.json) is the case this
  // encodes: its own new suite was green at turn 31, five edits followed, and
  // then `node joblog.js > /tmp/x; echo "exit: $?"` at turn 39 read as a PASS
  // verdict — the tool's own output even printed FAILED rows at 37 that read as
  // a fail — so `done` at 41 sailed through with one of its 21 tests newly red.
  // Deliverable-run verdicts remain the only tier for projects with no tests,
  // where they are the best evidence there is.
  // isTestCommand expands launcher payloads (bash -c '…') itself — see
  // deliverable-signals.js — so a suite piped through grep inside quotes
  // classifies correctly here and in ranVerification alike.
  const hasRealTests = all.some((tn) => verificationVerdict(tn) !== null && isSuiteVerification(tn));
  let lastEditIdx = -1, lastTestIdx = -1, lastTestFailed = false, lastTestCommand = null;
  all.forEach((tn, i) => {
    if (turnEditedSource(tn)) lastEditIdx = i;
    const verdict = verificationVerdict(tn);
    if (!verdict) return;
    if (hasRealTests && !isSuiteVerification(tn)) return;
    lastTestIdx = i; lastTestFailed = verdict === "fail";
    lastTestCommand = verificationCommand(tn) || null;
  });

  // Only enforce once the model has shown it CAN verify here (avoids trapping a
  // genuinely un-testable task). But "never ran a test" on a workspace that
  // VISIBLY ships a suite is not un-testable — it is unverified (card 22,
  // BANTAM×SOL: write bucket.js, done, npm test never ran once, sealed MISS).
  if (lastTestIdx === -1) {
    if (lastEditIdx === -1) return null;
    if (!workspaceShipsTests(opts.workspace)) return null;
    return "You edited this workspace and have not run its test suite even once — this project visibly "
      + "ships one (a test script / test files are right there). An edit nobody verified is a guess, "
      + "not a deliverable. Run the suite now (npm test, or the project's configured runner), read the "
      + "verdict, fix what is red, and only then call done.";
  }

  // A restoration can change generation on the SAME turn as its triggering
  // check. Turn ordering alone would otherwise certify the restored tree using
  // a receipt captured before that tree existed.
  if (!verificationIsCurrent(all[lastTestIdx], opts.workspaceGeneration)) {
    return "You called done, but the latest verification belongs to an earlier workspace state. "
      + "The workspace changed or was restored after that check. Re-run the verification on the "
      + "current files before finishing"
      + (lastTestCommand ? ` — \`${lastTestCommand}\` is the one you used` : "") + ".";
  }

  // 1) The most recent verdict was a failure and nothing was edited after it.
  if (lastTestFailed && lastTestIdx >= lastEditIdx) {
    // Declared-baseline escape (bootstrap #2, 2026-08-18): a workspace may
    // carry inherited reds — pre-existing or environmental — declared in
    // .bantam/known-failures.json (ideally generated in the same environment
    // the model tests in). If every failing test NAME in the final output
    // matches a declared entry, the run added nothing and done stands. New
    // names still block; missing/corrupt manifests and unparsable output
    // fail closed to the strict rule. Names, not counts: fix-one-break-one
    // keeps the count and must not slip through.
    const lastVerification = all[lastTestIdx];
    const typed = Object.hasOwn(lastVerification ?? {}, "verificationEvidence");
    const recordedNames = lastVerification?.verificationEvidence?.failingTests;
    const failingNames = typed && Array.isArray(recordedNames)
      ? recordedNames.filter((name) => typeof name === "string" && name.trim())
      : [...String(typed ? lastVerification.verificationEvidence?.rawOutput ?? "" : lastVerification?.observation ?? "")
        .matchAll(/^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/gim)].map((m) => m[1]);
    const declared = loadKnownFailures(opts.workspace);
    const namesComplete = !typed || (lastVerification.verificationEvidence?.failingTestsComplete !== false
      && !(lastVerification.verificationEvidence?.counts?.failed > failingNames.length)
      && lastVerification.verificationEvidence?.countsScope !== "multiple-summaries");
    if (namesComplete && failingNames.length && declared.length
        && failingNames.every((name) => declared.some((known) => name.includes(known) || known.includes(name)))) {
      return null;
    }
    return "You called done, but your most recent test output still shows failing tests. "
      + "The task is not complete. Do not stop here — diagnose the remaining problems, fix "
      + "them, and re-run your tests until they all succeed. You have turns left; use them. "
      + "If some failures are genuinely pre-existing and out of scope, they belong in "
      + ".bantam/known-failures.json — a declared baseline, not a silent shrug.";
  }

  // 2) You edited code after your last verification, so the change is unconfirmed.
  if (lastEditIdx > lastTestIdx) {
    return "You called done, but you changed code after your last test run and never "
      + "re-checked it. Before finishing, run the tests / the command that proves the task "
      + "works and confirm they succeed"
      + (lastTestCommand ? ` — \`${lastTestCommand}\` is the one you used` : "")
      + ". Only then call done again.";
  }

  return null;
}

/** Did this turn run something that exercises the deliverable? */
export function ranVerification(turn) {
  if (Object.hasOwn(turn ?? {}, "verificationEvidence")) {
    const status = turn.verificationEvidence?.status;
    return status === "pass" || status === "fail";
  }
  // A harness-run scoped verify IS a real verification of the deliverable (the harness executed the
  // affected tests itself), so it counts even though this turn's own action was the edit, not a shell.
  if (turn?.scopedVerify?.verdict === "pass" || turn?.scopedVerify?.verdict === "fail") return true;
  const a = (turn && (turn.action || turn.parsedAction)) || {};
  if (a.a !== "shell") return false;
  return isDeliverableRun(a.c);
}

/**
 * Oracle-silence gate: the model changed code and never ran anything that exercises it.
 *
 * prematureDoneObjection deliberately allows done when no verdict was ever seen, so it cannot trap
 * a genuinely un-testable task. That escape hatch is also the fastest path through the loop:
 * write_file then done passes every existing gate, because each one needs prior evidence that a
 * check was attempted. This gate asks the question that needs no such premise.
 *
 * @param {Array<{action?:object, parsedAction?:object, observation?:string}>} turns
 * @param {number} alreadyRejected
 * @param {{maxRejections?: number}} opts
 * @returns {string|null}
 */
export function unverifiedEditObjection(turns, alreadyRejected = 0, opts = {}) {
  const {
    maxRejections = 1,
    latestPreview = null,
    workspaceGeneration = null,
    // Whether ANY real oracle exists for this run (a configured/detected
    // verification script). Presumed true so headless evals keep the hard
    // line; interactive callers pass what they actually detected.
    verifierConfigured = true,
  } = opts;
  if (maxRejections <= 0 || alreadyRejected >= maxRejections) return null;

  const all = turns || [];
  let lastEditIdx = -1;
  let lastEditPath = null;
  let lastVerifyIdx = -1;
  all.forEach((tn, i) => {
    const a = (tn.action || tn.parsedAction || {});
    if (turnEditedSource(tn)) {
      // There is no such thing as exercising markdown: a turn whose edits are
      // all documentation does not move the anchor (the openclaw review was
      // scolded "you changed CODEXTHOUGHTS.md and never ran anything that
      // exercises it", 2026-08-17). A shell source-mutation names no paths and
      // stays conservative: it counts as code.
      const paths = editPaths(a);
      const docsOnly = paths.length > 0 && paths.every((p) => DOC_FILE_RE.test(p));
      if (!docsOnly) {
        lastEditIdx = i;
        // editPaths only knows edit actions; a shell source-mutation names no path (fall back below).
        lastEditPath = paths.at(-1) ?? null;
      }
    }
    if (ranVerification(tn) && verificationIsCurrent(tn, workspaceGeneration)) lastVerifyIdx = i;
  });

  if (lastEditIdx === -1) return null;
  // A current clean browser render is real execution evidence for a web
  // deliverable. It satisfies the broad "you never ran anything" objection,
  // while the dedicated preview gate still rejects red or stale renders. It
  // does not override a genuine shell-test failure handled by premature_done.
  if (latestPreview?.status === "pass"
      && Number.isInteger(latestPreview.generation)
      && latestPreview.generation === workspaceGeneration) {
    return null;
  }
  // `>=`, not `>`: a harness-run scoped verify verifies the edit on the SAME turn (edit and verdict
  // share an index). For model-run shell verifications the edit and the run are always separate turns,
  // so this equality only ever clears the trusted same-turn case — never a genuinely unverified edit.
  if (lastVerifyIdx >= lastEditIdx) return null;

  // Probes (`node -e`, `python -c`) are excluded from ranVerification for a
  // reason: they test what the model already holds in its head, and probe
  // streaks have hidden a red suite (swb2-sympy-rational, thirteen probes,
  // zero suite runs). That physics assumes a suite EXISTS. When no verifier
  // is configured anywhere, a post-edit probe that names the edited file and
  // came back clean is the best exercise this workspace can produce —
  // demanding "the project's tests" instead asks for the impossible (live
  // probe, 2026-08-17: shout() proven with HI BOB, scolded anyway).
  if (!verifierConfigured && lastEditPath) {
    const base = lastEditPath.split("/").at(-1);
    const probed = all.some((tn, i) => {
      if (i <= lastEditIdx) return false;
      const a = (tn.action || tn.parsedAction || {});
      if (a.a !== "shell" || typeof a.c !== "string" || !a.c.includes(base)) return false;
      if (Object.hasOwn(tn, "verificationEvidence") || Object.hasOwn(tn, "shellExecution")) {
        if (tn.verificationEvidence?.status === "pass"
            && verificationIsCurrent(tn, workspaceGeneration)) return true;
        // A raw outer-shell exit cannot overrule a recognized runner failure
        // or an explicitly unavailable receipt from that same execution.
        if (tn.verificationEvidence) return false;
        const run = tn.shellExecution;
        const command = String(run?.command ?? "");
        const exercisesFile = command.includes(base)
          && (isInlineEvalProbe(command) || isDeliverableRun(command, { editedNames: new Set([base]) }));
        return Boolean(exercisesFile && run.exitCode === 0
          && !run.timedOut && !run.interrupted && !run.bufferExceeded && !run.error
          && !run.blocked && !run.invalidated
          && (!Number.isInteger(workspaceGeneration)
            || (Number.isInteger(run.generation) && run.generation === workspaceGeneration)));
      }
      const obs = String(tn.observation ?? "").trim();
      return obs.length > 0 && !obs.startsWith("ERROR");
    });
    if (probed) return null;
  }

  const what = lastEditPath ? `\`${lastEditPath}\`` : "the workspace";
  const advice = verifierConfigured
    ? `Run the project's tests, or the command that proves the change works, read the output, `
      + `and only then call done.`
    : `Run the code you changed — a quick script or probe that imports it and shows the new `
      + `behavior — read the output, and only then call done.`;
  return `You called done, but you changed ${what} and never ran anything that exercises it. ${advice}`;
}

/** Declared inherited reds: .bantam/known-failures.json → array of test-name strings. Fail closed. */
function loadKnownFailures(workspace) {
  if (!workspace) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(`${workspace}/.bantam/known-failures.json`, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.failures;
    return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch { return []; }
}

const REFACTOR_TASK_RE = /\b(?:refactor|restructur|reorganiz|split (?:it|this|.{0,30}?) into|behaviou?r must not change|no behaviou?r change|byte-identical|without changing (?:the )?behaviou?r)\b/i;
const EXIT_CAPTURE_RE = /\$\?|--check-exit|set -e/;

/**
 * Behavior-preservation gate: a refactor's verification must exercise the
 * call surface, not one happy path.
 *
 * Workday pass 3 request 6 ("behaviour must not change AT ALL") preserved
 * stdout byte-for-byte while flipping exit codes in both directions; its one
 * baseline capture was a single invocation. Scoped to refactor-shaped tasks
 * with NO configured verifier — where a real suite exists, suite-green is the
 * contract. Requires, after the last edit, at least two DISTINCT deliverable
 * invocations with exit-code capture.
 */
export function refactorSurfaceObjection(turns, alreadyRejected = 0, opts = {}) {
  const { task = "", verifierConfigured = true, maxRejections = 1 } = opts;
  if (maxRejections <= 0 || alreadyRejected >= maxRejections) return null;
  if (verifierConfigured || !REFACTOR_TASK_RE.test(String(task))) return null;

  const all = turns || [];
  let lastEditIdx = -1;
  all.forEach((tn, i) => { if (turnEditedSource(tn)) lastEditIdx = i; });
  if (lastEditIdx === -1) return null;

  const shapes = new Set();
  all.forEach((tn, i) => {
    if (i <= lastEditIdx) return;
    const a = (tn.action || tn.parsedAction || {});
    if (a.a !== "shell" || typeof a.c !== "string") return;
    if (!isDeliverableRun(a.c) || !EXIT_CAPTURE_RE.test(a.c)) return;
    shapes.add(a.c.replace(/\s+/g, " ").trim());
  });
  if (shapes.size >= 2) return null;

  return `You called done on a behavior-preserving refactor, but after your last edit you verified `
    + `${shapes.size === 0 ? "no invocation with exit codes captured" : "only one invocation shape"}. `
    + `Behavior includes exit codes and stderr across the whole call surface, not just the output you have `
    + `been looking at. Run the tool at least two ways — bare, with normal arguments, and with bad `
    + `arguments — capturing \`; echo "exit=$?"\` each time, compare against the pre-refactor behavior, `
    + `and only then call done.`;
}

/**
 * Secret-removal tasks have a distinct completion failure mode: the model finds a real secret in a
 * path, edits some easier files, then "verifies" with a filtered grep that excludes the previously
 * observed path. If a prior secret-bearing hit is not covered by a post-edit secret search, veto
 * `done` once and name the missed path.
 */
export function secretCleanupObjection(turns, alreadyRejected = 0, opts = {}) {
  const { task = "", maxRejections = 1 } = opts;
  if (maxRejections <= 0 || alreadyRejected >= maxRejections) return null;
  if (!SECRET_CLEANUP_TASK_RE.test(String(task ?? ""))) return null;

  const all = turns || [];
  const lastEditIdx = lastIndexOfEdit(all);
  const hits = secretHitPaths(all);
  if (!hits.length) return null;

  const unresolved = [];
  for (const hit of hits) {
    const auditFromIdx = Math.max(lastEditIdx, hit.turn ?? -1);
    if (postEditStillMatchesSecret(all, hit.path, auditFromIdx)) {
      unresolved.push({ ...hit, reason: "still matched after the last edit" });
      continue;
    }
    if (!postEditVerificationCoversPath(all, hit.path, auditFromIdx)) {
      unresolved.push({ ...hit, reason: "not covered by the final secret search" });
    }
  }
  if (!unresolved.length) return null;

  const paths = unresolved.slice(0, 6).map((h) => `${h.path} (${h.reason})`).join(", ");
  const more = unresolved.length > 6 ? `, and ${unresolved.length - 6} more` : "";
  return "You called done, but earlier search output showed possible secrets in paths that your "
    + `post-edit verification did not actually clear: ${paths}${more}. Re-run a repository-wide `
    + "secret search without filters that exclude those paths, sanitize every remaining hit, and "
    + "only then call done. Do not prove cleanup by grepping with grep -v/filters that omit a path "
    + "where you already observed a secret.";
}

// Pre-done grounding directive. Kept token-clean (no PASS/FAIL/Traceback/AssertionError
// language) so the fed-back objection can't be misread as a test verdict next turn.
const REQUIREMENT_LEDGER_DIRECTIVE =
  "Before done is accepted, produce a REQUIREMENT LEDGER and confirm it. List every hard "
  + "requirement stated in the TASK. For each one write: the requirement, the exact expected "
  + "value it demands, the SOURCE of that expected value, and whether your output meets it. "
  + "The source must be the task text, an external tool's output, or an authoritative "
  + "reference — never your own memory and never your own solution restating itself. This is "
  + "the crux: for any NAMED external standard (a file-format magic number, a protocol "
  + "constant, an API signature, a spec value), a value you recalled from memory is NOT "
  + "grounded — re-establish it from the task or a tool, because a check that asserts your "
  + "own assumption confirms nothing. To ground such a value, first write its exact canonical "
  + "form as a standalone fact with a source, THEN compare your solution against that value "
  + "character by character. Do NOT 'verify' by re-running a check that "
  + "reads the value out of your own solution — that is circular and proves nothing. If your "
  + "written canonical value and your solution disagree, your solution is wrong; fix it. "
  + "Write the ledger (for example to a "
  + "REQUIREMENTS notes file), run the checks that tie each expected value to its true source, "
  + "then call done again. If every requirement is already grounded and met, briefly confirm "
  + "that and call done again.";

/**
 * Pre-done grounding gate. `done` should mean "the TASK's requirements are met and verified
 * against their TRUE sources" — not "my own self-test passed". A capable model will write a
 * competent verifier that checks the wrong premise: it recalls a named constant from memory,
 * asserts that value, watches its own check succeed, and calls done. The self-test was never
 * independent of the assumption it was meant to test.
 *
 * On the first otherwise-acceptable `done`, inject a one-shot requirement-ledger directive:
 * restate each requirement FROM THE TASK, its exact expected value, the SOURCE of that value,
 * and the check result. Bounded by maxRejections (default 1) so it adds at most one audit turn
 * and can never trap the run — the termination path is simply "already rejected enough → allow".
 *
 * @param {Array} turns  trajectory so far (accepted for symmetry / future conditioning)
 * @param {number} alreadyRejected  how many times this gate has fired this run
 */
export function requirementLedgerObjection(turns, alreadyRejected = 0, opts = {}) {
  const { maxRejections = 1 } = opts;
  if (maxRejections <= 0) return null;
  if (alreadyRejected >= maxRejections) return null; // termination path: never trap
  return REQUIREMENT_LEDGER_DIRECTIVE;
}

function lastIndexOfEdit(turns) {
  let idx = -1;
  turns.forEach((tn, i) => {
    if (turnEditApplied(tn)) idx = i;
  });
  return idx;
}

function secretHitPaths(turns) {
  const hits = new Map();
  for (let i = 0; i < (turns || []).length; i++) {
    const action = turns[i]?.action || turns[i]?.parsedAction || {};
    const obs = String(turns[i]?.observation ?? "");
    const trustSearchResult = action.a === "search" && HIGH_CONFIDENCE_SECRET_QUERY_RE.test(String(action.q ?? ""));
    for (const hit of extractSecretHits(obs, { trustSearchResult })) {
      if (!hits.has(hit.path)) hits.set(hit.path, { ...hit, turn: i });
    }
  }
  return [...hits.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function extractSecretHits(observation, { trustSearchResult = false } = {}) {
  const out = [];
  const text = String(observation ?? "");
  for (const match of text.matchAll(HIT_LINE_RE)) {
    const path = normalizeHitPath(match[1]);
    const line = match[2] ?? "";
    if (!path) continue;
    if (!trustSearchResult && !SECRET_SEARCH_RE.test(line)) continue;
    if (!trustSearchResult && /<your-|<path_to_|path_to_|example/i.test(line)) continue;
    out.push({ path, evidence: line.trim().slice(0, 160) });
  }
  return out;
}

function normalizeHitPath(raw) {
  let p = String(raw ?? "").trim();
  p = p.replace(/^\$ .*$/, "");
  p = p.replace(/^# \d+ .*$/, "");
  p = p.replace(/^\.?\//, "");
  p = p.replace(/^\/app\/[^/]+\//, "");
  p = p.replace(/^\/app\//, "");
  p = p.replace(/[),.;:'"]+$/g, "");
  if (!p || p.includes(" ") || /^[a-z]+:\/\//i.test(p)) return null;
  if (p === "cwd" || p === "sandbox" || p === "exit") return null;
  return p;
}

function postEditStillMatchesSecret(turns, path, lastEditIdx) {
  return (turns || []).slice(Math.max(0, lastEditIdx + 1)).some((tn) => {
    return extractSecretHits(tn?.observation).some((hit) => sameOrNestedPath(hit.path, path));
  });
}

function postEditVerificationCoversPath(turns, path, lastEditIdx) {
  return (turns || []).slice(Math.max(0, lastEditIdx + 1)).some((tn) => {
    const a = tn?.action || tn?.parsedAction || {};
    if (a.a === "search") return searchActionCoversPath(a, path);
    if (a.a === "inspect") return (a.ops ?? []).some((op) => op?.a === "search" && searchActionCoversPath(op, path));
    if (a.a === "shell") return shellSecretSearchCoversPath(a.c, path);
    return false;
  });
}

function searchActionCoversPath(action, path) {
  if (!SECRET_QUERY_RE.test(String(action.q ?? ""))) return false;
  return scopeCoversPath(action.p || ".", path);
}

function shellSecretSearchCoversPath(command, path) {
  const c = String(command ?? "");
  if (!/\b(?:grep|rg|git\s+grep)\b/i.test(c) || !SECRET_QUERY_RE.test(c)) return false;
  if (commandExcludesPath(c, path)) return false;
  if (mentionsPath(c, path)) return true;
  return searchesWholeWorkspace(c);
}

function scopeCoversPath(scope, path) {
  const s = normalizeHitPath(scope || ".") || ".";
  if (s === "." || s === "") return true;
  return sameOrNestedPath(path, s);
}

function mentionsPath(command, path) {
  const c = String(command ?? "");
  return pathTokens(path).some((token) => token.length >= 3 && c.includes(token));
}

function searchesWholeWorkspace(command) {
  const c = String(command ?? "");
  return /(?:^|\s)(?:\.|\/app(?:\/[A-Za-z0-9_.-]+)?)\s*(?:2>|$|\||;|&&)/.test(c)
    || /\b(?:grep|rg)\b[\s\S]{0,180}\s\.(?:\s|$)/i.test(c);
}

function commandExcludesPath(command, path) {
  const c = String(command ?? "");
  const tokens = pathTokens(path);
  const excluded = [];
  for (const match of c.matchAll(/\bgrep\s+-v\s+["']?([^"'\s|;&]+)|--exclude(?:-dir)?[= ]["']?([^"'\s|;&]+)|\brg\b[^|;&]*\s-g\s+["']?!([^"']+)/gi)) {
    excluded.push(match[1] || match[2] || match[3] || "");
  }
  return excluded.some((pattern) => tokens.some((token) => token.length >= 3 && pattern.includes(token)));
}

function pathTokens(p) {
  const clean = String(p ?? "").replace(/^\.\//, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return [...new Set([clean, ...parts, parts.at(-1)].filter(Boolean))];
}

function sameOrNestedPath(path, target) {
  const p = String(path ?? "").replace(/^\.\//, "");
  const t = String(target ?? "").replace(/^\.\//, "");
  return p === t || p.startsWith(`${t}/`) || t.startsWith(`${p}/`);
}
