import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepairHandoff, repairHandoffContext, repairHandoffOffer } from '../src/repair-handoff.js';
import { parseAction } from '../src/actions.js';
import { recordTurns } from '../src/logic/runlog.js';
import { pendingContractAudit } from '../src/contract-audit-recovery.js';
const options = { generation: 2, workspace: '/tmp/work', editApplied: true };
const failed = { shellExecution: { command: 'node check.mjs', executedCommand: 'node check.mjs',
  generation: 1, cwd: options.workspace, exitCode: 1, outputSha256: 'a'.repeat(64) } };
const proposal = { evidenceSha256: 'a'.repeat(64), fixture: 'abc with insertions X at 1 and Y at 2',
  priorExpected: 'aXYbc', proposedExpected: 'aXbYc', requirement: 'Offsets refer to the original string', nextCheck: 'node check.mjs' };
const action = { a: 'write_file', p: 'source.mjs', content: 'export const fixed = true;', repair: [proposal] };
function repaired() { return { action, editApplied: true, repairHandoff: createRepairHandoff(action, [failed], options) }; }

test('an actual successful AND chain settles a matching repair proposal without fabricating per-check receipts', () => {
  const turns = [failed, repaired()];
  const command = 'node check-other.mjs && node check.mjs';
  const pass = { shellExecution: { ...failed.shellExecution, generation: 2, exitCode: 0, command, executedCommand: command } };
  assert.equal(repairHandoffContext([...turns, pass], options), '');
  assert.equal(repairHandoffContext([...turns, pass], { ...options, generation: 3 }), '',
    'later edits require fresh completion checks but do not resurrect a settled repair hypothesis');
  assert.match(repairHandoffContext([...turns, pass, { shellExecution: { ...failed.shellExecution, generation: 3 } }],
    { ...options, generation: 3 }), /most recently exited 1/);
  for (const change of [{ exitCode: 1 }, { generation: 1 }, { invalidated: true }, { cwd: '/different' }]) {
    assert.match(repairHandoffContext([...turns, { shellExecution: { ...pass.shellExecution, ...change } }], options), /no matching current successful execution/);
  }
  assert.equal(pass.verificationEvidence, undefined);
  assert.equal(pass.shellExecution.executedCommand, command);
});
test('optional grammar-shaped handoff survives parsing and becomes explicit proposal context, not proof', () => {
  assert.deepEqual(parseAction(JSON.stringify(action)).action, action);
  assert.ok(parseAction(JSON.stringify({ ...action, repair: undefined })).ok);
  assert.ok(parseAction(JSON.stringify({ ...action, repair: null })).ok);
  assert.equal(parseAction(JSON.stringify({ ...action, repair: [] })).ok, false);
  const turn = repaired(), turns = [failed, turn];
  assert.equal(turn.repairHandoff.verified, false);
  const text = repairHandoffContext(turns, options);
  assert.match(text, /aXbYc/); assert.match(text, /aXYbc/); assert.match(text, /NOT independently established/);
  assert.match(text, /no matching current successful execution/);
  assert.ok(recordTurns(turns).asof('turn:1', 'repair-proposal', 1));
  assert.match(repairHandoffOffer(failed, { ...options, generation: 1 }), /optional repair array/);
  const audit = { contractStateAudit: { status: 'report', focus: 'collection-preconditions', report: 'Unverified', promptSha256: 'b'.repeat(64) } };
  assert.ok(pendingContractAudit([audit, ...turns], { ...options, configuredCommand: 'npm test' }).needsFocused);
});
test('forged, oversized, unmatched and unapplied handoffs cannot enter the current context', () => {
  for (const changes of [{ evidenceSha256: 'b'.repeat(64) }, { fixture: 'x'.repeat(701) }, { nextCheck: 'node check.mjs || true' }])
    assert.equal(createRepairHandoff({ ...action, repair: [{ ...proposal, ...changes }] }, [failed], options), null);
  assert.equal(createRepairHandoff(action, [failed], { ...options, editApplied: false }), null);
  assert.equal(createRepairHandoff(action, [failed], { ...options, workspace: '/tmp/foreign' }), null);
  const turn = repaired(); turn.repairHandoff.proposal.proposedExpected = 'POISON';
  assert.equal(repairHandoffContext([failed, turn], options), '');
  for (const changes of [{ timedOut: true }, { invalidated: true }, { exitCode: 0 }])
    assert.equal(createRepairHandoff(action, [{ shellExecution: { ...failed.shellExecution, ...changes } }], options), null);
});
test('generation changes are explicit, matching actual checks retire proposals, and later failures remain visible', () => {
  const turns = [failed, repaired()];
  assert.match(repairHandoffContext(turns, { ...options, generation: 3 }), /Source has changed/);
  const pass = { shellExecution: { ...failed.shellExecution, generation: 2, exitCode: 0, command: 'node check.mjs 2>&1', executedCommand: 'node check.mjs 2>&1' } };
  assert.equal(repairHandoffContext([...turns, pass], options), '');
  assert.match(repairHandoffContext([...turns, pass, { shellExecution: { ...failed.shellExecution, generation: 2 } }], options), /most recently exited 1/);
  assert.match(repairHandoffContext([...turns, { shellExecution: { ...pass.shellExecution, command: 'npm test', executedCommand: 'npm test' } }], options), /aXbYc/);
});

test('ordered automatic receipts offer and retain every correction, rejecting forged envelopes', () => {
  const proof = { schema: 1, source: 'automatic', status: 'fail', statusScope: 'execution',
    statusCommand: 'node check.mjs', ...failed.shellExecution };
  const automatic = { shellExecution: null, verificationEvidence: proof,
    verificationReceipts: { schema: 'bantam.verification-receipts.v1', authority: 'controller-execution-order', turn: 0,
      entries: [{ sequence: 0, shellExecution: null, verificationEvidence: proof }] } };
  assert.match(repairHandoffOffer(automatic, { ...options, generation: 1 }), /came from automatic/);
  const batch = { ...action, repair: [proposal, { ...proposal, fixture: 'second fixture', proposedExpected: 'second correction' }] };
  assert.equal(parseAction(JSON.stringify(batch)).ok, true);
  const handoff = createRepairHandoff(batch, [automatic], options);
  assert.equal(handoff.schema, 'bantam.repair-handoff.v2');assert.equal(handoff.repairs.length, 2);
  const turns = [automatic, { action: batch, editApplied: true, repairHandoff: handoff }];
  assert.match(repairHandoffContext(turns, options), /second correction/);
  assert.ok(recordTurns(turns).asof('turn:1', 'repair-proposal', 1));
  const forged = structuredClone(automatic);forged.verificationReceipts.entries[0].sequence = 2;
  assert.equal(createRepairHandoff(batch, [forged], options), null);
  const pass = { ...proof, generation: 2, status: 'pass', exitCode: 0 };
  assert.equal(repairHandoffContext([...turns, { verificationEvidence: pass }], options), '');
});

test('actual automatic failures expose batch repair syntax and retain controller-linked proposals', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { runAgent } = await import('../src/agent.js');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-auto-repair-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  const bad = "import test from 'node:test'; import assert from 'node:assert/strict'; test('first',()=>assert.equal(1,2)); test('second',()=>assert.equal(3,4));\n";
  let step = 0;
  const result = await runAgent({ workspace, task: 'Add numeric equality regression tests. Run npm test.\n' + 'Preserve ordinary numeric equality semantics. '.repeat(100),
    model: { assistantPrefill: '', async complete(prompt, request) {
      let next;
      if (step === 0) next = { a: 'write_file', p: 'test/added.test.js', content: bad };
      if (step === 1) {
        assert.match(prompt, /came from automatic/);assert.match(prompt, /TEST REPAIR/);
        assert.ok(request.jsonSchema.properties.a.enum.includes('patch'));
        const evidenceSha256 = /"evidenceSha256":"([a-f0-9]{64})"/.exec(prompt)?.[1];assert.ok(evidenceSha256);
        next = { a: 'patch', edits: [{ p: 'test/added.test.js', old: 'assert.equal(1,2)', new: 'assert.equal(1,1)' },
          { p: 'test/added.test.js', old: 'assert.equal(3,4)', new: 'assert.equal(3,3)' }],
          repair: [1,3].map(n => ({ evidenceSha256, fixture: String(n), priorExpected: String(n+1), proposedExpected: String(n), requirement: 'Numeric equality', nextCheck: 'npm test' })) };
      }
      if (step === 2) {
        const decision = prompt.slice(prompt.lastIndexOf('[verification workflow: current decision]'));
        assert.doesNotMatch(decision, /proposal remains unverified/);
        next = { a: 'done', summary: 'Two assertions pass.' };
      }
      assert.ok(next, 'bounded scripted repair');step++;return { content: JSON.stringify(next), tokens: 1 };
    } }, maxTurns: 8, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: 'host', promptTrajectory: 'extension', patchAction: 'auto', verificationScript: 'npm test',
    contractStateAudit: 'off', completionAudit: false, stateAudit: 'off', regressionGuard: false, testFocus: false,
    autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
  });
  assert.equal(result.turns[0].verificationEvidence.source, 'automatic');
  assert.equal(result.turns[0].verificationEvidence.counts.failed, 2);
  assert.equal(result.turns[1].editApplied, true);assert.equal(result.turns[1].repairHandoff.repairs.length, 2);
  assert.equal(result.turns[1].verificationEvidence.status, 'pass');assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(repairHandoffContext(result.turns.slice(0,2), { generation: 2, workspace }), '', 'same-turn controller pass settles the advisory repair');
});

test('actual worker prompts and saved artifacts retain a correction across the repair/check boundary', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { runAgent } = await import('../src/agent.js');
  const { buildArtifact } = await import('../src/artifact.js');
  const { RunCheckpoint } = await import('../src/run-checkpoint.js');
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-repair-prompt-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'source.mjs'), "export const result = 'aXbYc';\n");
  const prompts = []; let step = 0, linked;
  const result = await runAgent({ workspace, task: 'Verify source.mjs result preserves original-offset insertion order. Create check.mjs as regression coverage; do not edit source.mjs.',
    model: { assistantPrefill: '', async complete(prompt) {
      prompts.push(prompt);
      let next;
      if (step === 0) next = { a: 'shell', c: "node --input-type=module -e \"import {result} from './source.mjs'; if(result !== 'aXYbc') throw Error(result)\"" };
      if (step === 1) {
        const evidenceSha256 = /"evidenceSha256":"([a-f0-9]{64})"/.exec(prompt)?.[1];
        assert.ok(evidenceSha256, 'failed process offers its actual receipt identity');
        linked = { ...proposal, evidenceSha256, nextCheck: 'node check.mjs' };
        next = { a: 'write_file', p: 'check.mjs', content: "import assert from 'node:assert/strict'; import {result} from './source.mjs'; assert.equal(result, 'aXbYc');\n", repair: [linked] };
      }
      if (step === 2) {
        assert.match(prompt, /\[repair handoff; advisory, NOT verification evidence\]/);
        assert.match(prompt, /"proposedExpected":"aXbYc"/);
        assert.match(prompt, /no matching current successful execution/);
        next = { a: 'shell', c: 'node check.mjs' };
      }
      if (step === 3) next = { a: 'done', summary: 'Corrected the mistaken test expectation and executed the retained assertion.' };
      assert.ok(next, 'no extra worker calls'); step++;
      return { content: JSON.stringify(next), tokens: 1 };
    } }, maxTurns: 12, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: 'host', promptTrajectory: 'extension', verificationScript: null,
    contractStateAudit: 'off', completionAudit: false, stateAudit: 'off', regressionGuard: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent(event) { checkpoint.note(event); },
  });
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns[1].repairHandoff.proposal.proposedExpected, 'aXbYc');
  const artifact = buildArtifact({ runId: 'repair-prompt', stamp: 'test', result });
  assert.deepEqual(artifact.turns[1].repairHandoff, result.turns[1].repairHandoff);
  assert.deepEqual(checkpoint.turns()[1].repairHandoff, result.turns[1].repairHandoff);
  assert.equal(repairHandoffContext(result.turns, { generation: 1, workspace }), '');
});
