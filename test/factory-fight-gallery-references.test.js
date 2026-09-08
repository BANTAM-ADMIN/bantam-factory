import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {buildFightGallery,renderFightGallery,stageFightGallery,featuredFight} from '../scripts/factory-fight-gallery.mjs';
import {FACTORY_KITS} from '../scripts/factory-card-catalog.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const LAUNCH_CARDS=[...FACTORY_KITS['factory-2026-09-07'],...FACTORY_KITS['factory-2026-09-06'],...FACTORY_KITS['factory-controls-2026-09-07']];

// A reviewed public package, identical in shape to a launch card, written at an explicit directory.
function writeCard(dir,id,arms,{wallMs=arm=>58000,outcome=arm=>'PASS'}={}){
  const share=path.join(dir,'share');fs.mkdirSync(share,{recursive:true});
  const row=arm=>({arm,model:arm.startsWith('claude-')?`${arm} · native CLI alias`:'Qwen 27B · same local weights',recorded:true,outcome:outcome(arm),
    accepted:true,completed:outcome(arm)==='PASS',wallMs:wallMs(arm),groupsPassed:5,groupsTotal:5,publicExit:0,hiddenExit:0,protectedChanges:0,tokenUpdates:[],
    accounting:{complete:true,full:{inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null}}});
  const source=JSON.stringify(publicShowcaseData({generatedAt:'2026-09-08T12:00:00Z',series:[{kind:'comparison',complete:true,cards:[{card:id,repeat:1,rows:arms.map(row)}]}]}));
  fs.writeFileSync(path.join(dir,'showcase.json'),source);
  fs.writeFileSync(path.join(dir,'README.md'),'Public test notes');
  fs.writeFileSync(path.join(dir,'index.html'),'Public test replay');
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({schema:'bantam.factory-showcase-package.v1',private:false,redacted:true,
    files:[['showcase.json',source],['index.html','Public test replay']].map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}))}));
  const files=[['index.html','<!doctype html><title>Test</title>'],['share-card.png',Buffer.from('synthetic asset')],['share-card.svg','<svg/>'],['fight-card.json',JSON.stringify(buildLaunchData(source))]];
  for(const [name,bytes]of files)fs.writeFileSync(path.join(share,name),bytes);
  fs.writeFileSync(path.join(share,'package.json'),JSON.stringify({schema:'bantam.launch-package.v1',public:true,redacted:true,rawEvidenceIncluded:false,
    source:{sha256:sha(source)},files:files.map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}))}));
}

function gallery(t,{referenceCards=['context-packet'],fullLaunch=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-gallery-refs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const id of fullLaunch?LAUNCH_CARDS:['context-packet'])writeCard(path.join(root,id),id,['bantam-local-27b','opencode'],{wallMs:arm=>arm==='opencode'?559000:81800});
  for(const id of referenceCards)writeCard(path.join(root,'references',id),id,['claude-sonnet','claude-opus','claude-fable'],
    {wallMs:arm=>({'claude-sonnet':62200,'claude-opus':67300,'claude-fable':45100}[arm]),outcome:arm=>arm==='claude-opus'?'OUTPUT_ONLY':'PASS'});
  if(referenceCards.length)fs.writeFileSync(path.join(root,'references','README.md'),'Separately recorded native Claude Code references');
  return root;
}

test('gallery data carries separately recorded reference attempts per work order without merging them into the card roster',t=>{
  const root=gallery(t),data=buildFightGallery(root);
  const card=data.cards.find(c=>c.id==='context-packet');
  assert.deepEqual(card.rows.map(r=>r.arm),['bantam-local-27b','opencode'],'launch roster is unchanged');
  assert.equal(data.references.cards.length,1);
  const reference=data.references.cards[0];
  assert.equal(reference.id,'context-packet');
  assert.deepEqual(reference.rows.map(r=>[r.arm,r.label,r.outcome,r.passed,r.wallMs]),[
    ['claude-sonnet','Claude · Sonnet','PASS',true,62200],['claude-opus','Claude · Opus','OUTPUT_ONLY',false,67300],['claude-fable','Claude · Fable','PASS',true,45100]]);
  assert.equal(featuredFight(data).peer.arm,'opencode','references never become featured same-model wins');
});

test('gallery without a references directory renders exactly as before',t=>{
  const root=gallery(t,{referenceCards:[]}),data=buildFightGallery(root);
  assert.equal(data.references,null);
  assert.doesNotMatch(renderFightGallery(data),/<section class="references"/);
});

test('gallery page renders a references table with BANTAM beside each reference model and links every cell to its replay',t=>{
  const html=renderFightGallery(buildFightGallery(gallery(t)));
  assert.match(html,/<section class="references"/);
  assert.match(html,/Claude · Sonnet/);assert.match(html,/Claude · Opus/);assert.match(html,/Claude · Fable/);
  assert.match(html,/references\/context-packet\/share\/index\.html/);
  assert.match(html,/45\.1s/);assert.match(html,/OUTPUT_ONLY/);
  assert.match(html,/81\.8s/,'the BANTAM attempt from the launch card is shown for context');
  assert.match(html,/references\/README\.md/);
  assert.match(html,/3 separately recorded attempts/);
  assert.doesNotMatch(html,/<script|<iframe|<img[^>]+src="https?:/i);
});

test('publication stages reviewed reference packages beside the launch cards using the same explicit file list',t=>{
  const root=gallery(t,{fullLaunch:true}),output=path.join(root,'pages');
  const staged=stageFightGallery({root,output});
  assert.equal(staged.cards,8);
  for(const name of ['README.md','index.html','showcase.json','package.json','share/index.html','share/fight-card.json','share/package.json','share/share-card.png','share/share-card.svg'])
    assert.ok(fs.existsSync(path.join(output,'references','context-packet',name)),`staged references/context-packet/${name}`);
  assert.ok(fs.existsSync(path.join(output,'references','README.md')));
  assert.match(fs.readFileSync(path.join(output,'index.html'),'utf8'),/references\/context-packet\/share\/index\.html/);
  assert.equal(staged.files,2+8*9+1+9);
});

test('a reference package with an unrecorded row or a mismatched card is refused',t=>{
  const root=gallery(t);
  const source=path.join(root,'references','context-packet','showcase.json'),data=JSON.parse(fs.readFileSync(source,'utf8'));
  data.series[0].cards[0].rows[0].recorded=false;
  fs.writeFileSync(source,JSON.stringify(data));
  assert.throws(()=>buildFightGallery(root),/recorded|hash|package/);
});

test('gallery header links to the references section only when references exist',t=>{
  const withRefs=renderFightGallery(buildFightGallery(gallery(t)));
  assert.match(withRefs,/<section class="references" id="references"/);
  assert.match(withRefs,/<a class="nav-link" href="#references">Frontier references[^<]*<\/a>/);
  const without=renderFightGallery(buildFightGallery(gallery(t,{referenceCards:[]})));
  assert.doesNotMatch(without,/#references/);
});
