#!/usr/bin/env node
// Post-fix validation against the original sealed tasks, graders and starters.
// Each invocation has a new evidence directory; never overwrite a scored run.
import fs from 'node:fs';
import {readJsonFile} from '../src/json-file.js';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {acceptedBantamCompletion, cardCommand, changedSealedFiles, execute,
  gradeCandidate, treeHashes} from './repobrief-astra-fights.mjs';
import {cornerUsage} from '../src/fight.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const KIT=path.join(ROOT,'examples/fights/repobrief-astra-2026-09-06');
const ALLOWED_ARMS=['bantam-local-27b','bantam-codex-astra'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');

export function validationPlan({stages=[1,2,3],arms=ALLOWED_ARMS}={}) {
  if(!Array.isArray(stages)||!stages.length||stages.some(s=>![1,2,3].includes(s))||new Set(stages).size!==stages.length)
    throw Error('stages must be unique members of 1,2,3');
  if(!Array.isArray(arms)||!arms.length||arms.some(a=>!ALLOWED_ARMS.includes(a))||new Set(arms).size!==arms.length)
    throw Error('arms must be unique explicit BANTAM local/Astra contenders');
  return stages.flatMap(stage=>(stage===2?[...arms].reverse():arms).map(arm=>({stage,arm})));
}

export function validationEnv(overrides={}) {
  return {...Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !key.startsWith('BANTAM_')&&!key.startsWith('ASTRA_CONTAINER_')
    &&!['NODE_OPTIONS','NODE_TEST_CONTEXT','OPENAI_API_KEY','OPENAI_BASE_URL'].includes(key))),...overrides};
}

export async function validateContextFixes({sourceEvidence,output,stages=[1,2,3],arms=ALLOWED_ARMS,stopOnFailure=true}={}) {
  const plan=validationPlan({stages,arms});
  if(!path.isAbsolute(sourceEvidence??'')||!path.isAbsolute(output??''))throw Error('evidence paths must be absolute');
  if(fs.existsSync(output))throw Error('refusing to overwrite existing evidence');
  const original=JSON.parse(fs.readFileSync(path.join(sourceEvidence,'manifest.json')));
  if(!original.complete)throw Error('source comparison must be complete');
  const kitSeal=treeHashes(KIT);
  if(JSON.stringify(kitSeal)!==JSON.stringify(original.kitSeal))throw Error('original grader/task kit changed');
  const sourceSeal=Object.fromEntries(['src','bin','scripts'].flatMap(part=>Object.entries(treeHashes(path.join(ROOT,part))).map(([file,hash])=>[`${part}/${file}`,hash])));
  const manifest={schema:'bantam.repobrief-context-validation.v1',startedAt:new Date().toISOString(),
    sourceEvidence,originalManifestSha256:sha(fs.readFileSync(path.join(sourceEvidence,'manifest.json'))),
    baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    design:'One post-fix sample per requested corner/card, paired to original exact task and material bytes. Shared original BANTAM-Astra starters, not fresh independent trajectories. No hidden-test feedback or manual candidate edits. Original scores unchanged.',
    limits:{wallMs:480000,bantamTurns:60},plan,sourceSeal,kitSeal,results:[]};
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const save=()=>writeJson(path.join(output,'manifest.json'),manifest);save();
  for(const {stage,arm} of plan) {
    if(changedSealedFiles(sourceSeal,ROOT).length||changedSealedFiles(kitSeal,KIT).length)throw Error('source or kit changed during validation');
    const oldStage=original.stages.find(row=>row.stage===stage);
    const oldDir=path.join(sourceEvidence,`card-${stage}`);
    const materials=path.join(oldDir,'materials');
    if(JSON.stringify(treeHashes(materials))!==JSON.stringify(oldStage.materialSeal))throw Error('original starter changed');
    const task=fs.readFileSync(path.join(oldDir,arm,'task.md'),'utf8');
    if(sha(task)!==oldStage.taskSha256)throw Error('original task changed');
    const dir=path.join(output,`card-${stage}`,arm),workspace=path.join(dir,'ws');
    fs.mkdirSync(dir,{recursive:true});fs.cpSync(materials,workspace,{recursive:true,dereference:false});
    if(JSON.stringify(treeHashes(workspace))!==JSON.stringify(oldStage.materialSeal))throw Error('candidate starter mismatch');
    const command=cardCommand(arm,task,workspace,dir);
    fs.writeFileSync(path.join(dir,'task.md'),task);writeJson(path.join(dir,'command.json'),command);
    process.stdout.write(`Card ${stage}: ${arm} started\n`);
    const result=await execute(command,{cwd:workspace,env:validationEnv({...command.env,PWD:workspace}),dir,timeoutMs:480000,events:[],arm});
    const protectedSeal=Object.fromEntries(Object.entries(oldStage.materialSeal).filter(([p])=>p==='package.json'||p.startsWith('test/')));
    const tampered=changedSealedFiles(protectedSeal,workspace);
    const grade=await gradeCandidate(workspace,stage,kitSeal);
    fs.writeFileSync(path.join(dir,'grade.stdout.log'),grade.stdout);fs.writeFileSync(path.join(dir,'grade.stderr.log'),grade.stderr);
    let saved=null;try{saved=await readJsonFile(path.join(dir,'run.json'));}catch{}
    const candidatePass=!tampered.length&&grade.code===0&&!grade.timedOut&&!grade.bufferExceeded&&!grade.aborted;
    const acceptedCompletion=acceptedBantamCompletion(saved);
    const row={stage,arm,pass:candidatePass&&acceptedCompletion&&result.code===0&&!result.timedOut&&!result.bufferExceeded&&!result.aborted,
      candidatePass,acceptedCompletion,exitCode:result.code,timedOut:result.timedOut,wallMs:result.wallMs,
      tampered,graderExitCode:grade.code,graderTimedOut:grade.timedOut,
      taskSha256:sha(task),materialSeal:oldStage.materialSeal,
      usage:cornerUsage(arm,{armDir:dir,run:saved,rawLines:result.stdout.split('\n')}),finalFiles:treeHashes(workspace,{excludeGenerated:true})};
    writeJson(path.join(dir,'result.json'),row);manifest.results.push(row);save();
    process.stdout.write(`Card ${stage}: ${arm} ${row.pass?'PASS':'FAIL'} (${(row.wallMs/1000).toFixed(1)}s)\n`);
    if(!row.pass&&stopOnFailure){manifest.stopped='First failed post-fix sample retained; inspect before expanding validation.';break;}
  }
  manifest.finishedAt=new Date().toISOString();manifest.sourceMismatches=changedSealedFiles(sourceSeal,ROOT);manifest.kitMismatches=changedSealedFiles(kitSeal,KIT);
  manifest.complete=manifest.results.length===plan.length;
  manifest.allPassed=manifest.complete&&manifest.results.every(row=>row.pass)&&!manifest.sourceMismatches.length&&!manifest.kitMismatches.length;
  save();process.stdout.write(`Evidence: ${output}\nComplete=${manifest.complete} allPassed=${manifest.allPassed}\n`);return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),sourceEvidence=args[0],output=args[1];
  const value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
  const m=await validateContextFixes({sourceEvidence,output,
    ...(value('--stages')?{stages:value('--stages').split(',').map(Number)}:{}),
    ...(value('--arms')?{arms:value('--arms').split(',')}:{}),stopOnFailure:!args.includes('--continue-on-failure')});
  if(!m.allPassed)process.exitCode=1;
}
