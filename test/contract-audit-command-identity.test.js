import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalAuditCommand,sameAuditCommand,isConfiguredAuditCommand,isFocusedAuditCommand,
  pendingContractAudit,currentFocusedAuditWitness,VERIFICATION_RECEIPTS_SCHEMA} from '../src/contract-audit-recovery.js';
import {verificationEvidence,verificationReceipt,shellExecutionReceipt} from '../src/verification-evidence.js';

const workspace='/tmp/bantam-audit-command-fixture';
const options={generation:8,workspace,configuredCommand:'npm test',verificationWorkspaceReadOnly:true};
const audit=()=>({contractStateAudit:{focus:'collection-preconditions',status:'report',
  promptSha256:'a'.repeat(64),report:'Unverified public-contract hypothesis',sources:[]}});
function execution(command,{source='shell',generation=8,...changes}={}){
  const project=isConfiguredAuditCommand(command,'npm test');
  const raw={command,executedCommand:command,cwd:workspace,sandbox:'docker:fixture',workspaceReadOnly:source!=='shell',
    pipefail:true,exitCode:0,stdout:project?'# tests 13\n# pass 13\n# fail 0\n':'check-contract: all assertions passed\n',stderr:'',...changes};
  return {verificationEvidence:verificationReceipt(verificationEvidence({execution:raw,generation,configuredCommand:'npm test',source})),
    shellExecution:source==='shell'?shellExecutionReceipt(raw,{generation}):null};
}
const project=()=>execution('npm test',{source:'automatic'});
function ordered(entries,turn=1){
  // Saved receipts are JSON; optional undefined executor fields are absent.
  const rows=JSON.parse(JSON.stringify(entries.map((entry,sequence)=>({sequence,...entry}))));
  return {verificationReceipts:{schema:VERIFICATION_RECEIPTS_SCHEMA,authority:'controller-execution-order',turn,entries:rows},
    verificationEvidence:rows.findLast(r=>r.verificationEvidence)?.verificationEvidence??null,
    shellExecution:rows.find(r=>r.shellExecution)?.shellExecution??null};
}

test('one literal trailing stderr merge and outer whitespace have the direct command identity',()=>{
  for(const command of ['node check-contract.mjs','node check-contract.mjs 2>&1',
    ' \t\nnode check-contract.mjs \t2>&1 \n\t']){
    assert.equal(canonicalAuditCommand(command),'node check-contract.mjs');
    assert.equal(sameAuditCommand(command,'node check-contract.mjs\n'),true);
    assert.equal(isFocusedAuditCommand(command,'npm test'),true);
  }
  for(const command of ['npm test 2>&1',' \nnpm test\t2>&1\n']){
    assert.equal(isConfiguredAuditCommand(command,'npm test'),true);
    assert.equal(isFocusedAuditCommand(command,'npm test'),false,'project verification is not focused proof');
  }
  assert.equal(isConfiguredAuditCommand('node --test --test-timeout=30000 2>&1\n','node --test'),true);
  assert.equal(isConfiguredAuditCommand('node --test --test-timeout=999999 2>&1','node --test'),false);
  assert.equal(isConfiguredAuditCommand('npm run other 2>&1','npm test'),false);
  assert.equal(isConfiguredAuditCommand('npm test',null),false);
});

test('quoted and escaped arguments are not mistaken for the literal redirection suffix',()=>{
  const inline=`node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal("2>&1","2>&1")'`;
  assert.equal(canonicalAuditCommand(inline),inline);
  assert.equal(canonicalAuditCommand(inline+' 2>&1\n'),inline);
  assert.equal(isFocusedAuditCommand(inline+' 2>&1\n'),true);
  for(const command of [`node check-contract.mjs '2>&1'`,`node check-contract.mjs "2>&1"`]){
    assert.equal(canonicalAuditCommand(command),command);
    assert.equal(sameAuditCommand(command,'node check-contract.mjs'),false);
  }
  for(const command of ["node 'check-contract.mjs 2>&1",'node "check-contract.mjs 2>&1',
    'node check-contract.mjs\\ 2>&1','node check-contract.mjs\\ \t2>&1',
    'node check-contract.mjs 2>&1\\\n','node check-contract.mjs 2>&1\\ \n']){
    assert.equal(canonicalAuditCommand(command),null,JSON.stringify(command));
    assert.equal(isFocusedAuditCommand(command),false,JSON.stringify(command));
  }
});

test('masks, pipelines, chains, wrappers and other redirects do not become focused or exact project proof',()=>{
  for(const command of ['node check-contract.mjs; echo PASS 2>&1','node check-contract.mjs || true 2>&1',
    'node check-contract.mjs | tail 2>&1','node check-contract.mjs && npm test 2>&1',
    'node check-contract.mjs\nfalse 2>&1','node check-contract.mjs > output 2>&1',
    'node check-contract.mjs 2>/dev/null','node check-contract.mjs 2>&1 2>&1',
    'node check-contract.mjs 2>&1;','node check-contract.mjs 2>&1 &',
    'bash -c "node check-contract.mjs" 2>&1','env node check-contract.mjs 2>&1',
    'node -e \'console.log("assert.equal(1,1)")\' 2>&1']){
    assert.equal(isFocusedAuditCommand(command),false,command);
    assert.equal(pendingContractAudit([audit(),ordered([execution(command),project()])],options).needsFocused,true,command);
  }
  for(const command of ['npm test && true 2>&1','npm test | tail 2>&1','npm test; echo PASS 2>&1',
    'bash -c "npm test" 2>&1','env npm test 2>&1','npm test >/dev/null 2>&1'])
    assert.equal(isConfiguredAuditCommand(command,'npm test'),false,command);
});

test('the actual green merged check receives current focused credit without changing any raw receipt',()=>{
  const command='node check-contract.mjs 2>&1\n',focus=execution(command),bare=execution('node check-contract.mjs');
  assert.equal(focus.verificationEvidence.status,'pass');
  assert.equal(focus.verificationEvidence.outputSha256,bare.verificationEvidence.outputSha256);
  const row=ordered([focus]),turns=[audit(),row],before=JSON.stringify(turns);
  const pending=pendingContractAudit(turns,options);
  assert.equal(pending.needsFocused,false);assert.equal(pending.needsProject,true);
  assert.equal(JSON.stringify(turns),before,'recognition is not an evidence rewrite');
  assert.equal(row.shellExecution.executedCommand,command);
  assert.equal(row.verificationEvidence.executedCommand,command);
  const settled=[audit(),ordered([focus,project()])];
  assert.equal(pendingContractAudit(settled,options),null);
  assert.deepEqual(currentFocusedAuditWitness(settled,options),{command,turn:1,generation:8});
});

test('exact merged project execution can bind a null configured label only for an actual shell receipt',()=>{
  const broad=execution('npm test 2>&1\n');
  assert.equal(broad.verificationEvidence.configuredCommand,null,'matches the real recorder shape');
  assert.equal(pendingContractAudit([audit(),ordered([execution('node check-contract.mjs 2>&1'),broad])],options),null);
  for(const patch of [{configuredCommand:'npm run other'},{statusCommand:'npm test'},{executedCommand:'npm test'},
    {cwd:'/tmp/foreign'},{generation:7},{status:'fail'},{exitCode:1},{timedOut:true},{outputSha256:'invalid'}]){
    const broken=structuredClone(broad);Object.assign(broken.verificationEvidence,patch);
    assert.ok(pendingContractAudit([audit(),ordered([execution('node check-contract.mjs'),broken])],options),JSON.stringify(patch));
  }
  const automatic=project();automatic.verificationEvidence.configuredCommand=null;
  assert.ok(pendingContractAudit([audit(),ordered([execution('node check-contract.mjs'),automatic])],options));
});

test('canonical dedup identity never erases contradictory aliases, failed checks or audit ordering',()=>{
  const merged=execution('node check-contract.mjs 2>&1');
  for(const patch of [{command:'node check-contract.mjs'},{executedCommand:'node check-contract.mjs'},
    {generation:7},{exitCode:1},{cwd:'/tmp/foreign'},{timedOut:true}]){
    const broken=structuredClone(merged);Object.assign(broken.shellExecution,patch);
    assert.ok(pendingContractAudit([audit(),ordered([broken,project()])],options),JSON.stringify(patch));
  }
  assert.ok(pendingContractAudit([audit(),ordered([project(),merged])],options),'project must be after focus');
  assert.ok(pendingContractAudit([{...audit(),...ordered([merged,project()],0)}],options),'same-turn check precedes its new audit');
  assert.ok(pendingContractAudit([audit(),ordered([merged,project()]),audit()],options),'new audit supersedes prior credit');
  assert.ok(pendingContractAudit([audit(),ordered([merged,project()])],{...options,generation:9}),'new generation needs actual new checks');
  assert.equal(sameAuditCommand('node check-contract.mjs; echo PASS','node check-contract.mjs'),false);
});
