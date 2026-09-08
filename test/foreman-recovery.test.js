import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ForemanQueue} from '../src/foreman-queue.js';
import {materializeForemanWorker, integrateForemanCandidate, foremanWorkerContext} from '../src/foreman.js';
import {summarizeJobs} from '../src/foreman-controller.js';
import {WorkspaceStore} from '../src/workspace-store.js';

const job = (id, resumeFrom = '') => ({id,worker:'local',task:'Repair the component.',context:'Keep existing behavior.',verify:'npm test',dependsOn:[],resumeFrom});
test('recovery requires a settled failed snapshot and never waits on a successful dependency', async () => {
  let release;
  const q = new ForemanQueue({execute:async j => {
    if (j.id === 'build') await new Promise(r => {release=r;});
    return {pass:false,snapshot:'base',recoverySnapshot:'retained'};
  }});
  q.submit([job('build')]); await Promise.resolve();
  assert.throws(() => q.submit([job('early','build')]), /settled/);
  release(); while(q.pending) await q.wait();
  assert.throws(() => q.submit([{...job('dependency','build'),dependsOn:['build']}]), /new dependencies/);
  assert.throws(() => q.submit([job('missing','absent')]), /settled/);
  assert.equal(summarizeJobs(q)[0].result.recoveryAvailable,true);
  let received;
  q.execute = async (j,deps,signal,progress,recovery) => {received=recovery; return {pass:true};};
  q.submit([job('repair','build')]); while(q.pending) await q.wait();
  assert.equal(received.id,'build'); assert.equal(received.status,'failed');
  assert.equal(q.jobs.at(-1).status,'passed');
  assert.throws(() => q.submit([job('passed','repair')]), /settled/);
  await q.close();
});

test('retained work resumes privately and fresh integration preserves independent edits or rejects overlap', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-foreman-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const overlap of [false,true]) {
    const dir=path.join(root,String(overlap));fs.mkdirSync(dir);
    const candidate=path.join(dir,'candidate');fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate,'engine.js'),'original');
    fs.writeFileSync(path.join(candidate,'style.css'),'original style');
    const store=new WorkspaceStore(path.join(dir,'store'));
    const before=store.capture(candidate);
    const failed=path.join(dir,'failed');store.materialize(before.commit,failed);
    fs.writeFileSync(path.join(failed,'engine.js'),'unfinished but valuable');
    fs.writeFileSync(path.join(failed,'test.js'),'retained assertions');
    const retained=store.capture(failed);
    const recovery={id:'build',status:'failed',finishedAt:1,result:{pass:false,snapshot:before.commit,recoverySnapshot:retained.commit}};
    fs.writeFileSync(path.join(candidate,overlap?'engine.js':'style.css'),'independent newer work');
    const ws=path.join(dir,'repair'),baseline=path.join(dir,'baseline');
    const snapshot=materializeForemanWorker({store,candidate,job:job('repair','build'),recovery,ws,before:baseline});
    assert.equal(snapshot.commit,before.commit);
    assert.equal(fs.readFileSync(path.join(ws,'engine.js'),'utf8'),'unfinished but valuable');
    assert.equal(fs.readFileSync(path.join(ws,'test.js'),'utf8'),'retained assertions');
    assert.equal(fs.existsSync(path.join(candidate,'test.js')),false,'recovery is not promotion');
    assert.match(foremanWorkerContext(job('repair','build'),[]),/already contains.*UNVERIFIED/);
    fs.writeFileSync(path.join(ws,'engine.js'),'repaired');
    const sealed=path.join(dir,'sealed');store.materialize(store.capture(ws).commit,sealed);
    const integrate=()=>integrateForemanCandidate({candidate,before:baseline,sealed,transactionRoot:path.join(dir,'tx'),id:'repair',verification:{pass:true}});
    if(overlap) {
      assert.throws(integrate,/conflict|changed|match/i);
      assert.equal(fs.readFileSync(path.join(candidate,'engine.js'),'utf8'),'independent newer work');
      assert.equal(fs.existsSync(path.join(candidate,'test.js')),false);
    } else {
      integrate(); assert.equal(fs.readFileSync(path.join(candidate,'engine.js'),'utf8'),'repaired');
      assert.equal(fs.readFileSync(path.join(candidate,'style.css'),'utf8'),'independent newer work');
      assert.equal(fs.readFileSync(path.join(candidate,'test.js'),'utf8'),'retained assertions');
    }
  }
});
