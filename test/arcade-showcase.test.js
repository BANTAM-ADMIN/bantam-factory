import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {SHOWCASE_STATIC_FILES} from '../scripts/factory-showcase-page.mjs';
const root=new URL('../site/examples/arcade/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root));
const json=file=>JSON.parse(read(file));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const data=json('builds.json');

test('playable comparison files match recorded deliveries, prompts and measured token usage',()=>{
  assert.equal(data.taskSha256,sha(data.sharedBrief));
  const ids=new Set();
  for(const row of data.comparisons){
    assert.ok(!ids.has(row.id));ids.add(row.id);
    const record=json(row.record),bytes=read(row.file);
    assert.equal(record.artifact.sha256,sha(bytes));assert.equal(record.artifact.bytes,bytes.length);
    assert.equal(record.prompt,data.sharedBrief);assert.equal(record.wallMs,row.wallMs);
    assert.ok(record.actions.length>0);assert.equal(typeof record.finalResponse,'string');
    if(record.processCompleted)assert.ok(record.finalResponse.length>0);
    else {
      assert.equal(row.processCompleted,false);
      assert.equal(record.usage.complete,false,'an interrupted request may have unreported tokens');
      assert.match(row.result,/timed out|incomplete/i);
    }
    assert.equal(record.usage.outputTokens,row.usage.outputTokens);
    assert.ok(record.usage.maxRequestInputTokens>0&&record.usage.maxRequestInputTokens<=272000);
    assert.equal(record.usage.calls.reduce((sum,c)=>sum+c.usage.outputTokens,0),record.usage.outputTokens);
    assert.equal(record.usage.inputTokens-record.usage.cacheHitTokens,row.usage.freshInputTokens);
    assert.equal(record.usage.cacheHitTokens,row.usage.cacheHitTokens);
    assert.equal(record.usage.inputTokens,row.usage.inputTokens);
    for(const file of [row.file,row.record])assert.ok(SHOWCASE_STATIC_FILES.includes('examples/arcade/'+file));
    for(const match of bytes.toString().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
    for(const action of record.actions){assert.ok(action.observation===null||typeof action.observation==='string');assert.ok(!Object.hasOwn(action,'reasoning'));}
    assert.doesNotMatch(JSON.stringify(record),/"rawUsage"|"threadId"|"rawOutput"|\/home\/deveraux\//);
  }
  for(const key of ['left','right'])assert.ok(ids.has(data.defaults[key]));
  assert.match(data.usageNote,/Prefix-cache tokens are included in total input/);
  assert.doesNotMatch(read('index.html').toString()+read('builds.json').toString(), /API equivalent|apiEquivalent|token-price estimate|actualCostUsd/);
});

test('the two Astra games independently passed desktop and phone playtests',()=>{
  for(const file of ['astra-cli.json','astra-factory.json']){
    const record=json(file);assert.equal(record.processCompleted,true);
    assert.deepEqual(record.playtest.errors,[]);
    for(const check of ['gravity_visible','move_visible','hold_visible','hard_drop_scores','pause_freezes_board','resume_gravity','restart_resets_score','game_over_visible'])assert.equal(record.playtest.checks[check],true,file+': '+check);
    for(const width of [320,390]){const check=record.playtest.viewports.find(v=>v.width===width);assert.equal(check.overflow,false);assert.equal(check.touch_drop_scores,true);}
  }
});

test('the current factory build and prefix-cache reuse match the retained records',()=>{
  const current=json(data.versions.at(-1).record),previous=json('astra-factory.json');
  assert.equal(current.playtest.pass,true);assert.deepEqual(current.playtest.errors,[]);
  assert.deepEqual(current.playtest.externalRequests,[]);
  assert.ok(Object.values(current.playtest.checks).every(v=>v===true));
  for(const width of [320,390]){
    const view=current.playtest.viewports.find(v=>v.width===width);
    assert.equal(view.horizontalOverflow,false);assert.equal(view.touchMovesPiece,true);
    assert.ok(view.controlsBottom<=view.screenHeight);
  }
  assert.equal(current.prompt,previous.prompt);
  assert.equal(data.contextReuse.percentCached,
    Math.round(100*current.usage.cacheHitTokens/current.usage.inputTokens));
});
