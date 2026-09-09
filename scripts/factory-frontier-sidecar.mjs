#!/usr/bin/env node
// Six native-only follow-up bouts. No changes to the running main-series seal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {FIGHT_CARDS,freshCommand,cleanFightEnv,executeContender,parseGrade} from './factory-fights.mjs';
import {treeHashes,changedSealedFiles} from './repobrief-astra-fights.mjs';
import {codexSessionUsage} from './fight-usage.mjs';
import {discoverRuntime} from './astra-container-cli.mjs';
import {runShellProcess} from '../src/executor.js';
import {cornerUsage} from '../src/fight.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const KIT=path.join(ROOT,'examples/fights/factory-2026-09-06');
export const FRONTIER_MODELS=['gpt-5.6-sol','gpt-5.6-terra'];
const SCRIPTS=['factory-frontier-sidecar.mjs','factory-fights.mjs','repobrief-astra-fights.mjs',
  'astra-container-cli.mjs','fight-usage.mjs','fight-model-proxy.mjs'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const quote=value=>`'${String(value).replace(/'/g,"'\\''")}'`;
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const clean=result=>result?.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function frontierPlan(){
  return FIGHT_CARDS.flatMap((card,i)=>(i%2?[...FRONTIER_MODELS].reverse():FRONTIER_MODELS)
    .map(model=>({card,model,arm:model==='gpt-5.6-sol'?'codex-sol':'codex-terra',repeat:1})));
}

export function frontierCommand({model,task,workspace,dir,timeoutMs=600000}){
  if(!FRONTIER_MODELS.includes(model))throw Error('unsupported sidecar model');
  const command=freshCommand({arm:'codex-astra',task,workspace,dir,timeoutMs});
  const indexes=command.args.flatMap((value,i)=>value==='--model'?[i]:[]);
  if(indexes.length!==1||command.args[indexes[0]+1]!=='gpt-6-astra')throw Error('native reference command changed');
  if(command.args.filter(a=>a==='model_reasoning_effort="medium"').length!==1)throw Error('native effort must remain medium');
  command.args[indexes[0]+1]=model;
  return command;
}

// Native turn-context is evidence of the CLI's selected model, not a claim to
// inspect or authenticate the provider's internal execution.
export function nativeModelIdentity(directory,requestedModel){
  const observations=[],errors=[];let files=0,bytes=0;
  function walk(dir,depth=0){
    if(depth>12){errors.push('session nesting exceeds bound');return;}
    if(!fs.existsSync(dir))return;
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink()){errors.push('invalid session directory');return;}
    for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(dir,e.name),relative=path.relative(directory,file).split(path.sep).join('/');
      if(e.isSymbolicLink()){errors.push(`symlink session evidence: ${relative}`);continue;}
      if(e.isDirectory()){walk(file,depth+1);continue;}
      if(!e.isFile()||!e.name.endsWith('.jsonl'))continue;
      if(++files>256){errors.push('too many session files');return;}
      const size=fs.statSync(file).size;bytes+=size;
      if(size>64*1024*1024||bytes>256*1024*1024){errors.push('session evidence exceeds byte bound');return;}
      for(const [index,line] of fs.readFileSync(file,'utf8').split('\n').entries()){
        if(!line.trim())continue;
        let row;try{row=JSON.parse(line);}catch{errors.push(`malformed session line: ${relative}:${index+1}`);continue;}
        if(row?.type!=='turn_context')continue;
        const p=row.payload;
        if(typeof p?.model!=='string'||typeof p.effort!=='string'){errors.push(`missing model/effort: ${relative}:${index+1}`);continue;}
        observations.push({path:relative,line:index+1,model:p.model,effort:p.effort,turnId:p.turn_id??null,
          settingsModel:p.collaboration_mode?.settings?.model??null,
          settingsEffort:p.collaboration_mode?.settings?.reasoning_effort??null});
      }
    }
  }
  walk(directory);
  const mismatch=observations.some(o=>o.model!==requestedModel||o.effort!=='medium'
    ||o.settingsModel!==null&&o.settingsModel!==requestedModel||o.settingsEffort!==null&&o.settingsEffort!=='medium');
  return {source:'codex-native-turn-context',requestedModel,requestedEffort:'medium',
    status:mismatch?'mismatch':observations.length&&!errors.length?'verified':'unknown',
    observedModels:[...new Set(observations.map(o=>o.model))],observations,errors};
}

export function sidecarOutcome({result,grading,tampered=[],modelIdentity,integrity=true}){
  const candidatePass=!tampered.length&&clean(grading?.publicResult)&&clean(grading?.hidden)&&grading?.record?.pass===true;
  const processCompleted=clean(result),scoreEligible=integrity&&modelIdentity?.status==='verified';
  const outcome=!integrity?'INTEGRITY_ERROR':modelIdentity?.status==='mismatch'?'MODEL_MISMATCH':
    candidatePass?(processCompleted&&scoreEligible?'PASS':'OUTPUT_ONLY'):result?.timedOut?'TIMEOUT':'FAIL';
  return {outcome,pass:outcome==='PASS',candidatePass,processCompleted,scoreEligible};
}

export async function gradeFrontier(workspace,card,{kitRoot=KIT,run=runShellProcess}={}){
  if(!FIGHT_CARDS.includes(card))throw Error('invalid card');
  const kit=path.join(kitRoot,card),descriptor=JSON.parse(fs.readFileSync(path.join(kit,'card.json'),'utf8'));
  const publicStart=Date.now();
  const publicResult=await run(workspace,'npm test',{
    shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:60000});
  const publicWallMs=Date.now()-publicStart,hiddenStart=Date.now();
  const hidden=await run(workspace,`node ${quote(path.join(kit,'grader.mjs'))} ${quote(workspace)}`,{
    shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:60000,
    readOnlyHostFiles:[path.join(kitRoot,'grader-support.mjs'),path.join(kit,'grader.mjs'),path.join(kit,'card.json')]});
  const hiddenWallMs=Date.now()-hiddenStart;
  return {publicResult,hidden,record:parseGrade(hidden.stdout,card,descriptor.groups),
    timing:{publicWallMs,hiddenWallMs,totalWallMs:publicWallMs+hiddenWallMs}};
}

export function frontierSourceSeal(){
  return Object.fromEntries([
    ...['src','bin'].flatMap(part=>Object.entries(treeHashes(path.join(ROOT,part))).map(([p,h])=>[`${part}/${p}`,h])),
    ...['package.json','package-lock.json'].filter(p=>fs.existsSync(path.join(ROOT,p))).map(p=>[p,sha(fs.readFileSync(path.join(ROOT,p)))]),
    ...SCRIPTS.map(p=>[`scripts/${p}`,sha(fs.readFileSync(path.join(ROOT,'scripts',p)))]),
  ]);
}

function runtimeIdentity(){
  const runtime=discoverRuntime(),binary=path.join(runtime.vendor,'bin/codex');
  const files=[binary,...runtime.tools,...runtime.libraries,runtime.certificates,path.join(runtime.npm,'package.json')];
  return {codexVersion:execFileSync(binary,['--version'],{encoding:'utf8',timeout:10000}).trim(),
    image:'ubuntu:24.04',imageId:execFileSync('docker',['image','inspect','ubuntu:24.04','--format','{{.Id}}'],{encoding:'utf8',timeout:10000}).trim(),
    artifacts:Object.fromEntries([...new Set(files)].sort().map(file=>[file,sha(fs.readFileSync(file))])),
    authentication:'Existing CLI authentication mounted read-only by the unchanged launcher; secret bytes are not copied or hashed.',
    caveat:'Runtime observations are local provenance, not a provider model attestation.'};
}

function snapshotFiles(seal,source,target){
  for(const [relative,expected] of Object.entries(seal)){
    if(!/^[a-f0-9]{64}$/.test(expected))throw Error('source snapshots require regular files');
    const from=path.join(source,relative),to=path.join(target,relative);
    if(!fs.lstatSync(from).isFile()||fs.lstatSync(from).isSymbolicLink())throw Error('non-regular sealed source');
    fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
    if(sha(fs.readFileSync(to))!==expected)throw Error('source snapshot digest mismatch');
  }
}

function markdown(manifest){
  return '# Native Sol / Terra follow-up cards\n\n'+manifest.design+'\n\n'
    +'| Card | Model | Outcome | Groups | Model identity | Seconds | Input | Fresh input | Output | Accounting |\n'
    +'|---|---|---|---:|---|---:|---:|---:|---:|---|\n'
    +manifest.results.map(r=>`| ${r.card} | ${r.model} | ${r.outcome} | ${r.grade?.groups.filter(g=>g.pass).length??'—'}/${r.grade?.groups.length??'—'} | ${r.modelIdentity?.status??'unknown'} | ${((r.wallMs??0)/1000).toFixed(1)} | ${r.usage?.inputTokens??'—'} | ${r.usage?.freshInputTokens??'—'} | ${r.usage?.outputTokens??'—'} | ${r.usageStatus} |`).join('\n')
    +'\n\nUnknown usage is not zero. Partial totals are labeled incomplete. Completion, output acceptance, and native model selection are recorded independently. Local private evidence only; no upload or automatic promotion.\n';
}

export async function runFrontierSidecar({output,timeoutMs=600000}={}){
  if(!path.isAbsolute(output??'')||fs.existsSync(output)||/[\x00-\x1f,:]/.test(output))throw Error('requires a fresh absolute output directory without mount separators');
  if(timeoutMs!==600000)throw Error('sidecar uses the same fixed 600-second contender deadline');
  const sourceSeal=frontierSourceSeal(),kitSeal=treeHashes(KIT),runtime=runtimeIdentity(),plan=frontierPlan();
  for(const card of FIGHT_CARDS){
    const d=JSON.parse(fs.readFileSync(path.join(KIT,card,'card.json'),'utf8'));
    if(d.id!==card||!Array.isArray(d.groups)||!d.groups.length||!Array.isArray(d.protected))throw Error('invalid card descriptor');
  }
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  if(fs.realpathSync(output)!==path.resolve(output))throw Error('output path must not contain symlinks');
  const manifest={schema:'bantam.factory-frontier-sidecar.v1',startedAt:new Date().toISOString(),complete:false,
    design:'Exploratory native-only follow-up: two models on the same three sealed factory cards, one fresh attempt each, rotated serial order, no operator repairs. This separate sidecar does not replace or modify the main series. Six observations are not a statistical ranking.',
    baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    sourceSeal,kitSeal,runtimeIdentity:runtime,sourceEvidence:{runtime:'source-evidence/runtime',kit:'source-evidence/kit'},
    privacy:{localOnly:true,containsPrivateSourceAndNativeContext:true,redacted:false},
    limits:{wallMs:timeoutMs,publicGraderWallMs:60000,hiddenGraderWallMs:60000},
    configuration:{models:FRONTIER_MODELS,effort:'medium',nativeOnly:true,launcher:'scripts/astra-container-cli.mjs',
      executionSchedule:'All six sidecar contenders run serially. The main local-model queue may overlap, so shared host CPU/IO contention remains possible.',
      isolation:'Unchanged native Docker launcher; fresh candidate and session mounts, read-only CLI authentication, no host user config, no hidden grader during generation. Provider network enabled. Judges run offline in separate read-only Docker workspaces.',
      sampling:'Unchanged native Codex defaults, medium effort; no local model endpoint or local model requests.',
      accounting:'Native response-ID usage records; missing records remain unknown. CLI summaries retained separately and never substituted for native completeness.',
      identity:'All native turn-context model and effort observations must match requested model and medium for PASS. Native logs are evidence of CLI selection, not provider attestation.'},
    plan,results:[]};
  const save=()=>{write(path.join(output,'manifest.json'),manifest);fs.writeFileSync(path.join(output,'RESULTS.md'),markdown(manifest),{mode:0o600});};
  save();snapshotFiles(sourceSeal,ROOT,path.join(output,'source-evidence/runtime'));snapshotFiles(kitSeal,KIT,path.join(output,'source-evidence/kit'));
  const unchanged=()=>equal(frontierSourceSeal(),sourceSeal)&&equal(treeHashes(KIT),kitSeal)&&equal(runtimeIdentity(),runtime);
  try{
    for(const item of plan){
      if(fs.existsSync(path.join(output,'STOP_AFTER_CURRENT'))){manifest.stoppedEarly='Operator requested stop at a clean contender boundary.';break;}
      if(!unchanged())throw Error('source, kit, or runtime changed after sidecar freeze');
      const {card,model,arm}=item,kit=path.join(KIT,card),dir=path.join(output,'repeat-1',card,arm),workspace=path.join(dir,'ws');
      fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.cpSync(path.join(kit,'starter'),workspace,{recursive:true,dereference:false});
      const materialSeal=treeHashes(path.join(kit,'starter'));
      if(!equal(materialSeal,treeHashes(workspace)))throw Error('starter copy mismatch');
      const descriptor=JSON.parse(fs.readFileSync(path.join(kit,'card.json'),'utf8'));
      const task=fs.readFileSync(path.join(kit,'task.md'),'utf8');fs.writeFileSync(path.join(dir,'task.md'),task,{mode:0o600});
      const sessions=path.join(dir,'native-sessions');fs.mkdirSync(sessions,{mode:0o700});
      const command=frontierCommand({model,task,workspace,dir,timeoutMs});write(path.join(dir,'command.json'),command);
      process.stdout.write(`${card} ${arm}: started\n`);
      const start=Date.now();let result,executionError=null,grading=null,gradingError=null;
      try{result=await executeContender(command,{cwd:workspace,env:cleanFightEnv({...command.env,PWD:workspace}),dir,timeoutMs,events:[],arm});}
      catch(error){executionError=String(error.stack??error);result={code:null,timedOut:false,aborted:false,bufferExceeded:false,stdout:'',stderr:'',wallMs:Date.now()-start,startedAt:new Date(start).toISOString()};}
      const integrity=unchanged();
      const protectedSeal=Object.fromEntries(Object.entries(materialSeal).filter(([p])=>descriptor.protected.includes(p)||p==='package.json'||p.startsWith('test/')));
      const tampered=changedSealedFiles(protectedSeal,workspace);
      if(integrity&&!executionError){
        try{grading=await gradeFrontier(workspace,card);}
        catch(error){gradingError=String(error.stack??error);}
      }
      if(grading)for(const [label,record] of [['public',grading.publicResult],['hidden',grading.hidden]]){
        fs.writeFileSync(path.join(dir,`${label}.stdout.log`),record.stdout,{mode:0o600});fs.writeFileSync(path.join(dir,`${label}.stderr.log`),record.stderr,{mode:0o600});
      }
      const modelIdentity=nativeModelIdentity(sessions,model),usage=codexSessionUsage(sessions,
        {processCompleted:result.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded&&!executionError});
      const finalIntegrity=integrity&&unchanged();
      const outcome=sidecarOutcome({result,grading,tampered,modelIdentity,integrity:finalIntegrity});
      if(executionError||gradingError){outcome.outcome='ATTEMPT_ERROR';outcome.pass=false;outcome.scoreEligible=false;}
      const row={...item,...outcome,requestedEffort:'medium',modelIdentity,
        wallMs:result.wallMs,startedAt:result.startedAt,exitCode:result.code,timedOut:result.timedOut,aborted:result.aborted,bufferExceeded:result.bufferExceeded,
        executionError,gradingError,taskSha256:sha(task),materialSeal,tampered,grade:grading?.record??null,
        publicExit:grading?.publicResult.code??null,hiddenExit:grading?.hidden.code??null,
        graderTimedOut:grading?grading.publicResult.timedOut||grading.hidden.timedOut:null,
        gradingTiming:grading?.timing??null,contenderPlusGradingWallMs:grading?result.wallMs+grading.timing.totalWallMs:null,
        usage,usageStatus:usage?(usage.complete?'complete':'incomplete'):'unknown',
        nativeUsage:cornerUsage('codex-astra',{armDir:dir,rawLines:result.stdout.split('\n')}),
        nativeSessionSeal:treeHashes(sessions),finalFiles:treeHashes(workspace,{excludeGenerated:true}),operatorInterventions:0};
      write(path.join(dir,'result.json'),row);manifest.results.push(row);save();
      process.stdout.write(`${manifest.results.length}/6 ${card} ${arm}: ${row.outcome}, ${(row.wallMs/1000).toFixed(1)}s\n`);
      if(executionError)throw Error('contender execution/cleanup failed; attempted row retained, no further contender started');
      if(!finalIntegrity)throw Error('source, kit, or runtime changed; attempted row retained unscored');
    }
    manifest.finishedAt=new Date().toISOString();manifest.complete=manifest.results.length===plan.length;
    manifest.sourceMismatches=changedSealedFiles(sourceSeal,ROOT);manifest.kitMismatches=changedSealedFiles(kitSeal,KIT);save();return manifest;
  }catch(error){manifest.operatorError=String(error.stack??error);manifest.stoppedAt=new Date().toISOString();save();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3){process.stderr.write('Usage: node scripts/factory-frontier-sidecar.mjs FRESH_ABSOLUTE_OUTPUT\n');process.exitCode=1;}
  else runFrontierSidecar({output:process.argv[2]}).catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
}
