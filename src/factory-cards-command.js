import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FACTORY_KITS,PUBLIC_FACTORY_CARDS,factoryKit} from '../scripts/factory-card-catalog.mjs';
import {FIGHT_ARMS,fightPlan,runFactoryFights} from '../scripts/factory-fights.mjs';
import {writeFactoryReplay} from '../scripts/factory-fight-replay.mjs';
import {writeFightCardExport} from '../scripts/factory-fight-export.mjs';
import {writeShowcase} from '../scripts/factory-showcase.mjs';
import {loadConnection,discoverModelServers} from './first-run.js';
import {readCompetitorRegistry,registerCompetitor,executablePath,executableDigest,verifyCompetitorRegistration} from './competitor-registry.js';
import {checkPeerReadiness,readinessLocation} from './peer-readiness.js';
import {checkCodexReadiness} from './codex-readiness.js';
import {checkClaudeReadiness} from './claude-readiness.js';
import {nonRootIdentity} from './linux-peer-runtime.js';
import {checkDeepseekReadiness} from './deepseek-readiness.js';
import {startLiveFight,renderLiveFight} from './factory-card-live.js';

const LOCAL=new Set(['bantam-local-27b','hermes','opencode','deepseek-local-27b']);
export const CARDS_HELP=`BANTAM FACTORY · fight cards

bantamfactory cards                 Guided, explicitly approved comparison
bantamfactory cards --list          List frozen tasks and installed participants
bantamfactory cards --register hermes --path /path/to/installation-or-executable
bantamfactory cards --register opencode --path /path/to/installation-or-executable
bantamfactory cards --register deepseek --path /path/to/dsh-or-npm-installation
bantamfactory cards --check --arms hermes,opencode --yes  Offline runtime checks; no model requests
bantamfactory cards --check --arms codex-astra --yes     Offline Codex check; dummy credentials
bantamfactory cards --check --arms deepseek-local-27b --yes  Offline DeepSeek runtime check
bantamfactory cards --replay DIR    Rebuild replay/export from saved evidence; no inference
bantamfactory cards --card context-packet --arms bantam-local-27b,hermes --dry-run
bantamfactory cards --card context-packet --arms bantam-local-27b,opencode --endpoint http://127.0.0.1:8085 --yes

Options: --kit ID (default factory-2026-09-07), --card ID|all, --arms ID,...,
         --endpoint URL, --out NEW-DIRECTORY, --timeout-seconds 1..600,
         --repetitions 1..3, --serial, --list, --replay DIR, --check, --dry-run, --yes, --help
         --public (also generate an allowlisted public summary; never upload)
         --live (token-protected loopback viewer; saves live-public.html when finished)
         --peer-output-tokens 1024..32768 (default 8192; native local peers)
         --register hermes|opencode|deepseek --path PATH (save location only; no execution)

No rival installations, model downloads, cloud requests or uploads occur from
listing or planning. Execution requires Docker and the selected runtimes.
Local lanes currently require a loopback llama.cpp server with /props and /slots.
Cloud-only cards do not require a local server. Select cloud participants
explicitly: task context goes to the provider and consumes account access/quota.
Claude Code is never selected automatically. Select claude-sonnet, claude-opus or claude-fable
explicitly for an isolated native CLI comparison (Linux x64 standalone install,
file-backed authentication). Generic agent APIs are not model APIs.
`;

export function findCardExecutable(name,{env=process.env}={}){
 for(const directory of (env.PATH??'').split(path.delimiter)){
  const file=path.resolve(directory||'.',name);
  try{if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file;}}catch{}
 }
 return null;
}
export function findCardImage(image,{exec=execFileSync}={}){
 try{
  const id=exec('docker',['image','inspect','--format','{{.Id}}',image],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1500}).trim();
  return /^sha256:[a-f0-9]{64}$/.test(id)?id:null;
 }catch{return null;}
}
export function discoverCardParticipants({find=findCardExecutable,registrations={},inspectImages=false,inspectImage=findCardImage}={}){
 return FIGHT_ARMS.map(id=>{
  if(id==='deepseek-local-27b'){
   const registration=registrations.deepseek;
   let executable=registration?.executable??find('dsh');
   if(executable){try{executable=executablePath(executable);}catch{executable=null;}}
   if(registration||executable)return {id,pool:'local',executable,installed:Boolean(executable),...(registration?{registration}:{}),
    detail:executable?`${executable} (installed npm adapter; offline qualification required)`:'Registered DeepSeek executable unavailable; register its updated path. No image fallback.'};
   const image='bantam/deepseek-fight:0.1.2-rc.1',imageId=inspectImages?inspectImage(image):null;
   return {id,pool:'local',executable:null,installed:Boolean(imageId),imageId,
    detail:imageId?`Prepared adapter image detected: ${image} (${imageId}); runtime not yet qualified`:
     inspectImages?`Prepared adapter image unavailable or Docker inaccessible: ${image}; nothing installed`:
      `Prepared adapter image prerequisite checked before execution: ${image}`};
  }
  const command=id==='hermes'?'hermes':id==='opencode'?'opencode':id.includes('codex')?'codex':id.startsWith('claude-')?'claude':null;
  const registration=registrations[id];let executable=command?find(command):null,problem=null;
  if(registration){
   try{executablePath(registration.executable);executable=registration.executable;}
   catch{executable=null;problem='Registered executable missing/unreadable; register its updated path.';}
  }
  return {id,pool:LOCAL.has(id)?'local':'cloud',executable,
   installed:command?Boolean(executable):id==='bantam-local-27b',...(registration?{registration}:{}),
   detail:id==='bantam-local-27b'?'This checkout; your selected llama.cpp server':
    id==='deepseek-local-27b'?'Requires separately prepared bantam/deepseek-fight:0.1.2-rc.1 Docker image':
    problem??(executable?`${executable}${registration?' (registered; identity checked before execution)':''}`:`${command} not on PATH (no automatic installation)`)};
 });
}
export function normalizeCardEndpoint(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['/','/v1','/v1/'].includes(url.pathname)){
  throw Error('These recorded local cards require a credential-free loopback llama.cpp origin. Remote/general APIs remain usable by BANTAM setup, but need a separate recorded-card adapter.');
 }
 return url.origin;
}
export function makeCardsPlan(args,{cwd=process.cwd(),now=()=>new Date(),connection=loadConnection(),registrations={}}={}){
 const kitId=args.kit??'factory-2026-09-07',kit=factoryKit(kitId);
 const card=args.card??kit.cards[0],cards=card==='all'?[...kit.cards]:[card],arms=typeof args.arms==='string'?args.arms.split(',').map(a=>a.trim()):['bantam-local-27b'];
 const repetitions=Number(args.repetitions??1),timeoutMs=Number(args['timeout-seconds']??600)*1000;
 const peerOutputTokens=Number(args['peer-output-tokens']??8192);
 if(!Number.isInteger(peerOutputTokens)||peerOutputTokens<1024||peerOutputTokens>32768)throw Error('peer-output-tokens must be 1024..32768');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('timeout-seconds must be 1..600');
 fightPlan({kitId,cards,arms,repetitions});
 const endpoint=arms.some(a=>LOCAL.has(a))?normalizeCardEndpoint(args.endpoint??(connection?.kind==='api'&&connection.dialect==='llamacpp'?connection.apiUrl:'http://127.0.0.1:8085')):null;
 const output=path.resolve(cwd,args.out??path.join('.bantam','fight-cards',now().toISOString().replace(/[:.]/g,'-')));
 if(fs.existsSync(output))throw Error('Choose a new output directory; existing evidence is never overwritten.');
 const peerExecutables=Object.fromEntries(Object.entries(registrations).filter(([name])=>arms.includes(name==='deepseek'?'deepseek-local-27b':name)).map(([name,r])=>[name,{executable:r.executable,sha256:r.sha256}]));
 return {kitId,cards,arms,repetitions,timeoutMs,output,endpoint,parallelQueues:!args.serial,peerOutputTokens,...(Object.keys(peerExecutables).length?{peerExecutables}:{})};
}
export function preflightCards(plan,{exec=execFileSync,participants=discoverCardParticipants()}={}){
 const check=(exe,args,label)=>{try{exec(exe,args,{stdio:'ignore',timeout:5000});}catch{throw Error(`${label}. Nothing has been installed; fix this prerequisite and retry.`);}};
 const missing=plan.arms.filter(id=>!id.startsWith('deepseek')&&!participants.find(p=>p.id===id)?.installed);
 if(missing.length)throw Error(`Selected participants not installed/on PATH: ${missing.join(', ')}. Nothing was launched.`);
 for(const registration of Object.values(plan.peerExecutables??{}))verifyCompetitorRegistration(registration);
 check('docker',['info'],'Docker is unavailable');
 for(const image of new Set(['alpine:3',...(plan.arms.some(a=>a!=='bantam-local-27b')?['ubuntu:24.04']:[]),...(plan.arms.includes('deepseek-local-27b')&&!plan.peerExecutables?.deepseek?['bantam/deepseek-fight:0.1.2-rc.1']:[])])){
  check('docker',['image','inspect',image],`Required Docker image missing: ${image}`);
 }
 if(plan.arms.some(a=>a.includes('codex'))){
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('The isolated Codex card runtime currently requires Linux x64.');
  nonRootIdentity();
 }
}
export async function factoryCardsCommand(args,{ask,out=s=>process.stdout.write(s),interactive=Boolean(process.stdin.isTTY&&process.stderr.isTTY),
 discover=discoverCardParticipants,findExecutable=findCardExecutable,servers=discoverModelServers,connection=loadConnection(),
 registry=readCompetitorRegistry,register=registerCompetitor,
 preflight=preflightCards,run=runFactoryFights,exportCard=writeFightCardExport,replay=writeFactoryReplay,checkPeers=checkPeerReadiness,checkCodex=checkCodexReadiness,checkDeepseek=checkDeepseekReadiness,showcase=writeShowcase,startLive=startLiveFight}={}){
 const allowed=new Set(['_','help','list','replay','dry-run','yes','kit','card','arms','endpoint','out','timeout-seconds','repetitions','serial','register','path','check','public','live','peer-output-tokens']);
 for(const key of Object.keys(args))if(!allowed.has(key))throw Error(`Unknown cards option: --${key}`);
 if(args.help){out(CARDS_HELP);return 0;}
 if(args.register!==undefined||args.path!==undefined){
  if(typeof args.register!=='string'||typeof args.path!=='string'||Object.keys(args).some(k=>!['_','register','path'].includes(k)))throw Error('Use --register hermes|opencode|deepseek --path PATH, without run options.');
  const entry=register(args.register,args.path);
  out(`Registered ${args.register}: ${entry.executable}\nSHA-256: ${entry.sha256}\nNo harness was executed, account authorized, or software installed. Run cards to select a comparison.\n`);return 0;
 }
 if(args.replay!==undefined){
  if(typeof args.replay!=='string'||Object.keys(args).some(k=>!['_','replay'].includes(k)))throw Error('--replay requires an evidence directory and cannot be mixed with execution options.');
  const root=path.resolve(args.replay);
  try{exportCard(root);}
  finally{const rendered=replay(root);out(`Private replay: ${rendered.output}\nExisting contender evidence was not rerun. Inspect before sharing.\n`);}
  return 0;
 }
 const registrations=registry().tools;
 const participants=discover({registrations,inspectImages:Boolean(args.list||(interactive&&!args['dry-run']))});
 const detectedDeepseek=participants.find(p=>p.id==='deepseek-local-27b')?.executable;
 if(!registrations.deepseek&&detectedDeepseek)registrations.deepseek={executable:detectedDeepseek,sha256:executableDigest(detectedDeepseek)};
 const list=()=>{
  out('\nBANTAM FACTORY · frozen work orders\n');
  for(const [kit,cards]of Object.entries(FACTORY_KITS))for(const id of cards)out(`  ${kit} / ${id} — ${PUBLIC_FACTORY_CARDS[id]?.description??id}\n`);
  out('\nParticipants (installation discovery only, not a readiness certificate)\n');
  participants.forEach(p=>out(`  ${p.id} [${p.pool}] ${p.installed?'detected':'needs setup'} · ${p.detail}\n`));
  const claude=findExecutable('claude');
  out(`  Claude Code: ${claude?`detected · ${claude}`:'not found on PATH'}; explicit direct agent comparison only; see --help. Never auto-invoked.\n`);
 };
 if(args.list){list();return 0;}
 if(args.check){
  if(typeof args.arms!=='string'||Object.keys(args).some(k=>!['_','check','arms','out','yes','dry-run'].includes(k)))throw Error('Use --check --arms hermes,opencode [--out NEW-DIRECTORY] [--yes|--dry-run].');
  const arms=args.arms.split(',').map(a=>a.trim());
  if(!arms.length||arms.some(a=>!FIGHT_ARMS.includes(a)||a==='bantam-local-27b')||new Set(arms).size!==arms.length)throw Error('--check supports selected Hermes/OpenCode/DeepSeek/Codex/Claude runtimes only.');
  const peerExecutables=Object.fromEntries(Object.entries(registrations).filter(([name])=>arms.includes(name==='deepseek'?'deepseek-local-27b':name)));
  const output=args.out?path.resolve(args.out):readinessLocation(path.resolve('.bantam/fight-cards/offline-check'));
  out(`Offline runtime checks: ${arms.join(', ')}\nEvidence: ${output}\nNo model inference, cloud login, downloads or publication. Installed program code will execute in network-disabled containers.\n`);
  if(args['dry-run'])return 0;
  if(!args.yes){
   if(!interactive)throw Error('Noninteractive --check requires --yes, or use --dry-run.');
   const approved=/^y(es)?$/i.test((await ask('Run these installed tools offline? [y/N] ')).trim());
   if(!approved){out('Cancelled; no installed tools executed.\n');return 0;}
  }
  if(fs.existsSync(output))throw Error('Choose a fresh readiness evidence directory.');
  preflight({arms,peerExecutables},{participants});
  const peers=arms.filter(a=>['hermes','opencode'].includes(a)),codex=arms.some(a=>a.includes('codex'));
  const deepseek=arms.includes('deepseek-local-27b'),claude=arms.some(a=>a.startsWith('claude-')),mixed=Number(peers.length>0)+Number(codex)+Number(deepseek)+Number(claude)>1;
  if(peers.length)await checkPeers({arms:peers,peerExecutables,output:mixed?path.join(output,'peers'):output});
  if(codex)await checkCodex({output:mixed?path.join(output,'codex'):output});
  if(claude)await checkClaudeReadiness({output:mixed?path.join(output,'claude'):output});
  if(deepseek)await checkDeepseek({output:mixed?path.join(output,'deepseek'):output,registration:peerExecutables.deepseek});
  out('Offline readiness passed. This is not a coding score or token-accounting qualification.\n');return 0;
 }
 const selected={...args};
 if(interactive&&!args['dry-run']&&!args.yes){
  list();
  if(!selected.card)selected.card=(await ask('Card [context-packet]: ')).trim()||'context-packet';
  if(!selected.arms)selected.arms=(await ask('Participant IDs, comma-separated [bantam-local-27b]: ')).trim()||'bantam-local-27b';
  if(selected.arms.split(',').some(a=>LOCAL.has(a.trim()))&&!selected.endpoint){
   const found=await servers();found.forEach(s=>out(`  Found ${s.apiUrl} · ${s.models.join(', ')}\n`));
   const suggested=connection?.kind==='api'&&connection.dialect==='llamacpp'?connection.apiUrl:found[0]?.apiUrl??'http://127.0.0.1:8085';
   selected.endpoint=(await ask(`llama.cpp URL [${suggested}]: `)).trim()||suggested;
  }
 }
 const plan=makeCardsPlan(selected,{connection,registrations});
 out('\nPlanned comparison (no work launched yet):\n'+JSON.stringify(plan,null,2)+'\n');
 if(args['dry-run'])return 0;
 if(args.public)out('A sanitized public summary will also be generated locally. Raw evidence stays private; no publication is authorized.\n');
 out('Fresh isolated workspaces; no changes to your current project. All failures remain recorded.\nRaw task/source/model transcripts remain private locally; inspect before sharing. No automatic uploads.\n');
 if(plan.arms.some(a=>a.includes('codex')))out('Codex participants send task/context to OpenAI using your signed-in Codex account and consume its quota/access.\n');
 if(plan.arms.some(a=>a.startsWith('claude-')))out('Claude participants send task/context to Anthropic using your existing file-backed Claude account and consume its quota/access. No login, download or host configuration change is performed.\n');
 if(args.yes){
  if(typeof args.arms!=='string'||typeof args.card!=='string')throw Error('--yes requires explicit --arms and --card; no implicit paid participants.');
 }else if(!interactive)throw Error('Noninteractive execution requires --card, --arms and --yes. Use --dry-run to inspect without running.');
 else if(!/^y(es)?$/i.test((await ask('Run exactly this comparison, using the listed local/cloud resources? [y/N] ')).trim())){out('Cancelled; no tasks launched.\n');return 0;}
 preflight(plan,{participants});
 if(plan.arms.includes('deepseek-local-27b')){
  const output=readinessLocation(plan.output)+'.deepseek';
  out(`Checking DeepSeek offline before scored work. Evidence: ${output}\n`);
  plan.deepseekReadiness=await checkDeepseek({output,registration:plan.peerExecutables?.deepseek});
 }
 if(plan.arms.some(a=>a.startsWith('claude-'))){
  const output=readinessLocation(plan.output)+'.claude';out(`Checking Claude offline before scored work. Evidence: ${output}\n`);
  await checkClaudeReadiness({output,requireAuthentication:true});
 }
 if(plan.arms.some(a=>a.includes('codex'))){
  const output=readinessLocation(plan.output)+'.codex';out(`Checking Codex offline before scored work. Evidence: ${output}\n`);
  plan.codexReadiness=await checkCodex({output,requireAuthentication:true});
 }
 const peerArms=plan.arms.filter(a=>['hermes','opencode'].includes(a));
 if(peerArms.length){
  const output=readinessLocation(plan.output);out(`Checking selected peer runtimes offline first. Evidence: ${output}\n`);
  plan.peerReadiness=await checkPeers({arms:peerArms,peerExecutables:plan.peerExecutables,output});
 }
 let manifest;
 const viewer=args.live?await startLive():null;
 if(viewer)out(`Live comparison (read-only, local token URL): ${viewer.url}\nClosing the browser does not stop the comparison.\n`);
 try{
 try{manifest=await run(plan,viewer?{onProgress:viewer.publish}:{});}
 finally{
  if(fs.existsSync(path.join(plan.output,'manifest.json'))){
   try{exportCard(plan.output);}
   finally{
    const rendered=replay(plan.output);
    out(`Private replay: ${rendered.output}\nEvidence: ${plan.output}\n`);
   }
  }
 }
 if(args.public&&fs.existsSync(path.join(plan.output,'manifest.json'))){
  const summary=showcase({roots:[plan.output],output:path.join(plan.output,'public'),mode:'public'});
  out(`Public summary (review before sharing): ${summary.output}\nOnly that public subdirectory is sanitized. Do not share the surrounding raw evidence.\n`);
 }
 return manifest?.complete&&manifest.results.every(r=>r.pass)?0:1;
 }finally{
  if(viewer){try{
   if(fs.existsSync(plan.output)){
    const file=path.join(plan.output,'live-public.html');
    fs.writeFileSync(file,renderLiveFight(viewer.snapshot()),{flag:'wx',mode:0o600});
    out(`Standalone public snapshot: ${file}\nOnly this page is sanitized; surrounding raw evidence stays private.\n`);
   }
  }finally{await viewer.close();}}
 }
}
