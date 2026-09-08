import test from 'node:test';
import assert from 'node:assert/strict';
import {workReplayEvents} from '../scripts/fight-work-replay.mjs';
import {buildFightGallery,featuredFight} from '../scripts/factory-fight-gallery.mjs';
import {introFacts,renderFightIntro} from '../scripts/fight-intro.mjs';

const work=overrides=>({task:'Build a useful tool.',wallMs:1000,outcome:'PASS',accepted:true,completed:true,actions:[],
  stations:[],events:[],finalResponse:'Delivered the tool.',finalResponseKind:'delivery',checks:[{title:'Independent acceptance',exitCode:0,stdout:'All groups passed',stderr:''}],...overrides});
const action=overrides=>({id:'action-1',name:'shell',source:'native-tool',request:{command:'npm test'},output:'TEST OUTPUT',atMs:100,endedMs:600,exitCode:0,...overrides});

test('terminal replay separates a request from its response and retains post-run grading at the endpoint',()=>{
  const events=workReplayEvents(work({actions:[action({})]}));
  const visible=at=>events.filter(e=>e.atMs<=at).map(e=>e.body).join('\n');
  assert.match(visible(0),/Build a useful tool/);
  assert.doesNotMatch(visible(99),/npm test|TEST OUTPUT|All groups passed|Delivered/);
  assert.match(visible(100),/npm test/);
  assert.doesNotMatch(visible(599),/TEST OUTPUT|All groups passed|Delivered/);
  assert.match(visible(600),/TEST OUTPUT/);
  assert.doesNotMatch(visible(999),/All groups passed|Delivered/);
  assert.match(visible(1000),/All groups passed/);
  assert.equal(events.find(e=>e.kind==='check').precision,'final');
  // Seeking back is a fresh view of the same ledger, without retained future output.
  assert.doesNotMatch(visible(100),/TEST OUTPUT|All groups passed|Delivered/);
});

test('factory responses use an explicitly labelled next-turn bound when tool completion was not timestamped',()=>{
  const events=workReplayEvents(work({actions:[
    action({source:'factory-turn',turn:0,endedMs:null}),
    action({id:'action-2',source:'factory-automatic-check',turn:0,atMs:null,endedMs:null,output:'FACTORY CHECK'}),
    action({id:'action-3',source:'factory-turn',turn:1,atMs:700,endedMs:null,output:'LAST RESULT'}),
  ]}));
  const response=events.find(e=>e.id==='action-1-response');
  assert.equal(response.atMs,700);assert.equal(response.precision,'by');
  assert.equal(events.find(e=>e.id==='action-2-response').precision,'by');
  assert.equal(events.find(e=>e.id==='action-3-response').precision,'untimed');
  assert.equal(events.find(e=>e.id==='action-3-response').atMs,1000);
  assert.ok(!events.some(e=>e.atMs<700&&e.body==='TEST OUTPUT'));
});

test('untimed or out-of-clock records stay in the final log without manufactured times or success',()=>{
  const events=workReplayEvents(work({outcome:'TIMEOUT',accepted:false,completed:false,finalResponseKind:'last-message',
    actions:[action({atMs:null,endedMs:null}),action({id:'action-2',atMs:1200,endedMs:1210})]}));
  assert.ok(events.filter(e=>e.id.startsWith('action-')).every(e=>e.atMs===1000&&e.precision==='untimed'));
  assert.equal(events.find(e=>e.kind==='delivery').title,'LAST RECORDED MESSAGE');
  assert.match(events.find(e=>e.kind==='finish').body,/Project accepted: no\nClean completion: no/);
});

test('the published intro uses an accepted same-model pair and the public gallery omits archived Claude references',()=>{
  const gallery=buildFightGallery(new URL('../docs/fights/launch-2026-09-07',import.meta.url).pathname);
  assert.equal(gallery.references,null);
  const feature=featuredFight(gallery),facts=introFacts(feature),html=renderFightIntro(feature);
  assert.equal(facts.bantamMs,feature.bantam.wallMs);assert.equal(facts.peerMs,feature.peer.wallMs);
  assert.ok(html.includes((facts.bantamMs/1000).toFixed(1)));
  assert.ok(html.includes((facts.peerMs/1000).toFixed(1)));
  assert.match(html,/data-composition-id="bantam-intro"/);
  assert.match(html,/data-duration="18"/);
  assert.throws(()=>introFacts({...feature,peer:{...feature.peer,passed:false}}),/completed same-model/);
  assert.throws(()=>introFacts({...feature,peer:{...feature.peer,model:'Different model'}}),/completed same-model/);
});
