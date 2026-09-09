import {SHOWCASE_STATIC_FILES} from '../scripts/factory-showcase-page.mjs';
import {FIGHT_BRAND_FILES} from '../scripts/fight-poster.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {buildFightGallery,renderFightGallery,writeFightGallery,stageFightGallery,featuredFight} from '../scripts/factory-fight-gallery.mjs';
import {PUBLIC_FACTORY_CARDS} from '../scripts/factory-card-catalog.mjs';
import {LAUNCH_CARDS} from '../scripts/factory-fight-gallery.mjs';
const PLANNED=LAUNCH_CARDS.length;

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,{recorded=true,root:existingRoot,id='context-packet'}={}){
  const root=existingRoot??fs.mkdtempSync(path.join(os.tmpdir(),'bantam-gallery-test-'));
  if(!existingRoot)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,id),share=path.join(dir,'share');
  fs.mkdirSync(share,{recursive:true});
  const row=arm=>({arm,model:'Qwen 27B · same local weights',recorded,outcome:arm==='opencode'?'OUTPUT_ONLY':'PASS',
    accepted:true,completed:arm!=='opencode',wallMs:arm==='opencode'?600000:58000,groupsPassed:5,groupsTotal:5,
    publicExit:0,hiddenExit:0,protectedChanges:0,tokenUpdates:[],accounting:{complete:arm!=='opencode',
      full:{inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null}}});
  const source=JSON.stringify(publicShowcaseData({generatedAt:'2026-09-07T12:00:00Z',series:[{kind:'comparison',complete:recorded,
    cards:[{card:id,repeat:1,rows:[row('bantam-local-27b'),row('opencode')]}]}]}));
  fs.writeFileSync(path.join(dir,'showcase.json'),source);
  fs.writeFileSync(path.join(dir,'README.md'),'Public test notes');
  fs.writeFileSync(path.join(dir,'index.html'),'Public test replay');
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({schema:'bantam.factory-showcase-package.v1',private:false,redacted:true,
    files:[['showcase.json',source],['index.html','Public test replay']].map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}))}));
  const files=[['index.html','<!doctype html><title>Test</title>'],['share-card.png',Buffer.from('synthetic asset')],['share-card.svg','<svg/>'],
    ['fight-card.json',JSON.stringify(buildLaunchData(source))]];
  for(const [name,bytes]of files)fs.writeFileSync(path.join(share,name),bytes);
  fs.writeFileSync(path.join(share,'package.json'),JSON.stringify({schema:'bantam.launch-package.v1',public:true,redacted:true,
    rawEvidenceIncluded:false,source:{sha256:sha(source)},files:files.map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}))}));
  return {root,dir,share};
}

test('gallery keeps all planned tasks, complete rosters, timeout and partial-accounting disclosure',t=>{
  const {root}=fixture(t),data=buildFightGallery(root),html=renderFightGallery(data);
  assert.equal(data.cards.length,PLANNED);assert.equal(data.cards.filter(c=>c.recorded).length,1);
  const card=data.cards.find(c=>c.id==='context-packet');
  assert.equal(card.rows.length,2);assert.equal(card.rows[0].passed,true);assert.equal(card.rows[1].passed,false);
  assert.match(html,/OUTPUT_ONLY/);assert.match(html,/600\.0s/);assert.match(html,/Partial accounting disclosed/);
  assert.match(html,new RegExp('1\\/'+PLANNED));assert.match(html,/Not published yet/);assert.match(html,/jobs completed/);
  assert.doesNotMatch(html,/<script[^>]+src="(?:https?:)?\/\/|<iframe|<img[^>]+src="https?:/i);
  assert.deepEqual(writeFightGallery({root}),{published:1,planned:PLANNED});
  assert.throws(()=>writeFightGallery({root}),/Refusing to replace/);
  assert.deepEqual(writeFightGallery({root,replace:true}),{published:1,planned:PLANNED});
});

test('featured wins exclude timeouts, missing clocks and different-model comparisons',t=>{
  const {root}=fixture(t),data=buildFightGallery(root),card=data.cards.find(c=>c.recorded);
  assert.equal(featuredFight(data),null,'output-only is not a completed speed comparison');
  card.rows[1].passed=true;card.rows[1].outcome='PASS';
  assert.equal(featuredFight(data).ratio,600000/58000);
  card.rows[1].arm='codex-astra';assert.equal(featuredFight(data),null);
  card.rows[1].arm='hermes';card.rows[0].wallMs=0;assert.equal(featuredFight(data),null);
  card.rows[0].wallMs=700000;assert.equal(featuredFight(data),null,'a loss is not a featured win');
});

test('gallery rejects incomplete rosters, raw inputs, tampered packages and symlinked outputs',t=>{
  const missing=fixture(t,{recorded:false});assert.throws(()=>buildFightGallery(missing.root),/fully recorded/);
  const altered=fixture(t);fs.appendFileSync(path.join(altered.share,'index.html'),'tamper');
  assert.throws(()=>buildFightGallery(altered.root),/hash mismatch/);
  const raw=fixture(t);fs.writeFileSync(path.join(raw.dir,'showcase.json'),JSON.stringify({schema:'bantam.factory-showcase.v1',mode:'private'}));
  assert.throws(()=>buildFightGallery(raw.root),/redacted public/);
  const linked=fixture(t);fs.symlinkSync(path.join(linked.dir,'showcase.json'),path.join(linked.root,'index.html'));
  assert.throws(()=>writeFightGallery({root:linked.root,replace:true}),/Refusing to replace/);
});

test('gallery escapes display text and never turns unsupported labels into paths',t=>{
  const {root}=fixture(t),data=buildFightGallery(root);
  const card=data.cards.find(c=>c.recorded);card.rows[0].label='<img src=x onerror=alert(1)>';
  assert.doesNotMatch(renderFightGallery(data),/<img src=x/);
  card.id='../private';assert.throws(()=>renderFightGallery(data),/Unrecognized/);
});

test('publication requires the full planned card set and copies only the explicit reviewed file list',t=>{
  const {root}=fixture(t),output=path.join(root,'staged');
  assert.throws(()=>stageFightGallery({root,output}),/All planned/);
  assert.equal(fs.existsSync(output),false);
  for(const id of Object.keys(PUBLIC_FACTORY_CARDS).filter(id=>id!=='context-packet'))fixture(t,{root,id});
  fs.writeFileSync(path.join(root,'context-packet','private-run.json'),'PRIVATE_DO_NOT_UPLOAD');
  fs.writeFileSync(path.join(root,'private.txt'),'PRIVATE_DO_NOT_UPLOAD');
  assert.deepEqual(stageFightGallery({root,output}),{cards:PLANNED,files:3+PLANNED*9+FIGHT_BRAND_FILES.length+SHOWCASE_STATIC_FILES.length});
  assert.equal(fs.existsSync(path.join(output,'private.txt')),false);
  assert.equal(fs.existsSync(path.join(output,'context-packet','private-run.json')),false);
  assert.equal(fs.readFileSync(path.join(output,'context-packet','README.md'),'utf8'),'Public test notes');
  assert.throws(()=>stageFightGallery({root,output}),/fresh absolute/);
  fs.appendFileSync(path.join(root,'context-packet','index.html'),'tamper');
  assert.throws(()=>stageFightGallery({root,output:path.join(root,'bad')}),/Detailed package hash mismatch/);
  assert.equal(fs.existsSync(path.join(root,'bad')),false);
});

test('Pages workflow is explicit public-only main-branch publication of staged assets',()=>{
  const yaml=fs.readFileSync(new URL('../.github/workflows/fight-gallery.yml',import.meta.url),'utf8');
  assert.match(yaml,/workflow_dispatch:/);assert.match(yaml,/default: false/);
  assert.match(yaml,/inputs\.publish_reviewed_gallery == true/);
  assert.match(yaml,/github\.event\.repository\.private == false/);
  assert.match(yaml,/github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(yaml,/^\s+(?:push|pull_request):/m);
  assert.match(yaml,/path: fight-pages/);assert.match(yaml,/stageFightGallery/);
});

test('reviewed Codex packages get their own gallery links and retain the publication seals', t => {
  const {root}=fixture(t);
  for(const id of Object.keys(PUBLIC_FACTORY_CARDS).filter(id=>id!=='context-packet'))fixture(t,{root,id});
  const cloud=fixture(t,{root:path.join(root,'codex')});
  const data=buildFightGallery(root),html=renderFightGallery(data);
  assert.equal(data.codex.cards.length,1);
  assert.match(html,/Codex, inside the factory/);
  assert.match(html,/href="codex\/context-packet\/share\/index.html"/);
  assert.match(html,/href="codex\/context-packet\/share\/fight-card.json"/);
  const output=path.join(root,'cloud-staged');
  stageFightGallery({root,output});
  assert.equal(fs.readFileSync(path.join(output,'codex/context-packet/share/fight-card.json'),'utf8'),
    fs.readFileSync(path.join(cloud.share,'fight-card.json'),'utf8'));
  fs.appendFileSync(path.join(cloud.share,'index.html'),'tampered');
  assert.throws(()=>buildFightGallery(root),/hash mismatch/);
});

test('gallery page declares its own inline icon so hosting roots never 404 on a favicon request',t=>{
  const html=renderFightGallery(buildFightGallery(fixture(t).root));
  assert.match(html,/<link rel="icon" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
  assert.doesNotMatch(html,/<link[^>]+href="https?:/i);
});

test('solo cards have their own roster filter and make no claim against absent opponents',t=>{
  const data=buildFightGallery(fixture(t).root),card=data.cards.find(c=>c.recorded);
  card.rows=card.rows.filter(r=>r.arm==='bantam-local-27b');
  const before=structuredClone(data),html=renderFightGallery(data);
  assert.match(html,/data-mode="bantam"/);
  assert.match(html,/BANTAM FACTORY run/);
  assert.match(html,/Open run/);
  assert.doesNotMatch(html,/Selected highlight|shorter wall time|class="score-name">OpenCode/);
  assert.deepEqual(data,before);
});
