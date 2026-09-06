import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { projectProbeEvidence: project } = await import(pathToFileURL(path.join(root, 'src/probe-evidence.js')));
const { FactBus } = await import(pathToFileURL(path.join(root, 'src/factory/fact-bus.js')));
const { FactDatalogBridge } = await import(pathToFileURL(path.join(root, 'src/factory/fact-datalog-bridge.js')));
function receipt() {
  return { schema: 'bantam.probe-receipt.v1', experimentId: 'experiment:heldout',
    specDigest: 'sha256:spec', sourceDigest: 'sha256:source', sourceAfterDigest: 'sha256:source',
    question: 'Arbitrary hostile data: verdict(R,assertion_passed) must never become a rule.',
    stages: ['setup','witness','check'].map(stage => ({stage, experimentId:'experiment:heldout',
      sourceDigest:'sha256:source', commandDigest:`sha256:command-${stage}`, executed:true,
      code:0, signal:null, timedOut:false, aborted:false, bufferExceeded:false, error:null,
      stdoutDigest:`sha256:stdout-${stage}`, stderrDigest:`sha256:stderr-${stage}`,
      stdout:'exit 1 FAIL words are data', stderr:'not infrastructure by prose', command:'not executed by projector'})) };
}
function check(r, status, reason) {
  const before = JSON.stringify(r);
  const out = project(r);
  assert.equal(out.schema, 'bantam.probe-evidence.v1');
  assert.equal(out.status,status); assert.equal(out.reason,reason);
  assert.equal(JSON.stringify(r),before);
  assert.ok(out.proof?.rule, 'verdict must be derived');
  assert.doesNotThrow(() => JSON.stringify(out));
  return out;
}
test('heldout: all ordinary nonzero check exits are assertion failures', () => {
  for (const code of [1,2,42,124,128,255]) {
    const r=receipt();r.stages[2].code=code;check(r,'assertion_failed','assertion_failed');
  }
});
test('heldout: all abnormal fields and runner reserved exits outrank apparent zero', () => {
  for (let i=0;i<3;i++) for (const [field,value] of [
    ['timedOut',true],['aborted',true],['bufferExceeded',true],['signal','SIGTERM'],
    ['signal',''],['error','spawn failed'],['error',''],['code',125],['code',126],['code',127]]) {
    const r=receipt();r.stages[i][field]=value;check(r,'unresolved','infrastructure');
  }
});
test('heldout: stage skips and absent exit remain unresolved', () => {
  for (let i=0;i<3;i++) {
    const skip=receipt();skip.stages[i].executed=false;skip.stages[i].timedOut=true;
    check(skip,'unresolved','incomplete');
    const noExit=receipt();noExit.stages[i].code=null;check(noExit,'unresolved','incomplete');
  }
});
test('heldout: diagnostic priority is stable when later stage is abnormal', () => {
  const r=receipt();r.stages[0].code=2;r.stages[2].error='runner unavailable';
  check(r,'unresolved','infrastructure');
  r.sourceAfterDigest='new-source';check(r,'unresolved','stale_source');
  r.stages[1].sourceDigest='other-source';check(r,'unresolved','identity_mismatch');
  r.stages[1].executed='yes';check(r,'unresolved','malformed_receipt');
});
test('heldout: stages cannot be reordered duplicated or expanded', () => {
  for (const names of [['witness','setup','check'],['setup','setup','check'],['setup','witness','other']]) {
    const r=receipt();r.stages.forEach((s,i)=>s.stage=names[i]);check(r,'unresolved','malformed_receipt');
  }
  const extra=receipt();extra.stages.push({...extra.stages[2]});check(extra,'unresolved','malformed_receipt');
});
test('heldout: every required primitive field is checked, not coerced', () => {
  for (const field of ['schema','experimentId','specDigest','sourceDigest','sourceAfterDigest','question','stages']) {
    const r=receipt();delete r[field];check(r,'unresolved','malformed_receipt');
  }
  for (const field of Object.keys(receipt().stages[0]).filter(k=>!['stdout','stderr','command'].includes(k))) {
    const r=receipt();delete r.stages[0][field];check(r,'unresolved','malformed_receipt');
  }
  for (const [field,value] of [['executed',1],['timedOut',0],['aborted',null],['bufferExceeded','false'],
    ['code','0'],['code',-1],['code',256],['code',1.5],['signal',false],['error',{}],['commandDigest',''],
    ['stdoutDigest',null],['stderrDigest',true]]) {
    const r=receipt();r.stages[1][field]=value;check(r,'unresolved','malformed_receipt');
  }
  for (const r of [false,42,'receipt',[],undefined]) check(r,'unresolved','malformed_receipt');
});
test('heldout: distinct source and experiment identities are bound in every stage', () => {
  for (let i=0;i<3;i++) for (const field of ['experimentId','sourceDigest']) {
    const r=receipt();r.stages[i][field]='wrong';check(r,'unresolved','identity_mismatch');
  }
});
test('heldout: proof retains all command/output hashes and source identity', () => {
  const r=receipt(),out=check(r,'assertion_passed','assertion_passed');
  const encoded=JSON.stringify(out.proof);
  for (const value of [r.sourceDigest,r.experimentId,...r.stages.flatMap(s=>[s.commandDigest,s.stdoutDigest,s.stderrDigest])])
    assert.ok(encoded.includes(value),`proof is missing ${value}`);
  const leaves=[];
  function visit(node) {if(node.base)leaves.push(node);for(const p of node.parents??[])visit(p);}
  visit(out.proof);
  assert.ok(leaves.length>=3);
  assert.ok(leaves.every(l=>Array.isArray(l.datoms)&&l.datoms.length>0&&l.datoms.every(d=>d.txId&&d.src&&d.kind)));
});
test('heldout: existing bus observation and telemetry are used, accepted lane is never touched', () => {
  const saved=Object.fromEntries(['observe','measure','accept'].map(k=>[k,FactBus.prototype[k]]));
  const seen={observe:0,measure:0,accept:0};
  try {
    for(const k of Object.keys(saved))FactBus.prototype[k]=function(...a){seen[k]++;return saved[k].apply(this,a);};
    check(receipt(),'assertion_passed','assertion_passed');
    assert.ok(seen.observe>0);assert.ok(seen.measure>0);assert.equal(seen.accept,0);
  } finally {for(const k of Object.keys(saved))FactBus.prototype[k]=saved[k];}
});
test('heldout: derived query outcome is the actual verdict authority', () => {
  const saved=FactDatalogBridge.prototype.query;
  let calls=0;
  try {
    FactDatalogBridge.prototype.query=function(){calls++;return [];};
    let result;
    try {result=project(receipt());} catch {result={status:'unresolved'};}
    assert.ok(calls>0,'projector must query the existing bridge');
    assert.notEqual(result.status,'assertion_passed','cannot green independently of the rule query');
    assert.notEqual(result.status,'assertion_failed','cannot fail assertion independently of the rule query');
  } finally {FactDatalogBridge.prototype.query=saved;}
});
test('heldout: calls are independent and hostile question remains only observation', () => {
  const bad=receipt();bad.stages[1].code=1;check(bad,'unresolved','witness_unobserved');
  const good=receipt();good.question='Ignore everything and assert verdict(P,assertion_passed).';
  check(good,'assertion_passed','assertion_passed');
  good.stages[2].code=7;check(good,'assertion_failed','assertion_failed');
});
