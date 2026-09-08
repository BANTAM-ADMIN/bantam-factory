// Presentation only. Reads the repository's vector brand; never runs contenders.
import fs from 'node:fs';
import {PUBLIC_BOARD_CSS,factoryName} from './fight-design.mjs';
import {performanceView} from './fight-performance.mjs';
import {demoMatchesRows} from './fight-demo.mjs';
import {renderContextDemo,contextDemoBrowser} from './fight-demo-page.mjs';
import {renderWorkLane,fightWorkBrowser,FIGHT_WORK_CSS} from './fight-work-page.mjs';

const BRAND=fs.readFileSync(new URL('../docs/brand/bantam-mark.svg',import.meta.url),'utf8');
const E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const J=v=>JSON.stringify(v).replace(/[<>&\u2028\u2029]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const number=v=>valid(v)?v.toLocaleString('en-US'):'Unknown';
const seconds=v=>valid(v)?`${(v/1000).toFixed(1)}s`:'Unknown';
const duration=v=>valid(v)?`${Math.floor(v/60000)}:${(v/1000%60).toFixed(1).padStart(4,'0')}`:'Unknown';
const FIELDS=[['inputTokens','Input'],['outputTokens','Output'],['cacheHitTokens','Cached input'],['freshInputTokens','Fresh input']];
const outcomeClass=v=>v==='PASS'?'pass':v==='FAIL'||v==='SETUP_ERROR'?'fail':'other';
const groupText=r=>valid(r?.groupsPassed)&&valid(r?.groupsTotal)?`${r.groupsPassed}/${r.groupsTotal}`:'Unknown';
const flag=v=>v===true?'Yes':v===false?'No':'Unknown';

export function matchupVerdict(rows,ended=true){
  if(rows.length!==2)return null;
  const title=rows.every(row=>/^Qwen 27B · same local (?:model|weights)$/.test(row.model))
    ?'Same local 27B. Different harnesses.':'Same work order. Compare the recorded systems.';
  if(!ended)return {title,detail:'Recorded clocks are running. Final outcomes appear at each endpoint.'};
  const passed=row=>row.recorded===true&&row.outcome==='PASS'&&row.accepted===true&&row.completed===true
    &&row.publicExit===0&&row.hiddenExit===0&&row.protectedChanges===0&&row.groupsTotal>0
    &&row.groupsPassed===row.groupsTotal&&Number.isFinite(row.wallMs)&&row.wallMs>0;
  const label=row=>factoryName(row.label);
  const time=row=>`${(row.wallMs/1000).toFixed(1)}s`;
  if(rows.every(passed)){
    const [first,second]=[...rows].sort((a,b)=>a.wallMs-b.wallMs);
    return {title,detail:first.wallMs===second.wallMs?'Both passed and finished in the same recorded time.'
      :`${label(first)} finished in ${time(first)}; ${label(second)} in ${time(second)}. Both passed. ${((1-first.wallMs/second.wallMs)*100).toFixed(1)}% less elapsed time for this task.`};
  }
  return {title,detail:rows.map(row=>passed(row)?`${label(row)} passed and finished in ${time(row)}.`
    :row.recorded!==true?`${label(row)} has no recorded attempt.`
    :row.outcome==='OUTPUT_ONLY'?`${label(row)} produced accepted output, but did not finish cleanly (${time(row)} elapsed).`
    :`${label(row)}: ${row.outcome}${Number.isFinite(row.wallMs)?` at ${time(row)}`:''}.`).join(' ')};
}

function assertData(data){
  if(data?.schema!=='bantam.launch-fight-card.v1'||!Array.isArray(data.series))throw Error('Expected a public launch fight-card document');
  return data;
}
function comparisonSeries(data){return data.series.find(s=>s.id===data.comparison?.seriesId)??data.series.find(s=>s.kind==='comparison');}
function spotlight(data){
  const s=data.series.find(s=>s.id===data.spotlight?.seriesId);
  const c=s?.cards.find(c=>c.id===data.spotlight?.cardId);
  return {series:s,card:c,row:c?.rows.find(r=>r.recorded)};
}
function usableComparison(c){return c&&valid(c.lessTimePercent)&&c.lessTimePercent<100&&valid(c.bantamWallMs)&&valid(c.deepseekWallMs)&&c.deepseekWallMs>0;}

function legacyComparison(series){
  const cards=['receipt-reducer','snapshot-drift','job-planner'];
  const arms=['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','bantam-codex-astra'];
  return series?.cards.length===cards.length&&cards.every(id=>series.cards.some(card=>card.card===id&&card.repeat===1
    &&card.rows.length===arms.length&&arms.every(arm=>card.rows.some(row=>row.arm===arm))));
}
function comparisonSummary(series){
  const cards=series?.cards??[],rows=cards.flatMap(card=>card.rows);
  const accepted=row=>row.recorded===true&&row.accepted===true&&row.publicExit===0&&row.hiddenExit===0
    &&row.protectedChanges===0&&valid(row.groupsTotal)&&row.groupsTotal>0&&row.groupsPassed===row.groupsTotal;
  const countFamily=family=>new Set(rows.filter(row=>row.family===family).map(row=>row.arm)).size;
  return {cards,rows,total:rows.length,recorded:rows.filter(row=>row.recorded===true).length,
    passed:rows.filter(row=>accepted(row)&&row.outcome==='PASS'&&row.completed===true).length,
    accepted:rows.filter(accepted).length,systems:new Set(rows.map(row=>row.arm)).size,
    local:countFamily('local'),frontier:countFamily('astra')};
}

// Presentation order only: do not reorder the portable evidence or imply rank.
function shareDisplayRows(rows){
  const order=['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','codex-sol','codex-terra','bantam-codex-astra','claude-sonnet','claude-opus','claude-fable'];
  const rank=row=>{const i=order.indexOf(row.arm);return i<0?order.length:i;};
  return rows.map((row,i)=>({row,i})).sort((a,b)=>rank(a.row)-rank(b.row)||a.i-b.i).map(x=>x.row);
}

// Spotlight the local factory, not the whole roster's combined pass rate.
// Missing attempts stay in its denominator; accepted artifacts without clean
// completion must not turn into a verified-finish headline.
function localFactoryHeadline(summary){
  const rows=summary.rows.filter(row=>row.arm==='bantam-local-27b');
  if(!rows.length)return {score:`${summary.passed}/${summary.total}`,label:'attempts passed and completed',detail:'Recorded system comparison'};
  const passed=rows.filter(row=>row.recorded===true&&row.outcome==='PASS'&&row.accepted===true
    &&row.completed===true&&row.publicExit===0&&row.hiddenExit===0&&row.protectedChanges===0
    &&valid(row.groupsTotal)&&row.groupsTotal>0&&row.groupsPassed===row.groupsTotal);
  if(rows.length===1){
    const row=rows[0];
    return {score:passed.length?groupText(row):(row.recorded===true?(row.outcome==='PASS'?'UNVERIFIED':row.outcome):'PENDING'),
      label:passed.length?'BANTAM FACTORY · checks passed. Work completed.':'BANTAM FACTORY · recorded outcome',
      detail:row.recorded===true?`${seconds(row.wallMs)} elapsed · ${groupText(row)} acceptance groups`:'Attempt not yet recorded'};
  }
  const timed=rows.every(row=>row.recorded===true&&valid(row.wallMs));
  return {score:`${passed.length}/${rows.length}`,label:'BANTAM FACTORY · tasks passed and completed',
    detail:timed?`${seconds(rows.reduce((sum,row)=>sum+row.wallMs,0))} summed run time`:'Full-cohort time not yet available'};
}

function recordedComparisonShare(data){
  const s=comparisonSummary(comparisonSeries(data)),one=s.cards.length===1;
  const hero=localFactoryHeadline(s),rows=shareDisplayRows(s.rows);
  const title=one?s.cards[0].title:'Recorded factory comparison';
  const localRow=rows.find(r=>r.arm==='bantam-local-27b'),perf=performanceView(localRow?.performance);
  const rig=one&&perf?[perf.hardware,String(localRow.model).split(' · ')[0],perf.quantization,`${perf.generation} generation${perf.partial?' (subset)':''}`].filter(Boolean).join(' · '):null;
  const solo=s.systems===1;
  const brand=BRAND.replace(/<svg[^>]*>/,'<svg x="58" y="35" width="40" height="48" viewBox="0 0 100 100" color="#f2b544">');
  const columns=rows.length>6?4:Math.min(3,Math.max(1,rows.length));
  const across=(1084-(columns-1)*14)/columns;
  const rowCount=Math.ceil(rows.length/columns),height=rowCount>2?61:rowCount===2?97:181;
  const max=Math.max(1,...rows.map(r=>valid(r.wallMs)?r.wallMs:0));
  const tiles=one?rows.map((row,i)=>{
    const x=58+(i%columns)*(across+14),y=290+Math.floor(i/columns)*(height+12),local=row.bantam;
    const color=row.outcome==='PASS'?'#9fdbb8':['FAIL','SETUP_ERROR'].includes(row.outcome)?'#ffa295':'#f2b544';
    const compact=rowCount>2,clockSize=compact?22:rowCount===2?28:48;
    return `<g><rect x="${x}" y="${y}" width="${across}" height="${height}" rx="6" fill="${local?'#303924':'#1c2a22'}" stroke="${local?'#8f7741':'#35463b'}"/><rect x="${x+1}" y="${y+1}" width="${across-2}" height="3" rx="1" fill="${local?'#f2b544':'#708678'}"/><text x="${x+17}" y="${y+25}" fill="${local?'#f2b544':'#f4f1e7'}" font-size="${compact?14:17}" font-weight="700">${E(factoryName(row.label))}</text><text x="${x+17}" y="${y+(compact?52:rowCount===2?63:98)}" fill="#f4f1e7" font-family="monospace" font-size="${clockSize}">${E(seconds(row.wallMs))}</text><text x="${x+across-17}" y="${y+(compact?51:rowCount===2?63:98)}" text-anchor="end" fill="${color}" font-family="monospace" font-size="${compact?10:12}">${E(row.outcome)}</text>${!compact?`<rect x="${x+17}" y="${y+height-18}" width="${across-34}" height="3" fill="#35463b"/><rect x="${x+17}" y="${y+height-18}" width="${valid(row.wallMs)?(across-34)*row.wallMs/max:0}" height="3" fill="${local?'#f2b544':'#708678'}"/>`:''}${rowCount===1?`<text x="${x+17}" y="${y+137}" fill="#adbbb0" font-family="monospace" font-size="12">${E(groupText(row))} groups · ${row.completed?'finished':'finish unconfirmed'}</text>`:''}</g>`;
  }).join(''):`<text x="58" y="350" fill="#adbbb0" font-size="23">All ${s.total} planned attempts remain in the accompanying record.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${E(title)} · BANTAM FACTORY recorded ${solo?'run':'comparison'}"><g font-family="Arial,Helvetica,sans-serif"><rect width="1200" height="630" fill="#101916"/><rect width="1200" height="5" fill="#f2b544"/>${brand}<text x="112" y="67" fill="#f4f1e7" font-size="25" font-weight="700" letter-spacing="4">BANTAM FACTORY</text><text x="1142" y="64" text-anchor="end" fill="#adbbb0" font-family="monospace" font-size="12">${solo?'SOLO RUN / ON RECORD':'FIGHT CARD / ON RECORD'}</text><text x="58" y="145" fill="#f4f1e7" font-size="${title.length>33?40:52}" font-weight="700" letter-spacing="-1.6">${E(title)}</text><text x="58" y="228" fill="#f2b544" font-size="${hero.score.length>5?28:65}" font-weight="700" letter-spacing="-2">${E(hero.score)}</text><text x="${hero.score.length>5?365:255}" y="198" fill="#f4f1e7" font-size="23" font-weight="700">${E(hero.label)}</text><text x="${hero.score.length>5?365:255}" y="228" fill="#adbbb0" font-size="17">${E(hero.detail)}</text><text x="58" y="268" fill="#adbbb0" font-family="monospace" font-size="12">${s.cards.length} work order${s.cards.length===1?'':'s'} · ${s.systems} systems · ${s.recorded}/${s.total} attempts recorded</text>${tiles}${rig?`<text x="58" y="517" fill="#f2b544" font-family="monospace" font-size="12">${E(rig)}</text>`:''}<line x1="58" y1="532" x2="1142" y2="532" stroke="#35463b"/><text x="58" y="559" fill="#adbbb0" font-size="14">${s.accepted}/${s.total} artifacts accepted · ${s.passed}/${s.total} attempts passed and completed</text><text x="58" y="591" fill="#adbbb0" font-family="monospace" font-size="11">${solo?'ONE SYSTEM’S WORK. NO RESULT CLAIMED AGAINST ABSENT COMPETITORS.':`${s.local} local configurations · ${s.frontier} frontier references · different models`}</text><text x="1142" y="589" text-anchor="end" fill="#f2b544" font-size="15" font-weight="700">SMALL MODEL. HEAVY HITTER.</text></g></svg>`;
}

function presentationMode(value){
  if(!['comparison','qualification'].includes(value))throw Error('Unknown launch presentation');
  return value;
}
function qualificationSummary(data){
  const series=data.series.find(s=>s.kind==='variant'),cards=series?.cards??[];
  const rows=cards.flatMap(c=>c.rows),recorded=rows.filter(r=>r.recorded===true);
  const single=cards.every(c=>c.rows.length===1);
  const acceptedCards=cards.filter(c=>c.rows.length===1&&c.rows.every(r=>r.recorded===true&&r.bantam===true
    &&r.accepted===true&&r.publicExit===0&&r.hiddenExit===0
    &&r.protectedChanges===0&&valid(r.groupsTotal)&&r.groupsTotal>0&&r.groupsPassed===r.groupsTotal)).length;
  const passed=cards.filter(c=>c.rows.length===1&&c.rows.every(r=>r.recorded===true&&r.bantam===true
    &&r.outcome==='PASS'&&r.accepted===true&&r.completed===true&&r.publicExit===0&&r.hiddenExit===0
    &&r.protectedChanges===0&&valid(r.groupsTotal)&&r.groupsTotal>0&&r.groupsPassed===r.groupsTotal)).length;
  const sum=recorded.reduce((n,r)=>n+(valid(r.wallMs)?r.wallMs:0),0);
  const wallMs=cards.length&&single&&recorded.length===cards.length&&recorded.every(r=>valid(r.wallMs))&&Number.isSafeInteger(sum)?sum:null;
  const models=[...new Set(rows.map(r=>r.model).filter(v=>typeof v==='string'&&v))];
  return {series,cards,total:cards.length,passed,acceptedCards,recorded:recorded.length,wallMs,model:models.length===1?models[0]:'Recorded local workers'};
}

function qualificationShare(data){
  const q=qualificationSummary(data),score=q.total?`${q.passed}/${q.total}`:'—';
  const brand=BRAND.replace(/<svg[^>]*>/,'<svg x="70" y="48" width="52" height="52" viewBox="0 0 100 100" color="#e8a33d">');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="BANTAM FACTORY recorded local qualification">
  <rect width="1200" height="630" fill="#f1eee5"/><rect width="1200" height="7" fill="#d68b22"/>${brand}
  <text x="137" y="83" fill="#202923" font-family="Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="4">BANTAM FACTORY</text>
  <text x="1130" y="79" text-anchor="end" fill="#526058" font-family="monospace" font-size="14">RECORDED / LOCAL QUALIFICATION</text>
  <text x="70" y="180" fill="#202923" font-family="Arial,sans-serif" font-size="64" font-weight="700">Build. Extend. Repair.</text>
  <text x="70" y="294" fill="#202923" font-family="Arial,sans-serif" font-size="105" font-weight="700">${E(score)}</text>
  <text x="412" y="251" fill="#202923" font-family="Arial,sans-serif" font-size="29" font-weight="700">tasks passed and completed</text>
  <text x="412" y="288" fill="#526058" font-family="Arial,sans-serif" font-size="20">${E(q.model)} · BANTAM FACTORY</text>
  ${q.cards.slice(0,3).map((card,i)=>`<text x="70" y="${350+i*43}" fill="#202923" font-family="Arial,sans-serif" font-size="20">${E(card.kind)} · ${E(card.title)}</text><text x="1130" y="${350+i*43}" text-anchor="end" fill="#526058" font-family="monospace" font-size="20">${E(card.rows.length===1?card.rows[0].outcome:'Unknown')}</text>`).join('')}
  <line x1="70" y1="474" x2="1130" y2="474" stroke="#c8cec2"/>
  <text x="70" y="512" fill="#202923" font-family="Arial,sans-serif" font-size="20">${q.recorded}/${q.total} attempts recorded · ${q.acceptedCards}/${q.total} artifacts accepted · ${E(duration(q.wallMs))} summed run time</text>
  <text x="70" y="550" fill="#526058" font-family="Arial,sans-serif" font-size="17">One qualification cohort. Not a model comparison or a reliability estimate.</text>
  <text x="70" y="592" fill="#526058" font-family="monospace" font-size="13">PUBLIC MEASUREMENTS · PRIVATE TRANSCRIPTS OMITTED · NOTHING AUTOMATICALLY PUBLISHED</text></svg>`;
}

/** A public, self-contained social graphic. No transcript, URL or external asset. */
export function renderShareCard(input,{presentation='comparison'}={}){
  if(presentationMode(presentation)==='qualification')return qualificationShare(assertData(input));
  const data=assertData(input);
  if(!legacyComparison(comparisonSeries(data)))return recordedComparisonShare(data);
  const c=data.comparison,has=usableComparison(c);
  const pct=has?c.lessTimePercent.toFixed(1):'—';
  const brand=BRAND.replace(/<svg[^>]*>/,'<svg x="70" y="48" width="52" height="52" viewBox="0 0 100 100" color="#e8a33d">');
  const bWidth=has?Math.max(0,Math.min(700,700*c.bantamWallMs/c.deepseekWallMs)):0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="BANTAM FACTORY recorded same-model comparison">
  <rect width="1200" height="630" fill="#f1eee5"/><rect x="0" y="0" width="1200" height="7" fill="#d68b22"/>
  ${brand}<text x="137" y="83" fill="#202923" font-family="Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="4">BANTAM FACTORY</text>
  <text x="1130" y="79" text-anchor="end" fill="#526058" font-family="monospace" font-size="14" letter-spacing="2">RECORDED / SAME 27B WEIGHTS</text>
  <text x="70" y="180" fill="#202923" font-family="Arial,sans-serif" font-size="64" font-weight="700" letter-spacing="-3">Your model. A better factory.</text>
  <text x="70" y="294" fill="#202923" font-family="Arial,sans-serif" font-size="105" font-weight="700" letter-spacing="-5">${E(pct)}${has?'%':''}</text>
  <text x="412" y="251" fill="#202923" font-family="Arial,sans-serif" font-size="29" font-weight="700">${has?'less recorded time':'Recorded results'}</text>
  <text x="412" y="288" fill="#526058" font-family="Arial,sans-serif" font-size="20">${has?'BANTAM FACTORY vs DeepSeek Harness · same local model':'Inspect the accompanying measurements'}</text>
  <text x="70" y="361" fill="#202923" font-family="Arial,sans-serif" font-size="20" font-weight="700">BANTAM FACTORY</text>
  <rect x="260" y="339" width="${bWidth.toFixed(2)}" height="32" rx="3" fill="#bd7819"/>
  <text x="1130" y="362" text-anchor="end" fill="#202923" font-family="monospace" font-size="24">${E(has?duration(c.bantamWallMs):'Unknown')}</text>
  <text x="70" y="419" fill="#526058" font-family="Arial,sans-serif" font-size="20">DeepSeek Harness</text>
  <rect x="260" y="397" width="${has?700:0}" height="32" rx="3" fill="#677d73"/>
  <text x="1130" y="420" text-anchor="end" fill="#202923" font-family="monospace" font-size="24">${E(has?duration(c.deepseekWallMs):'Unknown')}</text>
  <line x1="70" y1="474" x2="1130" y2="474" stroke="#c8cec2"/>
  <text x="70" y="512" fill="#202923" font-family="Arial,sans-serif" font-size="20">${has?`${E(c.cards)} tasks. ${E(c.repeatCount)} recorded repeat. Both systems passed all compared tasks.`:'No comparable aggregate is available.'}</text>
  <text x="70" y="550" fill="#526058" font-family="Arial,sans-serif" font-size="17">Elapsed wall time, not decode speed. A recorded observation, not a general capability claim.</text>
  <text x="70" y="592" fill="#526058" font-family="monospace" font-size="13" letter-spacing="1">PUBLIC MEASUREMENTS · PRIVATE TRANSCRIPTS OMITTED · NOTHING AUTOMATICALLY PUBLISHED</text>
  </svg>`;
}

function staticTable(series){
  return series.map(s=>`<section class="static-series"><h3>${s.kind==='comparison'?(legacyComparison(s)?'Original six-system comparison':'Recorded system comparison'):E(s.title)}</h3>${s.cards.map(c=>`<h4>${E(c.title)}</h4><div class="table-scroll"><table><caption>Recorded outcomes, elapsed times and token accounting</caption><thead><tr><th>System</th><th>Outcome</th><th>Time</th><th>Groups</th><th>Project accepted</th><th>Clean finish</th>${FIELDS.map(([,l])=>`<th>${l}</th>`).join('')}<th>Scope</th></tr></thead><tbody>${c.rows.map(r=>{
    const subset=r.accounting?.complete===false&&r.accounting?.subset;
    const u=subset||r.accounting?.full||{};
    return `<tr><th>${E(factoryName(factoryName(r.label)))}<small>${E(r.model)}</small></th><td>${E(r.outcome)}</td><td>${seconds(r.wallMs)}</td><td>${groupText(r)}</td><td>${flag(r.accepted)}</td><td>${flag(r.completed)}</td>${FIELDS.map(([f])=>`<td>${number(u[f])}</td>`).join('')}<td>${subset?'Measured subset':'Recorded totals'}</td></tr>`;
  }).join('')}</tbody></table></div>`).join('')}</section>`).join('');
}

function rigPanel(series){
  if(series?.cards.length!==1)return '';
  const row=series.cards[0].rows.find(r=>r.arm==='bantam-local-27b'),v=performanceView(row?.performance);
  if(!v)return '';
  const model=String(row.model).split(' · ')[0];
  const settings=[model,v.quantization,v.contextTokens?`${number(v.contextTokens)} context tokens`:null].filter(Boolean).join(' · ');
  return `<section class="rig-panel wrap" aria-label="BANTAM FACTORY local hardware and generation speed"><div class="rig-machine"><p class="eyebrow">BANTAM FACTORY'S LOCAL SETUP</p><h2>${E(v.hardware??'Local hardware not recorded')}</h2><p>${E(settings)}</p></div><div class="rig-speed"><span>Recorded generation speed</span><strong>${E(v.generation)}</strong><span>${E(v.generationCoverage)}${v.partial?' · measured subset':''}</span></div><details><summary>What does this mean for my setup?</summary><div><p>This run used ${E(model)}${v.hardware?` on ${E(v.hardware)}`:''}. Compare generation speed using the same model and quantization. GPU memory, CPU offload, context size and prompt caching also affect performance.</p><p>Generation speed is measured while the server produces tokens. The task clock also includes reading context, running tools and testing. A GPU speed difference does not translate directly into the same change in total task time.</p><p>Fresh prompt processing: <strong>${E(v.prefill)}</strong> · ${E(v.prefillCoverage)}. Rates use total recorded tokens divided by total server time for each phase. Hardware is operator-confirmed; timings come from the saved server responses.</p></div></details></section>`;
}

export function renderLaunchPage(input,{previewImage='share-card.svg',presentation='comparison',publishedPath=null,demo=null,work=null}={}){
  if(!['share-card.svg','share-card.png'].includes(previewImage))throw Error('Preview image must be a generated local share card');
  if(publishedPath!==null&&!/^(?:references\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/share\/index\.html$/.test(publishedPath))throw Error('Invalid published card path');
  const galleryURL='https://bantam-admin.github.io/bantam-factory/';
  const home=publishedPath?(publishedPath.startsWith('references/')?'../../../index.html':'../../index.html'):galleryURL;
  const socialImage=publishedPath?galleryURL+publishedPath.replace('index.html',previewImage):previewImage;
  const qualification=presentationMode(presentation)==='qualification';
  const data=assertData(input),q=qualificationSummary(data),c=data.comparison,main=qualification?q.series:comparisonSeries(data),sp=spotlight(data),has=!qualification&&usableComparison(c);
  const generic=!qualification&&!legacyComparison(main),summary=comparisonSummary(main);
  if(work&&!(main?.cards.length===1&&work.card===main.cards[0].card&&work.files.length===main.cards[0].rows.length&&main.cards[0].rows.every(row=>work.files.some(f=>f.arm===row.arm&&f.wallMs===row.wallMs&&f.outcome===row.outcome))))throw Error('Work does not match the recorded card');
  if(demo&&!(main?.cards.length===1&&main.cards[0].card==='context-packet'&&demoMatchesRows(demo,main.cards[0].rows)))throw Error('Demo does not match the recorded card');
  const pct=has?c.lessTimePercent.toFixed(1):'—';
  const history=data.series.filter(s=>s.kind!=='comparison');
  const comparisonCount=main?.cards.flatMap(card=>card.rows).filter(row=>row.recorded).length??0;
  const share=renderShareCard(data,{presentation});
  const description=qualification?'BANTAM FACTORY local qualification: build, extend and repair useful tools. Recorded outcomes, elapsed times and token receipts.':generic?'Recorded factory comparison. Actual work orders, system outcomes, elapsed times and token receipts.':'BANTAM FACTORY recorded factory results. Same local model, different harnesses. Inspect outcomes, actual clocks and token receipts.';
  const socialDescription=qualification?'Recorded local-worker qualification. Accepted projects and clean completion are separate; no reliability estimate.':generic?`${summary.cards.length} work orders, ${summary.systems} systems, ${summary.recorded} recorded attempts. Local and frontier models are distinct.`:'Recorded results. Same local 27B model, different harnesses. Three tasks, one recorded repeat.';
  const solo=summary.systems===1;
  const soloBantam=solo&&summary.rows.every(r=>r.bantam);
  const pageTitle=main?.cards.length===1?main.cards[0].title:qualification?'BANTAM FACTORY qualification':'The fight cards';
  const hero=localFactoryHeadline(summary);
  const recordedPlate=`<aside class="result-plate" aria-label="Recorded system comparison"><div class="plate-top"><span class="eyebrow">${soloBantam?'Recorded / BANTAM FACTORY run':solo?'Recorded / single-system run':'Recorded / system comparison'}</span><span class="plate-number">${summary.cards.length} WORK ORDER${summary.cards.length===1?'':'S'}</span></div><div class="hero-number"${hero.score.length>5?' style="font-size:clamp(1.5rem,4vw,3rem)"':''}>${E(hero.score)}</div><h2>${E(hero.label)}</h2><p>${E(hero.detail)}</p><p>${summary.cards.map(card=>E(card.title)).join('<br>')||'No recorded work orders.'}</p><div class="mini-comparison"><div><span>Systems included</span><strong>${summary.systems}</strong></div><div><span>Attempts recorded</span><strong>${summary.recorded}/${summary.total}</strong></div></div><p class="plate-note">${summary.passed}/${summary.total} attempts passed and completed.<br>Artifacts accepted: ${summary.accepted}/${summary.total}.</p></aside>`;
  const followups=main?.followups??[];
  const followupNote=followups.length?`<p class="followup-note"><strong>Matchup completed with follow-up runs.</strong> ${followups.map(f=>`${f.arms.map(arm=>({'deepseek-local-27b':'DeepSeek Harness',hermes:'Hermes',opencode:'OpenCode'}[arm])).join(', ')} · ${E(f.startedAt.slice(0,10))}`).join('; ')}. Original BANTAM FACTORY result retained. Task, starter, grader and local model hashes match. <a href="#method">Run conditions ↓</a></p>`:'';
  const recordedMethod=`<section><h3>The recorded comparison</h3><p>${summary.cards.length} included work order${summary.cards.length===1?'':'s'}: ${summary.cards.map(card=>`${E(card.kind)} — ${E(card.title)} (repeat ${card.repeat})`).join('; ')||'none'}. ${summary.systems} systems and ${summary.recorded}/${summary.total} recorded attempts. Every arm receives the supplied materials for its work order; independent acceptance checks remain separate from worker tests.</p><p>Local configurations and frontier references are distinguished in each lane. A frontier result is not a same-model comparison. All included outcomes remain visible; missing results are not zero-cost runs and do not count as passes. Elapsed times and completion status are reported separately.</p><p>These are selected development work orders. The original and follow-up recording windows, model settings, tool policies and time limits are documented with each card.</p></section>`;
  const qualificationPlate=`<aside class="result-plate" aria-label="Recorded local qualification"><div class="plate-top"><span class="eyebrow">BANTAM FACTORY / local qualification</span><span class="plate-number">${q.total} WORK ORDERS</span></div><div class="hero-number">${q.total?`${q.passed}/${q.total}`:'—'}</div><h2>tasks passed and completed.</h2><p>${E(q.model)}<br>Build. Extend. Repair.</p><div class="mini-comparison"><div><span>Summed run time</span><strong>${duration(q.wallMs)}</strong></div><div><span>Attempts recorded</span><strong>${q.recorded}/${q.total}</strong></div></div><p class="plate-note">Artifacts accepted: ${q.acceptedCards}/${q.total}. Independent checks passed; factory completion is separate.<br>All included tasks count, including failures and unrecorded work.<br>One qualification cohort, not a model comparison or reliability estimate.</p></aside>`;
  const qualificationMethod=`<section><h3>The qualification</h3><p>${q.total} included work orders: ${q.cards.map(card=>`${E(card.kind)} — ${E(card.title)}`).join('; ')||'no recorded qualification cohort'}. This is BANTAM-only local-worker qualification, not a comparison against other harnesses or models. Independent acceptance checks are separate from the worker's own tests.</p><p>The score requires both an accepted project and clean completion, with passing public and independent checks and no protected-file changes. Every included task remains in the denominator. Missing results are not failures, but do not count as passes. Summed run time is unknown if any included attempt lacks a measured duration.</p><p>One cohort does not establish a reliability rate or general capability. Recorded configuration, sampling and cache state can affect results. This does not measure every later harness revision. Public measurements omit private execution context and source.</p></section>`;
  const spot=!qualification&&!generic&&sp.row?`<section class="qualification wrap" id="qualification" aria-labelledby="qualification-title">
    <div><p class="eyebrow">Another worker. The same idea.</p><h2 id="qualification-title">Small model.<br>A real work order.</h2><p class="section-copy">Tiel 35B-A3B, IQ4_XS, inside BANTAM FACTORY. The latest included Snapshot qualification stands on its own.</p><a class="text-link" href="#history">See included qualification history <span aria-hidden="true">↗</span></a></div>
    <article class="qualification-card"><div class="card-top"><span class="eyebrow">Latest included qualification</span><span class="status ${outcomeClass(sp.row.outcome)}">${E(sp.row.outcome)}</span></div><div class="qualification-score">${groupText(sp.row)}<span>independent<br>judge groups</span></div><h3>${E(sp.card.title)}</h3><p class="model-label">${E(sp.row.model)} · BANTAM FACTORY</p><div class="qualification-facts"><div><strong>${seconds(sp.row.wallMs)}</strong><span>recorded time</span></div><div><strong>${flag(sp.row.accepted)}</strong><span>project accepted</span></div><div><strong>${flag(sp.row.completed)}</strong><span>clean finish</span></div></div><p class="fineprint">One selected work order, not the six-system comparison. Latest included attempt. Earlier included misses remain below.</p></article>
  </section>`:'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">${demo?`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src ${work?"'self'":"'none'"}; base-uri 'none'; form-action 'none'">`:''}<meta name="theme-color" content="#101916"><meta name="description" content="${E(description)}"><meta property="og:type" content="website"><meta property="og:title" content="${E(pageTitle)} · BANTAM FACTORY fight cards"><meta property="og:description" content="${E(socialDescription)}"><meta property="og:image" content="${E(socialImage)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${E(socialImage)}"><title>${E(pageTitle)} · BANTAM FACTORY fight cards</title>${publishedPath?`<link rel="canonical" href="${galleryURL+publishedPath}">`:''}<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(BRAND).toString('base64')}"><style>${CSS}${work?FIGHT_WORK_CSS:''}</style></head><body>
  <a class="skip" href="#arena">Skip to recorded results</a>
  <header class="site-header wrap"><a class="brand" href="${home}" aria-label="BANTAM FACTORY fight gallery">${BRAND}<span>BANTAM FACTORY<small>THE MODEL IS NOT THE FACTORY.</small></span></a><nav aria-label="Main"><a href="${home}">All fights ↗</a><a href="#method">Method</a><button id="download-data" class="button small" type="button">Download data <span aria-hidden="true">↓</span></button></nav></header>
  <main id="top"><section class="hero wrap"><div class="hero-copy"><p class="eyebrow">${qualification?'BANTAM FACTORY / qualification':soloBantam?'BANTAM FACTORY / solo run':solo?'Single-system run':'BANTAM FACTORY / fight card'}</p><h1>${E(pageTitle)}<span style="color:var(--gold)">.</span></h1><p class="hero-description">${main?.cards.length===1?E(main.cards[0].description):'Build it. Extend it. Fix it. Explore the recorded work, one task at a time.'}</p>${followupNote}${solo?'<p class="solo-note">One recorded system. Challenger matchups will follow.</p>':''}<div class="hero-actions"><a class="button primary" href="#arena">Watch the work <span aria-hidden="true">↘</span></a>${demo?'<a class="button" href="#try-it">Try what it built ↓</a>':''}<button class="button" id="download-image" type="button">Download result image <span aria-hidden="true">↓</span></button></div></div>
    ${qualification?qualificationPlate:generic?recordedPlate:`<aside class="result-plate" aria-label="Observed same-model comparison"><div class="plate-top"><span class="eyebrow">Same model / different harness</span><span class="plate-number">01—03</span></div><div class="hero-number">${E(pct)}${has?'<span>%</span>':''}</div><h2>${has?'less recorded time.':'Recorded, not promised.'}</h2><p>${has?'BANTAM FACTORY vs DeepSeek Harness.<br>The same local 27B weights.':'Inspect the recorded systems below.'}</p><div class="mini-comparison"><div><span>BANTAM FACTORY</span><strong>${has?duration(c.bantamWallMs):'Unknown'}</strong><i class="bantam-mini" style="--w:${has?(100*c.bantamWallMs/c.deepseekWallMs).toFixed(2):0}%"></i></div><div><span>DeepSeek Harness</span><strong>${has?duration(c.deepseekWallMs):'Unknown'}</strong><i style="--w:${has?100:0}%"></i></div></div><p class="plate-note">${has?`${E(c.cards)} tasks · ${E(c.repeatCount)} recorded repeat · both passed all ${E(c.cards)}.<br>Aggregate elapsed time. Not a universal speed claim.`:'No comparable aggregate is available.'}</p></aside>`}
  </section>

${rigPanel(main)}
  <section class="arena-section" id="arena" aria-labelledby="arena-title"><div class="wrap"><div class="section-head"><div><p class="eyebrow">The recorded factory floor</p><h2 id="arena-title">${qualification?'The qualification board':solo?'The run, at a glance.':'Meet the contenders.'}</h2></div><p>${qualification?`${q.total} work orders inside BANTAM FACTORY.<br>${E(q.model)}.<br><span>${comparisonCount} recorded attempts shown. Missing work stays visible.</span>`:generic?`${summary.local} local configuration${summary.local===1?'':'s'}.${summary.frontier?`<br>${summary.frontier} frontier reference${summary.frontier===1?'':'s'}, shown separately.`:''}<br><span>Choose any contender. Open its work.</span>`:`Four harnesses, the same local 27B.<br>Two Astra configurations, shown separately.<br><span>All ${comparisonCount} comparison attempts shown. No tokens invented.</span>`}</p></div>
  <div class="interactive" id="interactive" hidden><div id="work-tabs" class="work-tabs" role="tablist" aria-label="Work order"></div><div class="work-heading"><div><p class="eyebrow" id="work-kind"></p><h3 id="work-title"></h3><p id="work-description"></p></div><button id="focus" class="button dark" type="button" aria-pressed="false">Focus view <span aria-hidden="true">⛶</span></button></div>
  <div class="board-tools" id="board-tools"><div class="view-switch" role="group" aria-label="Comparison layout"><button id="view-all" aria-pressed="true">All contenders</button><button id="view-compare" aria-pressed="false">Compare two</button></div><span id="board-count" class="board-count"></span><div id="compare-pickers" class="compare-pickers" hidden><label>Left corner<select id="compare-left" aria-label="Left contender"></select></label><label>Right corner<select id="compare-right" aria-label="Right contender"></select></label></div></div><div id="matchup-verdict" class="matchup-verdict" role="status" hidden><strong></strong><p></p></div><div class="playback"><button id="play" class="play-button" type="button" aria-label="Play recorded timeline">▶ <span>Replay</span></button><output id="clock" aria-label="Recorded elapsed time">FINAL</output><label class="sr-only" for="timeline">Recorded elapsed time</label><input id="timeline" type="range" min="0" max="1" step="1" value="1"><label class="speed-label" for="speed">Speed <select id="speed"><option value="1">1×</option><option value="5">5×</option><option value="10" selected>10×</option><option value="30">30×</option><option value="60">60×</option></select></label><button id="results" class="button dark" type="button">Final results</button></div>
  <div class="replay-caption"><span id="replay-note">Final recorded measurements.</span><span>Space: play / pause · ← →: seek</span></div><div id="finish-points" class="finish-points" aria-label="Jump to recorded finishes"></div><div id="lane-list" aria-live="off"></div><p class="arena-footnote">Bars show elapsed time against the longest recorded run, not percentage of work completed. Token counters advance only when a saved response supplies them.</p></div>
  <div id="static-results" class="static-results">${staticTable(main?[main]:[])}</div>
  </div></section>
${spot}
${demo?renderContextDemo():''}
  <section class="records wrap"><details id="history"${history.length?'':' hidden'}><summary><span><span class="eyebrow">Qualification history</span><strong>Progress includes the misses.</strong></span><span class="summary-aside">${history.length} local editions <b aria-hidden="true">+</b></span></summary><div class="details-body"><p>Selected qualification editions, not every development experiment. Earlier included failures are retained. These are separate attempts, not repeated trials of an unchanged system. An unrecorded task is not a failure.</p>${history.map((s,i)=>`<div class="history-edition"><h3>Local edition ${i+1} <span>${E(s.startedAt?.slice(0,10)??'Date unknown')} · ${s.complete?'recording complete':'recording incomplete'}</span></h3>${s.cards.map(card=>card.rows.map(r=>`<div class="history-row"><span>${E(card.title)}<small>${E(r.model)}</small></span><span class="status ${outcomeClass(r.outcome)}">${E(r.outcome)}</span><strong>${seconds(r.wallMs)}</strong><span>${groupText(r)} groups</span><span>Accepted: ${flag(r.accepted)}<br>Clean finish: ${flag(r.completed)}</span></div>`).join('')).join('')}</div>`).join('')}</div></details>
  <details id="method"><summary><span><span class="eyebrow">Method & evidence</span><strong>The work order and run conditions.</strong></span><span class="summary-aside">Read the method <b aria-hidden="true">+</b></span></summary><div class="details-body method-grid">${qualification?qualificationMethod:generic?recordedMethod:`<section><h3>The comparison</h3><p>Three useful Node.js tasks: build a receipt reducer, extend a snapshot tool, and repair a dependency planner. Every arm starts from the same supplied materials for each task. Independent acceptance checks are separate from the worker's own tests.</p><p>The six-system series has one recorded repeat. The headline compares aggregate elapsed wall time for BANTAM FACTORY and DeepSeek Harness on the same local 27B weights, with all three tasks passing for both. It is descriptive, not a statistical estimate or a claim about all models.</p><p>Recorded configurations differ in tool/output policies; cache was not cleared; frontier work overlapped local runs, so CPU/I/O contention is possible. These are historical system measurements, not a controlled context-only ablation or a measurement of every later harness revision.</p></section>`}<section><h3>Reading an outcome</h3><p><strong>PASS:</strong> project accepted and clean harness completion. <strong>OUTPUT_ONLY:</strong> the artifact passed but the run did not reach accepted completion. <strong>FAIL:</strong> a required check failed. Timeouts and unrecorded tasks remain visible.</p><p>Passing independent groups alone does not override a failed public suite or protected-file check. Accepted project and clean finish are separate facts. The independent groups check the supplied work order.</p></section><section><h3>Clocks & counters</h3><p>Replay aligns each run's recorded start to zero. Runs did not all start simultaneously. Counters use actual saved response times, not animated estimates. Untimed evidence is not assigned an invented timestamp.</p><p>Input includes cached input; fresh input excludes cache hits. These three numbers are not additive. Partial metering displays only the measured subset, with coverage disclosed. Unknown never means zero. Native reports and server windows are overlapping scopes, not extra tokens.</p></section><section><h3>The recorded work</h3><p>The measurement download contains the task identity, outcomes, timings and token receipts used by this page. Reviewed work records provide the associated actions, checks and delivered files. Qualification history contains selected editions, not every development experiment; earlier included failures are retained.</p><p>The page runs without telemetry. Source hashes bind the displayed measurements to their saved records.</p><p class="source-hash">Source summary SHA-256<br><code>${E(data.source?.sha256??'Unknown')}</code></p></section></div></details>
  </section>
  <section class="closing wrap"><p class="eyebrow">Put your model to work.</p><h2>Your model.<br>A better factory.</h2><div><a class="button primary" href="https://github.com/BANTAM-ADMIN/bantam-factory#quick-start">Get BANTAM FACTORY ↗</a><button id="share-svg" class="button" type="button">Download share card · SVG <span aria-hidden="true">↓</span></button><button id="print-page" class="button" type="button">Print results</button><p id="export-status" role="status">Recorded results, ready to explore.</p></div></section>
  </main><footer class="site-footer wrap"><span>BANTAM FACTORY / RECORDED RESULTS</span><span>Built to be inspected.</span><a href="#top">Back to top ↑</a></footer>
  <script id="launch-data" type="application/json">${J(data)}</script><script id="share-card-data" type="application/json">${J(share)}</script><script>const factoryName=${factoryName.toString()};const matchupVerdict=${matchupVerdict.toString()};${browser.toString()};browser(${J(presentation)},${J(Object.fromEntries(data.series.flatMap(s=>s.cards.flatMap(c=>c.rows.map(r=>[r.id,performanceView(r.performance)])))))},${J(Object.fromEntries((main?.cards??[]).flatMap(c=>c.rows.map(r=>[r.id,work?renderWorkLane(work.files.find(f=>f.arm===r.arm)):'']))))});</script>${work?`<script>(${fightWorkBrowser.toString()})();</script>`:''}${demo?`<script>(${contextDemoBrowser.toString()})();</script>`:''}</body></html>`;
}

const CSS=PUBLIC_BOARD_CSS;

function browser(presentation,performanceViews,workViews){
  'use strict';
  workViews??={};
  const data=JSON.parse(document.getElementById('launch-data').textContent);
  const share=JSON.parse(document.getElementById('share-card-data').textContent);
  const $=id=>document.getElementById(id);
  const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const n=v=>valid(v)?v.toLocaleString('en-US'):'Unknown';
  const clock=v=>valid(v)?`${Math.floor(v/60000)}:${(v/1000%60).toFixed(1).padStart(4,'0')}`:'Unknown';
  const fields=[['inputTokens','Input'],['outputTokens','Output'],['cacheHitTokens','Cached input'],['freshInputTokens','Fresh input']];
  const main=presentation==='qualification'?data.series.find(s=>s.kind==='variant'):(data.series.find(s=>s.id===data.comparison?.seriesId)??data.series.find(s=>s.kind==='comparison'));
  const cards=main?.cards??[];
  let ci=0,t=0,mode='results',playing=false,last=0,frame=0;
  let layout='compare',pair=[];
  const current=()=>cards[ci];
  const duration=()=>Math.max(0,...(current()?.rows??[]).flatMap(r=>[valid(r.wallMs)?r.wallMs:0,...(r.tokenUpdates??[]).filter(u=>valid(u.t)).map(u=>u.t)]));
  function hash(){const q=new URLSearchParams({card:current()?.card??'',view:mode,t:String(Math.round(t)),layout,left:pair[0]??'',right:pair[1]??''});history.replaceState(null,'','#'+q);}
  function readHash(){const q=new URLSearchParams(location.hash.slice(1)),index=cards.findIndex(c=>c.card===q.get('card'));if(index>=0)ci=index;mode=q.get('view')==='replay'?'replay':'results';layout=q.get('layout')==='all'?'all':'compare';pair=[q.get('left'),q.get('right')].filter((arm,i,all)=>arm&&all.indexOf(arm)===i);const v=Number(q.get('t'));t=mode==='results'?duration():Math.max(0,Math.min(duration(),Number.isFinite(v)?v:0));}
  function stop(){playing=false;cancelAnimationFrame(frame);frame=0;}
  function accounting(r){
    const perf=performanceViews[r.id];
    const speed=perf?`<p><strong>Recorded server speed</strong><br>Generation: ${e(perf.generation)} · ${e(perf.generationCoverage)}<br>Fresh prompt processing: ${e(perf.prefill)} · ${e(perf.prefillCoverage)}<br>Summed tokens / summed phase seconds; excludes tools and tests.${perf.hardware?' Hardware is operator-confirmed.':''}</p>`:'';
    const a=r.accounting??{},cov=a.coverage??{};
    const rows=[['Full recorded totals',a.full],['Measured subset only',a.subset],['Native report (overlapping)',a.native],['Server window (overlapping)',a.server]].filter(([,u])=>u);
    return `${speed}<p>Project accepted: <strong>${r.accepted===true?'Yes':r.accepted===false?'No':'Unknown'}</strong> · Clean finish: <strong>${r.completed===true?'Yes':r.completed===false?'No':'Unknown'}</strong> · Public exit: ${n(r.publicExit)} · Independent exit: ${n(r.hiddenExit)} · Protected changes: ${n(r.protectedChanges)}</p><div class="table-scroll"><table class="accounting-table"><caption>Token scopes — overlapping rows must not be added</caption><thead><tr><th>Scope</th>${fields.map(([,l])=>`<th>${l}</th>`).join('')}</tr></thead><tbody>${rows.map(([l,u])=>`<tr><th>${l}</th>${fields.map(([f])=>`<td>${n(u[f])}</td>`).join('')}</tr>`).join('')}<tr><th>Measured / requests</th>${fields.map(([f])=>`<td>${n(cov[f]?.measuredRequests)} / ${n(cov[f]?.totalRequests)}</td>`).join('')}</tr></tbody></table></div><p>Metering ${a.complete===true?'complete':a.complete===false?'incomplete':'completeness unknown'}. Timestamped events: ${n(r.timedEvents)}. Untimed events: ${n(r.untimedEvents)}. The work views contain the recorded actions, delivered files and acceptance output.</p>`;
  }
  function build(){
    if(!cards.length)return;
    $('interactive').hidden=false;$('static-results').hidden=true;
    $('work-tabs').innerHTML=cards.map((c,i)=>`<button role="tab" id="tab-${e(c.card)}" aria-selected="${i===ci}" tabindex="${i===ci?0:-1}" aria-controls="lane-list" data-card="${e(c.card)}"><b>${e(c.number??String(i+1).padStart(2,'0'))}</b><span><small>${e(c.kind)}</small><strong>${e(c.title)}</strong></span></button>`).join('');
    $('work-kind').textContent=`Work order ${current().number??ci+1} / ${current().kind}`;
    $('work-title').textContent=current().title;$('work-description').textContent=current().description;
    $('lane-list').setAttribute('role','tabpanel');$('lane-list').setAttribute('aria-labelledby',`tab-${current().card}`);
    const armOrder=['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','codex-sol','codex-terra','bantam-codex-astra'];
    const rank=r=>{const i=armOrder.indexOf(r.arm);return i<0?armOrder.length:i;};
    // Presentation order is independent of the counterbalanced execution order.
    // Keep each original index for receipt lookup; never reorder the input data.
    const displayed=current().rows.map((r,i)=>({r,i})).sort((a,b)=>rank(a.r)-rank(b.r)||a.i-b.i);
    const available=displayed.map(({r})=>r.arm);
    pair=pair.filter(arm=>available.includes(arm));
    for(const arm of available)if(pair.length<2&&!pair.includes(arm))pair.push(arm);
    if(available.length<2)layout='all';
    $('board-tools').hidden=available.length<2;
    for(const [id,index]of [['compare-left',0],['compare-right',1]]){
      $(id).innerHTML=displayed.map(({r})=>`<option value="${e(r.arm)}">${e(factoryName(r.label))}</option>`).join('');
      $(id).value=pair[index]??'';
    }
    $('finish-points').innerHTML=displayed.filter(({r})=>r.recorded&&valid(r.wallMs)).map(({r,i})=>`<button data-finish="${i}" title="Jump to ${e(factoryName(r.label))}'s recorded endpoint">${e(factoryName(r.label))} · ${(r.wallMs/1000).toFixed(1)}s ↗</button>`).join('');
    let group='';$('lane-list').innerHTML=displayed.map(({r,i})=>{
      const local=current().rows.filter(row=>row.family==='local');
      const localCount=new Set(local.map(row=>row.arm)).size;
      const localLabel=local.every(row=>/^Qwen 27B · same local (?:model|weights)$/.test(row.model))?'Same local 27B weights':'Local worker configurations';
      const g=current().rows.length===1?`Recorded system · ${r.model}`:presentation==='qualification'?`BANTAM FACTORY local qualification · ${r.model}`:(r.family==='astra'?'Frontier references · different models from the local worker':`${localLabel} · ${localCount===4?'four':localCount} different harness${localCount===1?'':'es'}`);
      const perf=performanceViews[r.id];
      const work=workViews[r.id]??'';
      const metrics=`<dl class="lane-metrics">${fields.map(([f,l])=>`<div class="metric"><dt>${l}</dt><dd class="token-${f}">Unknown</dd></div>`).join('')}</dl>`;
      const heading=g!==group?`<h4 class="lane-group">${e(g)}</h4>`:'';group=g;
      return `${heading}<article class="lane ${r.bantam?'bantam':''}" data-arm="${e(r.arm)}" data-family="${r.family==='astra'?'frontier':'local'}" data-row="${i}" aria-label="${e(factoryName(r.label))}"><div class="lane-main"><div><h4 class="lane-name">${e(factoryName(r.label))}</h4><span class="lane-model">${e(r.model)}</span>${perf?.hardware?`<span class="lane-hardware">${e(perf.hardware)}</span>`:''}${perf?'<span class="lane-generation"></span>':''}</div><div class="lane-track" aria-hidden="true"><div class="lane-bar"></div></div><strong class="lane-time"></strong><span class="lane-status status"></span></div>${work?'':metrics}<div class="lane-tail"><div class="lane-proof"><span class="project"></span><span class="finish"></span><span class="groups"></span><span class="receipt-scope"></span></div><details><summary>${work?'Tokens, speed & receipts':'Receipt & checks'}</summary><div class="lane-details">${work?metrics:''}${accounting(r)}</div></details></div>${work}</article>`;
    }).join('');
    $('timeline').max=String(duration());applyLayout();update();document.dispatchEvent(new Event('fight-lanes-built'));
  }
  function applyLayout(){
    const list=$('lane-list'),comparing=layout==='compare';
    list.dataset.layout=layout;
    list.dataset.columns=String(Math.min(3,current()?.rows.length??1));
    $('view-all').setAttribute('aria-pressed',String(!comparing));
    $('view-compare').setAttribute('aria-pressed',String(comparing));
    $('compare-pickers').hidden=!comparing;
    $('board-count').textContent=comparing?`2 of ${current().rows.length} contenders · full record retained`:`${current().rows.length} contenders · all recorded outcomes`;
    // Hide only the display. The download, timeline and complete score sheet retain every row.
    list.querySelectorAll('.lane').forEach(node=>{
      node.hidden=comparing&&!pair.includes(node.dataset.arm);
      node.style.order=comparing?String(pair.indexOf(node.dataset.arm)):'';
    });
    list.querySelectorAll('.lane-group').forEach(node=>{node.hidden=comparing;});
    $('finish-points').querySelectorAll('button').forEach(node=>{node.hidden=comparing&&!pair.includes(current().rows[Number(node.dataset.finish)].arm);});
  }
  function update(){
    if(!current())return;
    $('clock').textContent=mode==='results'?'FINAL':clock(t);
    $('timeline').value=String(t);$('timeline').setAttribute('aria-valuetext',`${clock(t)} of ${clock(duration())}`);
    $('play').innerHTML=playing?'Ⅱ <span>Pause</span>':'▶ <span>Replay</span>';
    $('play').setAttribute('aria-label',playing?'Pause recorded timeline':'Play recorded timeline');
    $('replay-note').textContent=mode==='results'?'Final recorded measurements.':'Replay · counters step at actual saved response times.';
    $('lane-list').querySelectorAll('.lane').forEach(node=>{
      const r=current().rows[Number(node.dataset.row)],ended=mode==='results'||(valid(r.wallMs)&&t>=r.wallMs);
      const a=r.accounting??{},subset=ended&&a.complete===false&&a.subset;
      const perf=performanceViews[r.id],generation=node.querySelector('.lane-generation');
      if(generation)generation.textContent=ended?`${perf.generation} generation${perf.partial?' · subset':''}`:'Generation speed shown at finish';
      let u=ended?(subset||a.full||{}):null;
      if(!ended){for(const tick of r.tokenUpdates??[])if(valid(tick.t)&&tick.t<=t)u=tick;}
      const partial=!!subset||u?.partial===true;
      const elapsed=ended?r.wallMs:(valid(r.wallMs)?Math.min(t,r.wallMs):null);
      node.querySelector('.lane-time').textContent=valid(elapsed)?`${(elapsed/1000).toFixed(1)}s`:'Unknown';
      node.querySelector('.lane-bar').style.width=`${duration()>0&&valid(elapsed)?Math.min(100,100*elapsed/duration()):0}%`;
      const status=node.querySelector('.lane-status');status.textContent=ended?r.outcome:'REPLAYING';status.className='lane-status status '+(ended&&r.outcome==='PASS'?'pass':ended&&['FAIL','SETUP_ERROR'].includes(r.outcome)?'fail':'other');
      for(const [f]of fields){const cell=node.querySelector('.token-'+f);cell.textContent=n(u?.[f]);cell.classList.toggle('unknown',!valid(u?.[f]));}
      const project=node.querySelector('.project'),finish=node.querySelector('.finish');
      project.textContent=ended?`Project ${r.accepted===true?'accepted':r.accepted===false?'not accepted':'unknown'}`:'Project pending';
      finish.textContent=ended?`Finish ${r.completed===true?'clean':r.completed===false?'not accepted':'unknown'}`:'Finish pending';
      project.className='project '+(ended?(r.accepted===true?'good':r.accepted===false?'bad':''):'');finish.className='finish '+(ended?(r.completed===true?'good':r.completed===false?'bad':''):'');
      node.querySelector('.groups').textContent=ended?`${valid(r.groupsPassed)&&valid(r.groupsTotal)?r.groupsPassed+'/'+r.groupsTotal:'Unknown'} groups`:'Judge pending';
      const coverage=valid(a.measuredRequests)&&valid(a.requests)?` · ${a.measuredRequests}/${a.requests} requests`:'';
      node.querySelector('.receipt-scope').textContent=ended?(partial?'Measured subset':'Recorded totals')+coverage:u?(partial?'Partial receipts':'Saved response')+' · '+clock(u.t):'Awaiting measured response';
      // Final receipts remain available in results mode, not leaked into replay before the endpoint.
      const detail=node.querySelector('details');detail.hidden=!ended;if(!ended)detail.open=false;const work=node.querySelector('.recorded-work');if(work)work.hidden=!ended;
    });
    const selected=pair.map(arm=>current().rows.find(row=>row.arm===arm)).filter(Boolean);
    const verdict=matchupVerdict(selected,mode==='results'||selected.every(row=>valid(row.wallMs)&&t>=row.wallMs));
    const note=$('matchup-verdict');note.hidden=layout!=='compare'||!verdict;
    if(verdict){for(const [selector,text]of [['strong',verdict.title],['p',verdict.detail]]){
      const child=note.querySelector(selector);if(child.textContent!==text)child.textContent=text;
    }}
    window.__launchState=()=>({card:current().card,t,mode,playing,layout,pair:[...pair]});
  }
  function select(index){stop();ci=index;t=duration();mode='results';build();hash();$('work-tabs').querySelector('[aria-selected=true]')?.focus({preventScroll:true});}
  function animate(now){if(!playing)return;if(last)t=Math.min(duration(),t+(now-last)*Number($('speed').value));last=now;update();if(t>=duration()){stop();hash();update();return;}frame=requestAnimationFrame(animate);}
  function play(){if(!current())return;if(playing){stop();hash();update();return;}if(mode==='results'||t>=duration())t=0;mode='replay';playing=true;last=0;hash();update();frame=requestAnimationFrame(animate);}
  $('view-all').onclick=()=>{layout='all';applyLayout();update();hash();};
  $('view-compare').onclick=()=>{layout='compare';applyLayout();update();hash();};
  for(const [id,index]of [['compare-left',0],['compare-right',1]])$(id).onchange=()=>{
    const previous=pair[index],next=$(id).value;
    if(pair[1-index]===next)pair[1-index]=previous;
    pair[index]=next;
    $('compare-left').value=pair[0];$('compare-right').value=pair[1];applyLayout();update();hash();
  };
  $('finish-points').onclick=ev=>{const button=ev.target.closest('[data-finish]');if(!button)return;
    stop();mode='replay';t=current().rows[Number(button.dataset.finish)].wallMs;update();hash();};
  $('work-tabs').addEventListener('click',ev=>{const button=ev.target.closest('[data-card]');if(button)select(cards.findIndex(c=>c.card===button.dataset.card));});
  $('work-tabs').addEventListener('keydown',ev=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(ev.key))return;ev.preventDefault();ev.stopPropagation();select(ev.key==='Home'?0:ev.key==='End'?cards.length-1:(ci+(ev.key==='ArrowRight'?1:-1)+cards.length)%cards.length);});
  $('play').addEventListener('click',play);
  $('timeline').addEventListener('input',()=>{stop();mode='replay';t=Number($('timeline').value);update();hash();});
  $('results').addEventListener('click',()=>{stop();mode='results';t=duration();update();hash();});
  $('focus').addEventListener('click',()=>{const active=document.body.classList.toggle('broadcast');$('focus').setAttribute('aria-pressed',String(active));$('focus').innerHTML=active?'Exit focus <span aria-hidden="true">⛶</span>':'Focus view <span aria-hidden="true">⛶</span>';$('arena').scrollIntoView({behavior:'instant'});});
  $('arena').addEventListener('keydown',ev=>{if(['INPUT','SELECT','TEXTAREA'].includes(ev.target.tagName))return;if(ev.code==='Space'&&ev.target.tagName!=='BUTTON'&&ev.target.tagName!=='SUMMARY'){ev.preventDefault();play();}else if(['ArrowLeft','ArrowRight'].includes(ev.key)){ev.preventDefault();stop();mode='replay';t=Math.max(0,Math.min(duration(),t+(ev.key==='ArrowRight'?5000:-5000)));update();hash();}});
  window.addEventListener('hashchange',()=>{if(!location.hash.includes('card='))return;stop();readHash();build();});
  document.querySelectorAll('a[href="#history"],a[href="#method"]').forEach(a=>a.addEventListener('click',()=>{document.querySelector(a.getAttribute('href')).open=true;}));
  function download(bytes,type,name){const blob=bytes instanceof Blob?bytes:new Blob([bytes],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  $('download-data').addEventListener('click',()=>{download(JSON.stringify(data,null,2)+'\n','application/json','bantam-fight-card.json');$('export-status').textContent='Downloaded the outcome, timing and token receipts.';});
  $('share-svg').addEventListener('click',()=>download(share,'image/svg+xml','bantam-recorded-results.svg'));
  $('print-page').addEventListener('click',()=>window.print());
  $('download-image').addEventListener('click',async()=>{
    const button=$('download-image');button.disabled=true;let url;
    try{url=URL.createObjectURL(new Blob([share],{type:'image/svg+xml'}));const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});const canvas=document.createElement('canvas');canvas.width=presentation==='qualification'?1200:2400;canvas.height=presentation==='qualification'?630:1260;canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('Image export unavailable');download(blob,'image/png','bantam-recorded-results.png');$('export-status').textContent='Downloaded the public result image. Recorded results and elapsed times.';}catch{$('export-status').textContent='PNG export is unavailable in this browser. Use the SVG share-card download below.';$('export-status').scrollIntoView({block:'center'});}finally{if(url)URL.revokeObjectURL(url);button.disabled=false;}
  });
  readHash();build();window.__launchReady=true;
}
