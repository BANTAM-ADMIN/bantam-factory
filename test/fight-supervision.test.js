import test from 'node:test';
import assert from 'node:assert/strict';
import {SUPERVISED_SYSTEMS, publicSupervisorRoles} from '../scripts/fight-supervision.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {renderLaunchPage} from '../scripts/factory-launch-page.mjs';
const counters={inputTokens:100,outputTokens:10,cacheHitTokens:75,freshInputTokens:25};
const fixture=()=>({full:{inputTokens:200,outputTokens:20,cacheHitTokens:150,freshInputTokens:50},complete:true,
  roles:[{role:'supervisor',model:'gpt-6-astra',...counters},{role:'worker',model:'gpt-5.6-terra',...counters}]});
test('supervised public totals include both roles with fixed model identities and no private metadata',()=>{
  const accounting=fixture();accounting.roles[0].prompt='PRIVATE';
  const value=publicSupervisorRoles('bantam-astra-terra',accounting);
  assert.equal(value.roles.length,2);assert.equal(value.roles[0].inputTokens,100);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE|prompt/);
  for(const mutate of [a=>a.roles.pop(),a=>a.full.inputTokens=100,a=>a.roles[1].model='gpt-6-astra',
    a=>a.roles[0].freshInputTokens=100,a=>a.roles[1].inputTokens=null]){
    const a=fixture();mutate(a);assert.throws(()=>publicSupervisorRoles('bantam-astra-terra',a));
  }
});
test('unknown worker accounting stays unknown instead of becoming free work',()=>{
  const a=fixture();a.complete=false;
  for(const field of Object.keys(counters)){a.roles[1][field]=null;a.full[field]=null;}
  assert.equal(publicSupervisorRoles('bantam-astra-terra',a).roles[1].inputTokens,null);
  a.full.inputTokens=100;
  assert.throws(()=>publicSupervisorRoles('bantam-astra-terra',a),/include every role/);
});
test('mixed-model fight cards preserve role counters without making a same-model claim',()=>{
  const row={arm:'bantam-astra-terra',model:SUPERVISED_SYSTEMS['bantam-astra-terra'][2],recorded:true,
    outcome:'PASS',accepted:true,completed:true,wallMs:1000,groupsPassed:5,groupsTotal:5,
    publicExit:0,hiddenExit:0,protectedChanges:0,accounting:fixture(),tokenUpdates:[]};
  const source={schema:'bantam.factory-showcase.v1',mode:'public',privacy:{redacted:true,rawEvidenceIncluded:false},
    series:[{kind:'comparison',complete:true,cards:[{card:'context-packet',repeat:1,rows:[row]}]}]};
  const data=buildLaunchData(JSON.stringify(source));
  assert.equal(data.comparison,null);assert.equal(data.series[0].cards[0].rows[0].bantam,true);
  assert.equal(data.series[0].cards[0].rows[0].accounting.roles[1].model,'gpt-5.6-terra');
  const html=renderLaunchPage(data);
  assert.match(html,/Both roles are included in the total/);
  assert.match(html,/Mixed-model lanes include both roles/);
  assert.doesNotMatch(html,/Same Codex models\.<br>/);
  row.model='GPT-6 Astra · wrapped CLI';
  assert.throws(()=>buildLaunchData(JSON.stringify(source)),/contradictory public model identity/);
});
