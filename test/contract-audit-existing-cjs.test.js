import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingFocusedCheck } from '../src/contract-audit-recovery.js';
import { contractAuditDecisionContext } from '../src/contract-audit-phase.js';
import { runAgent } from '../src/agent.js';

const source = "const { collectItems } = require('../source.cjs'); const assert = require('node:assert/strict'); assert.deepEqual(collectItems([]), []);";

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

test('a real failed CommonJS check remains repairable and cannot grant completion until fresh checks pass', async t => {
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
  const result = await runAgent({ workspace, task: 'Implement public collectItems(items). Require an array, including empty, otherwise throw. Return a copy preserving order. Run npm test.',
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
  });
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
});
