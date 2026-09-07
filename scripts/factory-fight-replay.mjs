#!/usr/bin/env node
// Presentation only: reads frozen receipts, never launches a contender or judge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {factoryKit,PUBLIC_FACTORY_CARDS} from './factory-card-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARMS = ['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','bantam-codex-astra'];
const LABELS = {'bantam-local-27b':'BANTAM · 27B','deepseek-local-27b':'DeepSeek Harness','opencode':'OpenCode','hermes':'Hermes','codex-astra':'Codex · Astra','bantam-codex-astra':'BANTAM · Astra'};
const TITLES = {'receipt-reducer':'Receipt reducer','snapshot-drift':'Snapshot drift','job-planner':'Job planner'};
const SHA = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const NUM = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const scriptJSON = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`);
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } };
const jsonLines = text => String(text ?? '').split(/\r?\n/).flatMap((line, index) => { try { return [{row:JSON.parse(line),line:index+1}]; } catch { return []; } });
const relativeTime = (value, origin) => {
  if (typeof value !== 'string' || typeof origin !== 'string') return null;
  const a = Date.parse(value), b = Date.parse(origin);
  return Number.isFinite(a) && Number.isFinite(b) && a >= b ? a-b : null;
};
const textOf = value => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const clip = (value, limit=220) => { const text=textOf(value); return text.length>limit?text.slice(0,limit)+'…':text; };

export function normalizeReplayUsage(usage) {
  if (!usage || typeof usage !== 'object') return {inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null};
  const inputTokens=NUM(usage.inputTokens),outputTokens=NUM(usage.outputTokens);
  const cacheHitTokens=NUM(usage.cacheHitTokens ?? usage.cachedInputTokens);
  const supplied=NUM(usage.freshInputTokens);
  const freshInputTokens=supplied ?? (inputTokens!==null&&cacheHitTokens!==null&&cacheHitTokens<=inputTokens?inputTokens-cacheHitTokens:null);
  return {inputTokens,outputTokens,cacheHitTokens,freshInputTokens};
}

/** Exact line comparison, not a semantic/code-correctness judgment. */
export function replayLineDiff(before, after) {
  if (before===after) return [{kind:'same',text:before}];
  const a=before.split('\n'),b=after.split('\n');
  let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const result=[];
  if(prefix)result.push({kind:'same',text:a.slice(0,prefix).join('\n')});
  if(a.length-prefix-suffix)result.push({kind:'removed',text:a.slice(prefix,a.length-suffix).join('\n')});
  if(b.length-prefix-suffix)result.push({kind:'added',text:b.slice(prefix,b.length-suffix).join('\n')});
  if(suffix)result.push({kind:'same',text:a.slice(a.length-suffix).join('\n')});
  return result;
}

function collectArtifacts(directory, {maxFileBytes=128*1024*1024,maxLaneBytes=512*1024*1024}={}) {
  const artifacts=[],warnings=[]; let bytes=0;
  const add=(relative,file,{synthetic=false}={})=>{
    try {
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()){warnings.push(`${relative}: not a regular file; not embedded`);return;}
      if(stat.size>maxFileBytes||bytes+stat.size>maxLaneBytes){artifacts.push({path:relative,size:stat.size,embedded:false,reason:'explicit evidence byte limit'});return;}
      const raw=fs.readFileSync(file),text=raw.toString('utf8'),utf8=Buffer.from(text).equals(raw);
      bytes+=raw.length;
      artifacts.push({path:relative,size:raw.length,sha256:SHA(raw),embedded:true,synthetic,
        encoding:utf8?'utf8':'base64',content:utf8?text:raw.toString('base64')});
    } catch(error){warnings.push(`${relative}: ${error.code ?? error.message}`);}
  };
  const walk=(relative,depth=0)=>{
    if(depth>20){warnings.push(`${relative}: depth limit`);return;}
    const file=path.join(directory,relative);let stat;
    try{stat=fs.lstatSync(file);}catch{return;}
    if(stat.isSymbolicLink()){warnings.push(`${relative}: symlink not followed`);return;}
    if(stat.isFile()){
      if(/(?:^|\/)(?:auth\.json|\.env(?:\..*)?|credentials(?:\.json)?|[^/]*\.pem|[^/]*\.key)$/i.test(relative)){
        warnings.push(`${relative}: credential-shaped artifact excluded`);return;
      }
      if(relative.startsWith('ws/')||/\.(?:json|jsonl|ndjson|log|body|md|txt|patch|diff)$/.test(relative))add(relative,file);
      return;
    }
    if(!stat.isDirectory())return;
    for(const entry of fs.readdirSync(file,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
      if(['.git','node_modules','.cache','__pycache__','cache'].includes(entry.name))continue;
      if(relative.startsWith('ws')&&entry.name==='.bantam')continue;
      walk(relative?`${relative}/${entry.name}`:entry.name,depth+1);
    }
  };
  for(const file of ['result.json','command.json','task.md','stdout.log','stderr.log','run.json',
    'public.stdout.log','public.stderr.log','hidden.stdout.log','hidden.stderr.log','server-usage.json']) {
    if(fs.existsSync(path.join(directory,file)))add(file,path.join(directory,file));
  }
  for(const tree of ['wire','native-sessions','native','factory','ws'])walk(tree);
  return {artifacts,warnings,bytes,add};
}

function summariesFromWire(artifacts, origin) {
  const byPath=new Map(artifacts.map(a=>[a.path,a]));
  const rows=jsonLines(byPath.get('wire/exchanges.jsonl')?.content);
  const events=[],receipts=[],responseStops=[];
  for(const {row,line} of rows) {
    const start=relativeTime(row.startedAt,origin),stem=String(row.index).padStart(5,'0');
    const request=`wire/${stem}.request.body`,response=`wire/${stem}.response.body`;
    if(row.phase==='request'){
      let parsed=null;try{parsed=JSON.parse(byPath.get(request)?.content);}catch{}
      const messages=Array.isArray(parsed?.messages)?parsed.messages.length:null;
      events.push({t:start,kind:row.generation?'context':'api',title:`${row.generation?'Context dispatched':'API request'} · ${row.route}`,
        detail:messages!==null?`${messages} messages · ${row.requestBytes ?? '?'} bytes`: `${row.requestBytes ?? '?'} bytes`,
        artifact:request,related:[response,'wire/exchanges.jsonl'],receiptLine:line,source:'external HTTP recorder'});
    } else if(row.phase==='response'){
      const duration=NUM(row.wallMs),t=start!==null&&duration!==null?start+duration:null;
      events.push({t,kind:row.error?'error':'response',title:`${row.generation?'Model response':'API response'} · HTTP ${row.status ?? '?'}`,
        detail:row.error?String(row.error):`${row.responseBytes ?? '?'} bytes · ${duration===null?'duration unknown':(duration/1000).toFixed(2)+'s'}`,
        artifact:response,related:[request,'wire/exchanges.jsonl'],receiptLine:line,source:'external HTTP recorder'});
      if(row.generation)receipts.push({t,usage:row.usage,valid:row.finished===true&&row.status===200,source:'external HTTP usage receipt'});
      if(row.generation){
        const body=byPath.get(response)?.content;let objects=[];
        if(typeof body==='string'){
          try{objects=[JSON.parse(body)];}catch{
            objects=body.split(/\r?\n/).filter(line=>line.startsWith('data:')).flatMap(line=>{try{return [JSON.parse(line.slice(5).trim())];}catch{return [];}});
          }
        }
        const reasons=[];
        for(const object of objects){
          for(const choice of Array.isArray(object?.choices)?object.choices:[])if(typeof choice?.finish_reason==='string')reasons.push(choice.finish_reason);
          if(object?.stopped_limit===true)reasons.push('length');
        }
        const outputLimit=NUM(row.settings?.max_tokens??row.settings?.max_completion_tokens??row.settings?.n_predict);
        responseStops.push({t,index:row.index,reasons:[...new Set(reasons)],outputLimit,artifact:response,
          source:'finish fields in exact recorded HTTP response body'});
      }
    }
  }
  return {events,receipts,responseStops};
}

function summariesFromSessions(artifacts,origin) {
  const events=[],totals=[],calls=[];
  for(const artifact of artifacts){
    if(!artifact.path.startsWith('native-sessions/')||!artifact.path.endsWith('.jsonl')||!artifact.embedded)continue;
    const rows=jsonLines(artifact.content);
    const session=rows.find(({row})=>row.type==='session_meta')?.row?.payload?.id ?? artifact.path;
    for(const {row,line} of rows){
      const payload=row.payload,t=relativeTime(row.timestamp,origin);
      if(row.type==='token_usage_record'&&payload?.usage&&typeof payload.response_id==='string'){
        const u=payload.usage;
        calls.push({responseId:payload.response_id,timestamp:row.timestamp,usage:normalizeReplayUsage({
          inputTokens:u.input_tokens,outputTokens:u.output_tokens,cacheHitTokens:u.cached_input_tokens})});
        events.push({t,kind:'usage',title:'Native response usage receipt',detail:`Response ${payload.response_id}`,
          artifact:artifact.path,line,source:'saved native per-response usage record'});
      }
      if(row.type==='event_msg'&&payload?.type==='token_count'&&payload.info?.total_token_usage){
        const u=payload.info.total_token_usage;
        totals.push({t,session,usage:normalizeReplayUsage({inputTokens:u.input_tokens,outputTokens:u.output_tokens,
          cacheHitTokens:u.cached_input_tokens}),artifact:artifact.path,line});
      }
      if(row.type==='turn_context')events.push({t,kind:'context',title:'Native turn context',detail:clip(payload),artifact:artifact.path,line,source:'saved Codex client session'});
      if(row.type!=='response_item'||!payload)continue;
      let kind,title,detail;
      if(['function_call','custom_tool_call','web_search_call'].includes(payload.type)){
        kind='tool';title=`Tool call · ${payload.name ?? payload.type}`;detail=clip(payload.arguments ?? payload.input ?? payload.action);
      } else if(['function_call_output','custom_tool_call_output'].includes(payload.type)){
        kind='observation';title='Tool result';detail=clip(payload.output);
      } else if(payload.type==='message'){
        kind=payload.role==='user'?'context':'message';title=`${payload.role ?? 'Native'} message`;
        detail=clip((payload.content ?? []).map(part=>part.text??'').join('\n'));
      } else if(payload.type==='reasoning'){
        kind='reasoning';title='Recorded reasoning summary';detail=clip(payload.summary ?? payload.content ?? []);
      } else continue;
      events.push({t,kind,title,detail,artifact:artifact.path,line,source:'saved Codex client session'});
    }
  }
  // Cumulative counters belong to sessions. Aggregate latest snapshot per
  // session, never add each cumulative token_count as if it were a request.
  const states=new Map(),updates=[];
  const seen=new Set();
  for(const row of totals.filter(r=>r.t!==null).sort((a,b)=>a.t-b.t)){
    const key=JSON.stringify([row.session,row.t,row.usage]);if(seen.has(key))continue;seen.add(key);
    states.set(row.session,row.usage);
    const usage={};
    for(const metric of ['inputTokens','outputTokens','cacheHitTokens','freshInputTokens']){
      const values=[...states.values()].map(state=>state[metric]);
      usage[metric]=values.every(value=>value!==null)?values.reduce((a,b)=>a+b,0):null;
    }
    updates.push({t:row.t,...usage,source:'recorded native session cumulative totals',measured:states.size,partial:true});
  }
  return {events,updates,calls};
}

function nativeResponseUpdates(calls,origin) {
  const unique=new Map();let partial=false,conflict=false;
  for(const call of calls){
    if(typeof call?.responseId!=='string'){partial=true;continue;}
    const previous=unique.get(call.responseId),usage=normalizeReplayUsage(call.usage);
    if(previous&&JSON.stringify(previous.usage)!==JSON.stringify(usage)){conflict=true;continue;}
    if(!previous)unique.set(call.responseId,{t:relativeTime(call.timestamp,origin),usage});
  }
  // Conflicting identity receipts cannot supply an unambiguous running total.
  if(conflict)return [];
  if([...unique.values()].some(call=>call.t===null))partial=true;
  const receipts=[...unique.values()].map(call=>({...call,valid:true}));
  return sumReceiptUpdates(receipts).map(update=>({...update,partial:update.partial||partial,source:'recorded distinct native responses'}));
}

function summariesFromModelCalls(saved,origin) {
  const calls=Array.isArray(saved?.modelCalls)?saved.modelCalls:[];
  const events=[],receipts=[],indices=new Map();let incomplete=false;
  for(const call of calls)if(Number.isSafeInteger(call?.index))indices.set(call.index,(indices.get(call.index)??0)+1);
  for(const [position,call] of calls.entries()){
    if(!call||typeof call!=='object'){incomplete=true;continue;}
    const start=relativeTime(call.startedAt,origin),end=relativeTime(call.completedAt,origin);
    const attempts=Array.isArray(call.attempts)?call.attempts:null;
    const usage=normalizeReplayUsage(call.response?.normalized?.usage);
    const attemptUsage=normalizeReplayUsage(attempts?.[0]?.response?.normalized?.usage);
    // A top-level settled response duplicates the successful attempt's
    // response. Count the former ONCE, never both. Retry/multi-request records
    // need different accounting; retain their exact evidence but do not infer
    // missing spend or spread an aggregate over invented request timestamps.
    const eligible=Number.isSafeInteger(call.index)&&call.index>=0&&indices.get(call.index)===1&&call.status==='ok'
      &&attempts?.length===1&&attempts[0]?.status==='ok'&&call.response?.status===200&&attempts[0]?.response?.status===200
      &&call.response?.normalized?.usage?.requests===1
      &&(call.response?.normalized?.usage?.codexRequests??1)===1
      &&usage.inputTokens!==null&&usage.outputTokens!==null
      &&(usage.cacheHitTokens===null||usage.cacheHitTokens<=usage.inputTokens)
      &&JSON.stringify(usage)===JSON.stringify(attemptUsage)
      &&(start===null||end===null||end>=start);
    if(!eligible||start===null||end===null||usage.cacheHitTokens===null)incomplete=true;
    const source='saved BANTAM model-call recorder; not independent HTTP wire';
    events.push({t:start,kind:'context',title:`BANTAM model-call ${call.index??position} · context dispatched`,
      detail:`${call.request?.method??'request'} ${call.request?.url??'endpoint not recorded'}`,
      artifact:'run.json',modelCallPosition:position,modelCallField:'request',source});
    events.push({t:end,kind:call.status==='ok'?'response':'error',title:`BANTAM model-call ${call.index??position} · ${call.status==='ok'?'response completed':'completion '+(call.status??'unknown')}`,
      detail:`${attempts===null?'attempt count unknown':attempts.length+' recorded attempt(s)'}${eligible?' · one settled usage receipt':' · usage accounting unsupported/incomplete'}`,
      artifact:'run.json',modelCallPosition:position,modelCallField:'response',source});
    receipts.push({t:end,usage:eligible?usage:null,valid:eligible});
  }
  const updates=sumReceiptUpdates(receipts).map(update=>({...update,partial:update.partial||incomplete,
    source:'recorded single-attempt BANTAM model calls'}));
  return {events,updates};
}

function sumReceiptUpdates(receipts) {
  const sums={inputTokens:0,outputTokens:0,cacheHitTokens:0,freshInputTokens:0};
  const known={inputTokens:true,outputTokens:true,cacheHitTokens:true,freshInputTokens:true};
  const updates=[];let measured=0,partial=false;
  for(const receipt of receipts.filter(r=>r.t!==null).sort((a,b)=>a.t-b.t)){
    if(!receipt.valid||!receipt.usage){partial=true;continue;}
    measured++;const usage=normalizeReplayUsage(receipt.usage);
    for(const metric of Object.keys(sums)){
      if(usage[metric]===null)known[metric]=false;else sums[metric]+=usage[metric];
    }
    updates.push({t:receipt.t,...Object.fromEntries(Object.keys(sums).map(metric=>[metric,known[metric]?sums[metric]:null])),
      source:'recorded completed HTTP responses',measured,partial});
  }
  return updates;
}

function outerEvents(text,arm) {
  return jsonLines(text).filter(({row})=>row.arm===arm).map(({row,line})=>{
    let parsed=null;try{parsed=JSON.parse(row.text);}catch{}
    const item=parsed?.item ?? parsed?.part ?? parsed;
    const type=String(parsed?.type ?? item?.type ?? 'console');
    const tool=/tool|command|function|action/.test(type)||item?.command||item?.tool;
    return {t:NUM(row.t),kind:tool?'tool':/error|fail/.test(type)?'error':'console',
      title:tool?`Native activity · ${item?.tool ?? item?.name ?? type}`:type==='console'?'Console receipt':type,
      detail:clip(item?.command ?? item?.text ?? row.text),artifact:'../events.ndjson',line,source:'controller elapsed-time console receipt'};
  });
}

/** Build only from recorded artifacts. Missing clocks/metrics remain null. */
export function buildReplayLane({directory,result,arm,card,repeat,outer='',limits={},kitSeal={},kitId='factory-2026-09-06',identity=null}) {
  const KIT=factoryKit(kitId).root;
  // A presentation adapter may describe a separately recorded local variant.
  // Never alias its identity or evidence to the historical 27B lane.
  const localVariant=/^bantam-local-[a-z0-9][a-z0-9-]{0,119}$/.test(arm??'')
    && identity?.family==='local' && typeof identity.label==='string'
    && identity.label.trim().length>0 && identity.label.length<=160;
  if((!ARMS.includes(arm)&&!localVariant)||!/^[a-z0-9-]+$/.test(card??'')||!Number.isInteger(repeat)||repeat<1)throw Error('invalid replay lane identity');
  const collected=collectArtifacts(directory,limits),{artifacts,warnings}=collected;
  const hasLaneArtifacts=artifacts.length>0;
  const saved=readJSON(path.join(directory,'run.json'));
  const origin=typeof result?.startedAt==='string'?result.startedAt:null;
  const wire=summariesFromWire(artifacts,origin),native=summariesFromSessions(artifacts,origin);
  const modelCalls=summariesFromModelCalls(saved,origin);
  const higherContext=wire.events.some(event=>event.kind==='context')||native.events.length>0;
  const events=[...wire.events,...native.events,...(!higherContext?modelCalls.events:[]),...outerEvents(outer,arm)];
  if(outer)artifacts.push({path:'../events.ndjson',size:Buffer.byteLength(outer),sha256:SHA(outer),embedded:true,encoding:'utf8',content:outer});
  const turns=saved?.turns ?? saved?.result?.turns ?? [];
  for(const turn of Array.isArray(turns)?turns:[]){
    const action=turn.parsedAction ?? turn.action;
    events.push({t:null,kind:'turn',title:`BANTAM turn ${turn.i ?? '?'} · ${action?.a ?? 'unparsed'}`,
      detail:clip(action ?? turn.rawOutput),artifact:'run.json',turn:turn.i,
      source:'saved turn sequence; no exact timestamp assigned'});
  }
  const files=[];
  for(const artifact of artifacts.filter(a=>a.path.startsWith('ws/'))){
    const relative=artifact.path.slice(3),expected=result?.materialSeal?.[relative];
    let baseline=null;
    if(expected&&typeof card==='string'&&/^[a-z0-9-]+$/.test(card)&&!relative.split('/').includes('..')){
      const file=path.join(KIT,card,'starter',relative);
      try{
        const stat=fs.lstatSync(file);
        if(stat.isFile()&&!stat.isSymbolicLink()){
          const bytes=fs.readFileSync(file);
          if(SHA(bytes)===expected){
            baseline=`starter/${relative}`;
            artifacts.push({path:baseline,size:bytes.length,sha256:expected,embedded:true,encoding:'utf8',content:bytes.toString('utf8'),synthetic:true});
          }
        }
      }catch{}
    }
    files.push({path:relative,artifact:artifact.path,sha256:artifact.sha256,size:artifact.size,
      baseline,baselineExpected:expected??null,state:expected?(expected===artifact.sha256?'unchanged':'changed'):'added',
      finalSealMatches:typeof result?.finalFiles?.[relative]==='string'?result.finalFiles[relative]===artifact.sha256:null});
  }
  for(const relative of Object.keys(result?.materialSeal ?? {}))if(!files.some(file=>file.path===relative)){
    files.push({path:relative,state:'missing',artifact:null,baseline:null,baselineExpected:result.materialSeal[relative]});
  }
  // Portable judge inspection uses the bytes of the frozen gauge only. Never
  // substitute a later local grader and label it as the one that scored a run.
  for(const [relative,name] of [[`${card}/grader.mjs`,'grader.mjs'],[`${card}/card.json`,'card.json'],
    [`${card}/task.md`,'task.md'],['grader-support.mjs','grader-support.mjs']]){
    const expected=kitSeal[relative];if(typeof expected!=='string')continue;
    try{
      const file=path.join(KIT,relative),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('not a regular file');
      const bytes=fs.readFileSync(file);
      if(SHA(bytes)!==expected)throw Error('current bytes do not match frozen kit seal');
      artifacts.push({path:`judge/${name}`,size:bytes.length,sha256:expected,embedded:true,encoding:'utf8',
        content:bytes.toString('utf8'),synthetic:true,binding:'kitSeal'});
    }catch(error){warnings.push(`Frozen judge source ${relative} unavailable: ${error.message}`);}
  }
  const order=(a,b)=>a.t===null?(b.t===null?0:1):b.t===null?-1:a.t-b.t;
  events.sort(order);events.forEach((event,index)=>{event.id=index;});
  const timed=events.filter(event=>event.t!==null);
  const directCalls=Array.isArray(result?.usage?.calls)?result.usage.calls:native.calls;
  const tokenUpdates=wire.receipts.length?sumReceiptUpdates(wire.receipts):directCalls.length?nativeResponseUpdates(directCalls,origin):
    native.updates.length?native.updates:modelCalls.updates;
  const duration=NUM(result?.wallMs);
  const sessions=result?.nativeMetadata?.native?.sessions;
  const stopReasons=[...new Set((Array.isArray(sessions)?sessions:[]).flatMap(session=>
    Array.isArray(session?.turnEndReasons)?session.turnEndReasons.filter(reason=>typeof reason==='string'):[]))];
  if(result?.timedOut===true)stopReasons.push('controller deadline');
  if(result?.aborted===true)stopReasons.push('controller interrupted');
  if(result?.bufferExceeded===true)stopReasons.push('controller output-buffer limit');
  const latestResponse=wire.responseStops.at(-1);
  if(latestResponse?.reasons.includes('length'))stopReasons.push('latest wire response: length');
  const budgetLimited=stopReasons.includes('max-tokens')||latestResponse?.reasons.includes('length')===true;
  const lane={id:`r${repeat}-${card}-${arm}`,arm,label:LABELS[arm]??identity.label,card,repeat,
    family:ARMS.includes(arm)?(ARMS.indexOf(arm)<4?'local':'astra'):identity.family,result:result??null,outcome:result?.outcome??(hasLaneArtifacts?'NO FINAL RESULT':'NOT RUN'),
    duration,origin,stopReasons,budgetLimited,responseStops:wire.responseStops,
    usage:normalizeReplayUsage(result?.usage),usageComplete:result?.usage?.complete??null,
    usageSource:result?.usage?.source ?? result?.usage?.usageSource ?? null,
    events,tokenUpdates,timedEvents:timed.length,untimedEvents:events.length-timed.length,
    observedUntil:timed.length?Math.max(...timed.map(event=>event.t)):null,
    files,warnings,artifactCount:artifacts.length,artifactBytes:artifacts.reduce((n,a)=>n+(a.size??0),0),
    inventory:artifacts.map(({content,...metadata})=>metadata)};
  // Inspector resolves turns from exact run.json on demand; no duplicate prompt
  // object is embedded alongside that already-complete artifact.
  const payload={artifacts,result:result??null};
  return {lane,payload};
}

function advantages(lanes) {
  const results=[];
  for(const arm of ['bantam-local-27b','bantam-codex-astra']){
    const bantam=lanes.find(l=>l.arm===arm);
    if(!bantam?.result?.pass)continue;
    const peers=lanes.filter(l=>l.family===bantam.family&&l.arm!==arm&&l.result);
    for(const peer of peers){
      if(!peer.result.pass){
        results.push(`${bantam.label} achieved accepted completion; ${peer.label} recorded ${peer.outcome}${peer.stopReasons.length?' (recorded termination: '+peer.stopReasons.join(', ')+')':''}.${peer.budgetLimited?' That was a budget-limited incomplete run, not evidence of general model incapacity or a general BANTAM superiority claim.':''}`);continue;
      }
      const wins=[],tradeoffs=[];
      for(const [name,b,p] of [['wall time',bantam.duration,peer.duration],['fresh input',bantam.usage.freshInputTokens,peer.usage.freshInputTokens]]){
        if(name==='fresh input'&&(bantam.usageComplete===false||peer.usageComplete===false))continue;
        if(b===null||p===null||p===0)continue;
        if(b<p)wins.push(`${((p-b)/p*100).toFixed(1)}% less ${name}`);
        else if(b>p)tradeoffs.push(`${((b-p)/p*100).toFixed(1)}% more ${name}`);
      }
      if(wins.length)results.push(`${bantam.label} vs ${peer.label}, both accepted: ${wins.join(', ')}${tradeoffs.length?'; tradeoff: '+tradeoffs.join(', '):''}.`);
      else if(tradeoffs.length)results.push(`${bantam.label} vs ${peer.label}, both accepted: ${tradeoffs.join(', ')}. The wrapper did not improve these measured costs.`);
    }
  }
  return results;
}

/** Compare against the fastest accepted local peer, not a selected slowest rival. */
export function localTimeSignal(lanes) {
  const bantam=lanes.find(l=>l.arm==='bantam-local-27b');
  if(!bantam?.result?.pass||NUM(bantam.duration)===null)return null;
  const peers=lanes.filter(l=>l.family==='local'&&l.arm!==bantam.arm&&l.result?.pass&&NUM(l.duration)!==null&&l.duration>0)
    .sort((a,b)=>a.duration-b.duration||a.arm.localeCompare(b.arm));
  const peer=peers[0];if(!peer||bantam.duration>=peer.duration)return null;
  return {bantam:bantam.label,peer:peer.label,bantamMs:bantam.duration,peerMs:peer.duration,
    lessWallPercent:(peer.duration-bantam.duration)/peer.duration*100};
}

function staticSummary(manifest,cards) {
  const metric=value=>value===null||value===undefined?'unknown':Number(value).toLocaleString('en-US');
  return cards.map(card=>`<section class="static-card"><h2>${escape(card.title)} <small>Repeat ${card.repeat}</small></h2>
    <div class="table-scroll"><table><thead><tr><th>System</th><th>Outcome</th><th>Independent groups</th><th>Wall seconds</th><th>Input</th><th>Output</th><th>Cached input</th><th>Fresh input</th></tr></thead><tbody>
    ${card.lanes.map(l=>`<tr><th>${escape(l.label)}</th><td>${escape(l.outcome)}</td><td>${l.result?.grade?`${l.result.grade.groups.filter(g=>g.pass).length}/${l.result.grade.groups.length}`:'unknown'}</td><td>${l.duration===null?'unknown':(l.duration/1000).toFixed(1)}</td><td>${metric(l.usage.inputTokens)}</td><td>${metric(l.usage.outputTokens)}</td><td>${metric(l.usage.cacheHitTokens)}</td><td>${metric(l.usage.freshInputTokens)}</td></tr>`).join('')}
    </tbody></table></div></section>`).join('');
}

export function renderFactoryReplay({manifest,cards,payloads,presentation={}}) {
  const summary={manifest,cards,presentation};
  const interrupted=presentation.interruption!=null;
  const total=cards.reduce((n,c)=>n+c.lanes.filter(l=>l.result).length,0);
  const passed=cards.reduce((n,c)=>n+c.lanes.filter(l=>l.result?.pass).length,0);
  const selectedOnly=manifest.presentation?.selectedParticipantsOnly===true;
  const laneCount=new Set(cards.flatMap(c=>c.lanes.map(l=>l.arm))).size;
  const localCount=new Set(cards.flatMap(c=>c.lanes.filter(l=>l.family==='local').map(l=>l.arm))).size;
  const workCount=new Set(cards.map(c=>c.card)).size;
  const brandAsset=fs.readFileSync(path.join(REPO,'docs/brand/bantam-mark.svg'),'utf8').replace('<svg ','<svg style="color:#e8a33d" ');
  const brandImage='data:image/svg+xml;base64,'+Buffer.from(brandAsset).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>BANTAM / Factory fight cards</title><style>${STYLES}${POLISH_STYLES}
.selected-participants .lanes{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}
</style></head><body${selectedOnly?' class="selected-participants"':''}>
<div class="scanline" aria-hidden="true"></div><header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true"><img src="${brandImage}" alt="" width="82" height="82"></span><div><p class="eyebrow">THE FACTORY FLOOR / BANTAM SYSTEM TRIALS</p><h1>${selectedOnly?'Your tools.<br><em>Same work order.</em>':'Same silicon.<br><em>Different process.</em>'}</h1><p class="subhead">${selectedOnly?`${laneCount} selected participants. ${workCount} frozen work orders.<br>Recorded outcomes, including failures. Every result attached to its evidence.`:'Four harnesses on one local 27B. Two Astra systems alongside them.<br>Three useful machines to build. Every result attached to its evidence.'}</p></div></div><div class="edition"><span class="live-dot"></span> ${interrupted?'INTERRUPTED / DIAGNOSTIC ONLY':manifest.complete?'SERIES RECORDED':'PARTIAL SERIES'}<br><span>${escape(String(manifest.startedAt??'Date not recorded').slice(0,10))}</span><div class="edition-number" aria-hidden="true">${selectedOnly?String(laneCount).padStart(2,'0'):'06'}<span> / ${selectedOnly?String(workCount).padStart(2,'0'):'03'}</span></div><span>PRODUCTION LINES / WORK ORDERS</span></div></header>
<main>${interrupted?`<aside class="interrupted-notice"><b>INTERRUPTED SERIES / NOT A COMPLETED COMPARISON</b><p>Individual receipts are preserved as diagnostic evidence. This abandoned partial series does not promote comparative BANTAM wins or support a system ranking.</p><details><summary>Read exact INTERRUPTED.md · SHA-256 ${escape(presentation.interruption.sha256)}</summary><pre>${escape(presentation.interruption.content)}</pre></details></aside>`:''}<section class="overview" aria-label="Series facts"><div><span class="kicker">ACCEPTED COMPLETIONS</span><strong>${passed}<small> / ${total}</small></strong></div><div><span class="kicker">LOCAL COMPARISON</span><strong>${selectedOnly?localCount:4} <small>${selectedOnly?'selected local systems':'harnesses · 27B'}</small></strong><p>Same configured local model; different native working loops.</p></div><div><span class="kicker">FRONTIER COMPARISON</span><strong>${selectedOnly?laneCount-localCount:2} <small>${selectedOnly?'selected frontier systems':'systems · Astra'}</small></strong><p>${selectedOnly?'Only explicitly selected cloud participants are run.':'Native Codex and Codex inside BANTAM.'}</p></div><div><span class="kicker">THE STANDARD</span><strong>Evidence<small>, not confidence.</small></strong><p>Independent acceptance is separate from an agent saying “done”.</p></div></section>
<aside class="method-note"><b>Read this as an exploratory comparison, not a leaderboard.</b> ${escape(manifest.design??'Design metadata is missing.')} <span class="privacy">PRIVATE EVIDENCE · This portable file contains task/source/transcripts when recorded. Inspect before sharing. Nothing is automatically published.</span><a class="export-card" href="./fight-card.json" download>↓ Machine-readable fight card <span>metadata + evidence hashes · inspect before sharing</span></a></aside>
<div id="interactive" hidden><nav id="cards" class="card-tabs" aria-label="Fight cards"></nav><section class="arena-head"><div><p id="card-kind" class="eyebrow"></p><h2 id="card-title"></h2><p id="card-subtitle"></p></div><div class="arena-actions"><button class="outline" id="focus-button">Focus card ⤢</button><button class="outline" id="task-button">Read work order ↗</button></div></section>
<div class="view-bar"><div class="view-switch" role="group" aria-label="Presentation view"><button id="results-view" aria-pressed="false">Results</button><button id="replay-view" aria-pressed="false">Replay</button></div><p id="view-note"></p></div>
<section class="transport" aria-label="Synchronized elapsed-time replay"><button id="play" class="primary" aria-label="Play replay">▶ Play</button><button id="restart" class="icon-button" aria-label="Restart replay">↶</button><span class="clock" id="clock">0:00.0</span><input id="seek" type="range" min="0" max="1" step="1" value="0" aria-label="Replay elapsed milliseconds"><span id="duration" class="muted"></span><label class="speed">Speed <select id="speed"><option value="1">1×</option><option value="5">5×</option><option value="10" selected>10×</option><option value="30">30×</option><option value="60">60×</option></select></label><button id="finish" class="outline">Final receipts</button></section>
<p class="clock-note">Aligned at each run’s recorded start, not run simultaneously. No time compression inside a lane. Counters update when actual usage receipts arrive; they do not estimate in-flight tokens.</p><aside id="budget-note" class="budget-note" hidden></aside>
<section id="lanes" class="lanes" aria-label="Contender lanes"></section><section class="findings"><div><p class="eyebrow">EVIDENCE-BOUND SIGNAL</p><h3>What the receipts establish</h3><div id="local-signal"></div><p>One run per system on this card. Same-model comparisons; different native loops and settings. Every loss and unknown remains visible.</p></div><ul id="advantages"></ul></section></div>
<details class="method-details"><summary>Method, boundaries & source seals</summary><div class="method-grid"><section><h3>What was compared</h3><p>${escape(manifest.configuration?.sampling??'Sampling metadata unavailable.')}</p><p>${escape(manifest.configuration?.cache??'Cache-state metadata unavailable.')}</p><p>${escape(manifest.configuration?.isolation??'Isolation metadata unavailable.')}</p></section><section><h3>Evidence authority</h3><p>${escape(manifest.configuration?.evidence??'Evidence metadata unavailable.')}</p><p>The independent grader checks published behavior after generation. Model-authored probes and self-reported tests remain separate. A hash binds recorded bytes; it does not prove that a test is sufficient.</p></section><section><h3>Recorded identity</h3><dl><dt>Local model</dt><dd>${escape(manifest.modelId??'unknown')}</dd><dt>Model file SHA-256</dt><dd>${escape(manifest.modelFileSha256??'not recorded')}</dd><dt>Base commit</dt><dd>${escape(manifest.baseCommit??'unknown')}</dd><dt>Source mismatches</dt><dd>${escape(manifest.sourceMismatches===undefined?'not checked':JSON.stringify(manifest.sourceMismatches))}</dd><dt>Kit mismatches</dt><dd>${escape(manifest.kitMismatches===undefined?'not checked':JSON.stringify(manifest.kitMismatches))}</dd></dl><button class="outline" id="manifest-button">Inspect complete manifest</button></section></div></details>
<section class="score-sheet"><p class="eyebrow">ALL CARDS · ALL CONTENDERS · NO HIDDEN LOSSES</p><h2>The complete score sheet</h2>${staticSummary(manifest,cards)}</section>
<noscript><p class="notice">JavaScript is disabled. The complete static results and method remain readable above. Interactive event replay and compressed evidence inspection require JavaScript and a browser with DecompressionStream support.</p></noscript>
<footer>Factory fight cards · offline artifact · zero external assets or telemetry · unknown is never treated as zero.<br>Elapsed-time replay preserves recorded timing. Untimed records remain untimed. Presentation is not part of contender execution.<br>Community lessons are evidence for quarantined proposals and independent qualification—not executable instructions or automatic promotion.</footer></main>
<dialog id="inspector"><div class="inspector-head"><div><p id="inspect-eyebrow" class="eyebrow">AUDIT DESK</p><h2 id="inspect-title">Evidence</h2></div><button id="close-inspector" class="icon-button" aria-label="Close evidence inspector">✕</button></div><nav class="inspect-tabs" id="inspect-tabs" aria-label="Evidence categories"></nav><div id="inspect-body" class="inspect-body"></div></dialog>
<script id="summary-data" type="application/json">${scriptJSON(summary)}</script>
${payloads.map(({id,data})=>`<script id="payload-${escape(id)}" type="application/octet-stream">${data}</script>`).join('\n')}
<script>(${browserApp.toString()})();</script></body></html>`;
}

export function writeFactoryReplay(outputRoot) {
  if(typeof outputRoot!=='string'||!path.isAbsolute(outputRoot))throw Error('replay requires an absolute evidence directory');
  const root=fs.realpathSync(outputRoot),manifest=readJSON(path.join(root,'manifest.json'));
  if(!manifest||manifest.schema!=='bantam.factory-fights.v1')throw Error('missing or unsupported factory-fights manifest');
  const plan=Array.isArray(manifest.plan)?manifest.plan:[],results=Array.isArray(manifest.results)?manifest.results:[];
  let interruption=null;
  try{
    const note=path.join(root,'INTERRUPTED.md'),stat=fs.lstatSync(note);
    if(stat.isFile()&&!stat.isSymbolicLink()){
      const bytes=fs.readFileSync(note);interruption={path:'INTERRUPTED.md',size:bytes.length,sha256:SHA(bytes),content:bytes.toString('utf8')};
    }
  }catch{}
  let exchange=null;
  try{
    const file=path.join(root,'fight-card.json'),stat=fs.lstatSync(file);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=16*1024*1024){
      const bytes=fs.readFileSync(file);
      exchange={path:'fight-card.json',size:bytes.length,sha256:SHA(bytes),encoding:'base64',content:bytes.toString('base64')};
    }
  }catch{}
  const presentation={generatedAt:new Date().toISOString(),interruption,exchange};
  const identities=[...plan,...results];const cards=[],payloads=[],seen=new Set();
  for(const item of identities){
    if(!Number.isInteger(item.repeat)||item.repeat<1||!/^[a-z0-9-]+$/.test(item.card??''))throw Error('invalid card identity in manifest');
    const key=`${item.repeat}/${item.card}`;if(seen.has(key))continue;seen.add(key);
    const metadata=PUBLIC_FACTORY_CARDS[item.card];
    const card={id:`repeat-${item.repeat}-${item.card}`,card:item.card,repeat:item.repeat,title:metadata?.title??TITLES[item.card]??item.card,kind:metadata?.kind??'',description:metadata?.description??'',lanes:[]};
    const directory=path.join(root,`repeat-${item.repeat}`,item.card);
    let outer='';try{outer=fs.readFileSync(path.join(directory,'events.ndjson'),'utf8');}catch{}
    for(const arm of ARMS.filter(a=>!manifest.presentation?.selectedParticipantsOnly||identities.some(i=>i.repeat===item.repeat&&i.card===item.card&&i.arm===a))){
      const result=results.find(r=>r.repeat===item.repeat&&r.card===item.card&&r.arm===arm)??null;
      const built=buildReplayLane({directory:path.join(directory,arm),result,arm,card:item.card,repeat:item.repeat,outer,kitSeal:manifest.kitSeal??{},kitId:manifest.kitId??'factory-2026-09-06',
        identity:manifest.presentation?.selectedParticipantsOnly&&arm==='bantam-local-27b'?{family:'local',label:'BANTAM · selected model'}:null});
      if(manifest.presentation?.selectedParticipantsOnly&&arm==='bantam-local-27b')built.lane.label='BANTAM · selected model';
      card.lanes.push(built.lane);
      payloads.push({id:built.lane.id,data:gzipSync(Buffer.from(JSON.stringify(built.payload)),{level:9}).toString('base64')});
    }
    card.advantages=interruption?[]:advantages(card.lanes);card.localTimeSignal=interruption?null:localTimeSignal(card.lanes);cards.push(card);
  }
  const html=renderFactoryReplay({manifest,cards,payloads,presentation}),output=path.join(root,'fight-cards.html');
  fs.writeFileSync(output,html,{mode:0o600});
  return {output,cards:cards.length,lanes:cards.reduce((n,c)=>n+c.lanes.length,0),bytes:Buffer.byteLength(html)};
}

const STYLES = `
:root{color-scheme:dark;--bg:#0b1013;--panel:#121a1f;--panel2:#19232a;--line:#2a363e;--ink:#eff4f3;--muted:#97a9af;--amber:#ffbd58;--teal:#63e2c0;--red:#ff7e87;--blue:#91b7ff;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0,#27312655,transparent 42%),var(--bg);color:var(--ink)}button,input,select{font:inherit}button,select{cursor:pointer}button{border:1px solid var(--line);color:var(--ink);background:var(--panel2);border-radius:6px;padding:10px 13px;font-size:12px;font-weight:650}button:hover{border-color:var(--amber);background:#2c3029}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--teal);outline-offset:3px}.scanline{height:4px;background:linear-gradient(90deg,var(--amber) 0 34%,#bd8644 34% 35%,var(--teal) 35% 71%,#1e4041 71%)}.masthead{max-width:1800px;margin:auto;padding:42px 40px 28px;display:flex;justify-content:space-between;gap:24px}.brand{display:flex;gap:24px;align-items:flex-start}.brand-mark{font:900 47px/1 var(--mono);letter-spacing:-8px;color:var(--amber);padding:15px 22px 17px 12px;border:2px solid var(--amber);transform:skew(-5deg)}.eyebrow,.kicker{font:600 10px/1.5 var(--mono);letter-spacing:1.7px;color:var(--amber);margin:0 0 10px}h1{font-size:clamp(32px,3.6vw,57px);letter-spacing:-2px;line-height:1.06;margin:0 0 14px;font-weight:650}h1 em{font-style:normal;color:var(--teal)}.subhead{margin:0;color:var(--muted);font-size:14px;max-width:650px}.edition{font:600 11px/1.8 var(--mono);text-align:right;white-space:nowrap;padding-top:10px;color:var(--teal)}.edition span:not(.live-dot){color:var(--muted)}.live-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--teal);box-shadow:0 0 14px #63e2c055;margin-right:7px}main{max-width:1800px;margin:auto;padding:0 40px 40px}.overview{display:grid;grid-template-columns:.9fr 1.1fr 1.1fr 1.2fr;border:1px solid var(--line);background:linear-gradient(110deg,#1b2527,#111b21);border-radius:9px;overflow:hidden}.overview>div{padding:23px 25px;border-right:1px solid var(--line)}.overview>div:last-child{border:none}.overview .kicker{display:block;color:var(--muted);font-size:9px;letter-spacing:1.2px}.overview strong{font:650 31px/1.1 var(--mono);letter-spacing:-1px}.overview strong small{font:500 13px/1.2 system-ui;letter-spacing:0;color:var(--muted)}.overview p{font-size:11px;color:var(--muted);margin:10px 0 0;line-height:1.6}.method-note{font-size:12px;line-height:1.7;color:var(--muted);padding:18px 0 24px}.method-note b{font-weight:600;color:var(--ink)}.privacy{display:block;color:#c6a56f;font:10px/1.6 var(--mono);margin-top:9px}.card-tabs{display:flex;gap:8px;border-bottom:1px solid var(--line);padding-bottom:12px;overflow-x:auto;margin-top:8px}.card-tab{min-width:220px;padding:15px 20px;background:#11191e;text-align:left}.card-tab span{display:block;font:9px var(--mono);color:var(--muted);letter-spacing:1.2px;margin-bottom:7px}.card-tab[aria-selected=true]{border-color:var(--amber);background:linear-gradient(125deg,#30291d,#19211f);box-shadow:inset 0 -2px var(--amber)}.arena-head{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:28px 0 20px}.arena-head h2{font-size:29px;letter-spacing:-.8px;margin:0 0 8px}.arena-head p:not(.eyebrow){margin:0;font-size:12px;color:var(--muted)}.arena-head .eyebrow{font-size:9px}.outline{background:transparent}.primary{background:var(--amber);color:#1c1c17;border-color:var(--amber);min-width:83px}.primary:hover{background:#ffd18a}.icon-button{min-width:35px}.transport{display:flex;gap:12px;align-items:center;padding:15px 18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.clock{font:600 20px var(--mono);min-width:90px;text-align:center;color:var(--teal)}input[type=range]{accent-color:var(--amber);width:100%;flex:1;min-width:50px}.muted{font:11px var(--mono);color:var(--muted)}.speed{font-size:10px;color:var(--muted);display:flex;gap:7px;align-items:center}.speed select{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:6px;color:var(--ink)}.clock-note{font-size:10px;color:var(--muted);line-height:1.6;margin:10px 2px 18px}.lanes{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.lane{--accent:var(--blue);background:var(--panel);border:1px solid var(--line);border-radius:8px;min-width:0;overflow:hidden;position:relative}.lane.bantam{--accent:var(--amber);border-color:#77572e;box-shadow:0 0 22px #ffbd5809}.lane.astra{--accent:var(--teal)}.lane-head{border-top:3px solid var(--accent);padding:16px 14px 12px;min-height:101px;background:linear-gradient(140deg,#ffffff05,transparent)}.lane-family{font:8px var(--mono);letter-spacing:1px;color:var(--muted);margin-bottom:9px}.lane h3{font-size:14px;letter-spacing:-.3px;margin:0 0 12px}.status-line{display:flex;align-items:center;justify-content:space-between;gap:5px}.badge{font:700 9px var(--mono);letter-spacing:.7px;border:1px solid var(--line);border-radius:3px;padding:4px 6px;background:#283238;color:var(--muted)}.badge.pass{color:var(--teal);background:#63e2c015;border-color:#63e2c055}.badge.fail{color:var(--red);background:#ff7e8710;border-color:#ff7e8750}.badge.output{color:var(--amber);border-color:#ffbd5860}.lane-time{font:10px var(--mono);color:var(--muted)}.progress{height:3px;background:#26313a}.progress>i{display:block;height:100%;width:0;background:var(--accent);transition:width .1s linear}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:13px 8px;padding:17px 14px;border-bottom:1px solid var(--line)}.metric span{display:block;font:8px var(--mono);letter-spacing:.6px;color:var(--muted);margin-bottom:5px}.metric strong{font:600 18px var(--mono);letter-spacing:-.7px}.metric.cached strong{color:var(--teal)}.metric.fresh strong{color:var(--amber)}.metric-note{grid-column:1/-1;font:8px/1.6 var(--mono);color:var(--muted);min-height:25px}.current{padding:14px;border-bottom:1px solid var(--line);height:91px;overflow:hidden}.current .kicker{font-size:8px;letter-spacing:.8px}.current p{font:10px/1.6 var(--mono);margin:0;color:#c8d8dc;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.event-list{height:280px;overflow:auto;padding:6px 7px;scrollbar-width:thin;scrollbar-color:#425057 transparent}.event{border:none;border-left:2px solid #34434d;border-radius:0;display:block;width:100%;text-align:left;background:transparent;padding:8px 7px;margin:3px 0;color:var(--muted);opacity:.4}.event.observed{opacity:1}.event.active{background:#ffffff06;border-left-color:var(--accent)}.event.context{border-left-color:#91b7ff60}.event.tool,.event.observation{border-left-color:#63e2c060}.event.error{border-left-color:var(--red)}.event time{display:block;font:8px var(--mono);margin-bottom:5px;color:var(--accent)}.event b{display:block;font:500 9px/1.5 var(--mono);overflow-wrap:anywhere}.lane-bottom{padding:12px;border-top:1px solid var(--line)}.judge-line{display:flex;justify-content:space-between;font:10px var(--mono);margin-bottom:10px;color:var(--muted)}.judge-line strong{color:var(--ink)}.lane-bottom button{width:100%;font-size:10px;padding:9px}.unknown-note{font:9px/1.7 var(--mono);color:var(--muted);padding:20px 10px}.findings{display:grid;grid-template-columns:1fr 1.5fr;gap:35px;padding:26px;margin-top:24px;border:1px solid #6a5130;border-radius:8px;background:linear-gradient(120deg,#282417,#182421)}.findings h3{margin:0 0 10px;font-size:20px;letter-spacing:-.3px}.findings p{font-size:11px;line-height:1.8;color:var(--muted);margin:0}.findings ul{padding-left:16px;margin:0;font-size:12px;line-height:1.8}.findings li{padding:0 0 8px}.method-details{margin:28px 0;border:1px solid var(--line);border-radius:8px;background:#11191e}.method-details summary{cursor:pointer;padding:17px 20px;font-size:12px;font-weight:600}.method-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:30px;padding:0 22px 22px}.method-grid h3{font-size:13px;color:var(--teal)}.method-grid p,.method-grid dl{font-size:11px;line-height:1.8;color:var(--muted)}dt{color:var(--ink);margin-top:8px}dd{margin:0;font:10px/1.7 var(--mono);overflow-wrap:anywhere}.score-sheet{padding-top:15px}.score-sheet>h2{font-size:25px;letter-spacing:-.5px}.static-card{margin:25px 0 32px}.static-card h2{font-size:15px}.static-card h2 small{font-size:10px;color:var(--muted);font-weight:400}.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font:11px var(--mono);white-space:nowrap}th,td{padding:12px 14px;text-align:right;border-bottom:1px solid #253039}thead th{font-size:9px;color:var(--muted);background:var(--panel)}th:first-child{text-align:left}tbody th{font-weight:500}tbody tr:last-child>*{border-bottom:none}tbody tr:hover{background:#ffffff04}footer{font:10px/1.8 var(--mono);color:#748991;padding:25px 0 0;border-top:1px solid var(--line)}dialog{width:min(1200px,94vw);max-height:90vh;border:1px solid #55626b;border-radius:10px;background:#111a20;color:var(--ink);padding:0;box-shadow:0 35px 120px #000a}dialog::backdrop{background:#020709ce;backdrop-filter:blur(5px)}.inspector-head{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--line)}.inspector-head h2{font-size:21px;margin:0}.inspector-head .eyebrow{font-size:9px;margin-bottom:6px}.inspect-tabs{display:flex;gap:6px;padding:12px 20px;border-bottom:1px solid var(--line);overflow-x:auto}.inspect-tabs button{white-space:nowrap;font-size:11px}.inspect-tabs button[aria-selected=true]{color:var(--teal);border-color:var(--teal)}.inspect-body{padding:20px 24px;min-height:300px;max-height:65vh;overflow:auto}.inspect-body h3{font-size:14px;margin:8px 0 12px}.inspect-body p{font-size:12px;line-height:1.8;color:var(--muted)}.inspect-body pre{background:#090f13;border:1px solid var(--line);padding:16px;border-radius:5px;font:11px/1.7 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:48vh;overflow:auto;tab-size:2}.evidence-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0}.evidence-toolbar select{max-width:100%;min-width:200px;padding:9px;background:#1d2931;border:1px solid var(--line);color:var(--ink);font:11px var(--mono)}.evidence-toolbar button{font-size:10px}.artifact-meta{font:10px/1.8 var(--mono)!important;overflow-wrap:anywhere}.evidence-grid{display:grid;grid-template-columns:minmax(200px,.65fr) minmax(0,1.7fr);gap:20px}.record-list{max-height:51vh;overflow:auto;padding-right:8px}.record-list button{display:block;text-align:left;width:100%;margin:0 0 6px;font:10px/1.6 var(--mono);overflow-wrap:anywhere}.record-list button small{display:block;color:var(--muted)}.judge-group{padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--red);margin-bottom:8px;border-radius:4px;font:11px var(--mono)}.judge-group.pass{border-left-color:var(--teal)}.judge-group pre{margin-bottom:0}.diff-block{display:block;white-space:pre-wrap;padding:6px 12px;font:11px/1.7 var(--mono);overflow-wrap:anywhere}.diff-block.same{color:#87999f;background:#0d151a}.diff-block.added{color:#a6efcf;background:#17352d}.diff-block.removed{color:#ffb1b6;background:#382229}.notice{border:1px solid #77572e;background:#2b251b;padding:14px;color:var(--amber)!important;font-size:12px}.loading{color:var(--teal);font:12px var(--mono)}.artifact-selector{width:100%}.hidden{display:none!important}@media(min-width:1650px){.event-list{height:330px}.lane h3{font-size:16px}.metric strong{font-size:21px}}@media(max-width:1250px){main{padding:0 24px 30px}.masthead{padding:32px 24px 25px}.lanes{grid-template-columns:repeat(3,minmax(0,1fr))}.event-list{height:230px}.overview strong{font-size:25px}.overview>div{padding:20px 16px}.overview strong small{font-size:11px}.method-grid{gap:20px}}@media(max-width:760px){.masthead{padding:25px 16px}.brand{gap:14px}.brand-mark{font-size:32px;letter-spacing:-5px;padding:12px 15px 12px 8px}h1{font-size:32px;letter-spacing:-1px}.eyebrow{font-size:8px;letter-spacing:1px}.subhead{font-size:12px}.edition{display:none}main{padding:0 14px 25px}.overview{grid-template-columns:1fr 1fr}.overview>div{border-bottom:1px solid var(--line)}.overview>div:nth-child(2){border-right:none}.overview p{font-size:10px}.overview strong{font-size:22px}.arena-head{align-items:flex-start}.arena-head h2{font-size:24px}.arena-head button{max-width:120px;font-size:10px}.transport{gap:8px;flex-wrap:wrap;padding:12px}.transport input{order:5;flex-basis:100%}.transport #finish{margin-left:auto}.clock{min-width:70px;font-size:17px}.transport .muted{display:none}.lanes{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.lane h3{font-size:13px}.lane-head{padding:12px 10px}.metric strong{font-size:17px}.metrics{padding:13px 10px}.lane-family{font-size:7px}.event-list{height:210px}.findings{grid-template-columns:1fr;gap:18px;padding:20px}.method-grid{grid-template-columns:1fr}.evidence-grid{grid-template-columns:1fr}.record-list{max-height:180px}.inspect-body{padding:16px}.inspector-head{padding:16px}.inspect-tabs{padding:10px}.card-tab{min-width:190px}.score-sheet>h2{font-size:22px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}.scanline{animation:none}}@media print{body{background:white;color:black}.scanline,#interactive,.method-details button,dialog{display:none!important}.masthead{padding:15px 0}.brand-mark{color:black;border-color:black}.eyebrow,.kicker,h1 em,.edition,.privacy{color:#444}.overview{background:white}.overview p,.overview strong small,.method-note,footer,td,th{color:#333}.method-details{background:white}.method-details:not([open])>*:not(summary){display:block}.method-grid{display:block}.score-sheet{padding-top:0}.static-card{break-inside:avoid}table{font-size:8px}th,td{padding:7px}.table-scroll{overflow:visible}main{padding:0}.subhead{color:#444}}
`;

const POLISH_STYLES = `
.interrupted-notice{margin:0 0 24px;padding:20px;border:1px solid #a2634c;border-radius:7px;background:#33211c;color:#ffc5a2;font:12px/1.8 var(--mono)}.interrupted-notice p{color:#d7bbb0}.interrupted-notice summary{cursor:pointer;overflow-wrap:anywhere;font-size:10px}.interrupted-notice pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.8 var(--mono)}
.budget-note{font:11px/1.8 var(--mono);border:1px solid #886039;background:#2d2417;color:#f3c283;padding:14px 18px;margin:0 0 17px;border-radius:6px}.focus-card .masthead,.focus-card .overview,.focus-card .method-note{display:none}.focus-card main{padding-top:20px}.focus-banner{display:flex;align-items:center;justify-content:space-between;gap:15px;font:10px/1.7 var(--mono);color:var(--muted);margin-bottom:16px}.focus-banner button{font-size:10px}.focus-card .arena-head{padding-top:22px}
.stop-reason{font:8px/1.6 var(--mono);color:var(--muted);min-height:26px;margin:4px 0 10px;overflow-wrap:anywhere}.stop-reason.budget-stop{color:var(--amber)}.transport{position:sticky;top:8px;z-index:2}.lane{container-type:inline-size}.metric strong{font-size:clamp(12px,7cqw,20px)}
.masthead{padding-top:48px;padding-bottom:36px}.brand-mark{margin-top:4px}.brand .eyebrow{letter-spacing:2px;color:#c4d0ce;margin-bottom:15px}h1{font-size:clamp(38px,4.6vw,72px);line-height:1.04;letter-spacing:-3px}.subhead{line-height:1.75;margin-top:18px}.edition-number{font:600 86px/1 var(--mono);color:#29393b;letter-spacing:-7px;margin-top:28px}.edition-number span{font-size:45px!important;letter-spacing:-4px;color:#2b3b3e!important}.edition>span:last-child{font-size:8px;letter-spacing:1px}.export-card{display:inline-flex;flex-wrap:wrap;gap:12px;align-items:center;font:600 11px var(--mono);color:var(--teal);text-decoration:none;margin-top:15px;padding:10px 13px;border:1px solid #385b53;border-radius:5px;background:#63e2c009}.export-card:hover{background:#63e2c012;border-color:var(--teal)}.export-card span{font:9px var(--mono);color:var(--muted)}.card-tabs{margin-top:0}.lane.bantam .lane-head{background:linear-gradient(135deg,#ffbd5812,transparent)}.lane.astra .lane-head{background:linear-gradient(135deg,#63e2c00c,transparent)}.event-list{background-image:linear-gradient(#ffffff02 1px,transparent 1px);background-size:100% 28px}.static-card tbody tr:first-child th{color:var(--amber)}.static-card tbody tr:last-child th{color:var(--teal)}.transport{box-shadow:0 6px 24px #0002}.method-note{max-width:1300px}.lane-family{line-height:1.6}.current{height:100px}@media(max-width:760px){.masthead{padding-top:28px;padding-bottom:25px}.brand .eyebrow{letter-spacing:1px;font-size:7px}h1{font-size:38px;letter-spacing:-1.5px}.subhead{font-size:11px}.export-card span{display:block;flex-basis:100%;font-size:8px}.brand-mark{font-size:29px;margin-top:2px}.lane-family{min-height:22px}.lane h3{min-height:17px}.lane-head{min-height:105px}}@media print{h1{font-size:36px}.edition-number{display:none}.export-card{display:none}.masthead{padding-top:10px;padding-bottom:15px}}
/* Results are a compact receipt board; replay restores the timed event lanes. */
.brand-mark{transform:none;border:0;padding:0;letter-spacing:0;flex:none}.brand-mark img{display:block;width:82px;height:82px}.arena-actions{display:flex;gap:8px}.view-bar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:0 0 13px}.view-bar p{font:10px/1.7 var(--mono);color:var(--muted);margin:0;text-align:right}.view-switch{display:flex;padding:3px;background:#080e12;border:1px solid var(--line);border-radius:7px;gap:3px}.view-switch button{border-color:transparent;background:transparent;color:var(--muted);padding:9px 22px}.view-switch button[aria-pressed=true]{background:#28332f;color:var(--teal);border-color:#3c5b51}.results-view .transport,.results-view .clock-note{display:none}.results-view .event-list{display:none}.results-view .current{height:75px}.results-view .current .kicker{color:var(--teal)}.results-view .current p{-webkit-line-clamp:3}.acceptance-facts{display:grid;grid-template-columns:1fr auto;gap:6px;font:9px/1.4 var(--mono);margin:12px 0;color:var(--muted)}.acceptance-facts strong{font-weight:500;color:var(--ink)}.acceptance-facts .fact-fail{color:var(--red)}.acceptance-facts .fact-pass{color:var(--teal)}.signal-number{display:block;font:600 52px/1.1 var(--mono);letter-spacing:-3px;color:var(--amber);margin:14px 0 8px}.signal-number small{font:500 12px/1.5 system-ui;letter-spacing:0;color:var(--ink);display:block;margin-top:7px}.signal-pair{font:10px/1.8 var(--mono)!important;color:#d7ded8!important;margin:0 0 12px!important}.findings ul{font-size:11px}.results-view .findings{margin-top:18px}.focus-card .arena-head{padding-top:20px}.focus-card .findings{padding:20px 25px}.focus-card .signal-number{font-size:44px}.focus-card .method-details{margin-top:20px}@media(max-width:760px){.brand-mark img{width:48px;height:58px}.arena-actions{flex-direction:column;gap:6px;flex:none}.arena-actions button{font-size:9px;padding:8px}.view-bar{align-items:flex-start;gap:10px}.view-bar p{font-size:8px;max-width:155px}.view-switch button{padding:9px 15px;font-size:11px}.results-view .current{height:90px}.signal-number{font-size:42px}.acceptance-facts{font-size:8px;gap:6px 3px}.results-view .stop-reason{min-height:38px}.findings{gap:20px}}
.results-view .lane{display:flex;flex-direction:column}.results-view .lane-time{font-size:18px;font-weight:600;color:var(--ink);letter-spacing:-.8px}.results-view .lane-bottom{margin-top:auto}.results-view .current{height:auto;min-height:95px;flex:1;overflow:visible}.results-view .current p{display:block;-webkit-line-clamp:unset;overflow:visible}.focus-card #focus-button{display:none}@media(max-width:760px){.results-view .lane-time{font-size:15px;letter-spacing:-.7px}.results-view .status-line{gap:3px}.results-view .badge{font-size:8px;padding:4px}.results-view .current{min-height:112px}}
`;

function browserApp() {
  'use strict';
  const data=JSON.parse(document.getElementById('summary-data').textContent);
  const $=id=>document.getElementById(id),fmt=n=>n==null?'unknown':Math.round(n).toLocaleString('en-US');
  const clock=ms=>{if(ms==null)return 'unknown';const s=Math.max(0,ms)/1000;return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}.${Math.floor(s*10)%10}`;};
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const query=new URLSearchParams(location.search);
  let resultsView=query.get('view')==='final'||(query.get('view')!=='replay'&&data.manifest.complete===true&&!data.presentation?.interruption);
  let selected=0,time=0,playing=false,lastFrame=null,currentLane=null,currentPayload=null,currentTab='timeline';
  const cache=new Map();
  const activeCard=()=>data.cards[selected];
  const duration=()=>Math.max(1,...activeCard().lanes.map(l=>l.duration??l.observedUntil??0));
  const statusClass=outcome=>outcome==='PASS'?'pass':outcome==='OUTPUT_ONLY'?'output':['FAIL','TIMEOUT','SETUP_ERROR'].includes(outcome)?'fail':'';
  const append=(parent,...nodes)=>nodes.forEach(node=>parent.append(node));
  function button(text,fn,className){const b=el('button',text,className);b.addEventListener('click',fn);return b;}
  async function payload(lane){
    if(cache.has(lane.id))return cache.get(lane.id);
    if(typeof DecompressionStream!=='function')throw Error('This browser cannot decompress embedded evidence. Use a current browser with DecompressionStream support. The static score sheet still works.');
    const encoded=$(`payload-${lane.id}`).textContent.trim(),raw=atob(encoded),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const result=JSON.parse(await new Response(stream).text());cache.set(lane.id,result);return result;
  }
  function showDialog(title,eyebrow='AUDIT DESK'){
    $('inspect-title').textContent=title;$('inspect-eyebrow').textContent=eyebrow;
    if(!$('inspector').open)$('inspector').showModal();
  }
  function artifactBytes(artifact){return artifact.encoding==='base64'?Uint8Array.from(atob(artifact.content),c=>c.charCodeAt(0)):new TextEncoder().encode(artifact.content);}
  function download(artifact){
    const url=URL.createObjectURL(new Blob([artifactBytes(artifact)],{type:'application/octet-stream'}));
    const link=el('a');link.href=url;link.download=artifact.path.split('/').at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function artifactView(parent,path,line=null){
    parent.replaceChildren();
    const artifact=currentPayload?.artifacts.find(a=>a.path===path);
    append(parent,el('h3',path??'No artifact selected'));
    if(!artifact){append(parent,el('p','This artifact was not recorded or is unavailable.','notice'));return;}
    append(parent,el('p',`${fmt(artifact.size)} exact bytes · SHA-256 ${artifact.sha256??'not computed'}${line?' · selected record line '+line:''}`,'artifact-meta'));
    if(!artifact.embedded){append(parent,el('p',`Not embedded: ${artifact.reason??'unknown'}. The original evidence directory is required.`,'notice'));return;}
    const controls=el('div',undefined,'evidence-toolbar');controls.append(button('Download exact bytes',()=>download(artifact)));
    if(artifact.synthetic)controls.append(el('span',artifact.binding==='kitSeal'?'Frozen judge/work-order bytes verified against recorded kit hash.':'Starter bytes verified against recorded material hash.','muted'));
    parent.append(controls);
    if(artifact.encoding==='base64'){parent.append(el('p','Binary artifact; download preserves its exact bytes.'));return;}
    let value=artifact.content;
    if(line){const lines=value.split('\n');const start=Math.max(0,line-3);value=lines.slice(start,Math.min(lines.length,line+8)).map((text,i)=>`${start+i+1}  ${text}`).join('\n');}
    const pre=el('pre');pre.textContent=value.slice(0,150000);parent.append(pre);
    if(line||value.length>150000){
      parent.append(el('p',line?'Showing the selected record and surrounding lines. Exact complete artifact is downloadable.':`Preview limited to 150,000 of ${fmt(value.length)} characters; exact complete bytes are embedded.`,`artifact-meta`));
      controls.append(button('Show complete text',()=>{pre.textContent=artifact.content;}));
    }
  }
  function tabs(){
    const nav=$('inspect-tabs');nav.replaceChildren();
    for(const [id,label] of [['timeline','Timeline'],['context','Context & tools'],['code','Source & diff'],['judge','Independent judge'],['seals','Seals & configuration']]){
      const b=button(label,()=>{currentTab=id;renderInspector();});b.setAttribute('aria-selected',String(currentTab===id));nav.append(b);
    }
  }
  function chooseArtifact(parent,paths,initial){
    const controls=el('div',undefined,'evidence-toolbar'),select=el('select');select.setAttribute('aria-label','Recorded artifact');
    for(const path of paths){const option=el('option',path);option.value=path;select.append(option);}
    const viewer=el('div');if(initial&&paths.includes(initial))select.value=initial;
    select.addEventListener('change',()=>artifactView(viewer,select.value));
    append(controls,select);append(parent,controls,viewer);
    if(paths.length)artifactView(viewer,select.value);else viewer.append(el('p','No matching artifacts were recorded.','notice'));
  }
  function renderInspector(event=null){
    tabs();const body=$('inspect-body');body.replaceChildren();
    const lane=currentLane;if(!lane||!currentPayload)return;
    if(currentTab==='timeline'){
      body.append(el('p','Recorded times are relative to this run’s actual start. Untimed BANTAM turns are retained in their saved order and are never distributed across the clock. Console excerpts are display records; original stdout and full run artifacts remain available.'));
      const grid=el('div',undefined,'evidence-grid'),list=el('div',undefined,'record-list'),viewer=el('div');append(grid,list,viewer);body.append(grid);
      for(const record of lane.events){const b=button(`${record.t===null?'UNTIMED':clock(record.t)} · ${record.title}`,()=>showEvent(record,viewer));b.append(el('small',record.source));list.append(b);}
      if(event)showEvent(event,viewer);else if(lane.events.length)showEvent(lane.events[0],viewer);else viewer.append(el('p','No event records are available.','notice'));
    } else if(currentTab==='context'){
      body.append(el('p','Exact HTTP bodies, saved client sessions, and BANTAM turn context are different evidence layers. Only local wire files represent the recorded HTTP transport; native sessions do not expose provider-side hidden context. No transcript is reconstructed and called exact.'));
      chooseArtifact(body,currentPayload.artifacts.filter(a=>/^(wire\/|native-sessions\/)|(^run\.json$)|^(native\/.*\.(jsonl|ndjson|json|log)$)|^(stdout|stderr)\.log$/.test(a.path)).map(a=>a.path),event?.artifact);
    } else if(currentTab==='code'){
      body.append(el('p','Final candidate files and exact line comparisons. Starter content is shown only when its current bytes match the original recorded material seal. A source hash is provenance, not a correctness judgment.'));
      const controls=el('div',undefined,'evidence-toolbar'),select=el('select'),viewer=el('div');select.setAttribute('aria-label','Candidate file');
      for(const file of lane.files){const option=el('option',`${file.state.toUpperCase()} · ${file.path}`);option.value=file.path;select.append(option);}controls.append(select);append(body,controls,viewer);
      function display(){
        viewer.replaceChildren();const file=lane.files.find(f=>f.path===select.value);if(!file)return;
        const candidate=currentPayload.artifacts.find(a=>a.path===file.artifact),baseline=currentPayload.artifacts.find(a=>a.path===file.baseline);
        viewer.append(el('p',`Candidate SHA-256: ${file.sha256??'unavailable'} · final recorded seal: ${file.finalSealMatches===null||file.finalSealMatches===undefined?'not recorded':file.finalSealMatches?'matches':'MISMATCH'}`,'artifact-meta'));
        const actions=el('div',undefined,'evidence-toolbar');
        if(candidate?.embedded)actions.append(button('Download candidate',()=>download(candidate)));
        if(baseline?.embedded)actions.append(button('Download sealed starter',()=>download(baseline)));viewer.append(actions);
        if(candidate?.encoding==='utf8'&&baseline?.encoding==='utf8'){
          viewer.append(el('p','Line comparison: common leading/trailing lines are neutral; changed middle is shown as removal/addition (not a minimal edit script).'));
          for(const part of lineDiff(baseline.content,candidate.content))viewer.append(el('code',part.text,`diff-block ${part.kind}`));
        }else if(candidate?.encoding==='utf8'){
          viewer.append(el('p',file.state==='added'?'New file; no starter counterpart.':'Sealed starter bytes unavailable; showing candidate only.'));viewer.append(el('pre',candidate.content));
        }else viewer.append(el('p','File content is missing or binary; see exact artifact download.','notice'));
      }
      select.addEventListener('change',display);display();
    } else if(currentTab==='judge'){
      const r=lane.result;
      body.append(el('p','Independent acceptance runs after the candidate stops. Its groups check the published contract. The agent’s own “done”, its public test claims, and its experiment assertions are not the independent verdict.'));
      const facts={outcome:lane.outcome,recordedStopReasons:lane.stopReasons,candidatePass:r?.candidatePass??null,processCompleted:r?.processCompleted??null,
        acceptedCompletion:r?.acceptedCompletion??null,publicExit:r?.publicExit??null,hiddenExit:r?.hiddenExit??null,
        graderTimedOut:r?.graderTimedOut??null,tampered:r?.tampered??null,operatorInterventions:r?.operatorInterventions??null};
      body.append(el('pre',JSON.stringify(facts,null,2)));
      if(lane.budgetLimited)body.append(el('p','An output-budget boundary was recorded: native max-tokens and/or the latest recorded HTTP response finish field length. This is distinct from the controller wall-clock deadline. A failing run under this constraint is a budget-limited incomplete system run, not a finding that the underlying model cannot solve the task. Exact request limits, wire finish fields, and native termination receipts remain inspectable.','notice'));
      if(lane.responseStops.length){const details=el('details'),summary=el('summary','Exact response finish fields and recorded output limits');details.append(summary,el('pre',JSON.stringify(lane.responseStops,null,2)));body.append(details);}
      for(const group of r?.grade?.groups??[]){const row=el('div',`${group.pass?'PASS':'FAIL'} · ${group.name}`,`judge-group${group.pass?' pass':''}`);if(group.error)row.append(el('pre',group.error));body.append(row);}
      if(!r?.grade)body.append(el('p','No complete independent grader record is available.','notice'));
      chooseArtifact(body,currentPayload.artifacts.filter(a=>/^(public|hidden)\.(stdout|stderr)\.log$|^judge\//.test(a.path)).map(a=>a.path),'hidden.stdout.log');
    } else {
      body.append(el('p','These records bind model settings, task/material hashes, final source, execution, and judge results. Full manifest source/kit seals are available from the method panel. Native evidence is subordinate to the controller and independent judge where their authority differs.'));
      if(lane.warnings.length)body.append(el('pre',lane.warnings.join('\n')));
      if(lane.result?.serverUsage){body.append(el('h3','Supplementary server-counter window'));
        body.append(el('p','Global endpoint deltas are supplementary reconciliation, not per-request transport measurements. Attribution assumes no other inference client used the endpoint during this serial run. They must not be silently added to wire usage.'));
        body.append(el('pre',JSON.stringify(lane.result.serverUsage,null,2)));}
      chooseArtifact(body,currentPayload.artifacts.filter(a=>/^(result|command|task)\.|^server-usage\.json$|^native\/(launch|result|cleanup)\.json$|^factory\//.test(a.path)).map(a=>a.path),'result.json');
      const details=el('details'),summary=el('summary','Complete embedded artifact inventory');details.append(summary,el('pre',JSON.stringify(lane.inventory,null,2)));body.append(details);
    }
  }
  function showEvent(event,viewer){
    viewer.replaceChildren();viewer.append(el('h3',`${event.t===null?'Untimed':clock(event.t)} · ${event.title}`));
    viewer.append(el('p',`${event.source}. ${event.detail??''}`));
    if(event.modelCallPosition!==undefined&&event.artifact==='run.json'){
      const raw=currentPayload.artifacts.find(a=>a.path==='run.json');let run;
      try{run=JSON.parse(raw?.content);}catch{}
      const call=run?.modelCalls?.[event.modelCallPosition];
      if(call){
        viewer.append(el('p','Exact saved BANTAM model-call record. The request is the harness-level request; provider-internal context is not reconstructed. The settled response and attempt response can contain the same usage, which is counted only once.'));
        for(const field of ['index','startedAt','completedAt','status','request','transport','attempts','response','error','promptTelemetry']){
          if(call[field]===undefined||call[field]===null)continue;
          const details=el('details'),summary=el('summary',field);
          if(field===event.modelCallField)details.open=true;
          details.append(summary,el('pre',typeof call[field]==='string'?call[field]:JSON.stringify(call[field],null,2)));viewer.append(details);
        }
        return;
      }
    }
    if(event.turn!==undefined&&event.artifact==='run.json'){
      const raw=currentPayload.artifacts.find(a=>a.path==='run.json');let run;
      try{run=JSON.parse(raw?.content);}catch{}
      const turn=(run?.turns??run?.result?.turns??[]).find(t=>t.i===event.turn);
      if(turn){
        viewer.append(el('p','This is the exact saved turn record, not a reconstructed transport request.'));
        const fields=['prompt','reasoning','rawOutput','parsedAction','action','observation','rawObservation','shellExecution','verificationEvidence','probeEvidence'];
        for(const field of fields)if(turn[field]!==undefined&&turn[field]!==null){const details=el('details'),summary=el('summary',field);details.append(summary,el('pre',typeof turn[field]==='string'?turn[field]:JSON.stringify(turn[field],null,2)));viewer.append(details);}
        return;
      }
    }
    const controls=el('div',undefined,'evidence-toolbar'),artifact=el('div');viewer.append(controls,artifact);
    for(const ref of [event.artifact,...(event.related??[])].filter(Boolean))controls.append(button(ref,()=>artifactView(artifact,ref,ref===event.artifact?event.line:null)));
    artifactView(artifact,event.artifact,event.line);
  }
  async function inspect(lane,tab='timeline',event=null){
    currentLane=lane;currentTab=tab;currentPayload=null;
    showDialog(lane.label,`${activeCard().title.toUpperCase()} · REPEAT ${lane.repeat} · AUDIT DESK`);
    $('inspect-tabs').replaceChildren();$('inspect-body').replaceChildren(el('p','Decompressing this lane’s embedded evidence…','loading'));
    try{const result=await payload(lane);if(currentLane!==lane)return;currentPayload=result;renderInspector(event);}
    catch(error){$('inspect-body').replaceChildren(el('p',error.message,'notice'));}
  }
  function lineDiff(before,after){
    if(before===after)return[{kind:'same',text:before}];const a=before.split('\n'),b=after.split('\n');let p=0,s=0;
    while(p<a.length&&p<b.length&&a[p]===b[p])p++;
    while(s<a.length-p&&s<b.length-p&&a[a.length-1-s]===b[b.length-1-s])s++;
    const out=[];if(p)out.push({kind:'same',text:a.slice(0,p).join('\n')});
    if(a.length-p-s)out.push({kind:'removed',text:a.slice(p,a.length-s).join('\n')});
    if(b.length-p-s)out.push({kind:'added',text:b.slice(p,b.length-s).join('\n')});
    if(s)out.push({kind:'same',text:a.slice(a.length-s).join('\n')});return out;
  }
  function selectCard(index){
    selected=index;time=0;playing=false;lastFrame=null;
    const card=activeCard();$('card-title').textContent=card.title;$('card-kind').textContent=`CARD ${index+1} / ${data.cards.length} · REPEAT ${card.repeat}`;
    $('card-subtitle').textContent=[card.kind,card.description].filter(Boolean).join(' · ');
    [...$('cards').children].forEach((b,i)=>b.setAttribute('aria-selected',String(i===index)));
    $('seek').max=String(duration());$('duration').textContent=clock(duration());
    $('lanes').replaceChildren();
    for(const lane of card.lanes){
      const node=el('article',undefined,`lane ${lane.arm.startsWith('bantam')?'bantam':''} ${lane.family==='astra'?'astra':''}`);node.dataset.lane=lane.id;
      const head=el('div',undefined,'lane-head');append(head,el('div',lane.family==='local'?(data.manifest.presentation?.selectedParticipantsOnly?'LOCAL · SELECTED MODEL':'LOCAL 27B · SAME CONFIGURED WEIGHTS'):'GPT-6-ASTRA · MEDIUM','lane-family'),el('h3',lane.label));
      const status=el('div',undefined,'status-line');append(status,el('span',lane.outcome,`badge ${statusClass(lane.outcome)}`),el('span',lane.duration===null?'time unknown':clock(lane.duration),'lane-time'));head.append(status);
      const progress=el('div',undefined,'progress');progress.append(el('i'));const metrics=el('div',undefined,'metrics');
      for(const [key,label,kind] of [['inputTokens','INPUT',''],['outputTokens','OUTPUT',''],['cacheHitTokens','CACHED INPUT','cached'],['freshInputTokens','FRESH INPUT','fresh']]){
        const metric=el('div',undefined,`metric ${kind}`);append(metric,el('span',label),el('strong','unknown'));metric.dataset.metric=key;metrics.append(metric);
      }
      metrics.append(el('div','Awaiting recorded usage receipt','metric-note'));
      const current=el('div',undefined,'current');append(current,el('span','ON THE CLOCK','kicker'),el('p',lane.result?'Run begins at 0:00.0':'No result is recorded for this lane.'));
      const list=el('div',undefined,'event-list');
      for(const event of lane.events.filter(e=>e.t!==null)){
        const row=button('',()=>{time=event.t;playing=false;update();inspect(lane,'timeline',event);},`event ${event.kind}`);row.dataset.event=event.id;
        append(row,el('time',clock(event.t)),el('b',event.title));list.append(row);
      }
      if(!lane.timedEvents)list.append(el('p','No timestamped events were recorded. Untimed evidence is still inspectable.','unknown-note'));
      const bottom=el('div',undefined,'lane-bottom'),judge=el('div',undefined,'judge-line');
      append(judge,el('span','INDEPENDENT GROUPS'),el('strong',lane.result?.grade?`${lane.result.grade.groups.filter(g=>g.pass).length}/${lane.result.grade.groups.length}`:'unknown'));
      const facts=el('div',undefined,'acceptance-facts');
      const checks=[['Public suite',lane.result?.publicExit==null?null:lane.result.publicExit===0],
        ['Protected files',Array.isArray(lane.result?.tampered)?lane.result.tampered.length===0:null],
        ['Process finished',lane.result?.processCompleted??null]];
      for(const [label,value] of checks)append(facts,el('span',label),el('strong',value===true?'passed':value===false?'failed':'unknown',value===true?'fact-pass':value===false?'fact-fail':''));
      const stop=el('p',lane.stopReasons.length?`STOP / ${lane.stopReasons.join(' · ')}`:'STOP / no explicit native reason recorded','stop-reason');
      if(lane.budgetLimited)stop.classList.add('budget-stop');
      append(bottom,judge,facts,stop,button(`Inspect ${lane.artifactCount} artifacts ↗`,()=>inspect(lane),'outline'));
      append(node,head,progress,metrics,current,list,bottom);$('lanes').append(node);
    }
    $('advantages').replaceChildren();
    document.querySelector('.findings h3').textContent=data.presentation?.interruption?'Interrupted series · diagnostic only':'What the receipts establish';
    const findings=data.presentation?.interruption?['This series was explicitly interrupted. No comparative BANTAM win is promoted from these partial results. Read the preserved stop note and individual receipts as development evidence.']:
      card.advantages.length?card.advantages:['No qualified BANTAM advantage is established by this card’s available receipts.'];
    for(const statement of findings)$('advantages').append(el('li',statement));
    $('local-signal').replaceChildren();
    if(card.localTimeSignal&&!data.presentation?.interruption){
      const s=card.localTimeSignal,number=el('strong',`${s.lessWallPercent.toFixed(1)}%`,'signal-number');
      number.append(el('small','less wall time than the fastest accepted local peer'));
      append($('local-signal'),number,el('p',`${s.bantam} ${clock(s.bantamMs)} / ${s.peer} ${clock(s.peerMs)} · both accepted`,'signal-pair'));
    }
    const limited=card.lanes.filter(l=>l.budgetLimited);
    $('budget-note').hidden=limited.length===0;
    if(limited.length){
      const cap=data.manifest.limits?.peerDeclaredOutput;
      $('budget-note').textContent=`OUTPUT-BUDGET BOUNDARY${cap!=null?' / '+fmt(cap)+' declared tokens per peer response':''} — ${limited.map(l=>l.label).join(', ')} recorded max-tokens/length termination evidence. These constrained runs do not establish a model capability ceiling or general harness superiority. Read the exact request limits and stop receipts alongside acceptance.`;
    }
    if(resultsView)time=duration();update();
  }
  function update(){
    document.body.classList.toggle('results-view',resultsView);
    $('results-view').setAttribute('aria-pressed',String(resultsView));$('replay-view').setAttribute('aria-pressed',String(!resultsView));
    $('view-note').textContent=resultsView?'FINAL RECEIPTS / Independent groups ≠ full acceptance':'ELAPSED-TIME REPLAY / Recorded starts aligned';
    $('clock').textContent=clock(time);$('seek').value=String(time);$('play').textContent=playing?'Ⅱ Pause':'▶ Play';
    for(const lane of activeCard().lanes){
      const node=[...$('lanes').children].find(n=>n.dataset.lane===lane.id),ended=resultsView||(lane.duration!==null&&time>=lane.duration);
      node.querySelector('.progress i').style.width=`${lane.duration===null?0:Math.min(100,time/Math.max(1,lane.duration)*100)}%`;
      const updates=lane.tokenUpdates.filter(u=>u.t<=time),last=updates.at(-1),usage=ended?lane.usage:last??{};
      for(const metric of node.querySelectorAll('[data-metric]'))metric.querySelector('strong').textContent=fmt(usage[metric.dataset.metric]);
      node.querySelector('.metric-note').textContent=ended?`${lane.usageComplete===false?'INCOMPLETE RECEIPT TOTALS':'FINAL RECEIPT TOTALS'} · ${lane.usageSource??'source details in result.json'}`:last?`${last.partial?'OBSERVED PARTIAL':'RECORDED SO FAR'} · ${last.measured} ${last.source.includes('session')?'sessions':'responses'}`:'No usage receipt yet; in-flight tokens are not estimated.';
      const observed=lane.events.filter(e=>e.t!==null&&e.t<=time),active=observed.at(-1);
      node.querySelector('.current .kicker').textContent=ended?'RECORDED OUTCOME':'ON THE CLOCK';
      node.querySelector('.current p').textContent=ended?`${lane.outcome}${lane.stopReasons.length?' · stop: '+lane.stopReasons.join(', '):''} · candidate acceptance ${lane.result?.candidatePass===true?'passed':lane.result?.candidatePass===false?'failed':'unknown'} · ${lane.untimedEvents} untimed records available`:active?`${active.title}${active.detail?' — '+active.detail:''}`:lane.result?'Run begins at 0:00.0':'No result recorded.';
      for(const eventNode of node.querySelectorAll('[data-event]')){
        const event=lane.events[Number(eventNode.dataset.event)];eventNode.classList.toggle('observed',event.t<=time);eventNode.classList.toggle('active',active?.id===event.id);
      }
      const list=node.querySelector('.event-list');
      if(playing&&active&&list.dataset.active!==String(active.id)){
        const row=list.querySelector(`[data-event="${active.id}"]`);
        if(row)list.scrollTop=Math.max(0,row.offsetTop-list.offsetTop-list.clientHeight/2);
        list.dataset.active=String(active.id);
      }
    }
  }
  function animate(now){
    if(playing){if(lastFrame!==null)time=Math.min(duration(),time+(now-lastFrame)*Number($('speed').value));if(time>=duration())playing=false;update();}
    lastFrame=now;requestAnimationFrame(animate);
  }
  $('close-inspector').addEventListener('click',()=>$('inspector').close());
  $('inspector').addEventListener('click',event=>{if(event.target===$('inspector'))$('inspector').close();});
  $('manifest-button').addEventListener('click',()=>{
    showDialog('Complete series manifest','SOURCE, MODEL, MATERIALS & METHOD');$('inspect-tabs').replaceChildren();$('inspect-body').replaceChildren(el('pre',JSON.stringify(data.manifest,null,2)));
  });
  if(data.presentation?.exchange){
    const link=document.querySelector('.export-card');
    link.title=`Exact recorded export · ${fmt(data.presentation.exchange.size)} bytes · SHA-256 ${data.presentation.exchange.sha256}`;
    link.addEventListener('click',event=>{event.preventDefault();download(data.presentation.exchange);});
  }
  if(!data.cards.length){$('interactive').hidden=true;return;}
  for(const [index,card] of data.cards.entries()){
    const b=button('',()=>selectCard(index),'card-tab');append(b,el('span',`0${index+1} · REPEAT ${card.repeat}`),el('b',card.title));b.setAttribute('role','tab');$('cards').append(b);
  }
  $('play').addEventListener('click',()=>{resultsView=false;if(time>=duration())time=0;playing=!playing;lastFrame=null;update();});
  $('restart').addEventListener('click',()=>{resultsView=false;time=0;playing=false;update();});
  $('finish').addEventListener('click',()=>{resultsView=true;time=duration();playing=false;update();});
  $('results-view').addEventListener('click',()=>{resultsView=true;time=duration();playing=false;update();});
  $('replay-view').addEventListener('click',()=>{resultsView=false;time=0;playing=false;update();});
  $('seek').addEventListener('input',()=>{resultsView=false;time=Number($('seek').value);playing=false;update();});
  $('task-button').addEventListener('click',async()=>{
    const lane=activeCard().lanes.find(l=>l.inventory.some(a=>a.path==='task.md'));
    if(!lane){showDialog('Work order unavailable');$('inspect-tabs').replaceChildren();$('inspect-body').replaceChildren(el('p','No task artifact was recorded.','notice'));return;}
    await inspect(lane,'seals');artifactView($('inspect-body'),'task.md');
  });
  const initial=data.cards.findIndex(card=>card.card===query.get('card')&&String(card.repeat)===(query.get('repeat')??'1'));
  $('interactive').hidden=false;selectCard(initial<0?0:initial);
  function focusCard(){
    if(document.body.classList.contains('focus-card'))return;
    document.body.classList.add('focus-card');const banner=el('div',undefined,'focus-banner');
    append(banner,el('span',data.manifest.presentation?.selectedParticipantsOnly?'FACTORY FLOOR / PRIVATE RECORDED EVIDENCE · Your selected participants.':'FACTORY FLOOR / PRIVATE RECORDED EVIDENCE · Four local 27B systems; two Astra systems.'),
      button('Show full report',()=>{document.body.classList.remove('focus-card');banner.remove();},'outline'));
    $('interactive').prepend(banner);
  }
  $('focus-button').addEventListener('click',focusCard);
  if(query.get('focus')==='card')focusCard();
  requestAnimationFrame(animate);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(writeFactoryReplay(process.argv[2]))+'\n');}
  catch(error){process.stderr.write(`${error.stack}\n`);process.exitCode=1;}
}
