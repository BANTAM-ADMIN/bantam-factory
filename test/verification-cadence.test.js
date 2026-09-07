import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationEvidence } from '../src/verification-evidence.js';
import { verificationCadenceEffect } from '../src/verification-cadence.js';
const options = { generation: 3, configuredCommand: 'npm test' };
const make = (command, source = 'shell', changes = {}) => verificationEvidence({ execution: {
  command, executedCommand: command, cwd: '/tmp/test', exitCode: 0, stdout: '# tests 4\n# pass 4\n# fail 0\n', stderr: '', ...changes,
}, ...options, command, source });
test('all producer sources credit the same merged configured execution without rewriting raw commands', () => {
  for (const source of ['shell', 'automatic', 'landing', 'completion', 'scoped']) {
    const evidence = make('npm test 2>&1', source);
    assert.equal(evidence.configuredCommand, 'npm test');
    assert.equal(evidence.executedCommand, 'npm test 2>&1');
    assert.deepEqual(verificationCadenceEffect(evidence, options), { full: source !== 'scoped', status: 'pass' });
  }
});
test('failed completed checks reset cadence; scoped, stale, cached and inconclusive checks cannot claim full freshness', () => {
  assert.equal(verificationCadenceEffect(make('npm test', 'automatic', { exitCode: 1 }), options).status, 'fail');
  assert.equal(verificationCadenceEffect(make('node --test test/one.test.js', 'scoped'), options).full, false);
  for (const changes of [{ timedOut: true }, { interrupted: true }, { blocked: true }, { exitCode: null }])
    assert.equal(verificationCadenceEffect(make('npm test', 'automatic', changes), options), null);
  for (const changes of [{ generation: 2 }, { cached: true }])
    assert.equal(verificationCadenceEffect({ ...make('npm test'), ...changes }, options), null);
  for (const command of ['npm test || true', 'npm test | tail', 'npm test; echo PASS'])
    assert.equal(verificationCadenceEffect(make(command), options), null);
});
