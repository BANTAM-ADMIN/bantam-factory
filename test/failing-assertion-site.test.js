import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {parseTestFailures} from '../src/logic/test-focus.js';
import {verificationEvidence,verificationReceipt} from '../src/verification-evidence.js';
import {currentConfiguredFailure,verificationFailureContext} from '../src/verification-failure-context.js';

test('actual runner: second assertion survives receipt serialization and current failure context',t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-assert-site-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  const source="import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('same case, different operands',()=>{\n  const values=[1,2];\n  assert.equal(values[0],1);\n  assert.equal([...values].reverse()[0],1);\n});\n";
  fs.writeFileSync(path.join(workspace,'case.test.mjs'),source);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--test','case.test.mjs'],{cwd:workspace,encoding:'utf8',env});
  assert.equal(child.status,1);
  const parsed=parseTestFailures(child.stdout);
  assert.equal(parsed[0].line,3,'declaration is retained separately');
  assert.equal(parsed[0].assertionLine,6,'the failing assertion, not its passing neighbor');
  const proof=verificationEvidence({execution:{stdout:child.stdout,stderr:child.stderr,code:child.status,cwd:workspace},
    command:'node --test case.test.mjs',configuredCommand:'node --test case.test.mjs',generation:2,source:'automatic'});
  const receipt=JSON.parse(JSON.stringify(verificationReceipt(proof)));
  const options={generation:2,workspace,configuredCommand:'node --test case.test.mjs'};
  const failure=currentConfiguredFailure([{verificationEvidence:receipt}],options);
  assert.equal(failure.failureSites[0].line,6);
  const rendered=verificationFailureContext(failure,{workspace,readSource:p=>fs.readFileSync(path.join(workspace,p),'utf8')});
  assert.match(rendered.text,/6 > .*reverse\(\)/);
  assert.match(rendered.text,/neighboring passing call/);
  assert.ok(rendered.text.length<=2400);
  assert.equal(currentConfiguredFailure([{verificationEvidence:receipt}],{...options,generation:3}),null);
});

test('stack locations cannot cross files, test blocks, or clipped output seams',()=>{
  const head="not ok 1 - first\n  location: '/workspace/a.test.js:3:1'\n";
  for(const suffix of [
    '    TestContext.<anonymous> (/workspace/other.test.js:9:1)',
    '... (verification output clipped; tail preserved) ...\n    TestContext.<anonymous> (/workspace/a.test.js:9:1)',
    'ok 2 - next\n    TestContext.<anonymous> (/workspace/a.test.js:9:1)',
  ]) assert.equal(parseTestFailures(head+suffix)[0].assertionLine,undefined);
});

test('failure site rendering rejects outside paths, invalid locations and oversized source',()=>{
  const base={generation:0,turn:0,exitCode:1,command:'npm test'};
  for(const site of [{file:'../secret',line:1},{file:'/elsewhere/secret',line:1},{file:'a.js',line:-1},{file:'a.js',line:Infinity}]){
    let reads=0;
    const result=verificationFailureContext({...base,failureSites:[site]}, {workspace:'/workspace',readSource:()=>{reads++;return 'secret';}});
    assert.equal(reads,0);assert.doesNotMatch(result.text,/Failing stack site/);
  }
  assert.doesNotMatch(verificationFailureContext({...base,failureSites:[{file:'a.js',line:1}]},
    {workspace:'/workspace',readSource:()=> 'x'.repeat(300000)}).text,/Failing stack site/);
});
