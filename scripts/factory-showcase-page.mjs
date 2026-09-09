// The product tour uses reviewed fight data; publishing never runs a model.
import fs from 'node:fs';
import {PUBLIC_FACTORY_CARDS} from './factory-card-catalog.mjs';
import {performanceView} from './fight-performance.mjs';

const E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ROOT=new URL('../site/',import.meta.url);
export const SHOWCASE_STATIC_FILES=Object.freeze([
  'style.css','chrome.css','brand.js','site.js','demos.js','rooster.js','hardware.json','img/bantam-mark.svg',
  'fonts/barlow-condensed-800.woff2','fonts/manrope-400.woff2','fonts/manrope-700.woff2',
  'fonts/source-code-pro-400.woff2','fonts/source-code-pro-600.woff2',
  'fonts/barlow-OFL.txt','fonts/manrope-OFL.txt','fonts/source-code-pro-OFL.txt',
  'examples/tetris/index.html','examples/tetris/BANTAMTETRIS.html','examples/tetris/build.json',
  'examples/arcade/index.html','examples/arcade/arcade.css','examples/arcade/arcade.js','examples/arcade/builds.json','examples/arcade/attempts.json',
  'examples/arcade/astra-cli.html','examples/arcade/astra-cli.json','examples/arcade/astra-factory.html','examples/arcade/astra-factory.json',
  'examples/arcade/astra-factory-context.html','examples/arcade/astra-factory-context.json',
  'examples/arcade/astra-cli-efficient.html','examples/arcade/astra-cli-efficient.json',
  'examples/arcade/astra-factory-efficient.html','examples/arcade/astra-factory-efficient.json',
]);
const ARMS=Object.freeze([
  ['bantam-local-27b','BANTAM FACTORY','Qwen 27B, local'],
  ['hermes','Hermes','same local model'],
  ['opencode','OpenCode','same local model'],
  ['deepseek-local-27b','DeepSeek Harness','same local model'],
  ['pi','Pi','same local model'],
  ['codex-astra','Codex','GPT-6 Astra, cloud'],
]);
const showcaseArms=data=>ARMS.filter(([arm])=>arm!=='pi'||data.cards.some(c=>c.rows?.some(r=>r.arm==='pi')));
function read(name){
  const file=new URL(name,ROOT),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Expected bounded showcase source');
  return fs.readFileSync(file);
}
export function showcaseAssets(){
  for(const name of ['.','fonts','img','examples','examples/tetris','examples/arcade']){
    const stat=fs.lstatSync(new URL(name,ROOT));
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Expected plain showcase directory');
  }
  return SHOWCASE_STATIC_FILES.map(name=>['assets/showcase/'+name,read(name)]);
}
const seconds=ms=>Number.isFinite(ms)&&ms>=0?(ms/1000).toFixed(1)+' s':'Time not recorded';
// Explicit reviewed cohorts, not a search for each model's fastest attempt.
const CODEX_PAIRS=[
  {id:'astra',name:'Astra',model:'GPT-6 Astra',cards:['context-packet-astra-context-1','context-packet-astra-context-2']},
  {id:'sol',name:'Sol',model:'GPT-5.6 Sol',cards:['context-packet-sol-1','context-packet-sol-2']},
  {id:'terra',name:'Terra',model:'GPT-5.6 Terra',cards:['context-packet']},
];
export function renderCodexEfficiency(data){
  const number=n=>n.toLocaleString('en-US');
  const panels=CODEX_PAIRS.flatMap(selection=>{
    const cards=selection.cards.map(id=>data.codex?.cards?.find(c=>c.id===id));
    if(cards.some(c=>!c?.recorded))return [];
    const pairs=cards.map(card=>['bantam-codex-','codex-'].map(prefix=>card.rows.find(r=>r.arm===prefix+selection.id)));
    if(pairs.flat().some(r=>!r||!r.accountingComplete||!r.model?.startsWith(selection.model+' · ')
      ||!Number.isFinite(r.wallMs)||r.wallMs<=0||!['inputTokens','outputTokens','cacheHitTokens'].every(k=>Number.isSafeInteger(r.tokens?.[k])&&r.tokens[k]>=0)
      ||r.tokens.inputTokens===0||r.tokens.cacheHitTokens>r.tokens.inputTokens))return [];
    const sums=[0,1].map(lane=>pairs.reduce((a,pair)=>{
      const r=pair[lane];for(const k of ['inputTokens','outputTokens','cacheHitTokens'])a[k]+=r.tokens[k];
      a.wallMs+=r.wallMs;a.passed+=Number(r.passed);return a;
    },{inputTokens:0,outputTokens:0,cacheHitTokens:0,wallMs:0,passed:0}));
    const [factory,native]=sums,change=1-factory.inputTokens/native.inputTokens;
    const completed=pairs.flat().every(r=>r.passed),ratio=native.wallMs/factory.wallMs;
    const clock=completed?(ratio>=1.05?`${ratio.toFixed(1)}× faster`:ratio<=.95?`${(1/ratio).toFixed(1)}× longer`:'Similar wall time'):'Completion differs';
    const badge=completed?`${Math.round(Math.abs(change)*100)}<span>%</span>`:`${factory.passed}<span>/${pairs.length}</span>`;
    const label=completed?`${change>=0?'less':'more'} input`:'factory completions';
    const max=Math.max(factory.inputTokens,native.inputTokens);
    const bars=sums.map((r,i)=>`<div class="codex-input-row"><div><b>${i?'Native CLI':'BANTAM FACTORY'}</b><span>${number(r.inputTokens)}</span></div><div class="codex-input-track"><span class="${i?'native':'factory'}" style="width:${(r.inputTokens/max*100).toFixed(2)}%"></span></div></div>`).join('');
    const metrics=[['Output tokens','outputTokens'],['Prefix cache tokens','cacheHitTokens'],['Wall clock','wallMs']]
      .map(([label,key])=>`<tr><th scope="row">${label}</th>${sums.map(r=>`<td>${key==='wallMs'?seconds(r[key]):number(r[key])}</td>`).join('')}</tr>`).join('');
    const links=cards.map((card,i)=>{
      const hash=new URLSearchParams({card:card.workOrder??'context-packet',view:'results',layout:'compare',left:'bantam-codex-'+selection.id,right:'codex-'+selection.id});
      return `<a href="codex/${E(card.id)}/share/index.html#${E(hash)}">${cards.length===1?'Open the fight':`Round ${i+1}`} ↗</a>`;
    }).join('');
    return [`<article class="codex-result"><header><h3>${selection.name}</h3><span>${pairs.length} paired ${pairs.length===1?'run':'runs'}</span></header><div class="codex-saving"><strong>${badge}</strong><div><b>${label}</b><span>${clock}</span></div></div><div class="codex-inputs" aria-label="Total input tokens">${bars}</div><table><caption class="sr-only">${selection.name}: recorded totals across ${pairs.length} paired runs</caption><thead><tr><th scope="col">Recorded totals</th><th scope="col">Factory</th><th scope="col">CLI</th></tr></thead><tbody>${metrics}<tr><th scope="row">Jobs completed</th><td>${factory.passed}/${pairs.length}</td><td>${native.passed}/${pairs.length}</td></tr></tbody></table><footer>${links}</footer></article>`];
  });
  if(!panels.length)return '';
  return `<section class="band codex-efficiency" id="codex" aria-labelledby="codex-heading"><p class="codex-eyebrow">SAME MODEL. SAME JOB. DIFFERENT HARNESS.</p><h2 id="codex-heading">Give Codex<br><span>a factory.</span></h2><p class="codex-lede">Put Astra, Sol or Terra to work with the Codex account you already have. The factory keeps the next step focused and checks the result. Here’s the same work in both harnesses.</p><div class="codex-results">${panels.join('')}</div><p class="fine codex-accounting">Context Packet · medium effort · identical starting files and independent checks. Repeats are summed. Prefix cache tokens are included in input tokens.</p><a class="codex-build-link" href="assets/showcase/examples/arcade/index.html">What about the work itself? Play the two Astra builds ↗</a></section>`;
}
export function renderShowcaseHighlights(data){
  const selections=[['hermes','context-packet'],['opencode','patch-transaction'],['pi','context-packet'],['deepseek-local-27b','receipt-reducer']];
  const cards=showcaseRows(data),sameModel=/^Qwen 27B · same local (?:model|weights)$/,rigs=[];
  const highlights=selections.flatMap(([arm,id])=>{
    const card=cards.find(c=>c.id===id),factory=card?.rows.find(r=>r?.arm==='bantam-local-27b'),peer=card?.rows.find(r=>r?.arm===arm);
    if(!factory?.passed||!peer?.passed||!sameModel.test(factory.model)||!sameModel.test(peer.model)
      ||!Number.isFinite(factory.wallMs)||!Number.isFinite(peer.wallMs)||factory.wallMs<=0||peer.wallMs/factory.wallMs<1.05)return [];
    const hash=new URLSearchParams({card:id,view:'results',layout:'compare',left:factory.arm,right:peer.arm});
    rigs.push(performanceView(factory.performance)?.hardware??null);
    return [`<a class="proof-fight" href="${id}/share/index.html#${E(hash)}"><strong>${(peer.wallMs/factory.wallMs).toFixed(1)}<span>×</span></strong><span class="proof-peer">faster than ${E(peer.label)}</span><span class="proof-job">${E(card.title)} <span aria-hidden="true">↗</span></span><span class="proof-times"><span>Factory ${seconds(factory.wallMs)}</span><span>${E(peer.label)} ${seconds(peer.wallMs)}</span></span></a>`];
  });
  if(!highlights.length)return '';
  const rig=rigs.every(r=>r&&r===rigs[0])?`${E(rigs[0])} · `:'';
  return `<section class="hero-proof" aria-labelledby="proof-heading"><div class="proof-heading"><h2 id="proof-heading">Same 27B. Faster finishes.</h2><p>Selected fights. Both completed the job.<br>${rig}Same local weights.</p></div><div class="proof-fights">${highlights.join('')}</div></section>`;
}
export function showcaseRows(data){
  return data.cards.filter(c=>c.recorded).map(card=>{
    const metadata=PUBLIC_FACTORY_CARDS[card.id];
    if(!metadata)throw Error('Unrecognized showcase card');
    return {...metadata,id:card.id,rows:showcaseArms(data).map(([arm,label,model])=>{
      const row=card.rows.find(r=>r.arm===arm);
      return row?{...row,arm,label,model:row.model}:null;
    })};
  });
}
export function renderShowcaseResults(data){
  const cards=showcaseRows(data);
  if(!cards.length)return '<p>Recorded comparisons will appear here as the work orders are published.</p>';
  const cell=(row,id)=>{
    if(!row)return '<td class="pending">Not run yet</td>';
    const outcome=row.passed?'Pass':row.outcome==='OUTPUT_ONLY'?'Output only':row.outcome==='TIMEOUT'?'Timed out':String(row.outcome??'Recorded').toLowerCase();
    const checks=row.groupsTotal>0?` · ${row.groupsPassed}/${row.groupsTotal} checks`:'';
    const hash=new URLSearchParams({card:id,view:'results',layout:'compare',left:'bantam-local-27b',right:row.arm==='bantam-local-27b'?'hermes':row.arm});
    return `<td class="${row.arm==='bantam-local-27b'?'bantam-result':row.passed?'complete':'miss'}" data-arm="${row.arm}"><a href="${id}/share/index.html#${E(hash)}">${seconds(row.wallMs)}<small>${E(outcome+checks)}</small></a></td>`;
  };
  return `<p>${cards.length} recorded jobs. The same work order, starting files, and independent checks for each contender. Local contenders use the same Qwen 27B weights; Codex uses GPT-6 Astra through its own CLI. Open any result for the complete record.</p><div class="table-wrap" tabindex="0" role="region" aria-label="Recorded fight results; scroll horizontally on small screens"><table class="results"><caption class="sr-only">Recorded outcomes and wall time by work order and harness</caption><thead><tr><th scope="col">Job</th>${showcaseArms(data).map(([,label,model])=>`<th scope="col">${label}<span>${model}</span></th>`).join('')}</tr></thead><tbody>${cards.map(card=>`<tr data-card="${card.id}"><th scope="row" class="job"><a href="${card.id}/share/index.html">${E(card.title)}</a><span class="kind">${E(card.kind)}</span></th>${card.rows.map(row=>cell(row,card.id)).join('')}</tr>`).join('')}</tbody></table></div><p class="fine">Times are wall clock. “Output only” means the files passed the checks, but the attempt did not complete within the recorded limit. Missing attempts are marked “Not run yet.”</p>`;
}
export function renderShowcaseSpeeds(data){
  const rows=data.cards.filter(c=>c.recorded).flatMap(c=>c.rows);
  const views=arm=>rows.filter(r=>arm.includes(r.arm)).map(r=>performanceView(r.performance)).filter(v=>v&&!v.partial&&v.generationRate!==null);
  const local=views(['bantam-local-27b']),peers=views(['hermes','opencode','deepseek-local-27b','pi']);
  const range=vs=>{const rates=vs.map(v=>v.generationRate);return `${Math.min(...rates).toFixed(1)}–${Math.max(...rates).toFixed(1)}`;};
  if(!local.length)return '';
  const rigs=[...new Set(local.map(v=>v.hardware).filter(Boolean))];
  return `<p class="fine recorded-speeds">${rigs.length===1?`Local rig: ${E(rigs[0])}. `:''}Recorded BANTAM FACTORY generation speeds: <strong>${range(local)} tokens/second</strong>${peers.length?`; other local harnesses: ${range(peers)}`:''}. These ranges use complete saved generation timings. Each card includes the hardware, timing coverage, and model settings.</p>`;
}
export function renderFactoryShowcase(data,{intro=false}={}){
  let html=read('index.html').toString('utf8');
  const context=showcaseRows(data).find(c=>c.id==='context-packet');
  const preview=context?{title:context.title,rows:context.rows.filter(Boolean).map(r=>({arm:r.arm,label:r.label,wallMs:r.wallMs,passed:r.passed,outcome:r.outcome,groupsPassed:r.groupsPassed,groupsTotal:r.groupsTotal}))}:null;
  const insert=(key,value)=>{
    const marker=`<!-- ${key} -->`;
    if(html.split(marker).length!==2)throw Error('Expected one showcase template marker: '+key);
    html=html.replace(marker,()=>value);
  };
  insert('FIGHT_RESULTS',renderShowcaseResults(data));
  insert('FIGHT_HIGHLIGHTS',renderShowcaseHighlights(data));
  insert('FIGHT_SPEEDS',renderShowcaseSpeeds(data));
  insert('CODEX_EFFICIENCY',renderCodexEfficiency(data));
  const hardware=JSON.parse(read('hardware.json'));
  insert('FIGHT_PREVIEW',`<script id="fight-preview" type="application/json">${JSON.stringify(preview).replace(/</g,'\\u003c')}</script><script id="hardware-preview" type="application/json">${JSON.stringify(hardware).replace(/</g,'\\u003c')}</script>`);
  insert('INTRO_LINK',intro?'<a class="intro-link" href="assets/motion/player.html">Meet your factory · 18-second film ↗</a>':'');
  return html;
}
