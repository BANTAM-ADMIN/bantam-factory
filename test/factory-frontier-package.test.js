import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {packageFrontierSidecar,selectFrontierEvidence,credentialPatternMatch} from '../scripts/factory-frontier-package.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'frontier-package-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'source'),destination=path.join(base,'package'),task='synthetic task\n',candidate='export const example = 1;\n';
  const session='{"type":"synthetic-test-only"}\n';
  const results=['receipt-reducer','snapshot-drift','job-planner'].flatMap(card=>['codex-sol','codex-terra'].map(arm=>({
    card,arm,repeat:1,model:arm==='codex-sol'?'gpt-5.6-sol':'gpt-5.6-terra',outcome:arm==='codex-sol'?'PASS':'TIMEOUT',
    candidatePass:arm==='codex-sol',processCompleted:arm==='codex-sol',usage:null,usageStatus:'unknown',
    taskSha256:sha(task),finalFiles:{'tool.js':sha(candidate)},nativeSessionSeal:{'nested/session.jsonl':sha(session)},
  })));
  const manifest={schema:'bantam.factory-frontier-sidecar.v1',complete:true,sourceMismatches:[],kitMismatches:[],
    plan:results.map(({card,arm,model,repeat})=>({card,arm,model,repeat})),results,
    sourceSeal:{'src/example.js':sha('source')},kitSeal:{'README.md':sha('kit')}};
  write(path.join(source,'RESULTS.md'),'synthetic results');write(path.join(source,'source-evidence/runtime/src/example.js'),'source');
  write(path.join(source,'source-evidence/kit/README.md'),'kit');
  for(const r of results){const dir=path.join(source,'repeat-1',r.card,r.arm);
    for(const name of ['command.json','stdout.log','stderr.log','public.stdout.log','public.stderr.log','hidden.stdout.log','hidden.stderr.log'])write(path.join(dir,name),'{}');
    write(path.join(dir,'task.md'),task);write(path.join(dir,'ws/tool.js'),candidate);write(path.join(dir,'native-sessions/nested/session.jsonl'),session);
    write(path.join(dir,'ws/.env'),'EXCLUDED_PRIVATE_BYTES');write(path.join(dir,'native/cache/auth.json'),'EXCLUDED_PRIVATE_BYTES');
    write(path.join(source,'repeat-1',r.card,'events.ndjson'),'{}\n');
  }
  const save=()=>{write(path.join(source,'manifest.json'),manifest);for(const r of results)write(path.join(source,'repeat-1',r.card,r.arm,'result.json'),r);};save();
  return {base,source,destination,manifest,save};
}

test('separate six-row package preserves schema, failures, unknowns and exact archive members',t=>{
  const f=fixture(t),result=packageFrontierSidecar(f.source,f.destination);assert.equal(result.results,6);
  const m=JSON.parse(fs.readFileSync(path.join(f.destination,'manifest.json')));assert.deepEqual(m,f.manifest);
  assert.equal(m.results.filter(r=>r.outcome==='TIMEOUT').length,3);assert.ok(m.results.every(r=>r.usage===null));
  const index=JSON.parse(fs.readFileSync(path.join(f.destination,'evidence-index.json')));
  assert.equal(index.sourceSchema,'bantam.factory-frontier-sidecar.v1');assert.equal(index.private,true);assert.equal(index.redacted,false);
  assert.equal(index.archive.roundtripVerified,true);assert.deepEqual(index.credentialScan.matchedFiles,[]);
  assert.ok(index.members.every(m=>!m.path.includes('/.env')&&!m.path.includes('/cache/')));
  assert.equal(spawnSync('sha256sum',['-c','package.sha256'],{cwd:f.destination}).status,0);
  const unpack=path.join(f.base,'unpack');fs.mkdirSync(unpack);
  assert.equal(spawnSync('tar',['-xzf',path.join(f.destination,'evidence.tar.gz'),'-C',unpack]).status,0);
  assert.equal(spawnSync('sha256sum',['-c',path.join(f.destination,'members.sha256')],{cwd:unpack}).status,0);
  for(const item of index.members)assert.equal(sha(fs.readFileSync(path.join(unpack,item.path))),item.sha256);
});

test('only complete distinct sidecars qualify; existing targets and source nesting are refused',t=>{
  const f=fixture(t);f.manifest.schema='bantam.factory-fights.v1';f.save();assert.throws(()=>selectFrontierEvidence(f.source),/six-run native sidecar/);
  f.manifest.schema='bantam.factory-frontier-sidecar.v1';f.manifest.complete=false;f.save();assert.throws(()=>selectFrontierEvidence(f.source),/complete/);
  f.manifest.complete=true;f.save();assert.throws(()=>packageFrontierSidecar(f.source,path.join(f.source,'nested')),/outside/);
  fs.mkdirSync(f.destination);write(path.join(f.destination,'mine'),'retain');assert.throws(()=>packageFrontierSidecar(f.source,f.destination),/already exists/);
  assert.equal(fs.readFileSync(path.join(f.destination,'mine'),'utf8'),'retain');
});

test('digest tampering, path traversal and symlink evidence fail without following links',t=>{
  const f=fixture(t),row=f.manifest.results[0],file=path.join(f.source,'repeat-1',row.card,row.arm,'ws/tool.js');
  write(file,'changed');assert.throws(()=>selectFrontierEvidence(f.source),/sealed bytes changed/);
  fs.unlinkSync(file);fs.symlinkSync('/etc/passwd',file);assert.throws(()=>selectFrontierEvidence(f.source),/symlink refused/);
  fs.unlinkSync(file);write(file,'export const example = 1;\n');row.finalFiles['../outside']=sha('bad');f.save();
  assert.throws(()=>selectFrontierEvidence(f.source),/unsafe relative path/);
});

test('credential scan reports filenames only, never the potential secret bytes',t=>{
  const f=fixture(t),row=f.manifest.results[0],secret='sk-'+'A'.repeat(40),relative=`repeat-1/${row.card}/${row.arm}/stdout.log`;
  assert.equal(credentialPatternMatch(Buffer.from(secret)),true);write(path.join(f.source,relative),secret);
  assert.throws(()=>packageFrontierSidecar(f.source,f.destination),error=>error.message.includes(relative)&&!error.message.includes(secret));
  assert.equal(fs.existsSync(f.destination),false);
});
