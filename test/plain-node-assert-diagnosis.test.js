import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';

test('three plain Node assertion failures activate existing focused diagnosis and pin actual public evidence',async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-plain-assert-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'src/value.cjs'),'exports.value=()=>0;\n');
  const originalTest="const assert=require('node:assert/strict');\nconst {value}=require('../src/value.cjs');\nassert.equal(value(),14,'public value must be fourteen');\n";
  fs.writeFileSync(path.join(workspace,'test/value.test.cjs'),originalTest);
  const actions=[...Array.from({length:3},(_,i)=>[
    {a:'write_file',p:'src/value.cjs',content:`exports.value=()=>0;\nfunction unusedHelper(){return ${i+1};}\n`},
    {a:'shell',c:'node test/value.test.cjs'},
  ]).flat(),{a:'write_file',p:'src/value.cjs',content:'exports.value=()=>14;\n'},
    {a:'shell',c:'node test/value.test.cjs'},{a:'done',summary:'Public value repaired and verified.'}];
  const diagnostics=[],events=[];
  const result=await runAgent({workspace,task:'Fix src/value.cjs so its public value() returns 14. Do not edit test/value.test.cjs. Verify with node test/value.test.cjs.',
    model:{assistantPrefill:'',actTemperature:null,async complete(prompt){
      if(prompt.includes('STRICT OUTPUT — exactly these THREE short lines')){
        diagnostics.push(prompt);
        return {content:'FIX: src/value.cjs exported value(): return the required public value.\nCAUSE: The edited helper is never called by the export.\nTRACE: test calls exported value -> returns 0; unusedHelper is unreachable.',tokens:1,stoppedEos:true};
      }
      assert.ok(actions.length,'unexpected additional worker call');
      return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
    }},onEvent:e=>events.push(e),maxTurns:12,useGrammar:false,interactive:false,grounding:false,
    shellSandbox:'host',verificationScript:'node test/value.test.cjs',completionAudit:false,stateAudit:'off',contractStateAudit:'off',
    diagnoseStuckTests:true,diagnoseAfter:3,testFocus:true,regressionGuard:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0});
  assert.equal(diagnostics.length,1,'plain-script assertions must reach the existing one-shot diagnostic');
  assert.match(diagnostics[0],/assert.equal\(value\(\),14/);
  assert.match(diagnostics[0],/exports.value=\(\)=>0/);
  assert.match(diagnostics[0],/unusedHelper/);
  assert.match(diagnostics[0],/14/);
  assert.ok(result.metrics.evidencePins>=1);
  assert.equal(events.filter(e=>e.type==='test_diagnosis').length,1);
  assert.equal(result.reachedDone,true,result.turns.at(-1)?.observation);
  assert.equal(result.verification.status,'pass');
  assert.equal(fs.readFileSync(path.join(workspace,'test/value.test.cjs'),'utf8'),originalTest);
});
