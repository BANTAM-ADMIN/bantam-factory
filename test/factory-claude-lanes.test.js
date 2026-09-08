import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claudeDockerArgs} from '../scripts/claude-fight-cli.mjs';
import {claudeStreamUsage} from '../scripts/fight-usage.mjs';
import {runFactoryFights,DEFAULT_FIGHT_ARMS} from '../scripts/factory-fights.mjs';
import {buildShowcase} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {writeFightCardExport} from '../scripts/factory-fight-export.mjs';
import {writeFactoryReplay} from '../scripts/factory-fight-replay.mjs';

const receipt={type:'result',subtype:'success',num_turns:3,usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:30},modelUsage:{'fixture-model':{}},total_cost_usd:0.01};
test('Claude aggregate is exact and absent or incomplete counters remain unknown',()=>{
  const u=claudeStreamUsage(JSON.stringify(receipt));
  assert.equal(u.inputTokens,200);assert.equal(u.cacheHitTokens,70);assert.equal(u.freshInputTokens,130);assert.equal(u.outputTokens,20);
  assert.equal(u.complete,true);assert.equal(u.turns,3);
  assert.equal(claudeStreamUsage(''),null);assert.equal(claudeStreamUsage(JSON.stringify({...receipt,usage:{input_tokens:0}})),null);
  assert.equal(claudeStreamUsage(JSON.stringify(receipt)+'\n'+JSON.stringify(receipt)),null);
});
test('Claude boundary mounts only one read-only credential, disables customizations and never uses bare OAuth-incompatible mode',()=>{
  const options={runtime:{identity:{uid:1000,gid:1000},binary:'/tools/claude',auth:'/auth/.credentials.json',toolMounts:[],libraries:[],gitCore:'/tools/git-core',npm:'/tools/npm'},
    workspace:'/tmp/claude-unit/ws',control:'/tmp/claude-unit/control',name:'bantam-claude-test',task:'EXACT TASK'};
  const args=claudeDockerArgs(options);
  assert.ok(args.includes('EXACT TASK'));assert.ok(args.includes('--read-only'));assert.ok(args.includes('1000:1000'));
  assert.ok(args.includes('type=bind,src=/auth/.credentials.json,dst=/home/ubuntu/.claude/.credentials.json,readonly'));
  assert.ok(args.includes('--strict-mcp-config'));assert.ok(args.includes('--disable-slash-commands'));assert.ok(!args.includes('--bare'));
  assert.equal(args[args.indexOf('--setting-sources')+1],'');assert.equal(args[args.indexOf('--effort')+1],'medium');
  assert.ok(!args.includes('--network'));const probe=claudeDockerArgs({...options,probe:true});assert.equal(probe[probe.indexOf('--network')+1],'none');
  assert.throws(()=>claudeDockerArgs({...options,workspace:'/'}));assert.throws(()=>claudeDockerArgs({...options,model:'other'}));
  assert.throws(()=>claudeDockerArgs({...options,control:options.workspace}));
});
test('explicit Claude lanes preserve native accounting and identities through frozen runner and public export',async t=>{
  assert.ok(DEFAULT_FIGHT_ARMS.every(a=>!a.startsWith('claude-')),'no implicit subscription use');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-claude-lanes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'run');
  const manifest=await runFactoryFights({output,arms:['claude-sonnet','claude-opus'],cards:['context-packet'],kitId:'factory-2026-09-07'}, {
    inspect:async()=>{throw Error('cloud-only must not inspect local GPU');},
    contender:async command=>{assert.ok(command.args.some(a=>a.endsWith('/claude-fight-cli.mjs')));return {code:0,stdout:JSON.stringify(receipt),stderr:'',wallMs:10,startedAt:new Date().toISOString(),timedOut:false,aborted:false,bufferExceeded:false};},
    grade:async()=>({publicResult:{code:0,stdout:'',stderr:'',timedOut:false},hidden:{code:0,stdout:'',stderr:'',timedOut:false},
      record:{schema:'bantam.factory-card-grade.v1',card:'context-packet',pass:true,groups:[{name:'synthetic',pass:true}]},timing:{publicWallMs:0,hiddenWallMs:0,totalWallMs:0}}),
  });
  assert.equal(manifest.complete,true);assert.equal(manifest.configuration.codexModel,null);
  for(const row of manifest.results){assert.equal(row.usage.inputTokens,200);assert.equal(row.outcome,'PASS');}
  writeFightCardExport(output);assert.equal(writeFactoryReplay(output).lanes,2);
  const data=buildShowcase({roots:[output],mode:'public'}).data,launch=buildLaunchData(JSON.stringify(data));
  assert.deepEqual(launch.series[0].cards[0].rows.map(r=>r.model),['Claude Sonnet · native CLI alias','Claude Opus · native CLI alias']);
  for(const row of launch.series[0].cards[0].rows){assert.equal(row.accounting.full.inputTokens,200);assert.equal(row.accounting.complete,true);}
});
