import {PUBLIC_FACTORY_CARDS} from '../scripts/factory-card-catalog.mjs';
import {aggregateExchanges} from '../scripts/fight-model-proxy.mjs';

const LABELS={'bantam-local-27b':'BANTAM · local','deepseek-local-27b':'DeepSeek Harness',hermes:'Hermes',pi:'Pi',opencode:'OpenCode',
 'codex-astra':'Codex · Astra','bantam-codex-astra':'BANTAM · Astra','bantam-codex-sol':'BANTAM · Sol','bantam-codex-terra':'BANTAM · Terra','codex-sol':'Codex · Sol','codex-terra':'Codex · Terra','claude-sonnet':'Claude · Sonnet','claude-opus':'Claude · Opus','claude-fable':'Claude · Fable'};
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const fields=['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'];
export const progressKey=r=>`${r.repeat}/${r.card}/${r.arm}`;
// A public, numeric projection. No model identifiers, endpoints, task text,
// source, tool arguments, native logs or arbitrary errors cross this boundary.
export function projectFightProgress(manifest,active=new Map(),now=Date.now()){
 const results=new Map(manifest.results.map(r=>[progressKey(r),r]));
 return {schema:'bantam.fight-progress.v1',updatedAt:now,finished:Boolean(manifest.finishedAt),
  complete:manifest.complete===true,stopped:Boolean(manifest.stoppedEarly||manifest.error),
  schedule:manifest.configuration?.executionSchedule?.startsWith('All contenders')?'serial':'serial-local-and-frontier-queues',
  lanes:manifest.plan.map(item=>{
   if(!Object.hasOwn(LABELS,item.arm)||!Object.hasOwn(PUBLIC_FACTORY_CARDS,item.card)||!count(item.repeat))throw Error('Invalid live card identity');
   const result=results.get(progressKey(item)),current=active.get(progressKey(item));
   const usage=result?.usage??(current?.exchanges?aggregateExchanges(current.exchanges):null);
   const groups=result?.grade?.groups;
   return {id:progressKey(item),label:LABELS[item.arm],card:PUBLIC_FACTORY_CARDS[item.card].title,repeat:item.repeat,
    phase:result?'finished':manifest.finishedAt?'unrecorded':['running','settling','grading'].includes(current?.phase)?current.phase:'queued',
    outcome:['PASS','FAIL','OUTPUT_ONLY','TIMEOUT','SETUP_ERROR'].includes(result?.outcome)?result.outcome:null,
    candidatePass:typeof result?.candidatePass==='boolean'?result.candidatePass:null,
    processCompleted:typeof result?.processCompleted==='boolean'?result.processCompleted:null,
    elapsedMs:result?count(result.wallMs):current?count(current.workElapsedMs??Math.max(0,now-current.startedAt)):null,
    groupsPassed:Array.isArray(groups)?groups.filter(g=>g.pass===true).length:null,groupsTotal:Array.isArray(groups)?groups.length:null,
    requests:count(usage?.requests),measuredRequests:count(usage?.measuredRequests),
    accountingComplete:usage?.complete===true,accountingScope:result?'final':'so-far',
    tokens:Object.fromEntries(fields.map(f=>[f,count(usage?.[f])])),
    measuredSubset:Object.fromEntries(fields.map(f=>[f,count(usage?.measuredSubset?.[f])]))};
  })};
}

export function publicFightProgress(value){
 if(value?.schema!=='bantam.fight-progress.v1'||!Array.isArray(value.lanes)||value.lanes.length>200)throw Error('Invalid progress snapshot');
 const flag=v=>typeof v==='boolean'?v:null;
 return {schema:value.schema,updatedAt:count(value.updatedAt),finished:value.finished===true,complete:value.complete===true,stopped:value.stopped===true,
  schedule:value.schedule==='serial'?'serial':'serial-local-and-frontier-queues',lanes:value.lanes.map(row=>{
   const [repeat,card,arm,...rest]=String(row.id).split('/');
   if(rest.length||!Object.hasOwn(LABELS,arm)||!Object.hasOwn(PUBLIC_FACTORY_CARDS,card)||!/^\d{1,3}$/.test(repeat)||Number(repeat)<1)throw Error('Invalid progress lane');
   return {id:`${Number(repeat)}/${card}/${arm}`,label:LABELS[arm],card:PUBLIC_FACTORY_CARDS[card].title,repeat:Number(repeat),
    phase:['running','settling','grading','finished','unrecorded'].includes(row.phase)?row.phase:'queued',
    outcome:['PASS','FAIL','OUTPUT_ONLY','TIMEOUT','SETUP_ERROR'].includes(row.outcome)?row.outcome:null,
    candidatePass:flag(row.candidatePass),processCompleted:flag(row.processCompleted),elapsedMs:count(row.elapsedMs),
    groupsPassed:count(row.groupsPassed),groupsTotal:count(row.groupsTotal),requests:count(row.requests),measuredRequests:count(row.measuredRequests),
    accountingComplete:row.accountingComplete===true,accountingScope:row.accountingScope==='final'?'final':'so-far',
    tokens:Object.fromEntries(fields.map(f=>[f,count(row.tokens?.[f])])),measuredSubset:Object.fromEntries(fields.map(f=>[f,count(row.measuredSubset?.[f])]))};
  })};
}
