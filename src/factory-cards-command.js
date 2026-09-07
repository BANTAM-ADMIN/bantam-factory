import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FACTORY_KITS,PUBLIC_FACTORY_CARDS,factoryKit} from '../scripts/factory-card-catalog.mjs';
import {FIGHT_ARMS,fightPlan,runFactoryFights} from '../scripts/factory-fights.mjs';
import {writeFactoryReplay} from '../scripts/factory-fight-replay.mjs';
import {writeFightCardExport} from '../scripts/factory-fight-export.mjs';
import {loadConnection,discoverModelServers} from './first-run.js';

const LOCAL=new Set(['bantam-local-27b','hermes','opencode','deepseek-local-27b']);
export const CARDS_HELP=`BANTAM FACTORY · fight cards

bantamfactory cards                 Guided, explicitly approved comparison
bantamfactory cards --list          List frozen tasks and installed participants
bantamfactory cards --replay DIR    Rebuild replay/export from saved evidence; no inference
bantamfactory cards --card context-packet --arms bantam-local-27b,hermes --dry-run
bantamfactory cards --card context-packet --arms bantam-local-27b,opencode --endpoint http://127.0.0.1:8085 --yes

Options: --kit ID (default factory-2026-09-07), --card ID, --arms ID,...,
         --endpoint URL, --out NEW-DIRECTORY, --timeout-seconds 1..600,
         --repetitions 1..3, --serial, --list, --replay DIR, --dry-run, --yes, --help

No rival installations, model downloads, cloud requests or uploads occur from
listing or planning. Execution requires Docker and the selected runtimes.
Local lanes currently require a loopback llama.cpp server with /props and /slots.
Cloud-only cards do not require a local server. Select cloud participants
explicitly: task context goes to the provider and consumes account access/quota.
Claude Code is never selected automatically. For an explicit direct Claude Code
agent comparison, the existing command is: bantam fight --arms bantam,claude-sonnet --task "..."
That legacy command has a different isolation/grading protocol; it is not this
frozen-card runner. Generic agent APIs are not interchangeable with model APIs.
`;

export function findCardExecutable(name,{env=process.env}={}){
 for(const directory of (env.PATH??'').split(path.delimiter)){
  const file=path.resolve(directory||'.',name);
  try{if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file;}}catch{}
 }
 return null;
}
export function discoverCardParticipants({find=findCardExecutable}={}){
 return FIGHT_ARMS.map(id=>{
  const command=id==='hermes'?'hermes':id==='opencode'?'opencode':id.includes('codex')?'codex':null;
  const executable=command?find(command):null;
  return {id,pool:LOCAL.has(id)?'local':'cloud',executable,
   installed:command?Boolean(executable):id==='bantam-local-27b',
   detail:id==='bantam-local-27b'?'This checkout; your selected llama.cpp server':
    id==='deepseek-local-27b'?'Requires separately prepared bantam/deepseek-fight:0.1.2-rc.1 Docker image':
    executable??`${command} not on PATH (no automatic installation)`};
 });
}
export function normalizeCardEndpoint(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['/','/v1','/v1/'].includes(url.pathname)){
  throw Error('These recorded local cards require a credential-free loopback llama.cpp origin. Remote/general APIs remain usable by BANTAM setup, but need a separate recorded-card adapter.');
 }
 return url.origin;
}
export function makeCardsPlan(args,{cwd=process.cwd(),now=()=>new Date(),connection=loadConnection()}={}){
 const kitId=args.kit??'factory-2026-09-07',kit=factoryKit(kitId);
 const card=args.card??kit.cards[0],arms=typeof args.arms==='string'?args.arms.split(',').map(a=>a.trim()):['bantam-local-27b'];
 const repetitions=Number(args.repetitions??1),timeoutMs=Number(args['timeout-seconds']??600)*1000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('timeout-seconds must be 1..600');
 fightPlan({kitId,cards:[card],arms,repetitions});
 const endpoint=arms.some(a=>LOCAL.has(a))?normalizeCardEndpoint(args.endpoint??(connection?.kind==='api'&&connection.dialect==='llamacpp'?connection.apiUrl:'http://127.0.0.1:8085')):null;
 const output=path.resolve(cwd,args.out??path.join('.bantam','fight-cards',now().toISOString().replace(/[:.]/g,'-')));
 if(fs.existsSync(output))throw Error('Choose a new output directory; existing evidence is never overwritten.');
 return {kitId,cards:[card],arms,repetitions,timeoutMs,output,endpoint,parallelQueues:!args.serial};
}
export function preflightCards(plan,{exec=execFileSync,participants=discoverCardParticipants()}={}){
 const check=(exe,args,label)=>{try{exec(exe,args,{stdio:'ignore',timeout:5000});}catch{throw Error(`${label}. Nothing has been installed; fix this prerequisite and retry.`);}};
 const missing=plan.arms.filter(id=>!id.startsWith('deepseek')&&!participants.find(p=>p.id===id)?.installed);
 if(missing.length)throw Error(`Selected participants not installed/on PATH: ${missing.join(', ')}. Nothing was launched.`);
 check('docker',['info'],'Docker is unavailable');
 for(const image of new Set(['alpine:3',...(plan.arms.some(a=>a!=='bantam-local-27b')?['ubuntu:24.04']:[]),...(plan.arms.includes('deepseek-local-27b')?['bantam/deepseek-fight:0.1.2-rc.1']:[])])){
  check('docker',['image','inspect',image],`Required Docker image missing: ${image}`);
 }
 if(plan.arms.some(a=>a.includes('codex'))&&(process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==1000||process.getgid?.()!==1000)){
  throw Error('The current isolated Codex card runtime requires Linux x64 with uid/gid 1000. Ordinary BANTAM Codex setup is separate; this runtime needs portability work.');
 }
}
export async function factoryCardsCommand(args,{ask,out=s=>process.stdout.write(s),interactive=Boolean(process.stdin.isTTY&&process.stderr.isTTY),
 discover=discoverCardParticipants,servers=discoverModelServers,connection=loadConnection(),
 preflight=preflightCards,run=runFactoryFights,exportCard=writeFightCardExport,replay=writeFactoryReplay}={}){
 const allowed=new Set(['_','help','list','replay','dry-run','yes','kit','card','arms','endpoint','out','timeout-seconds','repetitions','serial']);
 for(const key of Object.keys(args))if(!allowed.has(key))throw Error(`Unknown cards option: --${key}`);
 if(args.help){out(CARDS_HELP);return 0;}
 if(args.replay!==undefined){
  if(typeof args.replay!=='string'||Object.keys(args).some(k=>!['_','replay'].includes(k)))throw Error('--replay requires an evidence directory and cannot be mixed with execution options.');
  const root=path.resolve(args.replay);
  try{exportCard(root);}
  finally{const rendered=replay(root);out(`Private replay: ${rendered.output}\nExisting contender evidence was not rerun. Inspect before sharing.\n`);}
  return 0;
 }
 const participants=discover();
 const list=()=>{
  out('\nBANTAM FACTORY · frozen work orders\n');
  for(const [kit,cards]of Object.entries(FACTORY_KITS))for(const id of cards)out(`  ${kit} / ${id} — ${PUBLIC_FACTORY_CARDS[id]?.description??id}\n`);
  out('\nParticipants (installation discovery only, not a readiness certificate)\n');
  participants.forEach(p=>out(`  ${p.id} [${p.pool}] ${p.installed?'detected':'needs setup'} · ${p.detail}\n`));
  out('  Claude Code: explicit direct agent comparison only; see --help. Never auto-invoked.\n');
 };
 if(args.list){list();return 0;}
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
 const plan=makeCardsPlan(selected,{connection});
 out('\nPlanned comparison (no work launched yet):\n'+JSON.stringify(plan,null,2)+'\n');
 if(args['dry-run'])return 0;
 out('Fresh isolated workspaces; no changes to your current project. All failures remain recorded.\nRaw task/source/model transcripts remain private locally; inspect before sharing. No automatic uploads.\n');
 if(plan.arms.some(a=>!LOCAL.has(a)))out('Cloud participants send task/context to OpenAI using your signed-in Codex account and consume its quota/access.\n');
 if(args.yes){
  if(typeof args.arms!=='string'||typeof args.card!=='string')throw Error('--yes requires explicit --arms and --card; no implicit paid participants.');
 }else if(!interactive)throw Error('Noninteractive execution requires --card, --arms and --yes. Use --dry-run to inspect without running.');
 else if(!/^y(es)?$/i.test((await ask('Run exactly this comparison, using the listed local/cloud resources? [y/N] ')).trim())){out('Cancelled; no tasks launched.\n');return 0;}
 preflight(plan,{participants});
 let manifest;
 try{manifest=await run(plan);}
 finally{
  if(fs.existsSync(path.join(plan.output,'manifest.json'))){
   try{exportCard(plan.output);}
   finally{
    const rendered=replay(plan.output);
    out(`Private replay: ${rendered.output}\nEvidence: ${plan.output}\n`);
   }
  }
 }
 return manifest?.complete&&manifest.results.every(r=>r.pass)?0:1;
}
