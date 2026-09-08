import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {renderFactoryShowcase,renderShowcaseResults,showcaseAssets,SHOWCASE_STATIC_FILES} from '../scripts/factory-showcase-page.mjs';

const gallery=()=>({cards:[{id:'context-packet',recorded:true,rows:[
  {arm:'bantam-local-27b',model:'Qwen 27B · same local weights',wallMs:58123,passed:true,outcome:'PASS',groupsPassed:5,groupsTotal:5},
  {arm:'hermes',model:'Qwen 27B · same local weights',wallMs:512194,passed:true,outcome:'PASS',groupsPassed:5,groupsTotal:5},
]}]});

test('front-page results use recorded times and outcomes, and missing competitors remain absent attempts',()=>{
  const data=gallery(),before=structuredClone(data);
  const html=renderShowcaseResults(data);
  assert.match(html,/58\.1 s/);assert.match(html,/512\.2 s/);
  assert.equal((html.match(/Not run yet<\/td>/g)||[]).length,3);
  assert.match(html,/context-packet\/share\/index.html#card=context-packet/);
  assert.deepEqual(data,before);
  Object.assign(data.cards[0].rows[0],{wallMs:123456,passed:false,outcome:'TIMEOUT',groupsPassed:2});
  const changed=renderShowcaseResults(data);
  assert.match(changed,/123\.5 s<small>Timed out · 2\/5 checks/);
  assert.doesNotMatch(changed,/58\.1 s/);
});

test('the scrolling race shares the table records and never includes private fields or archived references',()=>{
  const data=gallery();data.cards[0].rows[0].privatePrompt='PRIVATE_DO_NOT_PUBLISH';
  const html=renderFactoryShowcase(data),json=html.match(/<script id="fight-preview" type="application\/json">(.*?)<\/script>/s)[1];
  const preview=JSON.parse(json);
  const context={window:{},document:{getElementById:id=>({textContent:id==='hardware-preview'?fs.readFileSync(new URL('../site/hardware.json',import.meta.url),'utf8'):json})}};
  vm.runInNewContext(fs.readFileSync(new URL('../site/demos.js',import.meta.url),'utf8'),context);
  const race=context.window.DEMOS.ring.steps.find(s=>s.race).race;
  assert.equal(race.rows.length,2);assert.equal(race.rows[0].finish,58.123);
  assert.equal(race.rows[1].finish,512.194);assert.equal(preview.rows[0].wallMs,58123);
  assert.doesNotMatch(html,/PRIVATE_DO_NOT_PUBLISH|reference runs with Claude|References · same work/);
  assert.equal(context.window.DEMOS.hardware.steps.flatMap(s=>s.out||[]).some(s=>s.includes('17.92 GB')),true);
  assert.doesNotMatch(context.window.DEMOS.hardware.steps.flatMap(s=>s.out||[]).join('\n'),/19.0 GB|0.6 GB|3.2 GB/);
  assert.match(html,/headerRooster/);assert.match(html,/data-demo="sandbox"/);
  assert.ok(html.indexOf('class="hero-factory"')<html.indexOf('id="stage"'));
});

test('the product page stages a finite local asset set without its template or private files',()=>{
  const files=showcaseAssets();
  assert.equal(files.length,SHOWCASE_STATIC_FILES.length);
  assert.ok(files.every(([name,bytes])=>name.startsWith('assets/showcase/')&&bytes.length>0));
  assert.ok(!files.some(([name])=>/README|index\.html|\.md$/.test(name)));
  assert.throws(()=>renderShowcaseResults({cards:[{id:'../private',recorded:true,rows:[]}]}),/Unrecognized/);
});
