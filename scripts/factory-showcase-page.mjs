// The product tour uses reviewed fight data; publishing never runs a model.
import fs from 'node:fs';
import {PUBLIC_FACTORY_CARDS} from './factory-card-catalog.mjs';
import {performanceView} from './fight-performance.mjs';

const E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ROOT=new URL('../site/',import.meta.url);
export const SHOWCASE_STATIC_FILES=Object.freeze([
  'style.css','site.js','demos.js','rooster.js','hardware.json','img/bantam-mark.svg',
  'fonts/barlow-condensed-800.woff2','fonts/manrope-400.woff2','fonts/manrope-700.woff2',
  'fonts/source-code-pro-400.woff2','fonts/source-code-pro-600.woff2',
  'fonts/barlow-OFL.txt','fonts/manrope-OFL.txt','fonts/source-code-pro-OFL.txt',
  'examples/tetris/index.html','examples/tetris/BANTAMTETRIS.html','examples/tetris/build.json',
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
  for(const name of ['.','fonts','img','examples','examples/tetris']){
    const stat=fs.lstatSync(new URL(name,ROOT));
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Expected plain showcase directory');
  }
  return SHOWCASE_STATIC_FILES.map(name=>['assets/showcase/'+name,read(name)]);
}
const seconds=ms=>Number.isFinite(ms)&&ms>=0?(ms/1000).toFixed(1)+' s':'Time not recorded';
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
  const local=views(['bantam-local-27b']),peers=views(['hermes','opencode','deepseek-local-27b']);
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
  insert('FIGHT_SPEEDS',renderShowcaseSpeeds(data));
  const hardware=JSON.parse(read('hardware.json'));
  insert('FIGHT_PREVIEW',`<script id="fight-preview" type="application/json">${JSON.stringify(preview).replace(/</g,'\\u003c')}</script><script id="hardware-preview" type="application/json">${JSON.stringify(hardware).replace(/</g,'\\u003c')}</script>`);
  insert('INTRO_LINK',intro?'<a class="intro-link" href="assets/motion/player.html">Meet your factory · 18-second film ↗</a>':'');
  return html;
}
