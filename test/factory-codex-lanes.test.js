import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runFactoryFights,NATIVE_CODEX_MODELS,freshCommand} from '../scripts/factory-fights.mjs';
import {buildShowcase} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {renderLaunchPage,renderShareCard} from '../scripts/factory-launch-page.mjs';
import {writeFightCardExport} from '../scripts/factory-fight-export.mjs';
import {writeFactoryReplay} from '../scripts/factory-fight-replay.mjs';

test('all native Codex lanes retain model, isolation, medium effort and complete receipt accounting through public replay',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-codex-lanes-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'run'),arms=Object.keys(NATIVE_CODEX_MODELS);
  for(const arm of arms){
    const command=freshCommand({arm,task:'TASK',workspace:path.join(root,'ws'),dir:root});
    assert.ok(command.exe.endsWith('astra-container-cli.mjs'));
    assert.equal(command.args[command.args.indexOf('--model')+1],NATIVE_CODEX_MODELS[arm]);
    for(const flag of ['--ignore-user-config','--ignore-rules','--json','model_reasoning_effort="medium"'])assert.ok(command.args.includes(flag));
    assert.ok(!command.args.includes('--ephemeral'));
  }
  const manifest=await runFactoryFights({output,arms,cards:['context-packet'],kitId:'factory-2026-09-07'}, {
    inspect:async()=>{throw Error('Cloud-only run must not contact the local model');},
    contender:async(command,{dir,arm})=>{
      fs.writeFileSync(path.join(dir,'native-sessions','usage.jsonl'),JSON.stringify({type:'token_usage_record',
        timestamp:new Date().toISOString(),payload:{response_id:arm,usage:{input_tokens:100,cached_input_tokens:70,output_tokens:12}}})+'\n');
      return {code:0,stdout:'',stderr:'',wallMs:10,startedAt:new Date().toISOString(),timedOut:false,aborted:false,bufferExceeded:false};
    },
    grade:async()=>({publicResult:{code:0,stdout:'',stderr:'',timedOut:false},hidden:{code:0,stdout:'',stderr:'',timedOut:false},
      record:{schema:'bantam.factory-card-grade.v1',card:'context-packet',pass:true,groups:[{name:'synthetic',pass:true}]},timing:{publicWallMs:0,hiddenWallMs:0,totalWallMs:0}}),
  });
  assert.equal(manifest.complete,true);assert.equal(manifest.configuration.codexModel,null);
  assert.deepEqual(manifest.configuration.codexModels,NATIVE_CODEX_MODELS);
  for(const row of manifest.results){assert.equal(row.usage.complete,true);assert.equal(row.usage.inputTokens,100);assert.equal(row.usage.freshInputTokens,30);}
  writeFightCardExport(output);assert.equal(writeFactoryReplay(output).lanes,3);
  const publicData=buildShowcase({roots:[output],mode:'public'}).data;
  const launch=buildLaunchData(JSON.stringify(publicData));
  assert.deepEqual(launch.series[0].cards[0].rows.map(r=>r.model),['GPT-6 Astra · native CLI','GPT-5.6 Sol · native CLI','GPT-5.6 Terra · native CLI']);
  for(const render of [renderLaunchPage,renderShareCard])for(const label of ['Codex · Astra','Codex · Sol','Codex · Terra'])assert.ok(render(launch).includes(label));
  publicData.series[0].cards[0].rows[1].model='GPT-6 Astra · native CLI';
  assert.throws(()=>buildLaunchData(JSON.stringify(publicData)),/contradictory public model/);
});
