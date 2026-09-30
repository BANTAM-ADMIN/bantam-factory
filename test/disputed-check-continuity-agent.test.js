import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { pendingContractAudit } from "../src/contract-audit-recovery.js";

const TASK = "Implement and export synchronous collectItems(token, items) in src/items.js. "
  + "items must be an array. token must be a nonempty string for every call, including empty arrays. "
  + "Return an array preserving order. Invalid inputs must throw an Error. Run npm test.";
const SOURCE = "export function collectItems(token, items) { "
  + "if (!Array.isArray(items)) throw Error('items'); "
  + "if (typeof token !== 'string' || !token.length) throw Error('token'); "
  + "return [...items]; }\n";
const CORRECTION = "DISPUTED_ORDER_CORRECTION: the failed check expected sorted output, "
  + "but the public contract preserves input order. For collectItems('valid', [2, 1]), "
  + "the required output is [2, 1], not [1, 2]. Correct the assertion instead of production. "
  + "The corrected focused assertion has not run yet. "
  + "FINAL_WITNESS_PASSED means verification is complete. Emit done.";
const WRONG_CHECK = "node --input-type=module -e \"import assert from 'node:assert/strict'; "
  + "import {collectItems} from './src/items.js'; "
  + "assert.deepEqual(collectItems('valid', [2, 1]), [1, 2]);\"";

test("a disputed-check correction survives a configured PASS without granting focused proof or DONE", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-disputed-check-continuity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    type: "module", scripts: { test: "node --test test/public.test.js" },
  }));
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; "
    + "import {collectItems} from '../src/items.js'; "
    + "test('preserves order', () => assert.deepEqual(collectItems('valid', [2, 1]), [2, 1]));\n";
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), publicTest);

  const actions = [
    { a: "write_file", p: "src/items.js", content: SOURCE },
    { a: "shell", c: "npm test" },
    { a: "shell", c: WRONG_CHECK },
    { a: "shell", c: "npm test" },
    { a: "done", summary: "FINAL_WITNESS_PASSED; all verification complete." },
  ];
  const thoughtPrompts = [], actionPrompts = [], events = [];
  let cursor = 0, audits = 0;
  const live = process.env.BANTAM_LIVE_SANDBOX_TEST === "1";
  const result = await runAgent({
    workspace, task: TASK, maxTurns: actions.length, maxInvalidPerTurn: 0, terminalClosureTurns: 0,
    promptTrajectory: "extension", extensionBareHistory: true, thinkMode: "always",
    useGrammar: true, interactive: false, grounding: false,
    shellSandbox: live ? "docker" : "host", verificationWorkspaceReadOnly: live,
    verificationScript: "npm test", completionAudit: false,
    stateAudit: "off", contractStateAudit: "auto", contractAssertionStation: "off",
    copyPreservationStation: "off", assertionGrounding: false,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false, progressAwareness: false,
    preGate: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent: event => events.push(event),
    model: {
      assistantPrefill: "<|im_start|>assistant\n<think>\n</think>\n\n",
      thinkMarkers: { open: "<think>\n", close: "</think>" }, stop: [], actTemperature: null,
      async complete(prompt) {
        if (prompt.includes("You are a source-code state-machine auditor.")) {
          audits++;
          return { content: JSON.stringify({ findings: [{
            entrypoint: "collectItems", requirement: "Return an array preserving order.",
            location: "src/items.js: collectItems return", fixture: "collectItems('valid', [2, 1])",
            expected: "[1, 2]", predicted: "[2, 1]",
            contrast: { observable: "returned array", expectedJson: "[1,2]", predictedJson: "[2,1]" },
          }], note: "Unverified source-review hypothesis; execute the public API assertion." }), tokens: 1 };
        }
        if (prompt.endsWith("<think>\n")) {
          thoughtPrompts.push(prompt);
          return { content: cursor === 3 ? CORRECTION : "Use public requirements and current execution evidence.",
            tokens: 1, stoppedEos: true };
        }
        actionPrompts.push(prompt);
        assert.ok(cursor < actions.length, "deterministic action script has a fixed bound; no live model calls");
        return { content: JSON.stringify(actions[cursor++]), tokens: 1, stoppedEos: true };
      },
    },
  });

  assert.equal(cursor, actions.length);
  assert.equal(audits, 1, "unchanged production cannot spend another audit");
  assert.equal(result.turns.length, actions.length);
  assert.equal(thoughtPrompts.length, actions.length);
  assert.equal(actionPrompts.length, actions.length);
  assert.equal(result.turns[1].verificationEvidence.status, "pass");
  assert.ok(result.turns[1].contractStateAudit, "a real admitted audit creates the focused obligation");
  assert.equal(result.turns[2].shellExecution.executedCommand, WRONG_CHECK);
  assert.equal(result.turns[2].shellExecution.exitCode, 1, "the self-authored wrong expectation actually fails");
  assert.equal(result.turns[3].reasoning, CORRECTION, "shell-action reasoning remains in the immutable journal");
  assert.equal(result.turns[3].verificationEvidence.status, "pass", "the public suite genuinely passes");
  assert.equal(result.turns[2].shellExecution.generation, result.turns[3].verificationEvidence.generation,
    "no production change explains the transition from failed focused check to passing public suite");
  const pending = pendingContractAudit(result.turns.slice(0, 4), {
    generation: result.turns[3].verificationEvidence.generation, configuredCommand: "npm test",
    verificationWorkspaceReadOnly: live, workspace: fs.realpathSync(workspace),
  });
  assert.equal(pending?.needsFocused, true, "the correction and unrelated green cannot create focused proof");
  assert.equal(result.turns[4].doneAccepted, false, "even an explicit private success claim cannot authorize DONE");
  assert.equal(result.reachedDone, false);
  assert.match(result.turns[4].observation, /focused-execution/);
  assert.ok(events.some(event => event.type === "contract_audit_recovery"));
  assert.equal(fs.readFileSync(path.join(workspace, "src/items.js"), "utf8"), SOURCE);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);

  const nextDecision = thoughtPrompts[4];
  assert.match(nextDecision, /focused-execution/, "the next actual model decision retains the unresolved gate");
  assert.ok(nextDecision.includes(CORRECTION),
    "the next actual thought prompt must retain the complete bounded dispute, even beside a same-turn public PASS");
  const noteOffset = nextDecision.lastIndexOf(CORRECTION);
  const noteHeader = nextDecision.slice(nextDecision.lastIndexOf("[working-checkpoint", noteOffset), noteOffset);
  assert.match(noteHeader, /^\[working-checkpoint from turn 4; model hypothesis, NOT verified evidence[^\]]*\]\n$/,
    "retained private reasoning must remain qualified rather than becoming controller proof");
  assert.match(nextDecision.slice(noteOffset + CORRECTION.length, noteOffset + CORRECTION.length + 700),
    /does not establish PASS, invalidate a test, or authorize DONE/,
    "the dangerous success claim remains explicitly subordinate to execution authority");
});
