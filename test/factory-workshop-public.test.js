import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {factoryKit,FACTORY_KITS,PUBLIC_FACTORY_CARDS} from '../scripts/factory-card-catalog.mjs';
import {buildShowcase,publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildReplayLane} from '../scripts/factory-fight-replay.mjs';
import {buildLaunchData,parseLaunchArgs,writeLaunchPackage} from '../scripts/factory-launch.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-workshop-public-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const arm='bantam-local-tiel-workshop-1';
  const manifest={schema:'bantam.factory-local-variant.v1',kitId:'factory-2026-09-07',
    variantId:'tiel-workshop-1',arm,modelId:'Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf',complete:false,
    startedAt:'2026-09-07T00:00:00.000Z',privateNote:'PRIVATE_WORKSHOP_SENTINEL',
    plan:factoryKit('factory-2026-09-07').cards.map(card=>({card,arm,repeat:1})),results:[]};
  const save=()=>fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));save();
  return {root,manifest,save};
}

test('versioned card catalog keeps historical identities and rejects paths/prototype aliases',()=>{
  assert.deepEqual(factoryKit().cards,['receipt-reducer','snapshot-drift','job-planner']);
  const kit=factoryKit('factory-2026-09-07');
  assert.deepEqual(kit.cards,['context-packet','patch-transaction','stream-framer']);
  assert.ok(path.isAbsolute(kit.root));assert.equal(path.basename(kit.root),kit.id);
  kit.cards.pop();assert.equal(factoryKit(kit.id).cards.length,3);
  assert.ok(Object.isFrozen(FACTORY_KITS[kit.id]));
  for(const id of ['../factory-2026-09-07','/tmp/kit','__proto__','constructor','factory-unknown'])assert.throws(()=>factoryKit(id));
  assert.equal(PUBLIC_FACTORY_CARDS['context-packet'].kind,'BUILD');
  assert.equal(PUBLIC_FACTORY_CARDS['patch-transaction'].kind,'EXTEND');
  assert.equal(PUBLIC_FACTORY_CARDS['stream-framer'].kind,'REPAIR');
});

test('new-kit public qualification retains every planned task without fabricating outcomes',t=>{
  const {root}=fixture(t),built=buildShowcase({roots:[root],mode:'public'});
  const data=built.data??built;
  assert.equal(data.series[0].kind,'variant');assert.equal(data.series[0].counts.pass,0);
  assert.equal(data.series[0].cards.length,3);
  for(const card of data.series[0].cards){
    const row=card.rows[0];assert.equal(row.model,'Tiel 35B-A3B · IQ4_XS');
    assert.equal(row.outcome,'NOT RECORDED');assert.equal(row.wallMs,null);
    assert.equal(row.accepted,null);assert.equal(row.accounting.full.inputTokens,null);
  }
  assert.ok(!JSON.stringify(data).includes('PRIVATE_WORKSHOP_SENTINEL'));
  const launch=buildLaunchData(JSON.stringify(data));
  assert.equal(launch.comparison,null);assert.equal(launch.spotlight,null);
  assert.equal(launch.series[0].cards[2].title,'Stream framer');
});

test('manifest kit binding rejects task substitution and public reprojection strips arbitrary text',t=>{
  const {root,manifest,save}=fixture(t);
  manifest.kitId='factory-2026-09-06';save();assert.throws(()=>buildShowcase({roots:[root],mode:'public'}),/kit/);
  manifest.kitId='../../tmp';save();assert.throws(()=>buildShowcase({roots:[root],mode:'public'}),/kit/);
  manifest.kitId='factory-2026-09-07';save();
  const built=buildShowcase({roots:[root],mode:'public'}),data=built.data??built;
  data.series[0].cards[0].title='PRIVATE_WORKSHOP_SENTINEL';
  data.series[0].cards[0].rows[0].events=[{text:'PRIVATE_WORKSHOP_SENTINEL'}];
  assert.ok(!JSON.stringify(publicShowcaseData(data)).includes('PRIVATE_WORKSHOP_SENTINEL'));
  data.series[0].cards[0].card='constructor';assert.throws(()=>publicShowcaseData(data),/identity/);
});

test('new-kit replay embeds only the matching sealed judge and refuses an arbitrary kit root',t=>{
  const {root,manifest}=fixture(t),kit=factoryKit(manifest.kitId),card='context-packet';
  const relative=`${card}/grader.mjs`,bytes=fs.readFileSync(path.join(kit.root,relative));
  const args={directory:root,arm:manifest.arm,card,repeat:1,identity:{label:'BANTAM · Tiel',family:'local'},
    kitId:kit.id,kitSeal:{[relative]:hash(bytes)}};
  const built=buildReplayLane(args);
  assert.equal(built.payload.artifacts.find(a=>a.path==='judge/grader.mjs')?.sha256,hash(bytes));
  const wrong=buildReplayLane({...args,kitId:'factory-2026-09-06'});
  assert.ok(!wrong.payload.artifacts.some(a=>a.path==='judge/grader.mjs'));
  assert.throws(()=>buildReplayLane({...args,kitId:'/tmp'}),/kit/);
});

test('qualification packaging requires explicit presentation and preserves public bytes',async t=>{
  const {root}=fixture(t),built=buildShowcase({roots:[root],mode:'public'}),data=built.data??built;
  const input=path.join(root,'public-source.json'),output=path.join(root,'public');
  fs.writeFileSync(input,JSON.stringify(data));
  assert.equal(parseLaunchArgs(['--input',input,'--output',output,'--presentation','qualification']).presentation,'qualification');
  assert.throws(()=>parseLaunchArgs(['--input',input,'--output',output,'--presentation','invent-win']),/presentation/);
  await writeLaunchPackage({input,output,presentation:'qualification'});
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'package.json')));
  assert.equal(manifest.presentation,'qualification');assert.equal(manifest.rawEvidenceIncluded,false);
  for(const item of manifest.files)assert.equal(hash(fs.readFileSync(path.join(output,item.path))),item.sha256);
  const exported=JSON.parse(fs.readFileSync(path.join(output,'fight-card.json')));
  assert.equal(exported.comparison,null);assert.equal(exported.series[0].cards.length,3);
});
