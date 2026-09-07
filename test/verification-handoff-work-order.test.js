import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';
import { existingFocusedCheck } from '../src/contract-audit-recovery.js';
import { createRepairHandoff, repairHandoffContext } from '../src/repair-handoff.js';
import { recordTurns } from '../src/logic/runlog.js';
import { buildArtifact } from '../src/artifact.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';

const workspaceFor = t => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-work-order-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p;
};
const settings = { maxTurns: 12, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
  shellSandbox: 'host', promptTrajectory: 'extension', completionAudit: false, stateAudit: 'off',
  contractAssertionStation: 'off', testFocus: false, regressionGuard: false, diagnoseStuckTests: false,
  autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0 };
const proposal = { evidenceSha256: 'a'.repeat(64), fixture: 'two original-coordinate insertions',
  priorExpected: 'insertion leaves cursor unchanged', proposedExpected: 'advance cursor to insertion position',
  requirement: 'Preserve untouched source once', nextCheck: 'node check.mjs' };

test('read handoff is source-bound, advisory, stale-aware, and cannot be fabricated from a refused read', () => {
  const workspace = '/tmp/work', failed = { shellExecution: { command: 'node check.mjs', executedCommand: 'node check.mjs',
    generation: 1, cwd: workspace, exitCode: 1, outputSha256: proposal.evidenceSha256 } };
  const action = { a: 'read_file', p: 'source.mjs', repair: [proposal] };
  const options = { generation: 1, workspace, readApplied: true, readSource: () => 'export const cursor = 0;' };
  const handoff = createRepairHandoff(action, [failed], options);
  assert.equal(handoff.schema, 'bantam.repair-handoff.v3'); assert.equal(handoff.verified, false);
  const turn = { action, observation: 'source.mjs (1 lines, showing 1-1):\n1\texport const cursor = 0;', repairHandoff: handoff };
  const turns = [failed, turn];
  assert.match(repairHandoffContext(turns, options), /Current source hash matches/);
  assert.match(repairHandoffContext(turns, { ...options, generation: 2, readSource: () => 'changed' }), /Source differs/);
  assert.ok(recordTurns(turns).asof('turn:1', 'repair-proposal', 1));
  assert.equal(repairHandoffContext([failed, { ...turn, observation: 'ERROR: refused' }], options), '');
  assert.equal(createRepairHandoff(action, [failed], { ...options, readApplied: false }), null);
  assert.equal(createRepairHandoff({ ...action, p: '../secret' }, [failed], options), null);
  assert.equal(createRepairHandoff(action, [failed], { ...options, readSource: () => 'x'.repeat(300000) }), null);
  const forged = structuredClone(turn);forged.repairHandoff.repairs[0].proposal.proposedExpected = 'forged';
  assert.equal(repairHandoffContext([failed, forged], options), '');
});

test('actual long-context failure -> read with decision -> edit retains the correction in prompt, checkpoint and datalog', async t => {
  const workspace = workspaceFor(t), checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  fs.writeFileSync(path.join(workspace, 'source.mjs'), "export const result = 'wrong';\n");
  fs.writeFileSync(path.join(workspace, 'check.mjs'), "import assert from 'node:assert/strict';import {result} from './source.mjs';assert.equal(result,'correct');\n");
  let step = 0;
  const result = await runAgent({ ...settings, workspace, verificationScript: 'node check.mjs', contractStateAudit: 'off',
    task: 'Repair the source module so its exported result is correct. Preserve the supplied assertion.\n' + 'Read current bytes before editing when necessary. '.repeat(100),
    onEvent: e => checkpoint.note(e), model: { assistantPrefill: '', async complete(prompt) {
      let action;
      if (step === 0) action = { a: 'shell', c: 'node check.mjs' };
      if (step === 1) {
        const evidenceSha256 = /"evidenceSha256":"([a-f0-9]{64})"/.exec(prompt)?.[1];assert.ok(evidenceSha256);
        assert.match(prompt, /attach that decision to read_file/);
        action = { a: 'read_file', p: 'source.mjs', repair: [{ ...proposal, evidenceSha256, proposedExpected: "change the result literal to 'correct'" }] };
      }
      if (step === 2) {
        assert.match(prompt, /Retained across a read; source binding/);assert.match(prompt, /change the result literal to 'correct'/);
        assert.match(prompt, /Current source hash matches/);assert.match(prompt, /NOT independently established/);
        action = { a: 'replace', p: 'source.mjs', old: "'wrong'", new: "'correct'" };
      }
      if (step === 3) action = { a: 'shell', c: 'node check.mjs' };
      if (step === 4) action = { a: 'done', summary: 'Repaired the implementation and executed the supplied assertion.' };
      assert.ok(action, 'bounded scripted worker'); step++;return { content: JSON.stringify(action), tokens: 1 };
    } } });
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  const handoff = result.turns[1].repairHandoff;assert.equal(handoff.schema, 'bantam.repair-handoff.v3');
  assert.deepEqual(checkpoint.turns()[1].repairHandoff, handoff);
  assert.deepEqual(buildArtifact({ runId: 'decision-read', stamp: 'test', result }).turns[1].repairHandoff, handoff);
  assert.ok(recordTurns(result.turns).asof('turn:1', 'repair-proposal', 1));
  assert.equal(repairHandoffContext(result.turns, { generation: 1, workspace }), '');
});

test('current source launcher hints are bounded and never infer proof from filenames or printed text', () => {
  const source = "import test from 'node:test';import assert from 'node:assert/strict';import {f} from '../source.js';test('f',()=>assert.equal(f(),1));";
  const hint = existingFocusedCheck(['test/edge.test.js'], () => source, { generation: 3 });
  assert.equal(hint.command, 'node --test test/edge.test.js');assert.equal(hint.verified, false);
  assert.notEqual(hint.sourceSha256, existingFocusedCheck(['test/edge.test.js'], () => source+'\n', { generation: 3 }).sourceSha256);
  for (const code of ['console.log("assert PASS")', 'bad syntax !!!', source.replace("'../source.js'", "'node:fs'"), 'x'.repeat(32001)])
    assert.equal(existingFocusedCheck(['test/edge.test.js'], () => code, { generation: 3 }), null);
  assert.equal(existingFocusedCheck(['../secret.js'], () => source, { generation: 3 }), null);
  assert.equal(existingFocusedCheck(['test/edge.test.js'], () => { throw Error('missing'); }, { generation: 3 }), null);
});

test('successful custom checks get an explicit non-admission reason and the current authored launcher', async t => {
  const workspace = workspaceFor(t);fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(workspace, 'source.js'), 'export function collectItems() { throw Error("TODO"); }');
  fs.writeFileSync(path.join(workspace, 'test/public.test.js'), "import test from 'node:test';import assert from 'node:assert/strict';import {collectItems} from '../source.js';test('API',()=>assert.deepEqual(collectItems([1]),[1]));");
  const source = 'export function collectItems(items) { if(!Array.isArray(items)) throw Error("array"); return [...items]; }';
  const edge = "import test from 'node:test';import assert from 'node:assert/strict';import {collectItems} from '../source.js';test('boundary',()=>{assert.throws(()=>collectItems(null));assert.deepEqual(collectItems([]),[]);});";
  const actions = [{ a: 'write_file', p: 'source.js', content: source }, { a: 'write_file', p: 'test/edge.test.js', content: edge },
    { a: 'shell', c: 'npm test' }, { a: 'shell', c: "node --input-type=module -e \"import {collectItems} from './source.js';if(collectItems([]).length)process.exit(1);console.log('OK');\"" },
    { a: 'shell', c: 'node --test test/edge.test.js' }, { a: 'done', summary: 'Implemented and verified.' }];
  let step = 0;
  const result = await runAgent({ ...settings, workspace, verificationScript: 'npm test', contractStateAudit: 'auto',
    task: 'Implement public API collectItems(items). Require an array including empty; otherwise throw. Return a copy in input order. Run npm test.',
    model: { assistantPrefill: '', async complete(prompt, options) {
      if (prompt.includes('You are a source-code state-machine auditor.')) return { content: JSON.stringify({ findings: [], note: '' }), tokens: 1 };
      if (step === 4) {
        const current = prompt.slice(prompt.lastIndexOf('[verification workflow: current decision]'));
        assert.match(current, /ran and exited 0/);assert.match(current, /NOT ADMITTED/);
        assert.match(current, /no recognized node:assert binding/);assert.match(current, /run exactly "node --test test\/edge.test.js"/);
        assert.ok(!options.jsonSchema.properties.a.enum.includes('done'));
      }
      if (step === 5) assert.match(prompt.slice(prompt.lastIndexOf('[verification workflow: current decision]')), /VERIFICATION READY/);
      assert.ok(actions.length);step++;return { content: JSON.stringify(actions.shift()), tokens: 1 };
    } } });
  assert.equal(result.turns[3].shellExecution.exitCode, 0);assert.equal(result.turns[3].verificationEvidence, null);
  assert.equal(result.turns[3].verificationWorkflow.admissionDiagnostic.reason, 'inline-assertion-not-recognized');
  assert.equal(result.turns[4].verificationWorkflow.phase, 'ready');assert.equal(result.reachedDone, true);
});
