import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectProbeEvidence } from '../src/probe-evidence.js';

function receipt() {
  return { schema: 'bantam.probe-receipt.v1', experimentId: 'experiment:a',
    specDigest: 'spec:a', sourceDigest: 'source:a', sourceAfterDigest: 'source:a',
    question: 'Does the declared fixture exercise the assertion?',
    stages: ['setup','witness','check'].map(stage => ({ stage,
      experimentId: 'experiment:a', sourceDigest: 'source:a', commandDigest: `command:${stage}`,
      executed: true, code: 0, signal: null, timedOut: false, aborted: false,
      bufferExceeded: false, error: null, stdoutDigest: `stdout:${stage}`, stderrDigest: `stderr:${stage}` })) };
}

function result(input, status, reason) {
  const before = JSON.stringify(input);
  const out = projectProbeEvidence(input);
  assert.equal(JSON.stringify(input), before, 'do not mutate caller input');
  assert.equal(out.schema, 'bantam.probe-evidence.v1');
  assert.equal(out.status, status);
  assert.equal(out.reason, reason);
  assert.ok(out.proof && typeof out.proof === 'object', 'real rule explanation is required');
  assert.ok(out.datalog && typeof out.datalog === 'object');
  assert.doesNotThrow(() => JSON.stringify(out));
  return out;
}

test('three fresh clean stages derive a scoped passing assertion with real proof', () => {
  const out = result(receipt(), 'assertion_passed', 'assertion_passed');
  assert.ok(out.proof.rule, 'a derived proof has its rule');
  const proof = JSON.stringify(out.proof);
  for (const name of ['setup','witness','check']) assert.ok(proof.includes(name), name);
});
test('clean nonzero check is a scoped failed assertion', () => {
  const r = receipt(); r.stages[2].code = 1;
  result(r, 'assertion_failed', 'assertion_failed');
});
test('setup and witness failure are not candidate assertion failure', () => {
  const setup = receipt(); setup.stages[0].code = 2;
  result(setup, 'unresolved', 'setup_failed');
  const witness = receipt(); witness.stages[1].code = 1;
  result(witness, 'unresolved', 'witness_unobserved');
});
test('abnormal exit-zero and skipped check cannot green', () => {
  const infra = receipt(); infra.stages[2].timedOut = true;
  result(infra, 'unresolved', 'infrastructure');
  const skip = receipt(); skip.stages[2].executed = false;
  result(skip, 'unresolved', 'incomplete');
});
test('stale source and mixed identities fail closed', () => {
  const stale = receipt(); stale.sourceAfterDigest = 'source:b';
  result(stale, 'unresolved', 'stale_source');
  const mixed = receipt(); mixed.stages[1].experimentId = 'experiment:b';
  result(mixed, 'unresolved', 'identity_mismatch');
});
test('missing stage and malformed input fail closed', () => {
  for (const bad of [null, {}, { ...receipt(), stages: receipt().stages.slice(0,2) }])
    result(bad, 'unresolved', 'malformed_receipt');
});
