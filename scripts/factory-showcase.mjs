#!/usr/bin/env node
// Offline presentation only. Never runs a model, contender, judge or imported code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {buildReplayLane,normalizeReplayUsage,replayLineDiff} from './factory-fight-replay.mjs';
import {deriveSavedWireUsage} from './fight-usage-report.mjs';
import {factoryKit, PUBLIC_FACTORY_CARDS} from './factory-card-catalog.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SHA=b=>crypto.createHash('sha256').update(b).digest('hex');
const FIELDS=['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'];
const N=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const BOOL=v=>typeof v==='boolean'?v:null;
const E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const J=v=>JSON.stringify(v).replace(/[<>&\u2028\u2029]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const readJSON=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const CARDS=PUBLIC_FACTORY_CARDS;
const SYSTEMS={
  'bantam-local-27b':['BANTAM · 27B','local','Qwen 27B · same local weights'],
  'deepseek-local-27b':['DeepSeek Harness','local','Qwen 27B · same local weights'],
  opencode:['OpenCode','local','Qwen 27B · same local weights'],
  hermes:['Hermes','local','Qwen 27B · same local weights'],
  'codex-astra':['Codex · Astra','astra','GPT-6 Astra · native CLI'],
  'bantam-codex-astra':['BANTAM · Astra','astra','GPT-6 Astra · wrapped CLI'],
};
const OUTCOMES=new Set(['PASS','OUTPUT_ONLY','TIMEOUT','FAIL','SETUP_ERROR']);
const knownDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)?v:null;
const counts=rows=>({observed:rows.filter(r=>r.recorded).length,planned:rows.length,
  accepted:rows.filter(r=>r.accepted===true).length,completed:rows.filter(r=>r.completed===true).length,
  pass:rows.filter(r=>r.outcome==='PASS').length,
  groupsMeasured:rows.filter(r=>r.recorded&&r.groupsPassed!==null&&r.groupsTotal!==null).length,
  groupsPassed:rows.reduce((s,r)=>s+(r.groupsPassed??0),0),groupsTotal:rows.reduce((s,r)=>s+(r.groupsTotal??0),0)});

function identity(manifest,arm){
  if(SYSTEMS[arm])return {label:SYSTEMS[arm][0],family:SYSTEMS[arm][1],model:SYSTEMS[arm][2]};
  if(manifest.schema!=='bantam.factory-local-variant.v1'||arm!==manifest.arm
    ||!/^bantam-local-[a-z0-9][a-z0-9-]{0,119}$/.test(arm))throw Error('unsupported or unbound model identity');
  // Public labels are selected from model identity, never copied from free text.
  const isTiel=/(?:^|\/)Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS\.gguf$/.test(manifest.modelId??'');
  return {label:isTiel?'BANTAM · Tiel':'BANTAM · local variant',family:'local',
    model:isTiel?'Tiel 35B-A3B · IQ4_XS':'Explicit local variant · inspect private provenance'};
}
function seriesTitle(m,index){
  if(m.schema==='bantam.factory-fights.v1')return 'The original factory comparison';
  const tail=String(m.variantId??'').match(/-(repair|confirmation)([1-9][0-9]{0,3})$/);
  const worker=identity(m,m.arm).label==='BANTAM · Tiel'?'Tiel':'Local worker';
  return tail?`${worker} · ${tail[1]==='repair'?'repair':'confirmation'} ${Number(tail[2])}`:`Local worker · edition ${index+1}`;
}
function metrics(usage){return normalizeReplayUsage(usage);}
function coverageOf(usage,report){
  return Object.fromEntries(FIELDS.map(field=>{
    const c=report?.usage?.coverage?.[field];
    const total=N(c?.totalRequests??usage?.requests),measured=N(c?.measuredRequests??usage?.measuredRequests);
    return [field,{measuredRequests:measured,totalRequests:total,
      complete:BOOL(c?.complete??(usage?.complete===false?false:undefined)),
      missingRequestIndices:Array.isArray(c?.missingRequestIndices)?c.missingRequestIndices.filter(v=>Number.isSafeInteger(v)&&v>=0):[]}];
  }));
}
function usageProjection(result,report){
  const usage=report?.usage??result?.usage??null;
  const full=metrics(usage),subset=report?.usage?.measuredSubset;
  return {full,subset:subset?metrics(subset):null,native:result?.nativeUsage?metrics(result.nativeUsage):null,
    server:result?.serverUsage?metrics(result.serverUsage):null,complete:BOOL(usage?.complete),
    requests:N(usage?.requests),measuredRequests:N(usage?.measuredRequests),coverage:coverageOf(usage,report),
    serverIdleBefore:BOOL(result?.serverUsage?.idleBefore),serverIdleAfter:BOOL(result?.serverUsage?.idleAfter),
    gaps:(report?.gaps??[]).map(g=>({index:N(g.index),missingFields:(g.missingFields??[]).filter(f=>FIELDS.includes(f)),
      finished:BOOL(g.finished),responseBytes:N(g.responseBytes)}))};
}
function numericUpdates(updates){return (updates??[]).filter(u=>N(u.t)!==null).map(u=>({t:u.t,...metrics(u),partial:u.partial===true}));}
export function showcaseAcceptanceAt(row,{results=false,t=0}={}){
  const ended=results||(typeof row.wallMs==='number'&&Number.isFinite(row.wallMs)&&row.wallMs>=0&&t>=row.wallMs);
  return {ended,accepted:ended?row.accepted:null,completed:ended?row.completed:null};
}
export function sameModelObservation(rows){
  const b=rows.find(r=>r.arm==='bantam-local-27b'),d=rows.find(r=>r.arm==='deepseek-local-27b');
  if(b?.outcome!=='PASS'||d?.outcome!=='PASS'||!(b.wallMs>0)||!Number.isFinite(b.wallMs)||!Number.isFinite(d.wallMs)||d.wallMs<=b.wallMs)return null;
  return {ratio:d.wallMs/b.wallMs,savedWallMs:d.wallMs-b.wallMs};
}
function publicAccounting(a={}){
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const indices=v=>Array.isArray(v)?v.filter(x=>count(x)!==null):[];
  return {full:metrics(a.full),subset:a.subset?metrics(a.subset):null,native:a.native?metrics(a.native):null,
    server:a.server?metrics(a.server):null,complete:BOOL(a.complete),requests:count(a.requests),measuredRequests:count(a.measuredRequests),
    serverIdleBefore:BOOL(a.serverIdleBefore),serverIdleAfter:BOOL(a.serverIdleAfter),
    coverage:Object.fromEntries(FIELDS.map(f=>{const c=a.coverage?.[f];return [f,{measuredRequests:count(c?.measuredRequests),
      totalRequests:count(c?.totalRequests),complete:BOOL(c?.complete),missingRequestIndices:indices(c?.missingRequestIndices)}];})),
    gaps:(Array.isArray(a.gaps)?a.gaps:[]).map(g=>({index:count(g.index),missingFields:(Array.isArray(g.missingFields)?g.missingFields:[]).filter(f=>FIELDS.includes(f)),
      finished:BOOL(g.finished),responseBytes:count(g.responseBytes)}))};
}
function publicIdentity(row){
  if(SYSTEMS[row.arm])return {arm:row.arm,label:SYSTEMS[row.arm][0],model:SYSTEMS[row.arm][2],family:SYSTEMS[row.arm][1],bantam:row.arm.startsWith('bantam-')};
  const tiel=row.model==='Tiel 35B-A3B · IQ4_XS'&&/^bantam-local-[a-z0-9][a-z0-9-]{0,119}$/.test(row.arm??'');
  return {arm:'bantam-local-variant',label:tiel?'BANTAM · Tiel':'BANTAM · local variant',model:tiel?'Tiel 35B-A3B · IQ4_XS':'Explicit local variant',family:'local',bantam:true};
}

/** Strict public projection: no arbitrary metadata strings, paths, code or logs. */
export function publicShowcaseData(privateData){
  return {schema:'bantam.factory-showcase.v1',mode:'public',generatedAt:knownDate(privateData.generatedAt),
    privacy:{redacted:true,rawEvidenceIncluded:false,policy:'Explicit numeric/public-task allowlist; private logs, paths, source, prompts, group names and configuration omitted.'},
    series:privateData.series.map((s,si)=>({id:`series-${si+1}`,title:s.kind==='comparison'?'The original factory comparison':`Local worker · edition ${si+1}`,
      kind:s.kind==='comparison'?'comparison':'variant',complete:s.complete===true,startedAt:knownDate(s.startedAt),finishedAt:knownDate(s.finishedAt),
      counts:counts(s.cards.flatMap(c=>c.rows).map(r=>({...r,groupsPassed:N(r.groupsPassed),groupsTotal:N(r.groupsTotal)}))),cards:s.cards.map(c=>{
        if(!Object.hasOwn(CARDS,c.card)||!Number.isSafeInteger(c.repeat)||c.repeat<1)throw Error('invalid public card identity');
        return {id:`s${si+1}-${c.card}-r${c.repeat}`,card:c.card,...CARDS[c.card],repeat:c.repeat,
        rows:c.rows.map((r,ri)=>({id:`s${si+1}-${c.card}-r${c.repeat}-lane${ri+1}`,...publicIdentity(r),
          recorded:r.recorded===true,outcome:OUTCOMES.has(r.outcome)?r.outcome:'NOT RECORDED',
          accepted:BOOL(r.accepted),completed:BOOL(r.completed),wallMs:N(r.wallMs),groupsPassed:N(r.groupsPassed),groupsTotal:N(r.groupsTotal),
          publicExit:N(r.publicExit),hiddenExit:N(r.hiddenExit),protectedChanges:N(r.protectedChanges),
          accounting:publicAccounting(r.accounting),tokenUpdates:numericUpdates(r.tokenUpdates),events:[],timedEvents:N(r.timedEvents),untimedEvents:N(r.untimedEvents),
          stopReasons:[],files:[],inventory:[],warnings:[],artifactCount:0,artifactBytes:0}))};})}))};
}

export function buildShowcase({roots,mode='private',limits={},now=new Date().toISOString()}){
  if(!['private','public'].includes(mode)||!Array.isArray(roots)||roots.length<1||roots.length>12)throw Error('requires 1..12 series roots and explicit private/public mode');
  const series=[],payloads=[],seen=new Set();
  for(const [si,input]of roots.entries()){
    if(typeof input!=='string'||!path.isAbsolute(input))throw Error('series roots must be absolute');
    const root=fs.realpathSync(input);if(seen.has(root))throw Error('duplicate series root');seen.add(root);
    const manifestPath=path.join(root,'manifest.json'),stat=fs.lstatSync(manifestPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('invalid manifest file');
    const raw=fs.readFileSync(manifestPath),m=JSON.parse(raw);
    if(!['bantam.factory-fights.v1','bantam.factory-local-variant.v1'].includes(m.schema))throw Error('unsupported showcase series schema');
    const kit=factoryKit(m.kitId??'factory-2026-09-06');
    if(!Array.isArray(m.plan)||!Array.isArray(m.results)||m.plan.length>200||m.results.length>200)throw Error('invalid series records');
    const key=r=>`${r.repeat}/${r.card}/${r.arm}`,rowsByKey=new Map();
    for(const r of m.results){if(rowsByKey.has(key(r)))throw Error('duplicate result identity');rowsByKey.set(key(r),r);}
    const cards=new Map(),seenIdentities=new Set();
    for(const item of [...m.plan,...m.results]){
      if(!kit.cards.includes(item.card)||!Number.isInteger(item.repeat)||item.repeat<1||item.repeat>100)throw Error('invalid card/repeat for the recorded kit');
      const system=identity(m,item.arm),k=key(item);if(seenIdentities.has(k))continue;seenIdentities.add(k);
      const result=rowsByKey.get(k)??null,cardKey=`${item.repeat}/${item.card}`;
      if(!cards.has(cardKey))cards.set(cardKey,{id:`s${si+1}-${item.card}-r${item.repeat}`,card:item.card,...CARDS[item.card],repeat:item.repeat,rows:[]});
      const directory=path.join(root,`repeat-${item.repeat}`,item.card,item.arm);
      let outer='';try{outer=fs.readFileSync(path.join(root,`repeat-${item.repeat}`,item.card,'events.ndjson'),'utf8');}catch{}
      let report=null,reportError=null;
      if(fs.existsSync(path.join(directory,'wire','exchanges.jsonl'))){
        try{report=deriveSavedWireUsage(path.join(directory,'wire'));}catch(error){reportError=String(error.message);}
      }
      const built=buildReplayLane({directory,result,arm:item.arm,card:item.card,repeat:item.repeat,outer,limits,kitSeal:m.kitSeal??{},kitId:kit.id,identity:system});
      const id=`s${si+1}-${built.lane.id}`,groups=result?.grade?.groups;
      const row={...built.lane,id,...system,bantam:item.arm.startsWith('bantam-'),recorded:result!==null,
        outcome:OUTCOMES.has(result?.outcome)?result.outcome:'NOT RECORDED',accepted:BOOL(result?.candidatePass),completed:BOOL(result?.processCompleted),
        wallMs:N(result?.wallMs),groupsPassed:Array.isArray(groups)?groups.filter(g=>g.pass===true).length:null,groupsTotal:Array.isArray(groups)?groups.length:null,
        publicExit:N(result?.publicExit),hiddenExit:N(result?.hiddenExit),protectedChanges:Array.isArray(result?.tampered)?result.tampered.length:null,
        accounting:usageProjection(result,report),meteringValidationError:reportError};
      delete row.result;
      if(report){const content=JSON.stringify(report,null,2)+'\n';built.payload.artifacts.push({path:'derived/saved-wire-usage.json',content,encoding:'utf8',embedded:true,
        size:Buffer.byteLength(content),sha256:SHA(content),synthetic:true,binding:'derived from saved body hashes; original receipts unchanged'});}
      if(reportError)row.warnings.push(`Saved metering evidence did not validate: ${reportError}; no repaired totals substituted.`);
      if(mode==='private')payloads.push({id,data:gzipSync(Buffer.from(JSON.stringify(built.payload)),{level:6}).toString('base64')});
      cards.get(cardKey).rows.push(row);
    }
    const cardList=[...cards.values()];
    series.push({id:`series-${si+1}`,title:seriesTitle(m,si),kind:m.schema==='bantam.factory-fights.v1'?'comparison':'variant',
      complete:m.complete===true,startedAt:m.startedAt??null,finishedAt:m.finishedAt??null,counts:counts(cardList.flatMap(c=>c.rows)),cards:cardList,
      provenance:{manifestSha256:SHA(raw),manifest:m,manifestBytes:{encoding:'base64',content:raw.toString('base64'),size:raw.length,sha256:SHA(raw)},
        root,sourceFiles:Object.keys(m.sourceSeal??{}).length,kitFiles:Object.keys(m.kitSeal??{}).length}});
  }
  const data={schema:'bantam.factory-showcase.v1',mode:'private',generatedAt:now,
    privacy:{redacted:false,rawEvidenceIncluded:true,policy:'Private, non-redacted evidence. Inspect before sharing; no automatic publication.'},series};
  return {data:mode==='public'?publicShowcaseData(data):data,payloads:mode==='private'?payloads:[]};
}

function scoreTable(series){
  return `<section class="static-series"><h2>${E(series.title)}</h2><p>${series.counts.pass}/${series.counts.observed} strict PASS · ${series.counts.accepted} accepted projects · ${series.counts.completed} clean completions</p>${series.cards.map(card=>`<h3>${E(card.title)} <small>repeat ${card.repeat}</small></h3><div class="table-wrap"><table><thead><tr><th>System</th><th>Outcome</th><th>Accepted</th><th>Completed</th><th>Time</th><th>Judge</th><th>Input</th><th>Output</th><th>Cached</th><th>Fresh</th></tr></thead><tbody>${card.rows.map(r=>`<tr><th>${E(r.label)}</th><td>${E(r.outcome)}</td><td>${r.accepted===null?'unknown':r.accepted?'yes':'no'}</td><td>${r.completed===null?'unknown':r.completed?'yes':'no'}</td><td>${r.wallMs===null?'unknown':(r.wallMs/1000).toFixed(3)+'s'}</td><td>${r.groupsPassed??'?'} / ${r.groupsTotal??'?'}</td>${FIELDS.map(f=>`<td>${r.accounting.full[f]===null?'unknown':r.accounting.full[f].toLocaleString('en-US')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}</section>`;
}

export function renderShowcase({data,payloads}){
  const brand=fs.readFileSync(path.join(ROOT,'docs/brand/bantam-mark.svg')).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><title>BANTAM Arena · Recorded factory trials</title><style>${CSS}</style></head><body>
<div class="top-stripe"></div><header class="topbar"><a class="wordmark" href="#"><img src="data:image/svg+xml;base64,${brand}" alt="" width="44" height="44"><span>BANTAM <i>ARENA</i></span></a><div class="top-status"><span class="dot"></span> RECORDED EVIDENCE <span class="divider">/</span> ${data.mode==='public'?'PUBLIC SUMMARY':'PRIVATE EDITION'}</div><button id="download-summary" class="quiet">↓ Export data</button></header>
<div class="layout"><aside class="rail"><p class="eyebrow">THE RECORD</p><nav id="series-nav" aria-label="Recorded series"></nav><div class="rail-foot"><span class="small-square"></span><p>Every edition stands alone.<br>Every outcome stays on record.</p></div></aside><main id="main"><section class="hero"><div><p class="eyebrow" id="edition-label">FACTORY SYSTEM TRIALS</p><h1 id="headline">Intelligence.<br><em>Put to work.</em></h1><p id="series-subtitle" class="hero-sub">Real work. Recorded clocks. Independent acceptance.</p></div><div class="hero-score"><span class="eyebrow">STRICT PASS / RECORDED</span><strong id="hero-score">—<small>/ —</small></strong><p id="hero-score-note">Artifact acceptance and harness completion are separate measures.</p><div class="mini-stats"><div><b id="accepted-count">—</b><span>PROJECTS ACCEPTED</span></div><div><b id="completed-count">—</b><span>CLEAN COMPLETIONS</span></div></div></div></section>
<div class="privacy ${data.mode}"><span>${data.mode==='public'?'PUBLIC SUMMARY':'PRIVATE · NOT REDACTED'}</span> ${data.mode==='public'?'Only allowlisted measurements and public task labels. Context, source, private paths and raw evidence are deliberately omitted.':'This portable file contains private context, source, transcripts and machine paths. Review before posting or recording. Nothing is uploaded.'}</div>
<section class="edition-strip"><p id="series-note"></p><button id="method-button" class="quiet">Method & provenance ↗</button></section>
<nav id="card-tabs" class="card-tabs" aria-label="Work orders"></nav><section id="arena" class="arena"><div class="arena-title"><div><p class="eyebrow" id="card-kind">WORK ORDER</p><h2 id="card-title">Recorded work</h2><p id="card-description"></p></div><div class="view-controls"><button id="results-view" class="selected">Results</button><button id="replay-view">Replay</button><button id="broadcast" class="quiet" aria-pressed="false">⛶ Focus</button></div></div>
<div class="transport" id="transport"><button class="primary" id="play" aria-label="Play recorded timeline">▶ Play</button><time id="clock">0:00.0</time><input id="seek" aria-label="Recorded elapsed time" type="range" min="0" max="1" value="0" step="10"><span id="end-clock" class="end-clock">—</span><label class="speed">Speed <select id="speed"><option value="1">1×</option><option value="4">4×</option><option value="10" selected>10×</option><option value="25">25×</option><option value="60">60×</option></select></label><button id="finish" class="quiet">Final →</button></div>
<p class="clock-note" id="clock-note">Clocks are relative to each lane's recorded start, not a claim that independent runs happened simultaneously.</p><div id="lane-grid" class="lane-grid"></div><div id="takeaway" class="takeaway"></div></section>
<section class="principles"><div><span>01</span><h3>Acceptance ≠ completion.</h3><p>Passing the judge is necessary, not sufficient. The delivered project, protected files and clean harness finish all matter.</p></div><div><span>02</span><h3>Unknown is a measurement.</h3><p>Missing receipts are never zero. Known subsets, native counters and endpoint windows carry different scopes.</p></div><div><span>03</span><h3>Different editions. No rewrite.</h3><p>Adaptive repairs and new models remain separate. A later success does not erase an earlier incomplete run.</p></div></section>
<details class="static"><summary>Complete static score sheets · printable, no JavaScript required</summary>${data.series.map(scoreTable).join('')}</details>
<footer>BANTAM / THE FACTORY FLOOR <span>Unsigned observations. Hashes establish byte consistency, not correctness or authority.</span></footer>
</main></div><dialog id="inspector"><header><div><p class="eyebrow" id="inspector-kicker">RECORDED EVIDENCE</p><h2 id="inspector-title">Inspect the work</h2></div><button id="close-inspector" aria-label="Close evidence inspector">✕</button></header><nav id="inspector-tabs" aria-label="Evidence sections"></nav><div id="inspector-body"></div></dialog>
<noscript><div class="nojs">Interactive controls require JavaScript. Open “Complete static score sheets” above to inspect every recorded outcome. Private compressed evidence additionally requires browser DecompressionStream support.</div></noscript>
<script id="showcase-data" type="application/json">${J(data)}</script>${payloads.map(p=>`<script id="evidence-${E(p.id)}" type="application/octet-stream">${p.data}</script>`).join('')}
<script>const lineDiff=${replayLineDiff.toString()};const acceptanceAt=${showcaseAcceptanceAt.toString()};const sameModelObservation=${sameModelObservation.toString()};(${client.toString()})();</script></body></html>`;
}

export function writeShowcase({roots,output,mode='private',limits={}}){
  if(typeof output!=='string'||!path.isAbsolute(output)||fs.existsSync(output))throw Error('showcase output must be a fresh absolute directory');
  const built=buildShowcase({roots,mode,limits}),html=renderShowcase(built),json=JSON.stringify(built.data,null,2)+'\n';
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const files=[['index.html',html],['showcase.json',json]];
  for(const [name,content]of files)fs.writeFileSync(path.join(output,name),content,{flag:'wx',mode:0o600});
  const receipt={schema:'bantam.factory-showcase-package.v1',private:mode==='private',redacted:mode==='public',
    sourceManifests:mode==='private'?built.data.series.map(s=>({series:s.id,sha256:s.provenance.manifestSha256})):undefined,
    files:files.map(([name,content])=>({path:name,bytes:Buffer.byteLength(content),sha256:SHA(content)}))};
  fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return {output:path.join(output,'index.html'),mode,series:built.data.series.length,rows:built.data.series.reduce((n,s)=>n+s.counts.observed,0),bytes:Buffer.byteLength(html)};
}

const CSS=String.raw`
:root{color-scheme:dark;--bg:#0b0f12;--panel:#13191e;--line:#2b343c;--ink:#edf0ec;--muted:#9ba7ab;--amber:#f2b65b;--teal:#79d5b9;--red:#ff9399;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,select{font:inherit}button,select{cursor:pointer}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button{border:1px solid var(--line);border-radius:5px;background:#1b242a;color:var(--ink);font-size:12px;font-weight:600;padding:10px 14px}button:hover{border-color:#788b8f;background:#253037}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--amber);outline-offset:4px}button:disabled{opacity:.45;cursor:default}a{color:inherit}.quiet{background:transparent}.primary{color:#151815;background:var(--amber);border-color:var(--amber)}.primary:hover{background:#ffd391}.top-stripe{height:3px;background:linear-gradient(90deg,var(--amber) 0 38%,#58796c 38% 100%)}.topbar{min-height:79px;padding:15px 32px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--line);background:#101518}.wordmark{display:flex;align-items:center;gap:10px;text-decoration:none;font-size:17px;letter-spacing:2px;font-weight:850}.wordmark img{color:var(--amber)}.wordmark i{font:500 11px var(--mono);letter-spacing:3px;margin-left:8px;color:var(--muted);font-style:normal}.top-status{font:9px var(--mono);letter-spacing:1.7px;color:var(--muted)}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--teal);margin-right:8px}.divider{margin:0 12px;color:#46545d}.layout{display:grid;grid-template-columns:225px minmax(0,1fr);max-width:1800px;margin:auto}.rail{border-right:1px solid var(--line);padding:34px 19px;min-width:0;background:#0e1316}.eyebrow{font:600 10px/1.7 var(--mono);letter-spacing:1.8px;color:var(--amber);margin:0 0 12px}.rail>.eyebrow{color:#697b83;font-size:9px;padding-left:12px}.series-button{display:block;width:100%;text-align:left;background:transparent;padding:17px 12px;margin:6px 0;border:1px solid transparent;font-size:12px;line-height:1.6}.series-button span{display:block;color:#87989e;font:9px var(--mono);letter-spacing:.6px;margin-bottom:7px}.series-button b{font-size:12px;font-weight:650;display:block}.series-button em{font:10px var(--mono);display:block;color:var(--muted);margin-top:9px;font-style:normal}.series-button.selected{border-color:#6d5838;background:linear-gradient(115deg,#332a1c,#171d1d);box-shadow:inset 3px 0 var(--amber)}.series-button.selected b{color:#ffd89c}.rail-foot{border-top:1px solid var(--line);margin:35px 10px 0;padding-top:23px}.small-square{display:block;width:8px;height:8px;border:1px solid #728d81;transform:rotate(45deg)}.rail-foot p{font:9px/1.9 var(--mono);color:#76868d}main{min-width:0;padding:0 38px 28px}.hero{display:grid;grid-template-columns:1.45fr 1fr;gap:30px;padding:48px 0 31px;align-items:center}.hero h1{font-size:clamp(38px,4.1vw,65px);font-weight:560;line-height:1.02;letter-spacing:-2.8px;margin:0 0 20px}.hero h1 em{font-style:normal;color:#cbd8cd}.hero-sub{font-size:13px;line-height:1.8;color:var(--muted);margin:0;max-width:520px}.hero-score{border-left:1px solid var(--line);padding:6px 0 6px 30px}.hero-score>.eyebrow{color:var(--muted);font-size:9px;margin-bottom:8px}.hero-score>strong{display:block;font:500 clamp(56px,5vw,77px)/1.15 var(--mono);letter-spacing:-5px;color:var(--amber)}.hero-score>strong small{font-size:27px;color:#65747a;font-weight:400;letter-spacing:-1px;margin-left:10px}.hero-score>p{color:var(--muted);font-size:11px;line-height:1.7;max-width:340px;margin:9px 0 16px}.mini-stats{display:flex;gap:28px}.mini-stats b{display:block;font:500 21px var(--mono);color:var(--teal)}.mini-stats span{display:block;font:8px var(--mono);letter-spacing:.5px;color:var(--muted);margin-top:7px}.privacy{font-size:10px;line-height:1.8;padding:12px 15px;background:#1a1c18;border:1px solid #3c3a2a;color:#aaa58c;border-radius:4px}.privacy span{font:600 9px var(--mono);letter-spacing:.9px;color:#dfbd7f;margin-right:11px}.privacy.public{background:#11221d;border-color:#27473a;color:#9bb5aa}.privacy.public span{color:var(--teal)}.edition-strip{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 0 23px}.edition-strip p{font:10px/1.9 var(--mono);color:#82949b;margin:0;max-width:760px}.edition-strip button{white-space:nowrap;font-size:10px}.card-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.card-tab{text-align:left;background:#12191d;padding:17px 18px;min-width:0;position:relative}.card-tab span{font:8px var(--mono);letter-spacing:1.1px;color:#7f929a;display:block;margin-bottom:8px}.card-tab b{font-size:14px;font-weight:600}.card-tab em{font:10px var(--mono);color:var(--muted);display:block;margin-top:10px;font-style:normal}.card-tab.selected{background:linear-gradient(120deg,#29291d,#17211e);border-color:#887044}.card-tab.selected span{color:var(--amber)}.arena{padding-top:29px}.arena-title{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:18px}.arena-title h2{font-size:28px;letter-spacing:-.8px;font-weight:550;margin:0 0 8px}.arena-title .eyebrow{font-size:8px;margin-bottom:7px}.arena-title p:not(.eyebrow){font-size:11px;color:var(--muted);line-height:1.7;margin:0;max-width:560px}.view-controls{display:flex;gap:5px;flex-shrink:0}.view-controls button{font-size:10px;padding:9px 11px}.view-controls button.selected{border-color:var(--amber);color:var(--amber)}.transport{padding:12px 15px;display:flex;align-items:center;gap:14px;border:1px solid var(--line);border-radius:5px;background:#10171b}.transport time{font:500 21px var(--mono);color:var(--teal);min-width:90px;text-align:center}.transport input{flex:1;min-width:50px;accent-color:var(--amber)}.end-clock{font:10px var(--mono);color:var(--muted)}.speed{font:9px var(--mono);color:var(--muted);display:flex;gap:7px;align-items:center}.speed select{background:#1c272c;color:var(--ink);border:1px solid var(--line);padding:7px 4px;border-radius:4px}.clock-note{font:9px/1.8 var(--mono);color:#7c9199;margin:10px 2px 16px}.lane-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.lane-grid.single{grid-template-columns:minmax(0,1fr)}.lane{min-width:0;background:linear-gradient(145deg,#182026,#12191d);border:1px solid #303d44;border-top:2px solid #688f96;border-radius:6px;overflow:hidden}.lane.bantam{border-color:#6d5734;border-top:2px solid var(--amber);background:linear-gradient(140deg,#26271d,#161e1d 65%)}.lane.native-astra{border-top-color:var(--teal)}.lane-top{padding:19px 18px 16px;display:flex;justify-content:space-between;gap:12px}.lane-family{font:8px var(--mono);letter-spacing:.6px;color:#8d9b9e;margin-bottom:8px}.lane h3{font-size:16px;font-weight:600;letter-spacing:-.3px;margin:0 0 12px}.badge{display:inline-block;font:650 8px var(--mono);letter-spacing:.8px;border:1px solid #526069;border-radius:3px;padding:5px 7px;color:var(--muted)}.badge.pass{color:var(--teal);border-color:#4e8670;background:#132f23}.badge.output{color:var(--amber);border-color:#806540;background:#30271a}.badge.fail{color:var(--red);border-color:#895057;background:#2e1d23}.lane-clock{text-align:right;flex-shrink:0}.lane-clock strong{font:500 25px var(--mono);letter-spacing:-1px;display:block;color:#e3eadf}.lane-clock span{font:8px var(--mono);color:#8f9f9f;display:block;margin-top:7px}.lane-bar{height:3px;background:#263338}.lane-bar i{display:block;height:100%;background:var(--teal);width:0}.bantam .lane-bar i{background:var(--amber)}.acceptance{display:flex;justify-content:space-between;gap:8px;padding:12px 18px;border-bottom:1px solid #33413d;font:9px var(--mono);color:#8f9e9e}.yes{color:var(--teal)}.no{color:var(--amber)}.metrics{padding:17px 18px 15px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:17px 12px}.metric>span{font:8px var(--mono);letter-spacing:.7px;color:#9ba7a6;display:block;margin-bottom:7px}.metric>strong{font:500 23px var(--mono);letter-spacing:-.7px}.metric.cached>strong{color:var(--teal)}.metric.fresh>strong{color:#e4c694}.meter-scope{margin:0 18px 14px;font:8px/1.8 var(--mono);color:#89a298;min-height:29px}.meter-scope.partial{color:var(--amber)}.activity{padding:13px 18px;border-top:1px solid #33413d;background:#00000012}.activity .eyebrow{font-size:7px;color:#8a9c99;margin-bottom:7px}.activity p{font:10px/1.8 var(--mono);margin:0;min-height:38px;color:#cbd5cd;overflow-wrap:anywhere}.lane-actions{display:flex;gap:7px;padding:14px 18px;border-top:1px solid #33413d}.lane-actions button{font-size:10px;flex:1;padding:10px 6px}.takeaway{display:flex;gap:24px;align-items:center;justify-content:space-between;border-left:2px solid var(--amber);background:linear-gradient(90deg,#23251b,#111b18);padding:19px 22px;margin-top:19px}.takeaway strong{font-size:14px;font-weight:550;color:#dfdfce}.takeaway p{font:10px/1.8 var(--mono);color:#9ca9a1;margin:5px 0 0;max-width:850px}.principles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:25px;padding:37px 0}.principles>div{border-top:1px solid var(--line);padding-top:19px}.principles span{font:11px var(--mono);color:#657e77}.principles h3{font-size:12px;font-weight:600;margin:14px 0 10px}.principles p{font-size:11px;line-height:1.8;color:#84949b;margin:0}.static{border:1px solid var(--line);border-radius:5px;padding:15px 18px;margin-bottom:29px}.static>summary{font-size:11px;cursor:pointer;color:#aab7b7}.static-series{padding-top:18px}.static-series h2{font-size:18px}.static-series h3{font-size:13px}.static-series h3 small{font-size:10px;color:var(--muted)}.static-series>p{font:10px var(--mono);color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:5px}table{width:100%;border-collapse:collapse;font:10px/1.7 var(--mono);white-space:nowrap}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right}th:first-child{text-align:left}th{font-weight:500}thead{background:#0c1419;color:var(--muted)}footer{border-top:1px solid var(--line);padding-top:21px;display:flex;justify-content:space-between;gap:22px;font:8px/1.9 var(--mono);letter-spacing:.5px;color:#788a91}footer span{letter-spacing:0;text-align:right}dialog{width:min(1150px,95vw);max-height:92vh;border:1px solid #65766d;border-radius:8px;padding:0;background:#111a1d;color:var(--ink);box-shadow:0 40px 130px #000d}dialog::backdrop{background:#050a0ee3;backdrop-filter:blur(7px)}dialog>header{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:22px 25px;border-bottom:1px solid var(--line)}dialog h2{font-size:22px;letter-spacing:-.5px;margin:0}dialog .eyebrow{font-size:8px;margin-bottom:6px}#inspector-tabs{display:flex;gap:6px;padding:12px 20px;border-bottom:1px solid var(--line);overflow:auto}#inspector-tabs button{font-size:10px;white-space:nowrap}#inspector-tabs button.selected{color:var(--teal);border-color:#608578}#inspector-body{padding:22px 25px;max-height:67vh;min-height:300px;overflow:auto}#inspector-body p{font-size:12px;line-height:1.8;color:#a6b6b7}#inspector-body h3{font-size:14px;color:#dbe4da;font-weight:550}#inspector-body pre{font:11px/1.8 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;background:#090f13;border:1px solid var(--line);padding:16px;border-radius:5px;max-height:48vh;overflow:auto}.inspect-toolbar{display:flex;gap:9px;align-items:center;margin:15px 0;flex-wrap:wrap}.inspect-toolbar select,.inspect-toolbar input{min-width:100px;max-width:100%;background:#1b282e;color:var(--ink);border:1px solid #485b60;border-radius:4px;padding:10px;font-size:11px}.inspect-toolbar input{flex:1}.inspect-toolbar select{flex:2}.artifact-meta{font:9px/1.8 var(--mono)!important;color:#94a89f!important;overflow-wrap:anywhere}.timeline{display:grid;gap:7px}.timeline button{display:grid;grid-template-columns:75px minmax(0,1fr);gap:10px;text-align:left;align-items:start;font:10px/1.7 var(--mono);font-weight:400}.timeline time{color:var(--amber)}.timeline small{display:block;color:var(--muted);font-size:9px;overflow-wrap:anywhere}.judge-group{padding:13px 16px;border:1px solid var(--line);border-left:3px solid var(--red);border-radius:4px;margin:9px 0;font:11px/1.8 var(--mono)}.judge-group.pass{border-left-color:var(--teal)}.notice{border:1px solid #725c39;background:#2a251a;padding:13px 16px;color:#dab57b!important;font-size:11px!important;line-height:1.8}.diff-line{padding:7px 13px;font:11px/1.8 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}.diff-line.same{color:#8c9d9e;background:#0a1316}.diff-line.added{color:#b1e9cd;background:#153125}.diff-line.removed{color:#f5b1b1;background:#342026}.nojs{padding:20px;color:var(--amber)}body.broadcast .rail,body.broadcast .top-status,body.broadcast .principles,body.broadcast footer,body.broadcast .static,body.broadcast .edition-strip,body.broadcast .hero{display:none}body.broadcast .layout{grid-template-columns:1fr;max-width:1600px}body.broadcast main{padding:25px 35px}body.broadcast .privacy{margin-bottom:20px}.lane-grid.single .lane{display:grid;grid-template-columns:1fr 1.2fr;grid-template-areas:'top metrics' 'accept metrics' 'activity activity' 'buttons buttons'}.lane-grid.single .lane-top{grid-area:top;padding:26px}.lane-grid.single .lane h3{font-size:23px}.lane-grid.single .lane-clock strong{font-size:35px}.lane-grid.single .lane-bar{display:none}.lane-grid.single .acceptance{grid-area:accept;padding:18px 26px}.lane-grid.single .metrics{grid-area:metrics;padding:27px 32px;border-left:1px solid var(--line);gap:24px}.lane-grid.single .metric strong{font-size:34px}.lane-grid.single .meter-scope{grid-area:activity;margin:0;padding:14px 26px;background:#121c17;border-top:1px solid var(--line)}.lane-grid.single .activity{grid-area:activity;margin-top:52px;padding:21px 26px}.lane-grid.single .activity p{font-size:13px;min-height:42px}.lane-grid.single .lane-actions{grid-area:buttons;padding:15px 26px}.hidden{display:none!important}@media(min-width:1650px){main{padding:0 49px 32px}.hero{padding-top:55px}.lane h3{font-size:19px}.metric strong{font-size:27px}}@media(max-width:1190px){.layout{grid-template-columns:190px minmax(0,1fr)}main{padding:0 25px 25px}.rail{padding:30px 12px}.hero{gap:20px}.hero h1{font-size:46px}.hero-score{padding-left:22px}.hero-score>strong{font-size:62px}.lane-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card-tab{padding:15px 12px}.card-tab b{font-size:12px}.top-status{font-size:8px}.arena-title{align-items:flex-start}.view-controls{flex-wrap:wrap;justify-content:flex-end;max-width:200px}}@media(max-width:850px){.layout{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid var(--line);padding:13px 20px}.rail>.eyebrow,.rail-foot{display:none}#series-nav{display:flex;gap:8px;overflow:auto}.series-button{min-width:190px;width:auto;margin:0;padding:12px 14px}.series-button span{font-size:8px}.series-button b{font-size:11px}.series-button em{display:none}.topbar{padding:12px 20px;min-height:70px}.top-status{display:none}.hero{padding-top:31px}.hero h1{font-size:49px}.hero-score>strong{font-size:64px}.hero-sub{font-size:12px}.edition-strip{align-items:flex-start}.edition-strip p{font-size:9px}.edition-strip button{font-size:9px;white-space:normal;min-width:110px}}@media(max-width:570px){.topbar{padding:12px 15px;gap:10px}.wordmark{font-size:14px;letter-spacing:1.3px}.wordmark i{font-size:9px;letter-spacing:2px;margin-left:5px}.wordmark img{width:34px;height:34px}.topbar button{font-size:10px;padding:8px 10px}main{padding:0 16px 22px}.rail{padding:11px 16px}.hero{grid-template-columns:1fr;gap:24px;padding:31px 0 24px}.hero h1{font-size:47px;letter-spacing:-2px;margin-bottom:15px}.hero-score{border-left:0;border-top:1px solid var(--line);padding:21px 0 0;display:grid;grid-template-columns:1fr 1.3fr;column-gap:15px}.hero-score>.eyebrow{grid-column:1/-1}.hero-score>strong{font-size:60px;grid-column:1;grid-row:2/4}.hero-score>strong small{font-size:24px;margin-left:6px}.hero-score>p{grid-column:2;margin:3px 0 10px;font-size:10px}.mini-stats{grid-column:2;gap:15px}.mini-stats b{font-size:18px}.mini-stats span{font-size:7px;letter-spacing:0;line-height:1.5}.privacy{font-size:9px;padding:11px 12px}.privacy span{display:block;font-size:8px;margin-bottom:4px}.edition-strip{padding:14px 0 18px;gap:12px}.edition-strip button{min-width:83px;padding:8px 7px}.card-tabs{gap:6px}.card-tab{padding:13px 9px}.card-tab span{font-size:7px;letter-spacing:.3px}.card-tab b{font-size:11px;line-height:1.6;display:block}.card-tab em{font-size:8px;line-height:1.5}.arena{padding-top:25px}.arena-title{display:block;margin-bottom:16px}.arena-title h2{font-size:25px}.view-controls{max-width:none;justify-content:flex-start;margin-top:16px}.transport{gap:8px;padding:11px;flex-wrap:wrap}.transport input{order:6;flex-basis:100%;width:100%}.transport time{font-size:18px;min-width:78px}.transport .end-clock{display:none}.transport .primary{padding:9px 11px;font-size:11px}.transport #finish{margin-left:auto;font-size:10px;padding:8px}.transport .speed{font-size:8px}.lane-grid{grid-template-columns:1fr}.lane-top{padding:21px 19px 17px}.lane h3{font-size:19px}.lane-clock strong{font-size:28px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));padding:20px;gap:20px}.metric>strong{font-size:28px}.metric>span{font-size:9px}.lane-family{font-size:9px}.badge{font-size:9px}.acceptance{font-size:10px}.meter-scope{font-size:9px}.activity p{font-size:11px}.lane-actions button{font-size:11px}.principles{grid-template-columns:1fr;gap:20px;padding:29px 0}.principles h3{margin-top:9px}.takeaway{padding:17px 19px}.takeaway strong{font-size:13px}.takeaway p{font-size:9px}.principles p{font-size:11px}footer{display:block;font-size:8px}footer span{display:block;text-align:left;margin-top:10px}.lane-grid.single .lane{display:block}.lane-grid.single .lane-top{padding:23px 20px}.lane-grid.single .lane h3{font-size:21px}.lane-grid.single .lane-clock strong{font-size:29px}.lane-grid.single .metrics{padding:23px 20px;border:0}.lane-grid.single .metric strong{font-size:31px}.lane-grid.single .activity{margin-top:0;padding:20px}.lane-grid.single .meter-scope{padding:13px 20px}.lane-grid.single .acceptance{padding:14px 20px}.lane-grid.single .activity p{font-size:11px}.lane-grid.single .lane-actions{padding:15px 20px}dialog>header{padding:19px 17px}dialog h2{font-size:19px}#inspector-tabs{padding:10px 12px}#inspector-body{padding:17px}#inspector-body pre{font-size:10px}.timeline button{grid-template-columns:60px minmax(0,1fr)}body.broadcast main{padding:18px 15px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}@media print{body{background:white;color:black}.topbar,.rail,.hero,.privacy,.edition-strip,.card-tabs,.arena,.principles,footer,dialog{display:none!important}.layout{display:block}main{padding:0}.static{border:0}.static>summary{display:none}.static:not([open])>*:not(summary){display:block}.static-series{break-inside:avoid}table{font-size:8px;color:black}th,td{padding:6px}thead{background:white;color:black}.table-wrap{overflow:visible}.static-series>p{color:#444}}
.lane-grid.single .lane{grid-template-areas:'top metrics' 'accept metrics' 'scope scope' 'activity activity' 'buttons buttons'}.lane-grid.single .meter-scope{grid-area:scope}.lane-grid.single .activity{margin-top:0}
`;

function client(){
  'use strict';
  const data=JSON.parse(document.getElementById('showcase-data').textContent),$=id=>document.getElementById(id),
    metricNames={inputTokens:'INPUT',outputTokens:'OUTPUT',cacheHitTokens:'CACHED INPUT',freshInputTokens:'FRESH INPUT'},
    fmt=v=>v===null||v===undefined?'unknown':Number(v).toLocaleString('en-US'),
    time=v=>v===null||v===undefined?'unknown':`${Math.floor(v/60000)}:${(v%60000/1000).toFixed(1).padStart(4,'0')}`,
    sec=v=>v===null?'—':(v/1000).toFixed(1)+'s',
    el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;},
    button=(text,fn,cls)=>{const b=el('button',text,cls);b.addEventListener('click',fn);return b;},
    append=(parent,...children)=>{for(const c of children)parent.append(c);return parent;},
    pre=v=>el('pre',typeof v==='string'?v:JSON.stringify(v,null,2));
  let si=data.series.length-1,ci=0,results=true,playing=false,t=0,previous=0,focus=null,inspectorRow=null,inspectorTab='evidence',picked=null;
  const cache=new Map();
  const series=()=>data.series[si],card=()=>series().cards[ci],duration=()=>Math.max(0,...card().rows.flatMap(r=>[r.wallMs??0,...r.tokenUpdates.map(u=>u.t),...(r.events??[]).filter(e=>e.t!==null).map(e=>e.t)]));
  function blobDownload(name,bytes,type='application/octet-stream'){
    const url=URL.createObjectURL(new Blob([bytes],{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function artifactBytes(a){return a.encoding==='base64'?Uint8Array.from(atob(a.content),c=>c.charCodeAt(0)):new TextEncoder().encode(a.content);}
  async function payload(row){
    if(data.mode==='public')throw Error('Private evidence is intentionally omitted from this summary.');
    if(!cache.has(row.id)){
      const node=$('evidence-'+row.id);if(!node)throw Error('No embedded evidence for this lane.');
      if(typeof DecompressionStream!=='function')throw Error('This browser needs DecompressionStream support to inspect compressed evidence. Static results remain available.');
      const bytes=Uint8Array.from(atob(node.textContent.trim()),c=>c.charCodeAt(0));
      cache.set(row.id,new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json());
    }
    return cache.get(row.id);
  }
  function setSeries(index){si=index;ci=0;focus=null;results=true;playing=false;t=duration();render();}
  function setCard(index){ci=index;focus=null;results=true;playing=false;t=duration();render();}
  function badge(outcome){return el('span',outcome,'badge '+(outcome==='PASS'?'pass':outcome==='OUTPUT_ONLY'?'output':outcome==='NOT RECORDED'?'':'fail'));}
  function render(){
    const s=series(),c=card();
    $('series-nav').replaceChildren(...data.series.map((entry,i)=>{
      const b=button('',()=>setSeries(i),'series-button'+(i===si?' selected':''));b.setAttribute('aria-current',i===si?'true':'false');
      return append(b,el('span',`${String(i+1).padStart(2,'0')} / ${entry.kind==='comparison'?'SYSTEM COMPARISON':'LOCAL QUALIFICATION'}`),el('b',entry.title),el('em',`${entry.counts.pass}/${entry.counts.observed} PASS · ${entry.complete?'recorded':'partial'}`));
    }));
    $('edition-label').textContent=`EDITION ${String(si+1).padStart(2,'0')} / ${s.complete?'RECORDED SERIES':'PARTIAL SERIES'}`;
    const headline=$('headline');headline.replaceChildren(el('span',s.kind==='comparison'?'Same weights.':'One factory.'),el('br'),el('em',s.kind==='comparison'?'Different processes.':'Another worker.'));
    $('series-subtitle').textContent=s.kind==='comparison'?'Four harnesses on the same local 27B. Native and BANTAM-wrapped Astra alongside them. Three useful tools; one frozen contract for each.':`${s.cards[0]?.rows[0]?.model??'Local worker'} inside BANTAM. A separately recorded edition, not a replacement for the original comparison.`;
    $('hero-score').replaceChildren(document.createTextNode(String(s.counts.pass)),el('small',`/ ${s.counts.observed}`));
    $('hero-score-note').textContent=`${s.counts.groupsMeasured?`${s.counts.groupsPassed}/${s.counts.groupsTotal} independent groups passed across ${s.counts.groupsMeasured} measured attempts.`:'No independent group results recorded.'} ${s.counts.planned-s.counts.observed?`${s.counts.planned-s.counts.observed} planned attempts have no final record.`:'Every recorded outcome remains visible.'}`;
    $('accepted-count').textContent=`${s.counts.accepted}/${s.counts.observed}`;$('completed-count').textContent=`${s.counts.completed}/${s.counts.observed}`;
    $('series-note').textContent=s.kind==='comparison'?'Exploratory, single-attempt system comparison. Warm cache, native tool and sampling differences. Local / frontier clocks are not a controlled hardware comparison.':'Adaptive qualification, not a causal ablation. Prior repairs, card order and cache state differ. A correct artifact without accepted completion remains OUTPUT_ONLY.';
    $('card-tabs').replaceChildren(...s.cards.map((entry,i)=>{
      const n=entry.rows.filter(r=>r.recorded).length,b=button('',()=>setCard(i),'card-tab'+(i===ci?' selected':''));b.setAttribute('aria-current',i===ci?'true':'false');
      return append(b,el('span',`${entry.kind} / ${entry.number}${entry.repeat>1?' · REPEAT '+entry.repeat:''}`),el('b',entry.title),el('em',`${entry.rows.filter(r=>r.outcome==='PASS').length}/${n} PASS · ${entry.rows.filter(r=>r.accepted).length}/${n} accepted`));
    }));
    $('card-kind').textContent=`WORK ORDER ${c.number} / ${c.kind}`;$('card-title').textContent=c.title;$('card-description').textContent=c.description;
    $('results-view').classList.toggle('selected',results);$('replay-view').classList.toggle('selected',!results);
    $('play').textContent=playing?'Ⅱ Pause':'▶ Play';$('seek').max=duration();$('seek').value=t;$('clock').textContent=results?'FINAL':time(t);$('end-clock').textContent=time(duration());
    $('clock-note').textContent=results?'Final recorded measurements. “Measured subset” never means full usage. Enter Replay to inspect actual response clocks.':'Each lane starts at its own recorded zero. Time is not invented for untimed turns; token counters advance only on saved response evidence.';
    const rows=focus?c.rows.filter(r=>r.id===focus):c.rows,grid=$('lane-grid');grid.classList.toggle('single',rows.length===1);grid.replaceChildren(...rows.map(renderLane));
    const strict=c.rows.filter(r=>r.outcome==='PASS'),accepted=c.rows.filter(r=>r.accepted),incomplete=c.rows.filter(r=>r.recorded&&!r.completed);
    const takeaway=$('takeaway'),body=el('div');
    let title=`${accepted.length}/${c.rows.filter(r=>r.recorded).length} accepted projects. ${strict.length} clean PASS.`,note='Functional acceptance and the completion protocol are shown separately. One attempt is not a reliability estimate.';
    if(s.kind==='comparison'){
      const observation=sameModelObservation(c.rows);
      if(observation){title=`Same 27B. Both accepted. BANTAM finished ${observation.ratio.toFixed(2)}× sooner than DeepSeek Harness.`;note='Observed on this card, not a universal ranking. Cache efficiency and cloud-system results can favor another lane.';}
    }else if(incomplete.length)note='Passing tests did not guarantee a clean finish. These incomplete deliveries stay visible beside successful runs.';
    append(body,el('strong',title),el('p',note));takeaway.replaceChildren(body);if(focus)takeaway.append(button('Show all lanes',()=>{focus=null;render();},'quiet'));
  }
  function renderLane(row){
    const lane=el('article',undefined,'lane'+(row.bantam?' bantam':'')+(row.family==='astra'?' native-astra':''));lane.dataset.lane=row.id;
    const stage=acceptanceAt(row,{results,t}),{ended}=stage,top=el('div',undefined,'lane-top'),name=el('div'),clock=el('div',undefined,'lane-clock');
    append(name,el('div',row.model,'lane-family'),el('h3',row.label),badge(ended?row.outcome:'REPLAYING'));
    append(clock,el('strong',ended?sec(row.wallMs):sec(Math.min(t,row.wallMs??t))),el('span',ended?'RECORDED WALL':'RECORDED ELAPSED'));append(top,name,clock);
    const progress=el('div',undefined,'lane-bar'),bar=el('i');bar.style.width=(ended?100:row.wallMs?Math.min(100,t/row.wallMs*100):0)+'%';progress.append(bar);
    const acceptance=el('div',undefined,'acceptance');append(acceptance,
      el('span',`PROJECT ${!ended?'PENDING':stage.accepted===null?'UNKNOWN':stage.accepted?'ACCEPTED':'NOT ACCEPTED'}`,stage.accepted?'yes':ended?'no':''),
      el('span',`FINISH ${!ended?'PENDING':stage.completed===null?'UNKNOWN':stage.completed?'CLEAN':'INCOMPLETE'}`,stage.completed?'yes':ended?'no':''));
    let value=row.accounting.full,scope='Recorded full-run counters',partial=false;
    if(!ended){const u=row.tokenUpdates.filter(u=>u.t<=t).at(-1);value=u??{};partial=!u||u.partial===true;scope=u?`${partial?'MEASURED SUBSET':'RECORDED RESPONSES'} · through ${time(u.t)}`:'Awaiting the first measured response';}
    else if(row.accounting.complete===false&&row.accounting.subset){value=row.accounting.subset;partial=true;scope=`MEASURED SUBSET · ${fmt(row.accounting.measuredRequests)} / ${fmt(row.accounting.requests)} requests. Full-run totals remain unknown.`;}
    else if(row.accounting.complete===false){partial=true;scope='Incomplete full-run accounting. Inspect the recorded evidence and separate scopes.';}
    else if(row.accounting.requests!==null)scope=`${row.accounting.measuredRequests??row.accounting.requests} / ${row.accounting.requests} requests measured · full-run counters`;
    const meter=el('div',undefined,'metrics');for(const [field,label]of Object.entries(metricNames))append(meter,append(el('div',undefined,'metric '+(field==='cacheHitTokens'?'cached':field==='freshInputTokens'?'fresh':'')),el('span',label),el('strong',fmt(value[field]))));
    const activity=el('div',undefined,'activity'),event=(row.events??[]).filter(e=>e.t!==null&&e.t<=t).at(-1);
    const text=ended?`${row.groupsPassed??'?'}/${row.groupsTotal??'?'} judge groups · public exit ${row.publicExit??'?'} · ${row.protectedChanges??'?'} protected changes. ${row.stopReasons?.join('; ')||''}`:data.mode==='public'?'Private context and tools are omitted from this public summary.':event?`${event.title}\n${event.detail??''}`:'No event has been assigned an invented timestamp.';
    append(activity,el('p',ended?'RECORDED OUTCOME':'LATEST TIMED EVIDENCE','eyebrow'),el('p',text));
    const actions=el('div',undefined,'lane-actions');append(actions,button(data.mode==='public'?'Inspect measurements':'Inspect evidence',()=>openInspector(row,'accounting')),button(focus?'All lanes':'Focus lane',()=>{focus=focus?null:row.id;render();},'quiet'));
    return append(lane,top,progress,acceptance,meter,el('p',scope,'meter-scope'+(partial?' partial':'')),activity,actions);
  }
  async function showArtifact(parent,row,artifactPath,selection=null){
    const p=await payload(row),a=p.artifacts.find(a=>a.path===artifactPath);if(!a){parent.append(el('p','This referenced artifact is unavailable.','notice'));return;}
    parent.append(el('p',`${a.path} · ${fmt(a.size)} bytes · SHA-256 ${a.sha256??'not recorded'}`,'artifact-meta'));
    if(!a.embedded){parent.append(el('p',a.reason??'Artifact omitted by the explicit byte limit.','notice'));return;}
    parent.append(button('↓ Download exact bytes',()=>blobDownload(a.path.split('/').at(-1),artifactBytes(a)),'quiet'));
    let content=a.content;
    if(a.encoding==='base64'){parent.append(el('p','Binary artifact. Download preserves the exact bytes.'));return;}
    if(selection?.modelCallPosition!==undefined){try{content=JSON.stringify(JSON.parse(content).modelCalls[selection.modelCallPosition]?.[selection.modelCallField],null,2);}catch{}}
    else if(selection?.turn!==undefined){try{const r=JSON.parse(content);content=JSON.stringify((r.turns??r.result?.turns??[]).find(t=>t.i===selection.turn),null,2);}catch{}}
    if(content.length>150000)parent.append(el('p',`Preview limited to 150,000 of ${fmt(content.length)} characters. The complete exact artifact is downloadable.`,'artifact-meta'));
    parent.append(pre(content.slice(0,150000)));
  }
  function dataTable(head,rows){const wrap=el('div',undefined,'table-wrap'),table=el('table'),thead=el('thead'),tr=el('tr'),body=el('tbody');for(const h of head)tr.append(el('th',h));thead.append(tr);for(const values of rows){const r=el('tr');values.forEach((v,i)=>r.append(el(i===0?'th':'td',v)));body.append(r);}return append(wrap,append(table,thead,body));}
  async function openInspector(row,tab='evidence',event=null){
    inspectorRow=row;inspectorTab=tab;picked=event;
    $('inspector-title').textContent=row?row.label+' / '+card().title:series().title;
    $('inspector-kicker').textContent=data.mode==='public'?'PUBLIC MEASUREMENTS / RAW EVIDENCE OMITTED':'PRIVATE EVIDENCE / READ-ONLY INSPECTION';
    if(!$('inspector').open)$('inspector').showModal();await renderInspector();
  }
  async function renderInspector(){
    const row=inspectorRow,body=$('inspector-body'),tabs=row?['accounting','timeline','evidence','candidate','judge','provenance']:['provenance'];
    $('inspector-tabs').replaceChildren(...tabs.map(tab=>button(tab[0].toUpperCase()+tab.slice(1),()=>{inspectorTab=tab;picked=null;renderInspector();},tab===inspectorTab?'selected':'')));
    body.replaceChildren();
    try{
      if(inspectorTab==='accounting'){
        const a=row.accounting;body.append(el('h3','One system. Different measurement scopes.'));
        body.append(el('p','Input includes cached input. Fresh = input − cache. These rows overlap: never add native or global counts to recorded wire totals.'));
        body.append(dataTable(['Scope','Input','Output','Cached','Fresh'],[['Full run',...Object.keys(metricNames).map(k=>fmt(a.full[k]))],
          ...(a.subset?[['Measured wire subset',...Object.keys(metricNames).map(k=>fmt(a.subset[k]))]]:[]),
          ...(a.native?[['Native main/report scope',...Object.keys(metricNames).map(k=>fmt(a.native[k]))]]:[]),
          ...(a.server?[['Supplementary endpoint window',...Object.keys(metricNames).map(k=>fmt(a.server[k]))]]:[])]));
        body.append(el('h3','Receipt coverage by field'));body.append(dataTable(['Field','Measured','Admitted','Complete'],Object.entries(a.coverage).map(([f,c])=>[metricNames[f],fmt(c.measuredRequests),fmt(c.totalRequests),c.complete===null?'not asserted':c.complete?'yes':'no'])));
        if(a.gaps.length)body.append(el('p',`${a.gaps.length} request(s) have incomplete measurements. A missing receipt is not a zero-token request.`,'notice'));
        if(a.server)body.append(el('p',`Endpoint counters are global, may be rounded, and assume no other client. Idle before: ${a.serverIdleBefore??'unknown'}; idle after: ${a.serverIdleAfter??'unknown'}. They do not repair missing primary receipts.`));
        if(a.native)body.append(el('p','Native reports may omit auxiliary summarization or post-task work. They are a separate scope, not a replacement whole-system total.'));
        if(data.mode==='private'){if(row.meteringValidationError)body.append(el('p',row.meteringValidationError,'notice'));body.append(button('Open exact recorded result',()=>{inspectorTab='evidence';picked={artifact:'result.json'};renderInspector();},'quiet'));}
      }else if(inspectorTab==='provenance'){
        body.append(el('h3','Interpretation boundaries'));body.append(el('p','PASS requires accepted code and a clean harness completion. OUTPUT_ONLY preserves accepted code without completion. Judge groups alone do not establish full correctness. Different editions are not pooled into a causal ranking.'));
        body.append(el('p','Clocks use each run’s recorded start. Untimed turns remain in sequence, without fabricated spacing. Token meters move only on saved response records.'));
        if(data.mode==='public')body.append(el('p','Private source seals, model paths, task bodies, raw configuration and transcripts are omitted. This summary does not contain a complete reproducibility bundle.','notice'));
        else{const p=series().provenance;body.append(el('p',`Manifest SHA-256 ${p.manifestSha256}\n${p.sourceFiles} runtime files · ${p.kitFiles} kit files`,'artifact-meta'));body.append(button('↓ Download exact manifest bytes',()=>blobDownload('manifest.json',artifactBytes(p.manifestBytes),'application/json'),'quiet'));body.append(pre(p.manifest));}
      }else if(data.mode==='public')body.append(el('p','This public-summary mode deliberately excludes private timelines, context, tools, source code, judge details and artifacts. Use the reviewed private edition for the complete evidence chain.','notice'));
      else if(inspectorTab==='timeline'){
        body.append(el('p',`${row.timedEvents} timed events; ${row.untimedEvents} ordered records without exact clocks. No timestamp is invented for an untimed action.`));
        const list=el('div',undefined,'timeline');for(const event of row.events)list.append(button('',()=>{picked=event;inspectorTab='evidence';renderInspector();}));
        row.events.forEach((event,i)=>append(list.children[i],el('time',event.t===null?'UNTIMED':time(event.t)),append(el('span'),el('span',event.title),el('small',event.detail),el('small',event.source))));body.append(list);
      }else if(inspectorTab==='evidence'){
        const p=await payload(row),toolbar=el('div',undefined,'inspect-toolbar'),select=el('select'),search=el('input');search.type='search';search.placeholder='Find a prompt, response, log or receipt…';search.setAttribute('aria-label','Filter evidence artifacts');select.setAttribute('aria-label','Evidence artifact');
        const viewer=el('div');let current=picked?.artifact??p.artifacts.find(a=>a.path==='run.json')?.path??p.artifacts[0]?.path;
        const options=()=>{const filtered=p.artifacts.filter(a=>a.path.toLowerCase().includes(search.value.toLowerCase()));select.replaceChildren(...filtered.map(a=>{const o=el('option',`${a.path} · ${fmt(a.size)} B`);o.value=a.path;return o;}));if(filtered.some(a=>a.path===current))select.value=current;};
        const show=async()=>{viewer.replaceChildren();await showArtifact(viewer,row,current,picked);};search.addEventListener('input',options);select.addEventListener('change',()=>{current=select.value;picked=null;show();});options();append(toolbar,search,select);body.append(toolbar,viewer);if(current)await show();else viewer.append(el('p','No recorded artifact is available.','notice'));
      }else if(inspectorTab==='candidate'){
        const p=await payload(row),select=el('select'),toolbar=el('div',undefined,'inspect-toolbar'),viewer=el('div');select.setAttribute('aria-label','Candidate source file');
        for(const f of row.files){const o=el('option',`${f.state.toUpperCase()} · ${f.path}`);o.value=f.path;select.append(o);}toolbar.append(select);body.append(el('p','Byte/line comparison with the sealed supplied starter, not a semantic correctness judgment.'),toolbar,viewer);
        const show=()=>{viewer.replaceChildren();const f=row.files.find(f=>f.path===select.value);if(!f)return;const a=p.artifacts.find(a=>a.path===f.artifact),b=p.artifacts.find(a=>a.path===f.baseline);viewer.append(el('p',`Final seal: ${f.finalSealMatches===null?'unavailable':f.finalSealMatches?'matches':'MISMATCH'} · ${f.sha256??'missing source'}`,'artifact-meta'));
          if(a?.embedded)viewer.append(button('↓ Download candidate',()=>blobDownload(f.path.split('/').at(-1),artifactBytes(a)),'quiet'));
          if(b?.embedded&&a?.embedded&&a.encoding==='utf8'&&b.encoding==='utf8')for(const part of lineDiff(b.content,a.content))viewer.append(el('div',part.text,'diff-line '+part.kind));
          else if(a?.embedded&&a.encoding==='utf8')viewer.append(pre(a.content));else viewer.append(el('p','Missing, binary or explicitly omitted source. See the artifact inventory.','notice'));};select.addEventListener('change',show);show();
      }else if(inspectorTab==='judge'){
        const p=await payload(row),r=p.result;body.append(el('h3',`${row.outcome} · ${row.groupsPassed??'?'}/${row.groupsTotal??'?'} independent groups`));body.append(el('p',`Public exit ${r?.publicExit??'unknown'}; hidden exit ${r?.hiddenExit??'unknown'}; protected changes ${row.protectedChanges??'unknown'}. Project accepted: ${row.accepted??'unknown'}. Clean finish: ${row.completed??'unknown'}.`));
        for(const g of r?.grade?.groups??[]){const n=el('div',`${g.pass?'PASS':'FAIL'} · ${g.name}`,'judge-group'+(g.pass?' pass':''));if(g.error)n.append(pre(g.error));body.append(n);}
        const bar=el('div',undefined,'inspect-toolbar');for(const name of ['public.stdout.log','hidden.stdout.log','judge/grader.mjs','judge/task.md'])if(p.artifacts.some(a=>a.path===name))bar.append(button(name,()=>{picked={artifact:name};inspectorTab='evidence';renderInspector();},'quiet'));body.append(bar);
      }
    }catch(error){body.append(el('p',error.message,'notice'));}
  }
  $('download-summary').addEventListener('click',()=>blobDownload('showcase.json',JSON.stringify(data,null,2)+'\n','application/json'));
  $('method-button').addEventListener('click',()=>openInspector(null,'provenance'));
  $('close-inspector').addEventListener('click',()=>$('inspector').close());
  $('results-view').addEventListener('click',()=>{results=true;playing=false;t=duration();render();});
  $('replay-view').addEventListener('click',()=>{results=false;playing=false;t=0;render();});
  $('play').addEventListener('click',()=>{if(results||t>=duration()){results=false;t=0;}playing=!playing;previous=0;render();});
  $('finish').addEventListener('click',()=>{results=true;playing=false;t=duration();render();});
  $('seek').addEventListener('input',()=>{results=false;playing=false;t=Number($('seek').value);render();});
  $('broadcast').addEventListener('click',()=>{const on=document.body.classList.toggle('broadcast');$('broadcast').setAttribute('aria-pressed',String(on));$('broadcast').textContent=on?'↙ Exit focus':'⛶ Focus';});
  let drawn=0;function frame(now){if(playing){if(previous)t=Math.min(duration(),t+(now-previous)*Number($('speed').value));previous=now;if(now-drawn>120||t>=duration()){if(t>=duration()){playing=false;results=true;}render();drawn=now;}}else previous=0;requestAnimationFrame(frame);}t=duration();render();requestAnimationFrame(frame);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),roots=[];let output=null,mode='private';for(let i=0;i<args.length;i++){
    if(args[i]==='--series')roots.push(args[++i]);else if(args[i]==='--output')output=args[++i];else if(args[i]==='--mode')mode=args[++i];else throw Error('usage: factory-showcase.mjs --series ABS_RUN [--series ABS_RUN] --output ABS_NEW_DIRECTORY --mode private|public');
  }console.log(JSON.stringify(writeShowcase({roots,output,mode})));}catch(error){console.error(error.message);process.exitCode=1;}
}
