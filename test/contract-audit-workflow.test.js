import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compoundAuditCleanupRefusal } from "../src/contract-audit-workflow.js";
import { directTestSuggestion } from "../src/executor.js";
import { isFocusedAuditCommand } from "../src/contract-audit-recovery.js";
import { clipKeepingControllerAnnotation } from "../src/prompt.js";
import { runAgent } from "../src/agent.js";
import { runProcess } from "../src/process-runner.js";

const LIVE_COMMAND = "node context-packet.verify.mjs && npm test && rm -f context-packet.verify.mjs && npm test";
const OPTIONS = { pending: { needsFocused: true, configuredCommand: "npm test" }, workspace: "/workspace",
  sourcePaths: ["context-packet.js", "context-packet.verify.mjs", "checks/edge verify.mjs"] };

test("the recorded repeated check/delete sequence is refused with an exact standalone suggestion", () => {
  const result = compoundAuditCleanupRefusal(LIVE_COMMAND, OPTIONS);
  assert.equal(result.kind, "compound-audit-cleanup");
  assert.deepEqual(result.nextAction, { a: "shell", c: "node context-packet.verify.mjs" });
  assert.deepEqual(result.sourcePaths, ["context-packet.verify.mjs"]);
  assert.match(result.correction, /Requested compound command was not executed/);
  assert.match(result.correction, /suffix was not executed/);
  assert.match(result.correction, /not a rewritten program/);
  assert.ok(result.correction.length <= 650);
  const clipped = clipKeepingControllerAnnotation(`${"output\n".repeat(3000)}\n${result.correction}\n[working] ${"note ".repeat(3000)}`);
  assert.ok(clipped.includes(result.correction), "the entire exact action survives the real protected-annotation clipper");
  assert.deepEqual(compoundAuditCleanupRefusal(LIVE_COMMAND, OPTIONS), result, "a repeated refused command remains a refusal, never an execution");
});

test("literal source removal and quoted focused arguments preserve their exact spelling", () => {
  for (const suffix of ["rm -f context-packet.verify.mjs", "unlink /workspace/context-packet.verify.mjs", "rm --force -- ./context-packet.verify.mjs"]) {
    assert.deepEqual(compoundAuditCleanupRefusal(`node context-packet.verify.mjs; ${suffix}`, OPTIONS)?.sourcePaths,
      ["context-packet.verify.mjs"], suffix);
  }
  const focused = "NODE_ENV=test node 'checks/edge verify.mjs'";
  const result = compoundAuditCleanupRefusal(`${focused} && npm test && rm -rf checks`, OPTIONS);
  assert.deepEqual(result?.nextAction, { a: "shell", c: focused });
  assert.deepEqual(result.sourcePaths, ["checks/edge verify.mjs"]);
});

test("normal edits, fixture cleanup and discharged audit phases are not prohibited", () => {
  for (const command of ["rm -f context-packet.verify.mjs", "node context-packet.verify.mjs", "rm -f context-packet.verify.mjs && npm test",
    "node context-packet.verify.mjs && rm -f /tmp/context-packet.verify.mjs", "node context-packet.verify.mjs && rm -f fixture.json",
    "node context-packet.verify.mjs && npm test", "npm test && rm -f context-packet.verify.mjs"]) {
    assert.equal(compoundAuditCleanupRefusal(command, OPTIONS), null, command);
  }
  for (const pending of [null, {}, { needsFocused: false }, { needsFocused: "true" }]) {
    assert.equal(compoundAuditCleanupRefusal(LIVE_COMMAND, { ...OPTIONS, pending }), null);
  }
  assert.equal(compoundAuditCleanupRefusal(LIVE_COMMAND, { ...OPTIONS, sourcePaths: [] }), null);
});

test("opaque shell or setup cannot be silently dropped to manufacture a standalone check", () => {
  for (const command of [
    `cd /workspace && ${LIVE_COMMAND}`, `export X=1; ${LIVE_COMMAND}`, `sh -c '${LIVE_COMMAND}'`,
    "node context-packet.verify.mjs && cd /tmp && rm -f context-packet.verify.mjs",
    "node context-packet.verify.mjs && eval cd /tmp && rm -f context-packet.verify.mjs",
    "node context-packet.verify.mjs && echo 'rm -f context-packet.verify.mjs'",
    "node context-packet.verify.mjs && rm -f $CHECK", "node context-packet.verify.mjs && rm -f *.mjs",
    "node context-packet.verify.mjs > result.txt && rm -f context-packet.verify.mjs",
    "node context-packet.verify.mjs | tail -20; rm -f context-packet.verify.mjs",
    "node context-packet.verify.mjs || rm -f context-packet.verify.mjs",
    "node context-packet.verify.mjs && rm --unknown context-packet.verify.mjs",
    "node context-packet.verify.mjs && rm -f $(echo context-packet.verify.mjs)",
    "node context-packet.verify.mjs && rm -f `echo context-packet.verify.mjs`",
    "node context-packet.verify.mjs <<'EOF'\nrm -f context-packet.verify.mjs\nEOF",
    "node 'context-packet.verify.mjs && rm -f context-packet.verify.mjs",
  ]) assert.equal(compoundAuditCleanupRefusal(command, OPTIONS), null, command);
  for (const workspace of ["relative", "/workspace/../workspace", null]) {
    assert.equal(compoundAuditCleanupRefusal(LIVE_COMMAND, { ...OPTIONS, workspace }), null);
  }
});

test("existing standalone-test safety is unchanged unless a focused predicate is explicitly supplied", () => {
  assert.equal(directTestSuggestion("npm test && rm -f check.mjs"), "npm test");
  assert.equal(directTestSuggestion(LIVE_COMMAND), null);
  assert.equal(directTestSuggestion(LIVE_COMMAND, { isCheck: candidate => isFocusedAuditCommand(candidate, "npm test") }),
    "node context-packet.verify.mjs");
  assert.equal(directTestSuggestion("cd /workspace && npm test"), null);
});

test("two refused check/delete attempts preserve files and generation, then direct focus and project verification permit DONE", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-audit-cleanup-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  const packageText = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import { collectItems } from '../src/items.js'; test('normal items', () => assert.deepEqual(collectItems('valid', [2, 1]), [2, 1]));\n";
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), publicTest);
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  const good = "export function collectItems(token, items) { if (!Array.isArray(items)) throw Error('items'); if (typeof token !== 'string' || !token.length) throw Error('token'); return [...items]; }\n";
  const check = "import assert from 'node:assert/strict'; import { collectItems } from './src/items.js'; assert.throws(() => collectItems('', []), Error); assert.deepEqual(collectItems('valid', []), []);\n";
  const compound = "node items.verify.mjs && npm test && rm -f items.verify.mjs && npm test";
  const actions = [
    { a: "write_file", p: "src/items.js", content: good },
    { a: "write_file", p: "items.verify.mjs", content: check },
    { a: "shell", c: "npm test" },
    { a: "shell", c: compound }, { a: "shell", c: compound },
    { a: "shell", c: "node items.verify.mjs" },
    { a: "done", summary: "Implemented and checked the API." },
  ];
  const processes = [], prompts = [], events = [];
  let auditCalls = 0;
  const result = await runAgent({
    task: "Implement and export synchronous collectItems(token, items) in src/items.js. items must be an array. token must be a nonempty string for every call, including empty arrays. Return an array preserving order. Invalid inputs must throw an Error. Run npm test. Do not modify package.json or existing public tests. You may add tests.",
    workspace, model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
      if (String(prompt).includes("You are a source-code state-machine auditor.")) {
        auditCalls++;
        return { content: JSON.stringify({ findings: [{ entrypoint: "collectItems", requirement: "token must be nonempty even for empty arrays", location: "src/items.js", fixture: "collectItems('', [])", expected: "throws Error", predicted: "may return []" }], note: "Unverified source review; execute the public API assertion." }), tokens: 1 };
      }
      prompts.push(String(prompt));
      assert.ok(actions.length, "bounded deterministic worker cannot request additional repair turns");
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: 12, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1",
    verificationScript: "npm test", completionAudit: false, stateAudit: "off", contractStateAudit: "auto",
    contractAssertionStation: "off", diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    progressAwareness: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    shellProcessRunner(file, args, options) { processes.push({ file, args }); return runProcess(file, args, options); },
    onEvent(event) { events.push(event); },
  });
  assert.equal(result.reachedDone, true, JSON.stringify(result.turns.map(turn => ({ a: turn.action, obs: turn.observation?.slice(-900) }))));
  assert.equal(result.turns.length, 7);
  assert.equal(auditCalls, 1);
  assert.equal(result.metrics.compoundAuditCleanupRefusals, 2);
  assert.equal(events.filter(event => event.type === "verification_workflow_refusal").length, 2);
  assert.ok(processes.every(process => !process.args.some(arg => String(arg).includes(compound))), "neither compound was launched or rewritten behind the worker's back");
  for (const i of [3, 4]) {
    assert.equal(result.turns[i].shellExecution, null);
    assert.equal(result.turns[i].verificationEvidence, null);
    assert.match(result.turns[i].observation, /Requested compound command was not executed/);
    assert.ok(prompts[i + 1].includes('{"a":"shell","c":"node items.verify.mjs"}'));
  }
  const focused = result.turns[5];
  assert.equal(focused.shellExecution.generation, result.turns[2].shellExecution.generation,
    "refusing both commands leaves the workspace generation unchanged");
  assert.equal(focused.shellExecution.executedCommand, "node items.verify.mjs");
  assert.equal(focused.verificationReceipts.entries.length, 2, "actual focused execution precedes the existing automatic configured verifier");
  assert.equal(focused.verificationReceipts.entries[1].verificationEvidence.command, "npm test");
  assert.equal(focused.verificationReceipts.entries[1].verificationEvidence.status, "pass");
  assert.equal(result.turns[6].doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "items.verify.mjs"), "utf8"), check);
  assert.equal(fs.readFileSync(path.join(workspace, "src/items.js"), "utf8"), good);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);
});
