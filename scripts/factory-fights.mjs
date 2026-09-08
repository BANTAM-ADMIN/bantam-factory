#!/usr/bin/env node
// Fresh, separately sealed cards; no candidate repair or automatic promotion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {treeHashes,changedSealedFiles,cardCommand,execute,acceptedBantamCompletion} from './repobrief-astra-fights.mjs';
import {cornerUsage} from '../src/fight.js';
import {historyCharBudget} from '../src/history-budget.js';
import {runShellProcess} from '../src/executor.js';
import {runProcess} from '../src/process-runner.js';
import {startModelRecorder} from './fight-model-proxy.mjs';
import {codexSessionUsage,claudeStreamUsage,serverCounters,counterDelta,settleServerCounters} from './fight-usage.mjs';
import {factoryKit} from './factory-card-catalog.mjs';
import {verifyCompetitorRegistration} from '../src/competitor-registry.js';
import {projectFightProgress,progressKey} from '../src/factory-card-progress.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DEFAULT_KIT_ID='factory-2026-09-06';
export const DEFAULT_FIGHT_ARMS=['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','bantam-codex-astra'];
export const NATIVE_CODEX_MODELS=Object.freeze({'codex-astra':'gpt-6-astra','codex-sol':'gpt-5.6-sol','codex-terra':'gpt-5.6-terra'});
export const FIGHT_ARMS=[...DEFAULT_FIGHT_ARMS,'codex-sol','codex-terra','claude-sonnet','claude-opus','claude-fable'];
export const FIGHT_CARDS=['receipt-reducer','snapshot-drift','job-planner'];
const LOCAL=new Set(FIGHT_ARMS.slice(0,4));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n',{mode:0o600});
const quote=text=>`'${String(text).replace(/'/g,"'\\''")}'`;

export function fightPlan({arms=DEFAULT_FIGHT_ARMS,cards,kitId=DEFAULT_KIT_ID,repetitions=1}={}) {
  const kit=factoryKit(kitId);if(cards===undefined)cards=kit.cards;
  if(!Array.isArray(arms)||!arms.length||arms.some(a=>!FIGHT_ARMS.includes(a))||new Set(arms).size!==arms.length)throw Error('invalid or duplicate arms');
  if(!Array.isArray(cards)||!cards.length||cards.some(c=>!kit.cards.includes(c))||new Set(cards).size!==cards.length)throw Error('invalid or duplicate cards');
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw Error('repetitions must be 1..3');
  const plan=[];
  for(let repeat=1;repeat<=repetitions;repeat++)for(const [i,card] of cards.entries()){
    const shift=((repeat-1)*cards.length+i)*2%arms.length;
    const order=[...arms.slice(shift),...arms.slice(0,shift)];
    if(repeat%2===0)order.reverse();
    for(const arm of order)plan.push({card,arm,repeat});
  }
  return plan;
}

export function cleanFightEnv(overrides={}) {
  // Do not inherit model credentials, endpoint overrides, teachers, Node hooks,
  // or third-party user settings. HOME retains its real meaning and value.
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR'].filter(k=>process.env[k]!=null).map(k=>[k,process.env[k]]));
  return {...env,NO_COLOR:'1',...overrides};
}

export function freshCommand({arm,task,workspace,dir,endpoint,model,contextTokens=null,timeoutMs=600000,probeEnabled=true,peerOutputTokens=8192,verificationWorkspaceReadOnly=false,terminalClosure=false,peerExecutables={}}) {
  if(!FIGHT_ARMS.includes(arm))throw Error('unknown arm');
  if(!Number.isInteger(peerOutputTokens)||peerOutputTokens<1024||peerOutputTokens>32768)throw Error('peer output tokens must be 1024..32768');
  if(typeof verificationWorkspaceReadOnly!=='boolean'||typeof terminalClosure!=='boolean')throw Error('verification and closure options must be boolean');
  if(arm.startsWith('claude-'))return {exe:process.execPath,args:[path.join(ROOT,'scripts/claude-fight-cli.mjs'),
    '--workspace',workspace,'--output',path.join(dir,'native'),'--task-file',path.join(dir,'task.md'),
    '--model',arm.slice('claude-'.length),'--timeout-seconds',String(Math.ceil(timeoutMs/1000))],env:{}};
  if(['deepseek-local-27b','opencode','hermes'].includes(arm)) {
    return {exe:process.execPath,args:[path.join(ROOT,'scripts',arm==='deepseek-local-27b'?'deepseek-fight-cli.mjs':'peer-fight-cli.mjs'),
      ...(arm==='deepseek-local-27b'?[]:['--arm',arm]),'--workspace',workspace,'--task-file',path.join(dir,'task.md'),
      '--output',path.join(dir,'native'),'--endpoint',endpoint,'--model',model,'--timeout-seconds',String(Math.ceil(timeoutMs/1000)),
      '--max-output-tokens',String(peerOutputTokens),
      ...(peerExecutables[arm==='deepseek-local-27b'?'deepseek':arm]?['--executable',peerExecutables[arm==='deepseek-local-27b'?'deepseek':arm].executable,'--executable-sha256',peerExecutables[arm==='deepseek-local-27b'?'deepseek':arm].sha256]:[])],env:{}};
  }
  const nativeModel=NATIVE_CODEX_MODELS[arm];
  const command=cardCommand(nativeModel?'codex-astra':arm,task,workspace,dir);
  command.env={...command.env,ASTRA_CONTAINER_SESSION_DIR:path.join(dir,'native-sessions')};
  if(nativeModel){
    command.args=command.args.filter(a=>a!=='--ephemeral');
    command.args[command.args.indexOf('--model')+1]=nativeModel;
  }
  else {
    command.args.push('--context-mode','extension','--factory','--factory-home',path.join(dir,'factory'));
    command.env={...command.env,BANTAM_SAVE_PROMPTS:'1',BANTAM_PROBE:probeEnabled?'1':'0',BANTAM_STREAM:'1',
      BANTAM_TEACHER:'0',BANTAM_DEEPRESEARCH:'0',BANTAM_PROMPT_TRAJECTORY:'extension',BANTAM_IMMUTABLE_HISTORY:'1'};
    if(arm==='bantam-local-27b'){
      command.args[command.args.indexOf('--endpoint')+1]=endpoint;command.env.BANTAM_ENDPOINT=endpoint;
      // The inspected window, so history eviction follows the served context
      // instead of a constant. Only this lane uses the inspected local server.
      if(Number.isInteger(contextTokens)&&contextTokens>0)command.env.BANTAM_CONTEXT_TOKENS=String(contextTokens);
    }
    if(verificationWorkspaceReadOnly){command.args.push('--verify-workspace-read-only');command.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY='1';}
    if(terminalClosure)command.env.BANTAM_TERMINAL_CLOSURE='1';
  }
  return command;
}

export function parseGrade(stdout,card,expectedGroups) {
  const objects=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const record=objects.findLast(row=>row?.schema==='bantam.factory-card-grade.v1'&&row.card===card);
  if(!record||!Array.isArray(record.groups)||typeof record.pass!=='boolean')return null;
  if(record.groups.length!==expectedGroups.length||record.groups.some((g,i)=>g?.name!==expectedGroups[i]||typeof g.pass!=='boolean'))return null;
  if(record.pass!==record.groups.every(g=>g.pass))return null;
  return record;
}

export async function inspectLocalModel(endpoint,{requireIdle=true}={}) {
  const result={};
  for(const route of ['health','v1/models','props','slots']) {
    const response=await fetch(`${endpoint.replace(/\/$/,'')}/${route}`,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error(`local ${route} returned ${response.status}`);
    result[route]=await response.json();
  }
  if(requireIdle&&result.slots.some(slot=>slot.is_processing))throw Error('local model is already processing a request; do not compete for its slot');
  result.id=result['v1/models'].data?.[0]?.id;
  if(!result.id)throw Error('local model identity missing');
  return result;
}

// Supplemental global counters must not erase a finished contender's receipts
// when the inference server dies. Own-wire usage remains separate authority;
// the next contender still requires the ordinary live identity/idle check.
export async function optionalServerCounters(endpoint) {
  try{return await serverCounters(endpoint);}
  catch(error){return {at:new Date().toISOString(),unavailable:true,error:String(error?.message??error)};}
}

export async function executeContender(command,options) {
  try{return await execute(command,options);}
  finally{
    // The adapter may be SIGKILLed at the outer deadline before its finally.
    // Stop ONLY the daemon-owned container identified by this run's receipt.
    const receipt=path.join(options.dir,'native','container.cid');
    let id=null;
    try{const s=fs.lstatSync(receipt);if(!s.isFile()||s.isSymbolicLink())throw Error('invalid container receipt');id=fs.readFileSync(receipt,'utf8').trim();}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(id!==null){
      if(!/^[a-f0-9]{64}$/.test(id))throw Error('malformed owned container ID');
      const stop=await runProcess('docker',['stop','--time','1',id],{timeoutMs:10000});
      write(path.join(options.dir,'operator-container-cleanup.json'),{schema:'bantam.fight-container-cleanup.v1',
        at:new Date().toISOString(),containerId:id,receipt:'native/container.cid',code:stop.code,
        stdout:stop.stdout,stderr:stop.stderr,confirmed:stop.code===0||/No such container/i.test(stop.stderr)});
      if(stop.code!==0&&!/No such container/i.test(stop.stderr))throw Error(`cannot confirm native container stopped: ${id}`);
    }
  }
}

const EXECUTION_SCRIPTS=['factory-fights.mjs','factory-card-catalog.mjs','fight-model-proxy.mjs','fight-usage.mjs','repobrief-astra-fights.mjs','astra-container-cli.mjs','deepseek-fight-cli.mjs','peer-fight-cli.mjs','claude-fight-cli.mjs'];
function sourceSeal() {return Object.fromEntries([
  ...['src','bin'].flatMap(part=>Object.entries(treeHashes(path.join(ROOT,part))).map(([p,h])=>[`${part}/${p}`,h])),
  ...EXECUTION_SCRIPTS.map(file=>[`scripts/${file}`,sha(fs.readFileSync(path.join(ROOT,'scripts',file)))]),
]);}
function exactSeal(before,dir){return JSON.stringify(before)===JSON.stringify(treeHashes(dir));}

export async function gradeFactoryFight(workspace,card,{kitId=DEFAULT_KIT_ID,run=runShellProcess}={}) {
  const selected=factoryKit(kitId);
  if(!selected.cards.includes(card)||!path.isAbsolute(workspace))throw Error('invalid grading workspace/card');
  const kit=path.join(selected.root,card);
  const descriptor=JSON.parse(fs.readFileSync(path.join(kit,'card.json'),'utf8'));
  const files=[path.join(selected.root,'grader-support.mjs'),...Object.keys(treeHashes(kit)).filter(p=>!p.startsWith('starter/')&&!p.startsWith('reviewer/')).map(p=>path.join(kit,p))];
  const publicStart=Date.now();
  const publicResult=await run(workspace,'npm test',{shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:60000});
  const publicWallMs=Date.now()-publicStart,hiddenStart=Date.now();
  const hidden=await run(workspace,`node ${quote(path.join(kit,'grader.mjs'))} ${quote(workspace)}`,{
    shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,readOnlyHostFiles:files,timeoutMs:60000});
  const hiddenWallMs=Date.now()-hiddenStart;
  return {publicResult,hidden,record:parseGrade(hidden.stdout,card,descriptor.groups),
    timing:{publicWallMs,hiddenWallMs,totalWallMs:publicWallMs+hiddenWallMs}};
}

function markdown(manifest) {
  const rows=manifest.results.map(r=>`| ${r.card} | ${r.arm} | ${r.outcome} | ${r.grade?.groups.filter(g=>g.pass).length ?? '—'}/${r.grade?.groups.length ?? '—'} | ${(r.wallMs/1000).toFixed(1)} | ${r.usage?.inputTokens ?? '—'} | ${r.usage?.freshInputTokens ?? '—'} | ${r.usage?.outputTokens ?? '—'} |`);
  return '# Fresh factory fight cards\n\n'+manifest.design+'\n\n| Card | Contender | Outcome | Groups | Seconds | Input | Fresh input | Output |\n|---|---|---|---:|---:|---:|---:|---:|\n'+rows.join('\n')+'\n\nUnknown token totals are not zero. Candidate acceptance and run completion are retained separately in manifest.json. No failed candidate was repaired by the operator.\n';
}

export async function runFactoryFights({output,endpoint='http://127.0.0.1:8085',arms=DEFAULT_FIGHT_ARMS,cards,kitId=DEFAULT_KIT_ID,repetitions=1,timeoutMs=600000,probeEnabled=true,peerOutputTokens=8192,parallelQueues=true,verificationWorkspaceReadOnly=false,terminalClosure=false,peerExecutables={},peerReadiness=null,codexReadiness=null,deepseekReadiness=null}={}, {inspect=inspectLocalModel,contender=executeContender,grade=gradeFactoryFight,settle=settleServerCounters,onProgress=()=>{}}={}) {
  if(!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('requires a fresh absolute output directory');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('deadline must be 1..600 seconds');
  if(!Number.isInteger(peerOutputTokens)||peerOutputTokens<1024||peerOutputTokens>32768)throw Error('peer output tokens must be 1024..32768');
  if(typeof verificationWorkspaceReadOnly!=='boolean'||typeof terminalClosure!=='boolean')throw Error('verification and closure options must be boolean');
  const selectedKit=factoryKit(kitId),kitRoot=selectedKit.root;if(cards===undefined)cards=selectedKit.cards;
  const plan=fightPlan({arms,cards,kitId,repetitions});
  if(!peerExecutables||typeof peerExecutables!=='object'||Array.isArray(peerExecutables))throw Error('invalid peer executable selections');
  for(const [name,record]of Object.entries(peerExecutables)){
    if(!['hermes','opencode','deepseek'].includes(name)||!arms.includes(name==='deepseek'?'deepseek-local-27b':name))throw Error('unsupported or unselected peer executable');
    verifyCompetitorRegistration(record);
  }
  const needsLocal=arms.some(arm=>LOCAL.has(arm));
  const model=needsLocal?await inspect(endpoint):null;
  const rawContext=model?.props?.default_generation_settings?.n_ctx;
  const localContextTokens=Number.isInteger(rawContext)&&rawContext>0?rawContext:null;
  const kitSeal=treeHashes(kitRoot),runtimeSeal=sourceSeal();
  for(const card of cards){const meta=JSON.parse(fs.readFileSync(path.join(kitRoot,card,'card.json'),'utf8'));if(meta.id!==card||!Array.isArray(meta.groups)||!meta.groups.length)throw Error('invalid card descriptor');}
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  write(path.join(output,'local-model.json'),model);
  const manifest={schema:'bantam.factory-fights.v1',kitId,startedAt:new Date().toISOString(),
    presentation:{selectedParticipantsOnly:true},
    design:`Exploratory system regression/demo on the frozen ${kitId} kit: fresh contender workspaces on already-seen adaptive development tasks, identical starter/task bytes per contender, rotated order within queues. No teacher or manual repairs. Native sampling/tool/resource differences are recorded, not a pure context ablation or held-out evaluation. One repeat is not a statistical ranking. Historical cards remain unchanged.`,
    baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    sourceSeal:runtimeSeal,kitSeal,modelId:model?.id??null,modelFileSha256:null,endpoint:needsLocal?endpoint:null,
    limits:{wallMs:timeoutMs,bantamTurns:60+(terminalClosure?1:0),bantamWorkTurns:60,terminalClosureAllowance:terminalClosure?1:0,peerDeclaredContext:65536,peerDeclaredOutput:peerOutputTokens,
      localContextTokens,bantamHistoryCharBudget:localContextTokens===null?null:historyCharBudget({contextTokens:localContextTokens,extensionTrajectory:true})},
    configuration:{bantamContext:'extension/immutable',probeEnabled,teacher:false,
      codexModel:!arms.some(a=>a.includes('codex'))||arms.some(a=>a==='codex-sol'||a==='codex-terra')?null:'gpt-6-astra',codexEffort:'medium',
      codexModels:Object.fromEntries(arms.filter(a=>a.includes('codex')).map(a=>[a,NATIVE_CODEX_MODELS[a]??'gpt-6-astra'])),
      claudeModels:Object.fromEntries(arms.filter(a=>a.startsWith('claude-')).map(a=>[a,{alias:a.slice('claude-'.length),effort:'medium'}])),
      verificationWorkspaceReadOnly,terminalClosure,peerExecutables,peerReadiness,codexReadiness,deepseekReadiness,
      executionSchedule:parallelQueues?'One serial local queue and one serial frontier queue overlap. No two local inference runs overlap; CPU/IO contention with frontier tools remains possible.':'All contenders run serially.',
      sampling:'native configured values, retained in local wire requests',
      outputPolicy:'BANTAM separates up-to-4096 reasoning and up-to-8192 action requests; peers share their declared output allowance between reasoning and action. Native input reservation/compaction may depend on the declared output allowance.',
      cache:'shared warm server, no server restart or KV erase; prior-run prefix carryover possible',
      isolation:'BANTAM project commands in offline Docker; peer agents in disposable Docker. Local peers use host networking solely configured for the loopback model; this is not enforced network egress confinement. Codex requires provider network and readonly mounted saved CLI authentication. No hidden grader is mounted during generation.',
      evidence:'All local HTTP bodies recorded without Authorization headers; BANTAM run/checkpoint/factory evidence; native Codex session rollouts; peer native records. No claim to capture provider-side hidden context.'},plan,results:[]};
  const modelFile=model?.props?.model_path;
  if(modelFile&&path.isAbsolute(modelFile)&&fs.existsSync(modelFile)&&fs.statSync(modelFile).isFile()){
    const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(modelFile))hash.update(chunk);manifest.modelFileSha256=hash.digest('hex');
  }
  const save=()=>{write(path.join(output,'manifest.json'),manifest);fs.writeFileSync(path.join(output,'RESULTS.md'),markdown(manifest));};
  save();
  const active=new Map();
  const publish=()=>{
    const snapshot=projectFightProgress(manifest,active);
    const temporary=path.join(output,'progress.json.tmp');write(temporary,snapshot);fs.renameSync(temporary,path.join(output,'progress.json'));
    try{onProgress(snapshot);}catch{/* An observer cannot change a contender's result. */}
  };
  publish();
  const progressTimer=setInterval(()=>{try{publish();}catch{/* Final publication below reports persistence failures. */}},1000);
  const runQueue=async(queue)=>{for(const item of queue){
    if(fs.existsSync(path.join(output,'STOP_AFTER_CURRENT'))){manifest.stoppedEarly='Operator requested stop at a clean contender boundary; no active run was interrupted.';break;}
    if(JSON.stringify(sourceSeal())!==JSON.stringify(runtimeSeal)||!exactSeal(kitSeal,kitRoot))throw Error('source or kit changed after freeze');
    if(LOCAL.has(item.arm)){
      const current=await inspect(endpoint);
      if(current.id!==model.id||JSON.stringify(current.props.build_info)!==JSON.stringify(model.props.build_info)||current.props.default_generation_settings.n_ctx!==model.props.default_generation_settings.n_ctx)throw Error('local server identity/settings changed');
    }
    const {card,arm,repeat}=item,kit=path.join(kitRoot,card),dir=path.join(output,`repeat-${repeat}`,card,arm),workspace=path.join(dir,'ws');
    fs.mkdirSync(dir,{recursive:true});fs.cpSync(path.join(kit,'starter'),workspace,{recursive:true,dereference:false});
    const materials=treeHashes(path.join(kit,'starter'));
    if(!exactSeal(materials,workspace))throw Error('starter copy mismatch');
    const task=fs.readFileSync(path.join(kit,'task.md'),'utf8');fs.writeFileSync(path.join(dir,'task.md'),task);
    fs.mkdirSync(path.join(dir,'native-sessions'));
    const recorder=LOCAL.has(arm)?await startModelRecorder({upstream:endpoint,output:path.join(dir,'wire')}):null;
    const countersBefore=recorder?await optionalServerCounters(endpoint):null;
    const command=freshCommand({arm,task,workspace,dir,endpoint:recorder?.endpoint??endpoint,model:model?.id,contextTokens:localContextTokens,timeoutMs,probeEnabled,peerOutputTokens,verificationWorkspaceReadOnly,terminalClosure,peerExecutables});
    write(path.join(dir,'command.json'),command);
    process.stdout.write(`${card} ${arm}: started\n`);
    const current={phase:'running',startedAt:Date.now(),exchanges:recorder?.exchanges};active.set(progressKey(item),current);publish();
    let result,wireUsage;
    try {result=await contender(command,{cwd:workspace,env:cleanFightEnv({...command.env,PWD:workspace}),dir,timeoutMs,events:[],arm});}
    finally {wireUsage=recorder?await recorder.close():null;}
    current.workElapsedMs=result?.wallMs;current.phase='settling';publish();
    const settlement=recorder?await settle(endpoint):null;
    const countersAfter=settlement?.after??null;
    const serverUsage=recorder?counterDelta(countersBefore,countersAfter):null;
    if(recorder)write(path.join(dir,'server-usage.json'),{before:countersBefore,after:countersAfter,delta:serverUsage,settlement});
    if(JSON.stringify(sourceSeal())!==JSON.stringify(runtimeSeal)||!exactSeal(kitSeal,kitRoot))throw Error('source or grader changed during contender run; no score issued');
    const tampered=changedSealedFiles(Object.fromEntries(Object.entries(materials).filter(([p])=>p==='package.json'||p.startsWith('test/'))),workspace);
    current.phase='grading';publish();
    const grading=await grade(workspace,card,{kitId});
    for(const [label,record] of [['public',grading.publicResult],['hidden',grading.hidden]]){
      fs.writeFileSync(path.join(dir,`${label}.stdout.log`),record.stdout);fs.writeFileSync(path.join(dir,`${label}.stderr.log`),record.stderr);
    }
    let saved=null;try{saved=JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'));}catch{}
    let native=null;try{native=JSON.parse(fs.readFileSync(path.join(dir,'native/result.json'),'utf8'));}catch{}
    let nativeLaunch=null;try{nativeLaunch=JSON.parse(fs.readFileSync(path.join(dir,'native/launch.json'),'utf8'));}catch{}
    const acceptedCompletion=arm.startsWith('bantam')?acceptedBantamCompletion(saved):null;
    const clean=r=>r.code===0&&!r.timedOut&&!r.aborted&&!r.bufferExceeded;
    const candidatePass=!tampered.length&&clean(grading.publicResult)&&clean(grading.hidden)&&grading.record?.pass===true;
    const processCompleted=clean(result)&&acceptedCompletion!==false;
    const nativeResponseUsage=NATIVE_CODEX_MODELS[arm]?codexSessionUsage(path.join(dir,'native-sessions')):null;
    const cliUsage=arm.startsWith('claude-')?claudeStreamUsage(result.stdout):cornerUsage(arm,{armDir:dir,rawLines:result.stdout.split('\n')});
    const usage=wireUsage??nativeResponseUsage??cliUsage;
    if(usage&&usage.freshInputTokens==null&&usage.inputTokens!=null&&usage.cacheHitTokens!=null)usage.freshInputTokens=usage.inputTokens-usage.cacheHitTokens;
    const noModelRequest=LOCAL.has(arm)&&wireUsage.requests===0;
    const outcome=noModelRequest?'SETUP_ERROR':candidatePass?(processCompleted?'PASS':'OUTPUT_ONLY'):result.timedOut?'TIMEOUT':'FAIL';
    const row={...item,outcome,pass:outcome==='PASS',candidatePass,processCompleted,acceptedCompletion,
      wallMs:result.wallMs,startedAt:result.startedAt,exitCode:result.code,timedOut:result.timedOut,aborted:result.aborted,bufferExceeded:result.bufferExceeded,
      taskSha256:sha(task),materialSeal:materials,tampered,grade:grading.record,
      publicExit:grading.publicResult.code,hiddenExit:grading.hidden.code,graderTimedOut:grading.publicResult.timedOut||grading.hidden.timedOut,
      gradingTiming:grading.timing,contenderPlusGradingWallMs:result.wallMs+grading.timing.totalWallMs,
      usage,serverUsage,nativeMetadata:native,nativeLaunch,nativeUsage:cliUsage,
      finalFiles:treeHashes(workspace,{excludeGenerated:true}),operatorInterventions:0};
    if(JSON.stringify(sourceSeal())!==JSON.stringify(runtimeSeal)||!exactSeal(kitSeal,kitRoot))throw Error('source or grader changed during judging; no score issued');
    write(path.join(dir,'result.json'),row);manifest.results.push(row);active.delete(progressKey(item));save();publish();
    process.stdout.write(`${manifest.results.length}/${plan.length} ${card} ${arm}: ${outcome}, ${(row.wallMs/1000).toFixed(1)}s, ${row.grade?.groups.filter(g=>g.pass).length??0}/${row.grade?.groups.length??0} groups\n`);
    if(settlement?.observedBusy&&!settlement.settled){
      manifest.stoppedEarly='Local queue stopped: endpoint remained unsettled after contender cleanup; see server-usage.json. No following local contender was launched.';
      save();process.stdout.write(manifest.stoppedEarly+'\n');break;
    }
  }};
  try{
    if(parallelQueues){
      const queues=await Promise.allSettled([runQueue(plan.filter(item=>LOCAL.has(item.arm))),runQueue(plan.filter(item=>!LOCAL.has(item.arm)))]);
      const failed=queues.find(q=>q.status==='rejected');if(failed)throw failed.reason;
    }else await runQueue(plan);
  }catch(error){manifest.error={at:new Date().toISOString(),message:error.message};manifest.finishedAt=new Date().toISOString();manifest.complete=false;save();throw error;}
  finally{clearInterval(progressTimer);publish();}
  manifest.finishedAt=new Date().toISOString();manifest.complete=manifest.results.length===plan.length;
  manifest.sourceMismatches=changedSealedFiles(runtimeSeal,ROOT);manifest.kitMismatches=changedSealedFiles(kitSeal,kitRoot);save();
  publish();process.stdout.write(`Evidence: ${output}\n`);return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
  runFactoryFights({output:args[0],...(value('--arms')?{arms:value('--arms').split(',')}:{}),
    ...(value('--endpoint')?{endpoint:value('--endpoint')}:{}),
    ...(value('--kit')?{kitId:value('--kit')}:{}),
    ...(value('--cards')?{cards:value('--cards').split(',')}:{}),...(value('--repetitions')?{repetitions:Number(value('--repetitions'))}:{}),
    ...(value('--timeout-seconds')?{timeoutMs:Number(value('--timeout-seconds'))*1000}:{}),
    ...(value('--peer-output-tokens')?{peerOutputTokens:Number(value('--peer-output-tokens'))}:{}),
    parallelQueues:!args.includes('--serial'),probeEnabled:!args.includes('--no-probe'),
    verificationWorkspaceReadOnly:args.includes('--verify-workspace-read-only'),terminalClosure:args.includes('--terminal-closure')})
    .catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
}
