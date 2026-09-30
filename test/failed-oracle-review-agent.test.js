import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { pendingContractAudit } from "../src/contract-audit-recovery.js";

const TASK = "Implement synchronous collectItems(token, items) in src/items.cjs. "
  + "items must be an array; token must be a nonempty string even for empty arrays. "
  + "Return items in their original order. Invalid calls must throw Error. Run npm test.";
const REQUIREMENT = "Return items in their original order.";
const GOOD = "// CANDIDATE_PRIVATE_BODY\nfunction collectItems(token, items) { "
  + "if (!Array.isArray(items) || typeof token !== 'string' || !token.length) throw Error('invalid'); "
  + "return [...items]; }\nmodule.exports = {collectItems};\n";
const BAD = GOOD.replace("return [...items]", "return [...items].sort()");
const write = (p, content) => ({ a: "write_file", p, content });
const shell = c => ({ a: "shell", c });
const VERIFY = shell("npm test");
const DONE = { a: "done", summary: "The review says the checks are grounded, so finish." };
const check = (input = [2, 1], expected = input) => "const assert = require('node:assert/strict');\n"
  + "const {collectItems} = require('./src/items.cjs');\n"
  + "assert.deepEqual(collectItems('valid', []), []);\n"
  + `assert.deepEqual(collectItems('valid', ${JSON.stringify(input)}), ${JSON.stringify(expected)});\n`;
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const answer = (verdict = "grounded", reason = "The check observes the required order.") => ({
  content: JSON.stringify({ requirement: verdict === "revise" ? REQUIREMENT : "", reason, verdict }),
  tokens: 1, stoppedEos: true,
});

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-failed-oracle-review-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test test/public.test.cjs" } }));
  fs.writeFileSync(path.join(workspace, "src/items.cjs"), "module.exports.collectItems = () => { throw Error('TODO'); };\n");
  fs.writeFileSync(path.join(workspace, "test/public.test.cjs"), "const test = require('node:test'); const assert = require('node:assert/strict'); "
    + "const {collectItems} = require('../src/items.cjs'); test('empty input', () => assert.deepEqual(collectItems('valid', []), []));\n");
  return workspace;
}

async function run(workspace, actions, { siteAnswer = () => answer("revise", "The fixture is [2,1], so original order requires [2,1], not the selected [1,2] expectation."), ...extra } = {}) {
  let cursor = 0;
  const sitePrompts = [], bundlePrompts = [], actionPrompts = [], events = [];
  const live = process.env.BANTAM_LIVE_SANDBOX_TEST === "1";
  const result = await runAgent({
    workspace, task: TASK, maxTurns: actions.length, maxInvalidPerTurn: 0, terminalClosureTurns: 0,
    verificationScript: "npm test", assertionGrounding: true,
    useGrammar: true, interactive: false, grounding: false,
    shellSandbox: live ? "docker" : "host", verificationWorkspaceReadOnly: live,
    completionAudit: false, stateAudit: "off", contractStateAudit: "auto",
    contractAssertionStation: "off", copyPreservationStation: "off", diagnoseStuckTests: false,
    testFocus: false, regressionGuard: false, progressAwareness: false, preGate: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent: event => events.push(event),
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
      if (prompt.includes("SELECTED ASSERTION SITE REVIEW:")) {
        sitePrompts.push(prompt);
        return siteAnswer(prompt, sitePrompts.length);
      }
      if (prompt.includes("Review the ASSERTION") || prompt.includes("Review COVERAGE")) {
        bundlePrompts.push(prompt);
        return answer(); // Deliberately imperfect original whole-bundle admission.
      }
      if (prompt.includes("You are a source-code state-machine auditor.")) {
        return { content: JSON.stringify({ findings: [], note: "Execute a focused public API assertion." }), tokens: 1 };
      }
      if (prompt.includes("Propose ONE small discriminating assertion")) {
        return { content: JSON.stringify({ assertion: "" }), tokens: 1 };
      }
      actionPrompts.push(prompt);
      assert.ok(cursor < actions.length, "deterministic model cannot request extra actions");
      return { content: JSON.stringify(actions[cursor++]), tokens: 1, stoppedEos: true };
    } }, ...extra,
  });
  return { result, sitePrompts, bundlePrompts, actionPrompts, events, cursor, live };
}

function pending(result, workspace, live) {
  return pendingContractAudit(result.turns, {
    generation: result.turns.at(-1).workspaceCoherence.generation,
    configuredCommand: "npm test", verificationWorkspaceReadOnly: live, workspace: fs.realpathSync(workspace),
  });
}

test("a wrongly admitted mixed bundle gets a source-blind site objection cached across production-only edits", async t => {
  const workspace = fixture(t), wrong = check([2, 1], [1, 2]);
  const { result, sitePrompts, bundlePrompts, events, cursor, live } = await run(workspace, [
    write("src/items.cjs", GOOD), write("check-order.cjs", wrong), VERIFY,
    shell("node check-order.cjs"),
    write("src/items.cjs", GOOD + "// Unrelated production-only revision.\n"), VERIFY,
    shell("node check-order.cjs"), DONE,
  ]);
  assert.equal(cursor, 8);
  assert.equal(result.turns[3].shellExecution.exitCode, 1);
  const record = result.turns[3].failedAssertionReview;
  assert.ok(record, "the real named-script failure has an exact selected-site review");
  assert.equal(record.review.verdict, "revise");
  assert.equal(record.review.authority, "assertion-site-only");
  assert.equal(record.executionEvidence, false);
  assert.equal(record.assertion, wrong, "retain exact pre-admission script bytes");
  assert.equal(record.sourceSha256, digest(wrong));
  assert.equal(record.focusSite.line, 4, "select the failing second assertion, not the passing first one");
  assert.equal(record.focusSite.expression, "assert.deepEqual(collectItems('valid', [2,1]), [1,2])");
  assert.equal(record.admissionPromptSha256, digest(bundlePrompts[0]));
  assert.deepEqual(record.execution, result.turns[3].shellExecution);
  assert.deepEqual(record.execution, result.turns[3].verificationReceipts.entries[0].shellExecution);
  assert.equal(record.execution.cwd, fs.realpathSync(workspace));
  assert.match(record.execution.sandbox, live ? /^docker:/ : /^host:/);
  assert.match(result.turns[3].observation, /EXECUTED AND FAILED/);
  assert.doesNotMatch(result.turns[3].observation, /Check NOT EXECUTED/);
  assert.equal(sitePrompts.length, 1, "production edits cannot reroll the selected expectation");
  assert.equal(bundlePrompts.length, 1, "the cached negative bundle review precedes generation-keyed positive admission");
  assert.ok(!sitePrompts[0].includes("CANDIDATE_PRIVATE_BODY"));
  assert.ok(!sitePrompts[0].includes("AssertionError [ERR_ASSERTION]"), "runtime output is withheld from the independent reviewer");
  assert.ok(sitePrompts[0].includes(REQUIREMENT));
  assert.match(sitePrompts[0], /"focusSite":/);
  assert.equal(result.turns[6].shellExecution, null, "identical rejected script cannot execute on a new production generation");
  assert.match(result.turns[6].observation, /identical script previously EXECUTED AND FAILED/);
  assert.ok(events.some(event => event.type === "assertion_grounding" && event.review.cachedFailedAssertion));
  assert.deepEqual(events.find(event => event.type === "failed_assertion_review").failedAssertionReview, record);
  assert.ok(events.some(event => event.type === "observation" && event.failedAssertionReview?.siteKey === record.siteKey));
  assert.equal(pending(result, workspace, live)?.needsFocused, true);
  assert.equal(result.reachedDone, false);
});

test("grounding a real failed site never grants proof, repeated sites do not reroll, and only two new sites are reviewed", async t => {
  const workspace = fixture(t);
  const { result, sitePrompts, cursor, live } = await run(workspace, [
    write("src/items.cjs", BAD),
    write("check-one.cjs", check([2, 1])), write("check-two.cjs", check([3, 1])), write("check-three.cjs", check([4, 1])), VERIFY,
    shell("node check-one.cjs"), write("src/items.cjs", BAD + "// Same defect on a new generation.\n"),
    shell("node check-one.cjs"), shell("node check-two.cjs"), shell("node check-three.cjs"), DONE,
  ], { siteAnswer: () => answer("grounded", "Each selected array must retain the specified input order; the selected expectation does so.") });
  assert.equal(cursor, 11);
  for (const index of [5, 7, 8, 9]) assert.equal(result.turns[index].shellExecution.exitCode, 1);
  assert.equal(sitePrompts.length, 2);
  assert.equal(result.metrics.failedAssertionReviews, 2);
  assert.equal(result.turns[5].failedAssertionReview.review.verdict, "grounded");
  assert.equal(result.turns[8].failedAssertionReview.review.verdict, "grounded");
  assert.equal(result.turns[7].failedAssertionReview, undefined, "same script/site across production edits consumes no second review");
  assert.equal(result.turns[9].failedAssertionReview, undefined, "third distinct site cannot exceed the fixed budget");
  assert.match(result.turns[5].observation, /failed execution remains unresolved/);
  assert.equal(pending(result, workspace, live)?.needsFocused, true);
  assert.equal(result.reachedDone, false);
  assert.equal(result.turns.at(-1).doneAccepted, false);
});

test("targeted reviewer exhaustion is advisory and retains the completed failed execution", async t => {
  const workspace = fixture(t);
  const { result, sitePrompts, cursor, live } = await run(workspace, [
    write("src/items.cjs", GOOD), write("check-order.cjs", check([2, 1], [1, 2])), VERIFY,
    shell("node check-order.cjs"), DONE,
  ], { siteAnswer: () => ({ content: "incomplete JSON", tokens: 1 }) });
  assert.equal(cursor, 5, "optional reviewer exhaustion does not terminally stop the worker");
  assert.equal(sitePrompts.length, 2, "one site review retains the existing bounded format retry");
  assert.equal(result.turns[3].shellExecution.exitCode, 1);
  assert.equal(result.turns[3].failedAssertionReview.review.verdict, "unknown");
  assert.equal(result.turns[3].failedAssertionReview.review.reviewFailure.exhausted, true);
  assert.equal(result.controllerStop, null);
  assert.equal(result.reachedDone, false);
  assert.equal(pending(result, workspace, live)?.needsFocused, true);
});

test("cancellation during optional site review preserves the already completed failed shell and stops", async t => {
  const workspace = fixture(t), controller = new AbortController();
  const { result, cursor, sitePrompts } = await run(workspace, [
    write("src/items.cjs", GOOD), write("check-order.cjs", check([2, 1], [1, 2])), VERIFY,
    shell("node check-order.cjs"), DONE,
  ], { signal: controller.signal, siteAnswer: () => {
    controller.abort(Error("operator canceled optional review"));
    return answer("revise", "This returned response must not acquire authority after cancellation.");
  } });
  assert.equal(cursor, 4, "no action is sampled after the operator cancellation");
  assert.equal(sitePrompts.length, 1);
  assert.equal(result.interrupted, true);
  assert.equal(result.reachedDone, false);
  assert.equal(result.turns.length, 4, "the already completed failing action remains in the film");
  const final = result.turns.at(-1);
  assert.equal(final.shellExecution.exitCode, 1);
  assert.deepEqual(final.failedAssertionReview.execution, final.shellExecution);
  assert.equal(final.failedAssertionReview.review.verdict, "unknown");
  assert.equal(final.failedAssertionReview.review.interrupted, true);
});

test("shell-expanded inline source cannot create an exact-source site review or negative cache", async t => {
  const workspace = fixture(t);
  const expanded = "node -e \"const assert=require('node:assert/strict'); "
    + "const {collectItems}=require('./src/items.cjs'); "
    + "assert.deepEqual(collectItems('valid',['first']),['$BANTAM_DISPUTED_EXPECTED']);\"";
  const { result, sitePrompts, cursor, events } = await run(workspace, [
    write("src/items.cjs", GOOD), VERIFY, shell(expanded), DONE,
  ], { shellEnvOverrides: { BANTAM_DISPUTED_EXPECTED: "second" } });
  assert.equal(cursor, 4);
  assert.equal(result.turns[2].shellExecution.exitCode, 1, "the expanded assertion actually executes and fails");
  assert.equal(result.turns[2].failedAssertionReview, undefined);
  assert.equal(sitePrompts.length, 0, "pre-expansion script bytes cannot be presented as the exact executed assertion");
  assert.ok(!events.some(event => event.type === "failed_assertion_review"));
  assert.ok(!events.some(event => event.type === "assertion_grounding" && event.review.cachedFailedAssertion));
  assert.equal(result.reachedDone, false);
});

test("artifact-resumed site reviews retain negative cache and budget, but altered bindings do not", async t => {
  for (const variant of ["valid", "source", "site", "receipt"]) {
    const workspace = fixture(t);
    const initial = await run(workspace, [
      write("src/items.cjs", GOOD), write("check-one.cjs", check([2, 1], [1, 2])),
      write("check-two.cjs", check([3, 1], [1, 3])), VERIFY,
      shell("node check-one.cjs"), shell("node check-two.cjs"),
    ]);
    assert.equal(initial.sitePrompts.length, 2, `${variant}: both initial sites consume the budget`);
    const resumeTurns = JSON.parse(JSON.stringify(initial.result.turns));
    const changed = resumeTurns[4].failedAssertionReview;
    if (variant === "source") changed.assertion += "\n";
    if (variant === "site") changed.focusSite.start++;
    if (variant === "receipt") changed.execution.outputSha256 = "f".repeat(64);
    const actions = [
      write("src/items.cjs", GOOD + `// Production-only resumed change: ${variant}.\n`), VERIFY,
      shell("node check-one.cjs"),
      write("check-three.cjs", check([4, 1], [1, 4])), shell("node check-three.cjs"), DONE,
    ];
    const resumed = await run(workspace, actions, { resumeTurns, maxTurns: resumeTurns.length + actions.length });
    const repeated = resumed.result.turns[resumeTurns.length + 2];
    if (variant === "valid") {
      assert.equal(repeated.shellExecution, null, "the artifact-preserved objection still rejects the original script");
      assert.match(repeated.observation, /identical script previously EXECUTED AND FAILED/);
      assert.equal(resumed.sitePrompts.length, 0, "two valid prior reviews leave no new-site budget after resume");
    } else {
      assert.equal(repeated.shellExecution.exitCode, 1, `${variant}: invalid metadata cannot seed a negative rejection`);
      assert.equal(resumed.sitePrompts.length, 1, `${variant}: only the unaltered prior site consumes resumed budget`);
      assert.equal(repeated.failedAssertionReview.review.verdict, "revise");
    }
    const third = resumed.result.turns[resumeTurns.length + 4];
    assert.equal(third.shellExecution.exitCode, 1);
    assert.equal(third.failedAssertionReview, undefined, "a third site cannot buy additional resumed review budget");
    assert.equal(resumed.result.reachedDone, false);
  }
});

test("correcting the disputed check permits actual focused/project verification and DONE without production changes", async t => {
  const workspace = fixture(t), corrected = check([2, 1]);
  const { result, sitePrompts, cursor } = await run(workspace, [
    write("src/items.cjs", GOOD), write("check-order.cjs", check([2, 1], [1, 2])), VERIFY,
    shell("node check-order.cjs"), write("check-order.cjs", corrected), shell("node check-order.cjs"), DONE,
  ]);
  assert.equal(cursor, 7);
  assert.equal(sitePrompts.length, 1);
  assert.equal(result.turns[3].failedAssertionReview.review.verdict, "revise");
  const accepted = result.turns[5];
  assert.equal(accepted.shellExecution.exitCode, 0, "corrected check really executes");
  assert.equal(accepted.failedAssertionReview, undefined);
  assert.ok(accepted.verificationReceipts.entries.some(entry => entry.sequence > 0
    && ["automatic", "landing"].includes(entry.verificationEvidence?.source)
    && entry.verificationEvidence.configuredCommand === "npm test" && entry.verificationEvidence.status === "pass"
    && entry.verificationEvidence.generation === accepted.shellExecution.generation),
  "a fresh configured project execution follows the successful focused check: " + JSON.stringify(accepted.verificationReceipts));
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "src/items.cjs"), "utf8"), GOOD,
    "the bad expectation was corrected without bending production to it");
  assert.equal(fs.readFileSync(path.join(workspace, "check-order.cjs"), "utf8"), corrected);
});
