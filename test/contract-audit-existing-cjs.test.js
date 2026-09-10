import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingFocusedCheck } from '../src/contract-audit-recovery.js';
import { contractAuditDecisionContext, contractAuditPhaseState, verificationWorkflowPromptText } from '../src/contract-audit-phase.js';
import { runAgent } from '../src/agent.js';

const source = "const { collectItems } = require('../source.cjs'); const assert = require('node:assert/strict'); assert.deepEqual(collectItems([]), []);";

test('an early-exiting custom check cannot complete the focused/project verification pair', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-empty-check-'));
  t.after(() => fs.rmSync(workspace, {recursive:true, force:true}));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({scripts:{test:'node --test test/public.cjs'}}));
  fs.writeFileSync(path.join(workspace, 'source.cjs'), 'exports.collectItems = () => { throw Error("TODO"); };');
  fs.writeFileSync(path.join(workspace, 'test/public.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'); test('baseline',()=>assert.ok(true));");
  const empty = source.replace('assert.deepEqual(collectItems([]), []);',
    "setTimeout(() => assert.deepEqual(collectItems([]), []), 0); console.log('UV check: 0 passed, 0 failed'); process.exit(0);");
  const actions = [{a:'write_file', p:'source.cjs', content:'exports.collectItems = items => { if(!Array.isArray(items)) throw Error("array"); return [...items]; };'},
    {a:'shell', c:'npm test'}, {a:'write_file', p:'test/edge.cjs', content:empty}, {a:'shell', c:'node test/edge.cjs'},
    {a:'write_file', p:'test/edge.cjs', content:source}, {a:'shell', c:'node test/edge.cjs'}, {a:'done', summary:'Verified.'}];
  let index = 0, afterEmpty;
  const result = await runAgent({workspace, task:'Implement public collectItems(items). Require an array, including empty, otherwise throw. Return a copy preserving order. Run npm test.',
    maxTurns:actions.length, maxInvalidPerTurn:0, useGrammar:true, interactive:false, grounding:false,
    shellSandbox:'host', promptTrajectory:'extension', verificationScript:'npm test',
    completionAudit:false, stateAudit:'off', contractStateAudit:'auto', contractAssertionStation:'off',
    testFocus:false, regressionGuard:false, diagnoseStuckTests:false,
    autoVerifyBlindEdits:0, autoVerifyProbes:0, autoVerifyStaleTurns:0,
    model:{assistantPrefill:'', async complete(prompt, options) {
      if (prompt.includes('You are a source-code state-machine auditor.')) return {content:JSON.stringify({findings:[], note:''}), tokens:1};
      if (index === 4) afterEmpty = options.jsonSchema.properties.a.enum;
      assert.ok(actions[index], 'bounded worker');
      return {content:JSON.stringify(actions[index++]), tokens:1};
    }}});
  const emptyTurn = result.turns[3];
  assert.equal(emptyTurn.shellExecution.exitCode, 0);
  assert.equal(emptyTurn.verificationEvidence.status, 'unverified');
  assert.ok(!afterEmpty.includes('done'));
  assert.doesNotMatch(emptyTurn.observation, /Focused assertion accepted|receipts are now complete/);
  assert.equal(result.reachedDone, true, 'the subsequently executed real assertion can complete verification');
});

test('literal CommonJS subject imports retain an existing assertion check as an unverified launcher', () => {
  for (const code of [source, "const test = require('node:test'); " + source]) {
    const hint = existingFocusedCheck(['test/edge.cjs'], () => code, { generation: 4 });
    assert.equal(hint.command, code.includes('node:test') ? 'node --test test/edge.cjs' : 'node test/edge.cjs');
    assert.equal(hint.verified, false);
    assert.equal(hint.authority, 'current-source-launcher-hint');
  }
  for (const code of [
    source.replace("'../source.cjs'", "subject"),
    source.replace("'../source.cjs'", "'node:fs'"),
    source.replace("require('../source.cjs')", "loader('../source.cjs')"),
    'function neverCalled() { ' + source + ' }',
    source.replace('assert.deepEqual(collectItems([]), []);', 'console.log("PASS");'),
  ]) assert.equal(existingFocusedCheck(['test/edge.cjs'], () => code, { generation: 4 }), null);
});

test('an actual failed execution without a source hint requests repair instead of a new test', () => {
  const pending = { generation: 4, needsFocused: true, needsProject: true, configuredCommand: 'npm test',
    admissionDiagnostic: { schema: 1, generation: 4, turn: 8, exitCode: 1, outputSha256: 'a'.repeat(64),
      admission: 'not-admitted', reason: 'execution-failed' } };
  const context = contractAuditDecisionContext(pending);
  assert.match(context.text, /Repair.*(?:source|fixture)/);
  assert.match(context.text, /rerun the affected check directly/);
  assert.doesNotMatch(context.text, /create a new workspace check/);
  assert.equal(context.phase, 'focused');
});

test('an existing source check does not prescribe the next action for another implementation milestone', () => {
  const checkCandidate = existingFocusedCheck(['test/edge.cjs'], () => source, { generation: 9 });
  const pending = { generation: 9, needsFocused: true, needsProject: true,
    configuredCommand: 'npm test', checkCandidate };
  const before = structuredClone(pending);
  const decision = contractAuditDecisionContext(pending);
  const phase = contractAuditPhaseState(pending);
  for (const text of [decision.text, phase.note]) {
    assert.match(text, /Continue any unfinished implementation milestone/);
    assert.match(text, /verification boundary/);
    assert.match(text, /if it covers the behavior changed/);
    assert.match(text, /node test\/edge.cjs/);
    assert.doesNotMatch(text, /Next: run exactly/);
    assert.match(text, /fresh configured project verification/);
  }
  assert.deepEqual(pending, before, 'advisory text supplies no execution credit');
  assert.equal(decision.phase, 'focused');
  assert.ok(phase.excludeVerbs.includes('done'));
  assert.ok(verificationWorkflowPromptText(decision).includes(decision.text), 'bounded newest-turn guidance survives delivery');
});

for (const resumed of [false, true]) test(`a real failed CommonJS check remains repairable${resumed ? ' after resuming' : ''} and requires fresh checks`, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-cjs-check-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/public.cjs' } }));
  fs.writeFileSync(path.join(workspace, 'source.cjs'), 'exports.collectItems = () => { throw Error("TODO"); };');
  fs.writeFileSync(path.join(workspace, 'test/public.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'),{collectItems}=require('../source.cjs');test('normal',()=>assert.deepEqual(collectItems([1]),[1]));");
  const actions = [
    { a: 'write_file', p: 'source.cjs', content: 'exports.collectItems = items => { if(!Array.isArray(items)) throw Error("array"); return [...items]; };' },
    { a: 'shell', c: 'npm test' },
    { a: 'write_file', p: 'test/edge.cjs', content: source.replace('collectItems([]), []', 'collectItems([]), [1]') },
    { a: 'shell', c: 'node test/edge.cjs 2>&1' },
    { a: 'replace', p: 'test/edge.cjs', old: 'collectItems([]), [1]', new: 'collectItems([]), []' },
    { a: 'shell', c: 'node test/edge.cjs 2>&1' },
    { a: 'done', summary: 'Implemented and verified the API.' },
  ];
  let index = 0, failureContext, failureAllowed;
  const options = { workspace, task: 'Implement public collectItems(items). Require an array, including empty, otherwise throw. Return a copy preserving order. Run npm test.',
    maxTurns: actions.length, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: 'host', promptTrajectory: 'extension', verificationScript: 'npm test',
    completionAudit: false, stateAudit: 'off', contractStateAudit: 'auto', contractAssertionStation: 'off',
    testFocus: false, regressionGuard: false, diagnoseStuckTests: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    model: { assistantPrefill: '', async complete(prompt, options) {
      if (prompt.includes('You are a source-code state-machine auditor.')) return { content: JSON.stringify({ findings: [], note: '' }), tokens: 1 };
      if (index === 4) {
        failureContext = prompt.slice(prompt.lastIndexOf('[verification workflow: current decision]'));
        failureAllowed = options.jsonSchema.properties.a.enum;
      }
      assert.ok(actions[index], 'bounded worker');
      return { content: JSON.stringify(actions[index++]), tokens: 1 };
    } },
  };
  const partial = resumed ? await runAgent({ ...options, maxTurns: 4 }) : null;
  const result = await runAgent({ ...options, ...(partial ? { resumeTurns: partial.turns } : {}) });
  assert.match(failureContext, /ran and exited 1/);
  assert.match(failureContext, /Existing authored check.*test\/edge.cjs/);
  assert.match(failureContext, /Repair.*before.*run exactly/);
  assert.doesNotMatch(failureContext, /create a new workspace check/);
  assert.ok(!failureAllowed.includes('done'));
  assert.equal(result.turns[3].shellExecution.exitCode, 1);
  assert.equal(result.turns[5].shellExecution.exitCode, 0);
  assert.equal(result.turns[5].verificationReceipts.entries[1].verificationEvidence.status, 'pass');
  assert.equal(result.reachedDone, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'test/edge.cjs'), 'utf8'), source);
  if (resumed) assert.deepEqual(result.metrics.editedPaths, ['test/edge.cjs'],
    'a prior source candidate must not become a new invocation-local edit');
});
