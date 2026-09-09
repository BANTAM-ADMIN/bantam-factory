import test from 'node:test';
import assert from 'node:assert/strict';
import {failureFingerprint, failureOutcomeFingerprint, repeatedFailureDiagnostic, OutcomeCycleTracker} from '../src/failure-diagnostics.js';

const shell={a:'shell',c:'npm test'};
const edit={action:{a:'replace',p:'checker.js',old:'before',new:'after'},observation:'replaced 1 occurrence in checker.js'};
const green=`VERDICT: all 3 tests passed.
Shell exit 0
TAP version 13
# Subtest: invalid arguments exit 2 without stdout
ok 1 - invalid arguments exit 2 without stdout
# Subtest: reports SIGSEGV and Segmentation fault for a crashed child
ok 2 - reports SIGSEGV and Segmentation fault for a crashed child
# Subtest: Aborted, core dumped and SIGABRT diagnostics are readable
ok 3 - Aborted, core dumped and SIGABRT diagnostics are readable
1..3
# tests 3
# pass 3
# fail 0
`;
const red=`Shell exit 1
TAP version 13
# Subtest: invalid arguments exit 2 without stdout
not ok 1 - invalid arguments exit 2 without stdout
  error: 'Expected values to be strictly equal'
  expected: 2
  actual: 0
1..1
# tests 1
# pass 0
# fail 1
`;

test('passing TAP names are descriptions, not observed exit codes or crashes',()=>{
 for(const text of [green,green.replaceAll('ok 1','\u001b[32mok 1\u001b[0m')]){
  assert.equal(failureFingerprint(text),null);
  assert.equal(failureOutcomeFingerprint(text),null);
 }
});

test('three green checks after edits neither diagnose repeated failure nor form an outcome cycle',()=>{
 const history=[{action:shell,observation:green},edit,{action:shell,observation:green},edit];
 assert.equal(repeatedFailureDiagnostic(history,shell,green),null);
 const tracker=new OutcomeCycleTracker();
 for(let turn=1;turn<=3;turn++){
  tracker.noteWorkspaceChanged();assert.equal(tracker.observe(shell,green,{turn}),null);
 }
});

test('a passing suite ends a failure streak even when its test names mention failures',()=>{
 const history=[{action:shell,observation:red},edit,{action:shell,observation:red},edit,
  {action:shell,observation:green},edit];
 assert.equal(repeatedFailureDiagnostic(history,shell,red),null);
});

test('real failing TAP assertions still escalate and preserve their diagnostic evidence',()=>{
 assert.match(failureFingerprint(red),/not ok 1/);
 assert.match(failureOutcomeFingerprint(red),/expected: 2/);
 const history=[{action:shell,observation:red},edit,{action:shell,observation:red},edit];
 assert.match(repeatedFailureDiagnostic(history,shell,red),/appeared 3 times/);
 const tracker=new OutcomeCycleTracker();tracker.observe(shell,red,{turn:1});tracker.noteWorkspaceChanged();
 assert.equal(tracker.observe(shell,red,{turn:2}).occurrence,2);
});

test('a real process failure after passing test labels remains visible',()=>{
 for(const tail of ['exit=139\nSegmentation fault (core dumped)','Error: teardown failed','not ok 4 - teardown']){
  assert.ok(failureFingerprint(green+tail));
  assert.ok(failureOutcomeFingerprint(green+tail));
 }
});
