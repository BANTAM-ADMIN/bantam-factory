import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isFocusedAuditCommand, pendingContractAudit } from "../src/contract-audit-recovery.js";
import { verificationEvidence, verificationReceipt, shellExecutionReceipt } from "../src/verification-evidence.js";
import { runAgent } from "../src/agent.js";

const RECORDED_T59 = "node -e \"import('./context-packet.js').then(async m=>{const a=await import('node:assert/strict');const f=s=>Buffer.byteLength('### '+JSON.stringify(s.id)+'\\n'+s.text+'\\n','utf8');a.throws(()=>m.packContext([{id:'a',text:'',priority:0,required:true}],0));a.throws(()=>m.packContext([{id:'a',text:'x',priority:0,required:true}],f({id:'a',text:'x',priority:0,required:true})-1));a.deepEqual(m.packContext([{id:'a',text:'x',priority:0,required:true}],f({id:'a',text:'x',priority:0,required:true})),{text:'### \\\"a\\\"\\nx\\n',bytes:f({id:'a',text:'x',priority:0,required:true}),included:['a'],omitted:[]});console.log('FOCUSED OK');})\"";
const command = source => "node --input-type=module -e '" + source.replace(/'/g, "'\"'\"'") + "'";
const options = { generation: 1, configuredCommand: "npm test" };
const audit = { contractStateAudit: { focus: "collection-preconditions", status: "report",
  promptSha256: "audit-hash", report: "Execute a public-API assertion.", sources: [] } };
function check(c, changes = {}, generation = 1) {
  const execution = { command: c, executedCommand: c, exitCode: 0, stdout: "", stderr: "", ...changes };
  return { verificationEvidence: verificationReceipt(verificationEvidence({ execution, generation, configuredCommand: "npm test" })),
    shellExecution: shellExecutionReceipt(execution, { generation }) };
}

test("the exact saved Context final command recognizes its awaited assertion namespace, not its printed success", () => {
  assert.equal(isFocusedAuditCommand(RECORDED_T59, "npm test"), true);
  const row = check(RECORDED_T59);
  assert.equal(row.verificationEvidence, null, "inline assertion remains a shell receipt, not invented project test counts");
  const pending = pendingContractAudit([audit, row], options);
  assert.equal(pending.needsFocused, false);
  assert.equal(pending.needsProject, true);
  assert.equal(pendingContractAudit([audit, row, check("npm test")], options), null);
  assert.equal(isFocusedAuditCommand(RECORDED_T59.replace("const a=await import", "const a=import")), false);
});

test("literal awaited assert namespaces support real synchronous assertion member calls", () => {
  for (const module of ["node:assert", "node:assert/strict", "assert", "assert/strict"]) {
    for (const call of ["a.throws(() => { throw Error('invalid'); })", "a.deepEqual([1], [1])", "a['strictEqual'](1, 1)"]) {
      assert.equal(isFocusedAuditCommand(command("const a = await import(" + JSON.stringify(module) + "); " + call + ";")), true);
    }
  }
  assert.equal(isFocusedAuditCommand(command("import assert from 'node:assert/strict'; assert.equal(1,1);")), true);
  assert.equal(isFocusedAuditCommand(command("const assert=require('node:assert/strict'); assert.equal(1,1);")), true);
});

test("Promises, opaque module names, unsupported aliases and nonasserting output gain no focused credit", () => {
  for (const source of [
    "const a=import('node:assert/strict'); a.throws(()=>{});",
    "const name='node:assert/strict'; const a=await import(name); a.ok(true);",
    "const a=await import('node:'+'assert/strict'); a.ok(true);",
    "const a=await import('./assert.mjs'); a.ok(true);",
    "const a=await import('node:assert/strict'); console.log('a.throws(() => {})');",
    "const a=await import('node:assert/strict'); console.log(true);",
    "const a=await import('node:assert/strict'); a.toString();",
    "const a=await import('node:assert/strict'); a[method](true);",
    "const a=await import('node:assert/strict'); other.ok(true);",
    "const a=await Promise.resolve(import('node:assert/strict')); a.ok(true);",
    "const {default:a}=await import('node:assert/strict'); a.ok(true);",
    "const a=(await import('node:assert/strict')).default; a.ok(true);",
    "const a=await import('node:assert/strict'); a.rejects(async()=>{});",
  ]) assert.equal(isFocusedAuditCommand(command(source)), false, source);
});

test("recognizing an awaited import never bypasses actual status, freshness or ordered project verification", () => {
  for (const change of [{ exitCode: 1 }, { timedOut: true }, { blocked: true }, { interrupted: true },
    { bufferExceeded: true }, { signal: "SIGTERM", exitCode: null }]) {
    assert.ok(pendingContractAudit([audit, check(RECORDED_T59, change), check("npm test")], options), JSON.stringify(change));
  }
  for (const flag of [{ invalidated: true }, { signal: "SIGTERM" }]) {
    const invalidated = check(RECORDED_T59);
    Object.assign(invalidated.shellExecution, flag); // Reject explicit saved-receipt invalidation/abnormal metadata too.
    assert.ok(pendingContractAudit([audit, invalidated, check("npm test")], options));
  }
  assert.ok(pendingContractAudit([audit, check(RECORDED_T59, {}, 0), check("npm test")], options));
  assert.ok(pendingContractAudit([audit, check("npm test"), check(RECORDED_T59)], options));
  assert.ok(pendingContractAudit([audit, { observation: "FOCUSED OK", parsedAction: { a: "shell", c: RECORDED_T59 } }, check("npm test")], options));
  for (const suffix of ["; echo EXIT=$?", " && npm test", " | tail -20"]) {
    assert.equal(isFocusedAuditCommand(RECORDED_T59 + suffix), false);
    assert.ok(pendingContractAudit([audit, check(RECORDED_T59 + suffix), check("npm test")], options));
  }
});

test("last-turn awaited-namespace focus receives an actual project check and bounded terminal DONE", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-awaited-assert-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "src/value.js"), "export function value() { return 0; }\n");
  const packageText = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
  const publicTest = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.js';test('value',()=>assert.equal(value(),7));\n";
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  fs.writeFileSync(path.join(workspace, "test/value.test.js"), publicTest);
  const focused = { a: "shell", c: 'node -e "import(\'./src/value.js\').then(async m=>{const a=await import(\'node:assert/strict\');a.deepEqual(m.value([]),7);a.throws(()=>m.value(null));console.log(\'FOCUSED OK\');})"' };
  const actions = [
    { a: "write_file", p: "src/value.js", content: "export function value(items = []) { if (!Array.isArray(items)) throw Error('items'); return 7; }\n" },
    { a: "shell", c: "npm test" }, focused, { a: "done", summary: "Implemented and verified the API." },
  ];
  let audits = 0, workerCalls = 0;
  const result = await runAgent({
    task: "Implement and export synchronous value(items = []) in src/value.js. items must be an array; reject nonarrays. Return 7 including for an empty array. Run npm test. Do not modify package.json or existing public tests.",
    workspace, terminalClosureTurns: 1, maxTurns: 3, maxInvalidPerTurn: 0,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
      if (String(prompt).includes("You are a source-code state-machine auditor.")) {
        audits++; return { content: JSON.stringify({ findings: [], note: "Execute one public-API assertion." }), tokens: 1 };
      }
      workerCalls++; assert.ok(actions.length, "only one bounded terminal completion call");
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true };
    } },
    useGrammar: true, interactive: false, grounding: false,
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1",
    verificationScript: "npm test", completionAudit: false, stateAudit: "off", contractStateAudit: "auto",
    contractAssertionStation: "off", diagnoseStuckTests: false, testFocus: false,
    regressionGuard: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
  });
  assert.equal(audits, 1); assert.equal(workerCalls, 4); assert.equal(result.turns.length, 4);
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  const proofTurn = result.turns[2], entries = proofTurn.verificationReceipts.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].shellExecution.executedCommand, focused.c);
  assert.equal(entries[0].shellExecution.exitCode, 0);
  assert.equal(entries[0].verificationEvidence, null);
  assert.equal(entries[1].verificationEvidence.status, "pass");
  assert.equal(entries[1].verificationEvidence.configuredCommand, "npm test");
  assert.equal(result.metrics.terminalClosure.grantedTurn, 2);
  assert.equal(result.turns[3].doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "test/value.test.js"), "utf8"), publicTest);
});
