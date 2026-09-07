#!/usr/bin/env node
// A separately identified BANTAM/local-model series. Never relabels historical arms.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {cleanFightEnv,freshCommand,inspectLocalModel,executeContender,parseGrade} from './factory-fights.mjs';
import {factoryKit} from './factory-card-catalog.mjs';
import {treeHashes,changedSealedFiles,acceptedBantamCompletion} from './repobrief-astra-fights.mjs';
import {startModelRecorder} from './fight-model-proxy.mjs';
import {serverCounters,counterDelta} from './fight-usage.mjs';
import {runShellProcess} from '../src/executor.js';
import {runProcess} from '../src/process-runner.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DEFAULT_KIT_ID='factory-2026-09-06';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const quote=value=>`'${String(value).replace(/'/g,"'\\''")}'`;
const clean=result=>result?.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded;

// A closed, versioned allowlist, never a user-supplied directory or grader.
// Return copies so callers cannot mutate the next run's permitted work orders.
export function variantKit(kitId=DEFAULT_KIT_ID) {
  return factoryKit(kitId);
}

export function variantOptions(options={}) {
  const {output,label,variantId,kitId=DEFAULT_KIT_ID,modelId=null,modelFile=null,timeoutMs=600000,endpoint='http://127.0.0.1:8085',verificationWorkspaceReadOnly=false,contractAssertionStation=false}=options;
  const kit=variantKit(kitId),cards=options.cards===undefined?kit.cards:options.cards;
  if(!path.isAbsolute(output??''))throw Error('--output must be an absolute, fresh evidence directory');
  if(typeof label!=='string'||!label.trim()||label.length>200||/[\r\n\x00-\x1f]/.test(label))throw Error('--label must name the actual model variant');
  if(typeof variantId!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(variantId))throw Error('--variant-id must be a lowercase path-safe identifier');
  if(modelId!==null&&(typeof modelId!=='string'||!modelId.trim()||/[\r\n\x00-\x1f]/.test(modelId)))throw Error('--model-id must be an exact server model identity');
  if(modelFile!==null&&!path.isAbsolute(modelFile))throw Error('--model-file must be absolute');
  if(!Array.isArray(cards)||!cards.length||new Set(cards).size!==cards.length||cards.some(c=>!kit.cards.includes(c)))throw Error('--cards must contain distinct IDs belonging to the selected factory kit');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('--timeout-seconds must be 1..600');
  if(typeof verificationWorkspaceReadOnly!=='boolean')throw Error('verificationWorkspaceReadOnly must be a boolean');
  if(typeof contractAssertionStation!=='boolean')throw Error('contractAssertionStation must be a boolean');
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('--endpoint must be a loopback HTTP origin without credentials');
  return {output,label:label.trim(),variantId,kitId,arm:`bantam-local-${variantId}`,modelId,modelFile,cards:[...cards],timeoutMs,endpoint:url.origin,verificationWorkspaceReadOnly,contractAssertionStation};
}

export function parseVariantArgs(args) {
  const flags=new Map([['--output','output'],['--endpoint','endpoint'],['--label','label'],['--variant-id','variantId'],['--kit','kitId'],
    ['--model-id','modelId'],['--model-file','modelFile'],['--cards','cards'],['--timeout-seconds','timeoutMs']]);
  const options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--contract-assertion-station'){
      if(Object.hasOwn(options,'contractAssertionStation'))throw Error('duplicate --contract-assertion-station');
      options.contractAssertionStation=true;continue;
    }
    if(args[i]==='--verify-workspace-read-only'){
      if(Object.hasOwn(options,'verificationWorkspaceReadOnly'))throw Error('duplicate --verify-workspace-read-only');
      options.verificationWorkspaceReadOnly=true;continue;
    }
    const name=flags.get(args[i]);
    if(!name||Object.hasOwn(options,name)||!args[i+1]||args[i+1].startsWith('--'))throw Error(`unknown, duplicate, or missing-valued option: ${args[i]}`);
    const value=args[++i];options[name]=name==='cards'?value.split(','):name==='timeoutMs'?Number(value)*1000:value;
  }
  return variantOptions(options);
}

export function localVariantCommand({task,workspace,dir,endpoint,modelId,verificationWorkspaceReadOnly=false,contractAssertionStation=false}) {
  // This legacy key selects a command recipe, not the recorded model identity.
  // Keep the exact prior baseline's Qwen profile, 60 turns and request budgets.
  const {exe,args,env}=freshCommand({arm:'bantam-local-27b',task,workspace,dir,endpoint,model:modelId,probeEnabled:true});
  if(verificationWorkspaceReadOnly){args.push('--verify-workspace-read-only');env.BANTAM_VERIFY_WORKSPACE_READ_ONLY='1';}
  if(contractAssertionStation)env.BANTAM_CONTRACT_ASSERTION_STATION='on';
  return {exe,args,env}; // Do not copy historical corner/name/subtitle metadata.
}

export async function gradeLocalVariant(workspace,card,{run=runShellProcess,kitId=DEFAULT_KIT_ID}={}) {
  const selected=variantKit(kitId);
  if(!selected.cards.includes(card)||!path.isAbsolute(workspace))throw Error('invalid card or workspace for selected kit');
  const kit=path.join(selected.root,card),descriptor=JSON.parse(fs.readFileSync(path.join(kit,'card.json'),'utf8'));
  if(descriptor.id!==card||!Array.isArray(descriptor.groups)||!descriptor.groups.length)throw Error('invalid frozen card descriptor');
  const files=[path.join(selected.root,'grader-support.mjs'),...Object.keys(treeHashes(kit))
    .filter(p=>!p.startsWith('starter/')&&!p.startsWith('reviewer/')).map(p=>path.join(kit,p))];
  const publicStart=Date.now();
  const publicResult=await run(workspace,'npm test',{shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:60000});
  const publicWallMs=Date.now()-publicStart,hiddenStart=Date.now();
  const hidden=await run(workspace,`node ${quote(path.join(kit,'grader.mjs'))} ${quote(workspace)}`,{
    shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,readOnlyHostFiles:files,timeoutMs:60000});
  const hiddenWallMs=Date.now()-hiddenStart;
  return {publicResult,hidden,record:parseGrade(hidden.stdout,card,descriptor.groups),
    timing:{publicWallMs,hiddenWallMs,totalWallMs:publicWallMs+hiddenWallMs}};
}

export function variantVerdict({processResult,grading,tampered,saved,usage}) {
  const acceptedCompletion=acceptedBantamCompletion(saved);
  const candidatePass=tampered.length===0&&clean(grading.publicResult)&&clean(grading.hidden)&&grading.record?.pass===true;
  const processCompleted=clean(processResult)&&acceptedCompletion;
  const noModelRequest=usage?.requests===0;
  const outcome=noModelRequest?'SETUP_ERROR':candidatePass?(processCompleted?'PASS':'OUTPUT_ONLY'):processResult.timedOut?'TIMEOUT':'FAIL';
  return {outcome,pass:outcome==='PASS',candidatePass,processCompleted,acceptedCompletion};
}

const SCRIPTS=['factory-local-variant.mjs','factory-card-catalog.mjs','factory-fights.mjs','repobrief-astra-fights.mjs','fight-model-proxy.mjs','fight-usage.mjs'];
function sourceSeal(){return Object.fromEntries([
  ...['src','bin'].flatMap(part=>Object.entries(treeHashes(path.join(ROOT,part))).map(([file,hash])=>[`${part}/${file}`,hash])),
  ...['package.json',...SCRIPTS.map(file=>`scripts/${file}`)].map(file=>[file,sha(fs.readFileSync(path.join(ROOT,file)))]),
]);}
const fingerprint=model=>JSON.stringify({id:model.id,modelPath:model.props?.model_path,build:model.props?.build_info,defaults:model.props?.default_generation_settings});

export async function cleanupVariantWorkspace(workspace,dir,{run=runProcess}={}) {
  if(!path.isAbsolute(workspace)||!path.isAbsolute(dir)||path.resolve(workspace)!==path.join(path.resolve(dir),'ws'))throw Error('cleanup requires the exact run workspace');
  const stat=fs.lstatSync(workspace);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('cleanup workspace must be a real directory');
  const source=fs.realpathSync(workspace),receipt={schema:'bantam.local-variant-container-cleanup.v1',
    at:new Date().toISOString(),workspace:source,confirmed:false,containers:[]};
  const save=()=>write(path.join(dir,'operator-container-cleanup.json'),receipt);
  const invoke=args=>run('docker',args,{env:cleanFightEnv(),timeoutMs:10000,maxBuffer:1024*1024});
  const ids=async()=>{
    const result=await invoke(['container','ls','--all','--quiet','--no-trunc','--filter','name=^/bantam-shell-']);
    if(!clean(result))throw Error('cannot enumerate BANTAM shell containers');
    const list=result.stdout.trim()?result.stdout.trim().split(/\r?\n/):[];
    if(list.length>256||new Set(list).size!==list.length||list.some(id=>! /^[a-f0-9]{64}$/.test(id)))throw Error('invalid or excessive Docker container IDs');
    return list;
  };
  const matching=async()=>{
    const matches=[];
    for(const id of await ids()){
      // Never request Config/Env, which may contain credentials in other containers.
      const result=await invoke(['container','inspect','--format',
        '{"id":{{json .Id}},"name":{{json .Name}},"mounts":{{json .Mounts}}}',id]);
      if(!clean(result)){
        // An unrelated --rm shell may disappear between list and inspect.
        if(!(await ids()).includes(id))continue;
        throw Error(`cannot inspect listed container: ${id}`);
      }
      let record;try{record=JSON.parse(result.stdout);}catch{throw Error('invalid Docker inspection JSON');}
      if(record?.id!==id||typeof record.name!=='string'||!/^\/bantam-shell-\d+-\d+-[a-f0-9]+$/.test(record.name)||!Array.isArray(record.mounts))throw Error('invalid BANTAM shell inspection identity');
      if(record.mounts.some(m=>m?.Type==='bind'&&m.RW===true&&m.Source===source))matches.push({id,name:record.name});
    }
    return matches;
  };
  save();
  try{
    for(const container of await matching()){
      const entry={...container,writableBindSource:source,removed:false};receipt.containers.push(entry);save();
      // Exact ID and exact run-owned writable bind were verified above. Removing
      // this disposable shell cannot remove its bind-mounted workspace files.
      const result=await invoke(['container','rm','--force',container.id]);
      Object.assign(entry,{code:result.code,timedOut:result.timedOut===true,stderr:result.stderr,removed:clean(result)});save();
      if(!clean(result)&&(await ids()).includes(container.id))throw Error(`cannot remove owned workspace writer: ${container.id}`);
      entry.removed=true;
    }
    if((await matching()).length)throw Error('a BANTAM shell still owns a writable workspace bind; grading refused');
    receipt.confirmed=true;save();return receipt;
  }catch(error){receipt.error=error.message;save();throw error;}
}

export async function verifyVariantServer(endpoint,expected,dir,{inspect=inspectLocalModel}={}) {
  const receipt={at:new Date().toISOString(),expected:JSON.parse(fingerprint(expected)),matched:false};
  try{
    receipt.observed=await inspect(endpoint,{requireIdle:true});
    receipt.matched=fingerprint(receipt.observed)===fingerprint(expected);
    if(!receipt.matched)throw Error('local server model/build/default settings changed during contender; grading refused');
    return receipt.observed;
  }catch(error){receipt.error=error.message;throw error;}
  finally{write(path.join(dir,'server-post-run.json'),receipt);}
}

async function optionalCounters(endpoint){try{return await serverCounters(endpoint);}catch(error){return {at:new Date().toISOString(),unavailable:true,error:error.message};}}
async function modelFileReceipt(filename){
  if(!filename)return null;
  const resolved=fs.realpathSync(filename),before=fs.statSync(resolved);
  if(!before.isFile())throw Error('model file must be regular');
  const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(resolved))digest.update(chunk);
  const after=fs.statSync(resolved);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('model file changed while hashing');
  return {path:resolved,size:after.size,mtimeMs:after.mtimeMs,sha256:digest.digest('hex')};
}
function report(manifest){
  const safe=value=>String(value).replaceAll('|','\\|').replace(/[\r\n]/g,' ');
  return `# BANTAM local variant: ${safe(manifest.label)}\n\n${manifest.design}\n\nServer model: ${safe(manifest.modelId)}\n\n`+
    '| Card | Outcome | Independent groups | Public exit | Process finished | Seconds | Input | Output | Cached input | Fresh input |\n|---|---|---:|---:|---|---:|---:|---:|---:|---:|\n'+
    manifest.results.map(r=>`| ${r.card} | ${r.outcome} | ${r.grade?.groups.filter(g=>g.pass).length??'—'}/${r.grade?.groups.length??'—'} | ${r.publicExit??'—'} | ${r.processCompleted} | ${(r.wallMs/1000).toFixed(1)} | ${r.usage?.inputTokens??'unknown'} | ${r.usage?.outputTokens??'unknown'} | ${r.usage?.cacheHitTokens??'unknown'} | ${r.usage?.freshInputTokens??'unknown'} |`).join('\n')+
    '\n\nUnknown accounting is not zero. Independent groups, public tests, protected files and process completion remain separate. No failed candidate is repaired or carried into another card.\n';
}

export async function runLocalVariant(input) {
  const options=variantOptions(input),{output,endpoint,cards,timeoutMs,arm,label,variantId}=options;
  const selectedKit=variantKit(options.kitId),kitRoot=selectedKit.root;
  if(fs.existsSync(output))throw Error('refusing to overwrite an existing evidence directory');
  const model=await inspectLocalModel(endpoint);
  if(options.modelId!==null&&model.id!==options.modelId)throw Error(`server model identity mismatch: expected ${options.modelId}, observed ${model.id}`);
  const advertisedFile=model.props?.model_path;
  if(options.modelFile&&advertisedFile&&path.isAbsolute(advertisedFile)&&fs.realpathSync(options.modelFile)!==fs.realpathSync(advertisedFile))throw Error('--model-file does not match the server-advertised model path');
  const fileReceipt=await modelFileReceipt(options.modelFile??(advertisedFile&&path.isAbsolute(advertisedFile)&&fs.existsSync(advertisedFile)?advertisedFile:null));
  const runtimeSeal=sourceSeal(),kitSeal=treeHashes(kitRoot);
  const assertFrozen=()=>{
    if(JSON.stringify(runtimeSeal)!==JSON.stringify(sourceSeal())||JSON.stringify(kitSeal)!==JSON.stringify(treeHashes(kitRoot)))throw Error('runtime or frozen card bytes changed; no further score issued');
    if(fileReceipt){const s=fs.statSync(fileReceipt.path);if(s.size!==fileReceipt.size||s.mtimeMs!==fileReceipt.mtimeMs)throw Error('model file metadata changed during series');}
  };
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output,{mode:0o700});
  write(path.join(output,'local-model.json'),model);
  const manifest={schema:'bantam.factory-local-variant.v1',startedAt:new Date().toISOString(),complete:false,
    label,variantId,kitId:selectedKit.id,arm,modelId:model.id,expectedModelId:options.modelId,modelFile:fileReceipt,modelFileSha256:fileReceipt?.sha256??null,endpoint,
    baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),sourceSeal:runtimeSeal,kitSeal,
    design:`New separately identified local-model variant on the frozen ${selectedKit.id} factory kit. One serial BANTAM run per selected card, fresh identical starters, no teacher or operator repairs. Historical cards remain unchanged. Different tasks/model/quantization/server settings prevent treating this as a pure harness ablation or statistical ranking.`,
    limits:{wallMs:timeoutMs,bantamTurns:60,reasoningPredict:4096,actionPredict:8192},
    configuration:{bantamContext:'extension/immutable',profile:'qwen',probeEnabled:true,teacher:false,
      contractAssertionStation:options.contractAssertionStation,
      verificationEnvironment:{profile:options.verificationWorkspaceReadOnly?'configured-readonly-v1':'legacy-writable-live-verifier',
        configuredWorkspaceReadOnly:options.verificationWorkspaceReadOnly,manualShellWorkspaceReadOnly:false,
        independentGradingWorkspaceReadOnly:true,temporaryDirectory:'/tmp',
        disclosure:options.verificationWorkspaceReadOnly?'explicit model-visible verification context; source read-only and fresh temporary fixtures required':'historical live-verifier environment; no new task disclosure'},
      commandRecipe:'same BANTAM local recipe as the historical fresh factory baseline; explicit endpoint replaced',
      sampling:'unchanged baseline native sampling; exact settings retained in each wire request',
      cache:'server cache is not cleared; all selected cards run serially; prefix carryover is possible',
      isolation:'project shell commands and both independent grading phases use offline Docker; candidate workspace read-only while grading; hidden grader is not supplied during generation',
      evidence:'exact local HTTP bodies, timestamped exchanges, run.json with prompts/model calls, factory records, stdout/stderr, independent grade logs and protected/source/kit hashes; global server counters are supplementary and never added to wire totals'},
    plan:cards.map(card=>({card,arm,repeat:1,label,modelId:model.id})),results:[]};
  const save=()=>{write(path.join(output,'manifest.json'),manifest);fs.writeFileSync(path.join(output,'RESULTS.md'),report(manifest),{mode:0o600});};
  save();
  try{
    for(const item of manifest.plan){
      if(fs.existsSync(path.join(output,'STOP_AFTER_CURRENT'))){manifest.stoppedEarly='Operator requested stop at a clean card boundary.';break;}
      assertFrozen();
      const current=await inspectLocalModel(endpoint);
      if(fingerprint(current)!==fingerprint(model))throw Error('local server model/build/default settings changed');
      const {card}=item,kit=path.join(kitRoot,card),dir=path.join(output,'repeat-1',card,arm),workspace=path.join(dir,'ws');
      fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.cpSync(path.join(kit,'starter'),workspace,{recursive:true,dereference:false});
      const materials=treeHashes(path.join(kit,'starter'));
      if(JSON.stringify(materials)!==JSON.stringify(treeHashes(workspace)))throw Error('starter copy mismatch');
      const task=fs.readFileSync(path.join(kit,'task.md'),'utf8');fs.writeFileSync(path.join(dir,'task.md'),task,{mode:0o600});
      fs.mkdirSync(path.join(dir,'native-sessions'));
      const recorder=await startModelRecorder({upstream:endpoint,output:path.join(dir,'wire')});
      const before=await optionalCounters(endpoint);
      const command=localVariantCommand({task,workspace,dir,endpoint:recorder.endpoint,modelId:model.id,verificationWorkspaceReadOnly:options.verificationWorkspaceReadOnly,contractAssertionStation:options.contractAssertionStation});
      write(path.join(dir,'command.json'),command);
      process.stdout.write(`${card} / ${label}: started\n`);
      let result,usage;
      try{result=await executeContender(command,{cwd:workspace,env:cleanFightEnv({...command.env,PWD:workspace}),dir,timeoutMs,events:[],arm});}
      finally{try{usage=await recorder.close();}finally{await cleanupVariantWorkspace(workspace,dir);}}
      await verifyVariantServer(endpoint,model,dir);
      const after=await optionalCounters(endpoint),serverUsage=counterDelta(before,after);
      write(path.join(dir,'server-usage.json'),{before,after,delta:serverUsage});assertFrozen();
      const tampered=changedSealedFiles(Object.fromEntries(Object.entries(materials).filter(([file])=>file==='package.json'||file.startsWith('test/'))),workspace);
      const grading=await gradeLocalVariant(workspace,card,{kitId:selectedKit.id});
      for(const [name,record] of [['public',grading.publicResult],['hidden',grading.hidden]]){
        fs.writeFileSync(path.join(dir,`${name}.stdout.log`),record.stdout,{mode:0o600});fs.writeFileSync(path.join(dir,`${name}.stderr.log`),record.stderr,{mode:0o600});
      }
      let saved=null;try{saved=JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'));}catch{}
      const verdict=variantVerdict({processResult:result,grading,tampered,saved,usage});
      const row={...item,...verdict,wallMs:result.wallMs,startedAt:result.startedAt,exitCode:result.code,timedOut:result.timedOut,aborted:result.aborted,bufferExceeded:result.bufferExceeded,
        taskSha256:sha(task),materialSeal:materials,tampered,grade:grading.record,publicExit:grading.publicResult.code,hiddenExit:grading.hidden.code,
        graderTimedOut:grading.publicResult.timedOut||grading.hidden.timedOut,gradingTiming:grading.timing,
        contenderPlusGradingWallMs:result.wallMs+grading.timing.totalWallMs,usage,serverUsage,
        finalFiles:treeHashes(workspace,{excludeGenerated:true}),operatorInterventions:0};
      assertFrozen();write(path.join(dir,'result.json'),row);manifest.results.push(row);save();
      process.stdout.write(`${manifest.results.length}/${manifest.plan.length} ${card}: ${row.outcome}, ${(row.wallMs/1000).toFixed(1)}s, ${row.grade?.groups.filter(g=>g.pass).length??0}/${row.grade?.groups.length??0} groups\n`);
    }
    manifest.finishedAt=new Date().toISOString();manifest.complete=manifest.results.length===manifest.plan.length;
    manifest.sourceMismatches=changedSealedFiles(runtimeSeal,ROOT);manifest.kitMismatches=changedSealedFiles(kitSeal,kitRoot);save();
    return manifest;
  }catch(error){manifest.error={at:new Date().toISOString(),message:error.message};save();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help'))process.stdout.write('node scripts/factory-local-variant.mjs --output ABS_DIR --label "Tiel35BA3B IQ4_XS" --variant-id tiel35ba3b-iq4-xs [--kit factory-2026-09-06|factory-2026-09-07] [--endpoint http://127.0.0.1:8085] [--model-id EXACT_SERVER_ID] [--model-file ABS_GGUF] [--cards COMMA_SEPARATED_KIT_IDS] [--timeout-seconds 600] [--verify-workspace-read-only] [--contract-assertion-station]\n');
  else Promise.resolve().then(()=>runLocalVariant(parseVariantArgs(process.argv.slice(2))))
    .then(result=>{process.stdout.write(`Evidence: ${result.results.length}/${result.plan.length} recorded in ${process.argv[process.argv.indexOf('--output')+1]}\n`);if(!result.complete||result.results.some(row=>!row.pass))process.exitCode=1;})
    .catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
}
