#!/usr/bin/env node
// Non-scored integration check. Never uses a fight card or hidden grader.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {freshCommand,cleanFightEnv,inspectLocalModel,FIGHT_ARMS,executeContender} from './factory-fights.mjs';
import {startModelRecorder} from './fight-model-proxy.mjs';
import {execute,changedSealedFiles,treeHashes} from './repobrief-astra-fights.mjs';
import {runShellProcess} from '../src/executor.js';
import {readCornerUsage} from '../src/fight.js';
import {readCompetitorRegistry} from '../src/competitor-registry.js';
const write=(p,data)=>fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');
export async function preflight(output,arms=FIGHT_ARMS,{peerExecutables=readCompetitorRegistry().tools,peerOutputTokens=8192}={}){
  if(!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('fresh absolute output required');
  if(arms.some(a=>!FIGHT_ARMS.includes(a)))throw Error('unknown arm');
  const upstream='http://127.0.0.1:8085',model=await inspectLocalModel(upstream);
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const results=[];
  const task='Implement sum(a,b) in sum.js to add two finite numbers. Use the existing Node builtin test suite. Do not modify package.json or test/sum.test.js. Run npm test and finish. No dependencies or network access are needed.';
  for(const arm of arms){
    const dir=path.join(output,arm),workspace=path.join(dir,'ws');
    fs.mkdirSync(path.join(workspace,'test'),{recursive:true});fs.mkdirSync(path.join(dir,'native-sessions'));
    fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({name:'fight-preflight',private:true,type:'module',scripts:{test:'node --test test/*.test.js'}}));
    fs.writeFileSync(path.join(workspace,'sum.js'),'export function sum(a,b) { throw new Error("implement"); }\n');
    fs.writeFileSync(path.join(workspace,'test/sum.test.js'),'import {sum} from "../sum.js"; import assert from "node:assert/strict"; import test from "node:test"; test("sum",()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,0.5),-1.5);});\n');
    fs.writeFileSync(path.join(dir,'task.md'),task);
    const seal=treeHashes(workspace),local=!arm.includes('codex')&&!arm.startsWith('codex');
    const recorder=local?await startModelRecorder({upstream,output:path.join(dir,'wire')}):null;
    const command=freshCommand({arm,task,workspace,dir,endpoint:recorder?.endpoint??upstream,model:model.id,timeoutMs:120000,peerExecutables,peerOutputTokens});
    write(path.join(dir,'command.json'),command);process.stdout.write(`${arm}: smoke started\n`);
    let result,usage;
    try{result=await executeContender(command,{cwd:workspace,env:cleanFightEnv({...command.env,PWD:workspace}),dir,timeoutMs:120000,events:[],arm});}
    finally{usage=recorder?await recorder.close():null;}
    const check=await runShellProcess(workspace,'npm test',{shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:15000});
    fs.writeFileSync(path.join(dir,'check.stdout.log'),check.stdout);fs.writeFileSync(path.join(dir,'check.stderr.log'),check.stderr);
    usage??=await readCornerUsage(arm,{armDir:dir,rawLines:result.stdout.split('\n')});
    const protectedChanged=changedSealedFiles(Object.fromEntries(Object.entries(seal).filter(([p])=>p!=='sum.js')),workspace);
    const row={arm,pass:result.code===0&&!result.timedOut&&check.code===0&&!protectedChanged.length,wallMs:result.wallMs,exitCode:result.code,timedOut:result.timedOut,checkExit:check.code,protectedChanged,usage};
    results.push(row);write(path.join(dir,'result.json'),row);write(path.join(output,'results.json'),results);
    process.stdout.write(`${arm}: ${row.pass?'PASS':'FAIL'} ${(row.wallMs/1000).toFixed(1)}s; usage ${JSON.stringify(usage)}\n`);
  }
  return results;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))preflight(process.argv[2],process.argv[3]?.split(',')).catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
