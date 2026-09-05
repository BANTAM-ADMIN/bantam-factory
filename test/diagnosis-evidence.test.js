import test from 'node:test';
import assert from 'node:assert/strict';
import { priorDiagnosisFollowup } from '../src/diagnosis-evidence.js';
import { parseTestFailures } from '../src/logic/test-focus.js';

const tap = (name, message = 'unexpected EOF') => `not ok 1 - ${name}\n  ---\n  location: 'test/csv.test.js:10:1'\n  error: '${message}'\n  ...\n`;
const failure = (name = 'EOF', message) => parseTestFailures(tap(name, message))[0];
const diagnosis = (name = 'EOF', file = 'src/csv.js', message) => ({
  parsedAction: { a: 'shell', c: 'npm test' },
  verificationEvidence: { status: 'fail', failingTests: [name], rawOutput: tap(name, message) },
  observation: tap(name, message) + `\n[diagnosis of "${name}"] FIX: ${file} end(): flush a pending row.\nCAUSE: pending EOF record.\nTRACE: end() path.`,
});
const edit = (file = 'src/csv.js', overrides = {}) => ({
  parsedAction: { a: 'replace', p: file, old: 'crPending = false', new: 'crPending = true' },
  observation: 'replaced one occurrence', editApplied: true, ...overrides,
});

test('same-file CR edit after EOF diagnosis gives factual follow-up, not causal falsification', () => {
  const result = priorDiagnosisFollowup([diagnosis(), edit()], failure());
  assert.match(result, /subsequent edit to src\/csv.js did not resolve/);
  assert.match(result, /does not prove the suggested change was applied or that the diagnosis was false/);
  assert.doesNotMatch(result, /diagnosis-falsified|previous focused diagnosis was applied|Discard its assumed trace/);
});

test('matching diagnosis block owns its FIX, not the first FIX in aggregate feedback', () => {
  const first = diagnosis('CR', 'src/cr.js');
  first.verificationEvidence.rawOutput = tap('CR') + tap('EOF');
  first.verificationEvidence.failingTests = ['CR', 'EOF'];
  first.observation += '\n\n[diagnosis of "EOF"] FIX: src/csv.js end(): flush pending row.\nCAUSE: EOF.';
  assert.match(priorDiagnosisFollowup([first, edit()], failure()), /src\/csv.js/);
  assert.equal(priorDiagnosisFollowup([first, edit('src/cr.js')], failure()), null);
});

test('later diagnosis cannot lend its FIX to the selected earlier block', () => {
  const first = diagnosis('EOF', 'src/csv.js');
  first.observation += '\n\n[diagnosis of "CR"] FIX: src/cr.js: adjust CR.';
  assert.equal(priorDiagnosisFollowup([first, edit('src/cr.js')], failure()), null);
});

test('changed message is a different failure even when test name matches', () => {
  assert.equal(priorDiagnosisFollowup([diagnosis(), edit()], failure('EOF', 'bare CR')), null);
});

test('unrelated, refused, no-change, and absent edit receipts do not establish mutation', () => {
  for (const change of [edit('src/other.js'), edit('src/csv.js', { editApplied: false }),
    edit('src/csv.js', { editApplied: undefined, observation: 'ERROR: old not found' }),
    edit('src/csv.js', { editApplied: undefined, observation: 'NO_CHANGE: identical' }),
    edit('src/csv.js', { editApplied: undefined, observation: '' })]) {
    assert.equal(priorDiagnosisFollowup([diagnosis(), change], failure()), null);
  }
});

test('typed null, unverified, or passing evidence cannot be replaced by red prose', () => {
  for (const receipt of [null, { status: 'unverified' }, { status: 'pass' }]) {
    assert.equal(priorDiagnosisFollowup([{ ...diagnosis(), verificationEvidence: receipt }, edit()], failure()), null);
  }
});

test('legacy shell film with actual TAP and explicit mutation retains conservative support', () => {
  const prior = diagnosis(); delete prior.verificationEvidence;
  const change = edit(); delete change.editApplied;
  assert.match(priorDiagnosisFollowup([prior, change], failure()), /does not prove/);
});

test('stored typed receipt without rawOutput uses only actual failure block before controller prose', () => {
  const prior = diagnosis(); delete prior.verificationEvidence.rawOutput;
  assert.match(priorDiagnosisFollowup([prior, edit()], failure()), /subsequent edit/);
  prior.observation = '[fix-tests] ' + prior.observation;
  assert.equal(priorDiagnosisFollowup([prior, edit()], failure()), null);
});

test('one advisory per diagnosis, and shell change receipts count only for shell actions', () => {
  const history = [diagnosis(), { parsedAction: { a: 'shell', c: 'patch' }, shellChangedPaths: ['src/csv.js'] }];
  const result = priorDiagnosisFollowup(history, failure());
  assert.match(result, /subsequent edit/);
  assert.equal(priorDiagnosisFollowup([...history, { observation: result }], failure()), null);
  history[1].parsedAction.a = 'read_file';
  assert.equal(priorDiagnosisFollowup(history, failure()), null);
});
