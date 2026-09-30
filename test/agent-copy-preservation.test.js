import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { runFactoryCodingCell } from '../src/factory/coding-cell.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';
import { buildArtifact } from '../src/artifact.js';

const TASK = 'Repair api.mjs. Export copy(input) returning a deep copy of any JSON value. The copy must preserve nested object and array structure without sharing references with the input. The supplied interface examples are in test/public.test.mjs. Run node --test test/public.test.mjs.';
const VERIFY = 'node --test test/public.test.mjs';
const GOOD = 'export function copy(input) { return structuredClone(input); }\n';
const BAD = 'export function copy(input) { if (input === null || typeof input !== "object") return input; const out = {}; for (const key of Object.keys(input)) out[key] = copy(input[key]); return out; }\n';
const PUBLIC_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import {copy} from '../api.mjs'; test('public scalar example', () => assert.deepEqual(copy({value:3}), {value:3}));\n";
const SPEC = { module: 'api.mjs', calls: [{ export: 'copy', args: [{ $input: true }] }], observePath: [] };
const PROJECT_GREEN = 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
const projectOnlyRunner = async (_file, args) => {
  assert.match(args.at(-1), /node --test.*test\/public\.test\.mjs/);
  return { code: 0, stdout: PROJECT_GREEN, stderr: '' };
};

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-copy-station-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'api.mjs'), GOOD);
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'test/public.test.mjs'), PUBLIC_TEST);
  return workspace;
}

async function run(workspace, actions, options = {}) {
  const { fixtureSpec = SPEC, ...agentOptions } = options;
  const prompts = [], requests = [], events = [];
  let proposals = 0;
  const result = await runAgent({ workspace, task: TASK, maxTurns: actions.length, maxInvalidPerTurn: 0,
    model: { assistantPrefill: '', async complete(prompt, request) {
      if (request.recordLabel === 'copy-preservation-fixture') {
        proposals++;
        return { content: JSON.stringify(fixtureSpec), tokens: 1 };
      }
      if (request.recordLabel === 'copy-preservation-fixture-review') return { content: JSON.stringify({
        requirement: 'The copy must preserve nested object and array structure without sharing references with the input.',
        reason: 'The public copy(input) API accepts every JSON value. Returning the entire copied object must preserve every nested JSON descendant and detach the caller input.', valid: true,
      }), tokens: 1 };
      prompts.push(prompt); requests.push(request);
      assert.ok(actions.length, `Unexpected worker request: ${request.recordLabel}`);
      return { content: JSON.stringify(actions.shift()), tokens: 1 };
    } },
    grounding: false, interactive: false, useGrammar: true, shellSandbox: 'host', shellNetwork: false,
    verificationScript: VERIFY, verificationWorkspaceReadOnly: false, probeEnabled: true,
    contractStateAudit: 'off', contractAssertionStation: 'off', completionAudit: false,
    stateAudit: 'off', testFocus: false, regressionGuard: false, lexicalContractAudit: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent: event => events.push(event), ...agentOptions,
  });
  return { result, prompts, requests, events, proposals };
}

test('ordinary agents default off, and explicit probe/shell policy prevents copy-station execution', async t => {
  const cases = [
    { copyPreservationStation: 'off', shellSandbox: 'docker' },
    { copyPreservationStation: 'auto', probeEnabled: false, shellSandbox: 'docker' },
    { copyPreservationStation: 'auto', excludeActions: ['probe'], shellSandbox: 'docker' },
    { copyPreservationStation: 'auto', excludeActions: ['shell'], shellSandbox: 'docker' },
    { copyPreservationStation: 'auto', shellSandbox: 'host' },
    { copyPreservationStation: 'auto', shellSandbox: 'docker', task: 'Keep api.mjs immutable.' },
  ];
  for (const options of cases) {
    const workspace = fixture(t);
    const { result, proposals } = await run(workspace, [{ a: 'read_file', p: 'api.mjs' }], {
      ...options, verificationPolicy: 'after_edit',
      shellProcessRunner: projectOnlyRunner,
    });
    assert.equal(result.metrics.copyPreservationStationEnabled, false, JSON.stringify(options));
    assert.equal(proposals, 0);
    assert.ok(result.turns.every(turn => !turn.copyVerification));
  }
  const prior = process.env.BANTAM_COPY_PRESERVATION_STATION;
  delete process.env.BANTAM_COPY_PRESERVATION_STATION;
  try {
    const { result } = await run(fixture(t), [{ a: 'read_file', p: 'api.mjs' }], {
      shellSandbox: 'docker', verificationPolicy: 'after_edit',
      shellProcessRunner: projectOnlyRunner,
    });
    assert.equal(result.metrics.copyPreservationStationEnabled, false);
  } finally {
    if (prior === undefined) delete process.env.BANTAM_COPY_PRESERVATION_STATION;
    else process.env.BANTAM_COPY_PRESERVATION_STATION = prior;
  }
});

test('Factory opts into the station and probe capability while respecting explicit opt-outs', async t => {
  const previousProbe = process.env.BANTAM_PROBE;
  const previousStation = process.env.BANTAM_COPY_PRESERVATION_STATION;
  delete process.env.BANTAM_PROBE;
  delete process.env.BANTAM_COPY_PRESERVATION_STATION;
  try {
    for (const overrides of [{}, { probeEnabled: false }, { copyPreservationStation: 'off' }]) {
      const workspace = fixture(t);
      let forwarded;
      await runFactoryCodingCell({ workspace, task: TASK, verificationScript: VERIFY, ...overrides,
        runAgentFn: async options => {
          forwarded = options;
          return { reachedDone: true, interrupted: false, summary: 'fixture', metrics: {}, turns: [] };
        }, verifier: async () => ({ pass: true, status: 'pass' }),
      });
      assert.equal(forwarded.copyPreservationStation, overrides.copyPreservationStation ?? 'auto');
      assert.equal(forwarded.probeEnabled, overrides.probeEnabled ?? true);
    }
    process.env.BANTAM_PROBE = 'off';
    let forwarded;
    await runFactoryCodingCell({ workspace: fixture(t), task: TASK, verificationScript: VERIFY,
      runAgentFn: async options => { forwarded = options; return { reachedDone: true, metrics: {}, turns: [] }; },
      verifier: async () => ({ pass: true, status: 'pass' }),
    });
    assert.equal(forwarded.probeEnabled, false);
  } finally {
    if (previousProbe === undefined) delete process.env.BANTAM_PROBE; else process.env.BANTAM_PROBE = previousProbe;
    if (previousStation === undefined) delete process.env.BANTAM_COPY_PRESERVATION_STATION; else process.env.BANTAM_COPY_PRESERVATION_STATION = previousStation;
  }
});

test('copy-interface examples are frozen before candidate edits and remain frozen on resume', async t => {
  const workspace = fixture(t);
  const altered = PUBLIC_TEST + '// candidate-generated assumption is not public authority\n';
  const first = await run(workspace, [{ a: 'write_file', p: 'test/public.test.mjs', content: altered }], {
    copyPreservationStation: 'off', verificationPolicy: 'after_edit',
  });
  const frozen = first.result.turns[0].contextBasis.copyInterfaceDocuments;
  assert.deepEqual(frozen.map(document => [document.path, document.text]), [['test/public.test.mjs', PUBLIC_TEST]]);
  const resumed = await run(workspace, [{ a: 'read_file', p: 'api.mjs' }], {
    copyPreservationStation: 'off', resumeTurns: first.result.turns, maxTurns: 2,
  });
  assert.deepEqual(resumed.result.turns[0].contextBasis.copyInterfaceDocuments, frozen);
});

test('unavailable copy adapter grants no copy credit and returns to ordinary verification without forced edits', async t => {
  const workspace = fixture(t);
  let projectExecutions = 0;
  const { result, prompts, requests, proposals } = await run(workspace, [
    { a: 'write_file', p: 'api.mjs', content: GOOD + '// public contract implemented\n' },
    { a: 'shell', c: VERIFY }, { a: 'read_file', p: 'api.mjs' },
    { a: 'done', summary: 'Public verification passed; automatic copy adapter unavailable' },
  ], {
    copyPreservationStation: 'auto', shellSandbox: 'docker', verificationWorkspaceReadOnly: true,
    fixtureSpec: { unsupported: true },
    shellProcessRunner: async (...args) => { projectExecutions++; return projectOnlyRunner(...args); },
  });
  const stationTurn = result.turns.find(turn => turn.copyVerification);
  assert.ok(stationTurn, 'The station actually attempted fixture admission');
  assert.equal(proposals, 2, 'Unsupported fixture proposals have a bounded retry limit');
  assert.equal(result.metrics.copyPreservationStations, 1, 'Unchanged source does not endlessly reopen an unavailable adapter');
  assert.equal(stationTurn.copyVerification.status, 'unverified');
  assert.equal(stationTurn.copyVerification.advisoryFallback.kind, 'ordinary-verification');
  assert.equal(stationTurn.copyVerification.advisoryFallback.executionEvidence, false);
  assert.ok(stationTurn.copyVerification.obligations.every(row => row.status === 'unverified' && !row.probeEvidence));
  assert.match(stationTurn.observation, /\[copy preservation unavailable\]/);
  assert.match(stationTurn.observation, /No copy verification credit was granted/);
  assert.match(stationTurn.observation, /do not change production to satisfy an unsupported fixture/);
  assert.doesNotMatch(stationTurn.observation, /All recorded shape-preservation and input-detachment cases passed/);
  assert.ok(requests[2].jsonSchema.properties.a.enum.includes('done'), 'An unavailable adapter does not permanently mask completion');
  assert.ok(requests.at(-1).jsonSchema.properties.a.enum.includes('done'));
  assert.match(prompts[2], /copy preservation unavailable/);
  assert.ok(projectExecutions > 0, 'The normal configured verifier still executed');
  assert.equal(result.verification.status, 'pass');
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(fs.readFileSync(path.join(workspace, 'api.mjs'), 'utf8'), GOOD + '// public contract implemented\n');
});

test('copy-adapter fallback cannot waive a failing configured verifier', async t => {
  const { result } = await run(fixture(t), [
    { a: 'write_file', p: 'api.mjs', content: GOOD + '// still needs normal project verification\n' },
    { a: 'done', summary: 'Attempted completion' },
  ], {
    copyPreservationStation: 'auto', shellSandbox: 'docker', verificationWorkspaceReadOnly: true,
    useGrammar: false, fixtureSpec: { unsupported: true },
    shellProcessRunner: async (_file, args) => {
      assert.match(args.at(-1), /node --test.*test\/public\.test\.mjs/);
      return { code: 1, stdout: 'TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n', stderr: '' };
    },
  });
  assert.equal(result.turns.find(turn => turn.copyVerification)?.copyVerification.advisoryFallback.kind, 'ordinary-verification');
  assert.equal(result.reachedDone, false);
  assert.equal(result.turns.at(-1).doneAccepted, false);
  assert.equal(result.verification.status, 'fail');
});

test('isolated copy failures retain current context and rerun after every repaired source generation', {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== '1', timeout: 120000,
}, async t => {
  const workspace = fixture(t);
  const checkpoint = new RunCheckpoint({ dest: path.join(workspace, 'checkpoint.json'), autosaveEvery: 0 });
  const actions = [
    { a: 'write_file', p: 'api.mjs', content: BAD }, { a: 'shell', c: VERIFY },
    { a: 'read_file', p: 'api.mjs' },
    { a: 'write_file', p: 'api.mjs', content: BAD + '// still broken generation 2\n' }, { a: 'shell', c: VERIFY },
    { a: 'write_file', p: 'api.mjs', content: BAD + '// still broken generation 3\n' }, { a: 'shell', c: VERIFY },
    { a: 'write_file', p: 'api.mjs', content: GOOD }, { a: 'shell', c: VERIFY },
    { a: 'done', summary: 'Copied shape and detached references verified' },
  ];
  const { result, prompts, requests, proposals } = await run(workspace, actions, {
    shellSandbox: 'docker', verificationWorkspaceReadOnly: true, copyPreservationStation: 'auto',
    onEvent: event => checkpoint.note(event),
  });
  const receipts = result.turns.filter(turn => turn.copyVerification).map(turn => turn.copyVerification);
  const receiptSummary = JSON.stringify(receipts.map(receipt => ({ generation: receipt.generation,
    status: receipt.status, reason: receipt.reason, obligations: receipt.obligations.map(row => ({
      id: row.id, status: row.status, output: row.probeEvidence?.stages.find(stage => stage.stage === 'check')?.stdout,
    })),
  })));
  assert.equal(receipts.length, 4, receiptSummary);
  assert.ok(receipts.slice(0, 3).every(receipt => receipt.obligations
    .find(row => row.id === 'shape-preservation')?.status === 'failed'), receiptSummary);
  assert.ok(receipts.slice(0, 3).every(receipt => !receipt.advisoryFallback), 'Measured copy failures cannot enter the unavailable-adapter fallback');
  assert.equal(receipts[3].status, 'passed', receiptSummary);
  assert.equal(new Set(receipts.map(receipt => receipt.generation)).size, 4);
  assert.equal(proposals, 1, 'Only fixture data is cached; every source generation executes new probes');
  for (const index of [2, 3, 5, 7]) {
    const verbs = requests[index].jsonSchema.properties.a.enum;
    assert.ok(!verbs.includes('done') && !verbs.includes('respond'));
    assert.ok(verbs.includes('shell') && verbs.includes('write_file'));
    assert.match(prompts[index], /copy preservation|copy-preservation|shape-preservation/i);
  }
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.ok(requests.at(-1).jsonSchema.properties.a.enum.includes('done'));
  const latestProject = result.turns.flatMap(turn => turn.verificationReceipts?.entries ?? [])
    .map(entry => entry.verificationEvidence).filter(evidence => evidence?.status === 'pass').at(-1);
  assert.equal(latestProject.generation, receipts[3].generation);
  assert.ok(checkpoint.turns().some(turn => turn.copyVerification?.obligations.some(row => row.status === 'failed')));
  const artifact = buildArtifact({ runId: 'copy-station-test', stamp: new Date().toISOString(), task: TASK, result });
  assert.ok(artifact.turns.some(turn => turn.copyVerification?.status === 'passed'));
  assert.equal(fs.readFileSync(path.join(workspace, 'api.mjs'), 'utf8'), GOOD, 'The station did not edit production source');
});
