import test from 'node:test';
import assert from 'node:assert/strict';
import {fightPlan,FIGHT_ARMS,freshCommand,parseGrade,cleanFightEnv} from '../scripts/factory-fights.mjs';
test('fresh plan covers all18corner/card cells once, with rotated order',()=>{
  const plan=fightPlan();assert.equal(plan.length,18);assert.equal(new Set(plan.map(r=>r.card+':'+r.arm)).size,18);
  assert.notEqual(plan[0].arm,plan[6].arm);assert.notEqual(plan[6].arm,plan[12].arm);
  assert.throws(()=>fightPlan({arms:['opencode','opencode']}));assert.throws(()=>fightPlan({cards:['old-card']}));
});
test('all arms get exact task or task file and same explicit local endpoint/Astra model',()=>{
  for(const arm of FIGHT_ARMS){
    const command=freshCommand({arm,task:'EXACT_TASK',workspace:'/tmp/fresh/ws',dir:'/tmp/fresh',endpoint:'http://127.0.0.1:9999',model:'exact27b'});
    assert.ok(command.args.includes('EXACT_TASK')||command.args.includes('/tmp/fresh/task.md'));
    if(arm.includes('codex'))assert.ok(command.args.includes('gpt-6-astra'));
    else assert.ok(command.args.includes('http://127.0.0.1:9999'));
    if(arm.startsWith('bantam')){assert.equal(command.env.BANTAM_TEACHER,'0');assert.equal(command.env.BANTAM_PROBE,'1');assert.ok(command.args.includes('--factory'));}
    if(arm==='codex-astra')assert.ok(!command.args.includes('--ephemeral'));
  }
});
test('grade requires complete expected groups, booleans and matching conjunction',()=>{
  const row={schema:'bantam.factory-card-grade.v1',card:'a',pass:true,groups:[{name:'one',pass:true}]};
  assert.deepEqual(parseGrade(JSON.stringify(row),'a',['one']),row);
  assert.equal(parseGrade('', 'a',['one']),null);
  assert.equal(parseGrade(JSON.stringify(row),'a',['one','two']),null);
  assert.equal(parseGrade(JSON.stringify({...row,pass:false}),'a',['one']),null);
  assert.equal(parseGrade(JSON.stringify(row),'b',['one']),null);
});
test('native peer response allowance is explicit, bounded, and does not alter BANTAM prompts',()=>{
  const base={task:'EXACT',workspace:'/tmp/fresh/ws',dir:'/tmp/fresh',endpoint:'http://127.0.0.1:9999',model:'exact27b'};
  for(const arm of ['deepseek-local-27b','opencode','hermes']){
    const a=freshCommand({...base,arm}),b=freshCommand({...base,arm,peerOutputTokens:32768});
    assert.equal(a.args[a.args.indexOf('--max-output-tokens')+1],'8192');
    assert.equal(b.args[b.args.indexOf('--max-output-tokens')+1],'32768');
    assert.throws(()=>freshCommand({...base,arm,peerOutputTokens:32769}));
  }
  assert.deepEqual(freshCommand({...base,arm:'bantam-local-27b'}),freshCommand({...base,arm:'bantam-local-27b',peerOutputTokens:32768}));
});
test('environment does not inherit endpoint, credentials or Node hooks',()=>{
  const env=cleanFightEnv({BANTAM_TEACHER:'0'});assert.equal(env.BANTAM_TEACHER,'0');
  for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','BANTAM_TEACHER_CMD','OPENROUTER_API_KEY'])assert.ok(!(key in env));
});
