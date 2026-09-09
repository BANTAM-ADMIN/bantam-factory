// Offline index of reviewed public cards. Never runs models or publishes files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {GALLERY_CSS,factoryName} from './fight-design.mjs';
import {fightBrandFiles,posterFonts,POSTER_GALLERY_CSS} from './fight-poster.mjs';
import {renderFightIntro,renderIntroPlayer} from './fight-intro.mjs';
import {renderFactoryShowcase,showcaseAssets} from './factory-showcase-page.mjs';
import {performanceView,publicPerformance} from './fight-performance.mjs';
import {buildLaunchData} from './factory-launch.mjs';
import {PUBLIC_FACTORY_CARDS,FACTORY_KITS} from './factory-card-catalog.mjs';
import {readFightDemo} from './fight-demo.mjs';
import {readFightWork} from './fight-work.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The brand mark is inlined as the page icon so the static host never serves a 404 for it.
const ICON=fs.readFileSync(new URL('../docs/brand/bantam-mark.svg',import.meta.url)).toString('base64');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${(value/1000).toFixed(1)}s`:'Unknown';
const passed=row=>row.recorded===true&&row.outcome==='PASS'&&row.completed===true&&row.accepted===true
  &&row.publicExit===0&&row.hiddenExit===0&&row.protectedChanges===0&&row.groupsTotal>0&&row.groupsPassed===row.groupsTotal;

function readBounded(file,max=4*1024*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('Expected bounded regular public file');
  return fs.readFileSync(file);
}

// Explicit publication list, grouped the way the kits are. Registering a kit in
// the catalog does not put its work orders on the public page; adding a section
// here does, and the all-recorded gate then holds publication until every listed
// card is a reviewed package. One flat grid stopped being legible past about
// eight cards, so each section carries its own heading and numbering.
export const LAUNCH_SECTIONS=Object.freeze([
  Object.freeze({id:'launch',title:'Launch series',
    blurb:'The first six work orders: build, extend and repair, against local harnesses and frontier CLIs.',
    cards:Object.freeze([...FACTORY_KITS['factory-2026-09-07'],...FACTORY_KITS['factory-2026-09-06']])}),
  Object.freeze({id:'controls',title:'Controls',
    blurb:'Deterministic edit receipts and retry arithmetic, where a wrong boundary is silent until it is not.',
    cards:Object.freeze([...FACTORY_KITS['factory-controls-2026-09-07']])}),
  Object.freeze({id:'selection',title:'Selection',
    blurb:'Choosing and resolving: which paths match, which stay inside the workspace, which version wins.',
    cards:Object.freeze([...FACTORY_KITS['factory-selection-2026-09-08']])}),
]);
export const LAUNCH_CARDS=Object.freeze(LAUNCH_SECTIONS.flatMap(section=>section.cards));

// Reviewed follow-up windows keep their own URLs and complete rosters. Earlier
// recordings stay inspectable; a later harness revision never replaces them.
const CODEX_RECORDINGS=Object.freeze([
  {id:'snapshot-drift-qualified-3',workOrder:'snapshot-drift',title:'Snapshot checker · latest round',
    description:'The updated factory extends a real file checker. Compare native Astra, factory Astra, and Astra supervising Terra or Sol, with every result and both roles counted.'},
  ...['context-packet','stream-framer'].map(workOrder=>({
    id:`${workOrder}-qualified-1`,workOrder,
    title:`${workOrder==='context-packet'?'Context packer':'Stream decoder'} · latest round`,
    description:'Astra in native Codex, Astra inside BANTAM FACTORY, and Astra supervising Terra or Sol. Four fresh attempts with the updated factory; every result and both supervised roles included.',
  })),
  ...[1,2].map(round=>({id:`snapshot-drift-qualified-${round}`,workOrder:'snapshot-drift',
    title:`Snapshot checker · ${round===1?'first':'batch-edit'} round`,
    description:'Four complete recorded workflows from an earlier factory revision. Follow the edits, reviews and tests that led to the next improvement.'})),
  ...LAUNCH_CARDS.map(id=>({id,workOrder:id})),
  ...['astra','sol'].flatMap(model=>[1,2].map(repeat=>({
    id:`context-packet-${model}-${repeat}`,workOrder:'context-packet',
    title:`${model==='astra'?'Astra':'Sol'} · efficiency round ${repeat}`,
    description:'The same context-packet work order, in native Codex and BANTAM FACTORY. A fresh paired run after the context improvements.',
  }))),
  ...['context-packet','patch-transaction'].flatMap(workOrder=>[1,2].map(repeat=>({
    id:`${workOrder}-astra-context-${repeat}`,workOrder,
    title:`Astra · ${workOrder==='context-packet'?'context packer':'patch transaction'} · round ${repeat}`,
    description:'Astra with a leaner factory context, against native Codex. The same task and checks, with both paired rounds published.',
  }))),
  ...['context-packet','stream-framer'].map(workOrder=>({
    id:`${workOrder}-supervised-1`,workOrder,
    title:`${workOrder==='context-packet'?'Context packer':'Stream decoder'} · solo and supervised`,
    description:'Native Codex, BANTAM workers, and Astra supervising Terra or Sol. The same assignment and independent checks; both roles included in supervised totals.',
  })),
]);

// One reviewed public card package: a single-work-order showcase whose share
// package hashes match it byte for byte. Used for launch cards and references.
function readCardPackage(dir,id){
  if(fs.lstatSync(dir).isSymbolicLink())throw Error('Card directory must not be a symlink');
  const source=readBounded(path.join(dir,'showcase.json'));
  const data=buildLaunchData(source);
  if(data.series.length!==1||data.series[0].cards.length!==1||data.series[0].cards[0].card!==id)throw Error('Expected one matching work order');
  const card=data.series[0].cards[0];
  if(card.rows.some(row=>!row.recorded))throw Error('Publish only fully recorded card rosters');
  const share=path.join(dir,'share');
  if(fs.lstatSync(share).isSymbolicLink())throw Error('Share directory must not be a symlink');
  const manifest=JSON.parse(readBounded(path.join(share,'package.json')));
  if(manifest.schema!=='bantam.launch-package.v1'||manifest.public!==true||manifest.redacted!==true
    ||manifest.rawEvidenceIncluded!==false||manifest.source?.sha256!==sha(source))throw Error('Expected matching public share package');
  for(const name of ['index.html','fight-card.json','share-card.png']){
    const receipt=manifest.files?.find(f=>f.path===name),bytes=readBounded(path.join(share,name));
    if(!receipt||receipt.bytes!==bytes.length||receipt.sha256!==sha(bytes))throw Error('Share package hash mismatch');
  }
  const portable=JSON.parse(readBounded(path.join(share,'fight-card.json')));
  if(JSON.stringify(portable)!==JSON.stringify(data))throw Error('Share evidence differs from public source');
  const demo=readFightDemo(dir,card.rows);
  const work=readFightWork(dir,id,card.rows);
  const testReviews=work?.receipt.files.flatMap(file=>(file.testReviews??[]).map(review=>({arm:file.arm,...review})))??[];
  return {sourceSha256:sha(source),...(demo?{reviewedDemo:true}:{}),...(work?{reviewedWork:true}:{}),...(testReviews.length?{testReviews}:{}),rows:card.rows.map(row=>({label:row.label,model:row.model,
    arm:row.arm,outcome:row.outcome,passed:passed(row),wallMs:row.wallMs,groupsPassed:row.groupsPassed,
    groupsTotal:row.groupsTotal,accountingComplete:row.accounting.complete,
    tokens:row.accounting.complete?Object.fromEntries(['inputTokens','outputTokens','cacheHitTokens']
      .map(key=>[key,row.accounting.full?.[key]??null])):null,
    ...(row.performance?{performance:publicPerformance(row.performance)}:{})}))};
}

export function buildFightGallery(root){
  if(!path.isAbsolute(root)||!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw Error('Expected absolute gallery directory');
  const cards=LAUNCH_CARDS.map(id=>{
    const metadata=PUBLIC_FACTORY_CARDS[id],dir=path.join(root,id);
    if(!fs.existsSync(dir))return {id,...metadata,recorded:false,rows:[]};
    return {id,...metadata,recorded:true,...readCardPackage(dir,id)};
  });
  // Separately recorded reference attempts (for example native Claude Code) on
  // the same work orders live under references/<card>. They are published
  // beside a card, never merged into its roster, and never feed the featured
  // same-model comparison.
  const referenceRoot=path.join(root,'references');
  let references=null;
  if(fs.existsSync(referenceRoot)){
    if(!fs.lstatSync(referenceRoot).isDirectory()||fs.lstatSync(referenceRoot).isSymbolicLink())throw Error('References must be a plain directory');
    const found=LAUNCH_CARDS.filter(id=>fs.existsSync(path.join(referenceRoot,id)))
      .map(id=>({id,...PUBLIC_FACTORY_CARDS[id],recorded:true,...readCardPackage(path.join(referenceRoot,id),id)}));
    if(found.length)references={cards:found};
  }
  const codexRoot=path.join(root,'codex');
  let codex=null;
  if(fs.existsSync(codexRoot)){
    if(!fs.lstatSync(codexRoot).isDirectory()||fs.lstatSync(codexRoot).isSymbolicLink())throw Error('Codex series must be a plain directory');
    const found=CODEX_RECORDINGS.filter(({id})=>fs.existsSync(path.join(codexRoot,id)))
      .map(recording=>({...PUBLIC_FACTORY_CARDS[recording.workOrder],...recording,recorded:true,
        ...readCardPackage(path.join(codexRoot,recording.id),recording.workOrder)}));
    if(found.length)codex={cards:found};
  }
  return {schema:'bantam.fight-gallery.v1',public:true,rawEvidenceIncluded:false,cards,references,...(codex?{codex}:{})};
}

// Feature only completed, accepted same-weights comparisons. A timeout is
// never a denominator for a speedup, and frontier models are not same-model peers.
export function featuredFight(data){
  const candidates=[];
  for(const card of data.cards.filter(c=>c.recorded)){
    const bantam=card.rows.find(r=>r.arm==='bantam-local-27b');
    if(!bantam?.passed||!(bantam.wallMs>0))continue;
    for(const peer of card.rows){
      if(!['opencode','hermes','deepseek-local-27b','pi'].includes(peer.arm)||!peer.passed||!(peer.wallMs>bantam.wallMs))continue;
      candidates.push({card,bantam,peer,ratio:peer.wallMs/bantam.wallMs});
    }
  }
  return candidates.sort((a,b)=>b.ratio-a.ratio)[0]??null;
}

// Count completed jobs among actual recordings. The shared task count and
// pending roster stay explicit; an absent contender is never a failed run.
export function sameModelScoreboard(data){
  const arms=['bantam-local-27b','deepseek-local-27b','hermes','opencode'];
  const cards=data.cards.filter(card=>card.recorded&&card.rows.some(row=>row.arm===arms[0]
    &&/^Qwen 27B · same local (?:model|weights)$/.test(row.model)));
  if(!cards.length)return null;
  const labels=['BANTAM FACTORY','DeepSeek Harness','Hermes','OpenCode'];
  if(cards.some(card=>card.rows.some(row=>row.arm==='pi'))){arms.push('pi');labels.push('Pi');}
  return {tasks:cards.length,systems:arms.map((arm,i)=>{
    const rows=cards.flatMap(card=>card.rows.filter(row=>row.arm===arm&&/^Qwen 27B · same local (?:model|weights)$/.test(row.model)));
    return {arm,label:labels[i],recorded:rows.length,completed:rows.filter(row=>row.passed===true).length,
      pending:cards.length-rows.length};
  })};
}

function renderSameModelScoreboard(data){
  const score=sameModelScoreboard(data);
  if(!score)return '';
  return `<section class="same-model shell" aria-label="Same-model completion scoreboard"><div class="section-heading"><div><p class="eyebrow">THE HARNESS MAKES A DIFFERENCE</p><h2>Same model. Different results.</h2></div><p>${score.tasks} published tasks. The same local Qwen 27B weights. A completed job means accepted work <em>and</em> a clean finish.</p></div><div class="harness-scores">${score.systems.map(system=>`<article class="harness-score${system.arm==='bantam-local-27b'?' bantam':''}" data-score-arm="${system.arm}"><h3>${system.label}</h3><strong>${system.recorded?`${system.completed}<small> / ${system.recorded}</small>`:'—'}</strong><p>jobs completed</p><span>${system.pending?`${system.recorded} of ${score.tasks} recorded · ${system.pending} pending`:'All matchups recorded'}</span></article>`).join('')}</div><p class="cohort-note">Completed jobs / recorded attempts. Unrun matchups stay pending. Each card includes its recording conditions. <a href="#fights">Open the fights ↓</a></p></section>`;
}

// Presentation order only; it never reorders portable evidence or implies rank.
const ARM_ORDER=['bantam-local-27b','deepseek-local-27b','opencode','hermes','pi','codex-astra','codex-sol','codex-terra','bantam-codex-astra','bantam-codex-sol','bantam-codex-terra','claude-sonnet','claude-opus','claude-fable'];
const armRank=arm=>{const i=ARM_ORDER.indexOf(arm);return i<0?ARM_ORDER.length:i;};

function renderReferences(data){
  const refs=data.references.cards;
  const arms=[...new Set(refs.flatMap(c=>c.rows.map(r=>r.arm)))].sort((a,b)=>armRank(a)-armRank(b));
  const labels=Object.fromEntries(refs.flatMap(c=>c.rows.map(r=>[r.arm,r.label])));
  const attempts=refs.reduce((n,c)=>n+c.rows.length,0);
  const cell=(row,href)=>row?`<a href="${href}">${escape(row.outcome)} · ${time(row.wallMs)}</a>`:'—';
  const body=refs.map(ref=>{
    const meta=PUBLIC_FACTORY_CARDS[ref.id],launch=data.cards.find(c=>c.id===ref.id),bantam=launch?.rows.find(r=>r.arm==='bantam-local-27b');
    return `<tr><th scope="row"><a href="${ref.id}/README.md">${escape(meta.title)}</a></th><td class="bantam">${bantam?cell(bantam,`${ref.id}/share/index.html`):'—'}</td>${arms.map(arm=>`<td>${cell(ref.rows.find(r=>r.arm===arm),`references/${ref.id}/share/index.html`)}</td>`).join('')}</tr>`;
  }).join('');
  return `<section class="references" id="references" aria-label="Separately recorded reference attempts"><p class="eyebrow">References · same work orders, separate runs</p><h2>Frontier CLIs on the same work orders.</h2><p>${attempts} separately recorded attempts. Each used its native CLI, tools and policies; recording windows and conditions accompany the results. BANTAM FACTORY's own recorded attempt is shown for context. The table identifies each model and links to its recorded results.</p><div class="table-wrap"><table><caption class="sr-only">Reference attempts by work order</caption><thead><tr><th>Work order</th><th>BANTAM FACTORY · local</th>${arms.map(arm=>`<th>${escape(labels[arm])}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div><a class="download" href="references/README.md">Read reference conditions and accounting notes</a></section>`;
}

export function renderFightGallery(data){
  const cards=data.cards,recorded=cards.filter(c=>c.recorded),rows=recorded.flatMap(c=>c.rows);
  const local=rows.filter(r=>r.arm==='bantam-local-27b'),feature=featuredFight(data);
  const rigs=local.map(r=>performanceView(r.performance)).filter(v=>v?.hardware);
  const oneRig=rigs.length===local.length&&rigs.length>0&&local.every(r=>/^Qwen 27B ·/.test(r.model))&&rigs.every(v=>v.hardware===rigs[0].hardware&&v.quantization===rigs[0].quantization);
  const rates=rigs.filter(v=>!v.partial&&v.generationRate!==null).map(v=>v.generationRate);
  const cardRig=card=>{
    const v=performanceView(card.rows.find(r=>r.arm==='bantam-local-27b')?.performance);
    return v?`<div class="card-rig"><span>${escape(v.hardware??'Local hardware not recorded')}</span><strong>${escape(v.generation)} <small>generation${v.partial?' · subset':''}</small></strong></div>`:'';
  };
  const references=data.references?.cards?.length?renderReferences(data):'';
  const referenceNav=references?'<a class="nav-link" href="#references">Frontier references ↓</a>':'';
  const claimed=new Set(LAUNCH_SECTIONS.flatMap(section=>section.cards));
  for(const card of cards){
    if(!PUBLIC_FACTORY_CARDS[card.id])throw Error('Unrecognized public task');
    if(!claimed.has(card.id))throw Error('Unsectioned public task');
  }
  const ordered=card=>[...card.rows].sort((a,b)=>armRank(a.arm)-armRank(b.arm));
  const status=row=>`<span class="status ${row.passed?'pass':['FAIL','SETUP_ERROR'].includes(row.outcome)?'fail':'other'}">${escape(row.outcome)}</span>`;
  const scoreboard=card=>{
    const max=Math.max(1,...card.rows.map(r=>typeof r.wallMs==='number'?r.wallMs:0));
    return `<div class="scoreboard" aria-label="Recorded outcomes and elapsed times">${ordered(card).map(row=>`<div class="score-row${row.arm==='bantam-local-27b'?' bantam':''}"><span class="score-name">${escape(factoryName(row.label))}</span>${status(row)}<strong>${time(row.wallMs)}</strong><div class="score-track" aria-hidden="true"><i style="width:${typeof row.wallMs==='number'?Math.max(0,Math.min(100,100*row.wallMs/max)):0}%"></i></div></div>`).join('')}</div>`;
  };
  const featuredCard=feature?.card??recorded[0];
  const byId=new Map(cards.map(c=>[c.id,c]));
  const panel=(card,index,total,prefix='')=>{
    const meta=card,solo=card.rows.length===1;
    const mode=solo&&card.rows[0].arm==='bantam-local-27b'?'bantam':solo?'single':'comparison';
    const stage=card.recorded?(mode==='bantam'?'BANTAM FACTORY run':solo?'Single-system run':`${card.rows.length} contenders`):'Awaiting publication';
    const href=`${prefix}${card.id}/share/index.html`;
    return `<article class="card${card.recorded?'':' pending'}" data-mode="${mode}" data-search="${escape([meta.title,meta.kind,meta.description,...card.rows.map(r=>factoryName(r.label))].join(' ').toLowerCase())}"><div class="card-top"><span>${escape(meta.kind)}</span><span>${String(index+1).padStart(2,'0')} / ${String(total).padStart(2,'0')}</span></div><div class="card-body"><div class="card-heading"><h3>${card.recorded?`<a href="${href}">${escape(meta.title)}</a>`:escape(meta.title)}</h3><span class="stage">${stage}</span></div><p class="card-description">${escape(meta.description)}</p>${card.recorded?`${scoreboard(card)}${cardRig(card)}<p class="meter">${card.rows.every(r=>r.accountingComplete===true)?'Complete token accounting.':'Partial accounting disclosed in the replay.'}</p><a class="watch button" href="${href}">${solo?'Open run':'Open fight'} <span aria-hidden="true">↗</span></a>${card.reviewedDemo?`<a class="demo-link" href="${card.id}/share/index.html#try-it">Try the tool it built ↗</a>`:''}<div class="card-links"><a href="${prefix}${card.id}/share/fight-card.json" download>Measurements ↓</a>${prefix?'':`<a href="https://github.com/BANTAM-ADMIN/bantam-factory/blob/main/docs/fights/launch-2026-09-07/${card.id}/README.md">Conditions ↗</a>`}<a href="${prefix}${card.id}/share/share-card.png" download>Share image ↓</a></div>`:'<p class="queued">Not published yet · no result claimed</p>'}</div></article>`;
  };
  const panels=LAUNCH_SECTIONS.map(section=>{
    const list=section.cards.map(id=>byId.get(id)).filter(Boolean);
    return list.length?`<section class="fight-section" id="${section.id}"><div class="kit"><h2>${escape(section.title)}</h2><span>${list.length} work orders</span></div><p class="kit-blurb">${escape(section.blurb)}</p><section class="grid" aria-label="${escape(section.title)} fight cards">${list.map((card,i)=>panel(card,i,list.length)).join('')}</section></section>`:'';
  }).join('');
  const codexCards=data.codex?.cards??[];
  const latestIds=new Set(['snapshot-drift-qualified-3','context-packet-qualified-1','stream-framer-qualified-1']);
  const latest=codexCards.filter(card=>latestIds.has(card.id)),earlier=codexCards.filter(card=>!latestIds.has(card.id));
  const codexGrid=(list,label)=>`<section class="grid" aria-label="${label}">${list.map(card=>panel(card,codexCards.indexOf(card),codexCards.length,'codex/')).join('')}</section>`;
  const codexContents=latest.length?`${codexGrid(latest,'Latest Codex fight cards')}${earlier.length?`<details class="earlier-fights"><summary>Earlier recordings <span>${earlier.length} cards · complete records</span></summary>${codexGrid(earlier,'Earlier Codex fight cards')}</details>`:''}`:codexGrid(codexCards,'Codex fight cards');
  const codexPanels=codexCards.length?`<section class="fight-section" id="codex"><div class="kit"><h2>Codex, inside the factory.</h2><span>Solo and supervised</span></div><p class="kit-blurb">Astra, Sol and Terra in BANTAM FACTORY and their native CLI. Also watch Astra supervise a Terra or Sol worker, with both roles counted. Compare time, tokens, tests and delivered code.</p>${codexContents}</section>`:'';
  const intro=`<section class="gallery-intro shell" aria-labelledby="gallery-title"><div><p class="eyebrow">REAL WORK. ON RECORD.</p><h1 id="gallery-title">Put the factory<br>in the ring.</h1><p class="gallery-lede">Choose a job. Pick two contenders. See every action, test, and delivered file.</p><div class="gallery-actions"><a class="button primary" href="#fights">Browse the cards ↓</a><a href="assets/showcase/examples/arcade/index.html">Play the arcade builds ↗</a></div><div class="gallery-counts"><span>${recorded.length}/${cards.length} jobs published</span><span>${rows.length} recorded attempts</span></div></div><aside class="gallery-rig"><img src="assets/bantam-rooster-v1.png" alt="The copper-feathered BANTAM rooster." width="1232" height="1296"><div><strong>${oneRig?escape(rigs[0].hardware):'Your model. Your factory.'}</strong><span>${oneRig?'Local Qwen 27B · '+escape(rigs[0].quantization??'recorded weights'):'Recorded hardware inside each card'}</span>${rates.length?`<span>${Math.min(...rates).toFixed(1)}–${Math.max(...rates).toFixed(1)} tok/s · recorded BANTAM generation</span>`:''}</div></aside></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f0e7"><meta name="description" content="Your model. Your hardware. A better coding factory. Watch BANTAM FACTORY tackle real coding tasks, inspect the fight cards, and bring your own model."><meta property="og:title" content="BANTAM FACTORY · Small model. Heavy hitter."><meta property="og:description" content="Local coding power. Verified work. Fight cards you can inspect.">${featuredCard?`<meta property="og:image" content="https://bantam-admin.github.io/bantam-factory/${featuredCard.id}/share/share-card.png"><meta name="twitter:card" content="summary_large_image">`:''}<title>BANTAM FACTORY · Small model. Heavy hitter.</title><link rel="icon" href="data:image/svg+xml;base64,${ICON}"><style>${posterFonts('assets/')}${GALLERY_CSS}${POSTER_GALLERY_CSS}</style><link rel="stylesheet" href="assets/showcase/chrome.css"></head><body class="factory-fights"><a class="skip" href="#fights">Skip to fight cards</a><header class="factory-top"><a class="factory-brand" href="index.html" aria-label="BANTAM FACTORY home"><canvas id="headerRooster" width="22" height="22" aria-hidden="true"></canvas><span>BANTAM FACTORY</span></a><nav aria-label="Site"><a href="fights.html" aria-current="page">Fights</a><a href="https://github.com/BANTAM-ADMIN/bantam-factory/blob/main/docs/README.md">Docs</a><a href="https://github.com/BANTAM-ADMIN/bantam-factory">GitHub</a></nav></header><main id="top">${intro}${renderSameModelScoreboard(data)}<section id="fights" class="shell fight-browser"><div class="section-heading"><div><p class="eyebrow">THE FIGHT CARDS</p><h2>Let the work talk.</h2></div><p>Open a card to compare the work side by side. Search by job or harness.</p></div><div class="filters" id="filters" hidden><label class="search-label"><span class="sr-only">Search fight cards</span><input id="fight-search" type="search" placeholder="Find a task or contender…"></label><label><span class="sr-only">Filter by recorded roster</span><select id="fight-mode"><option value="all">All cards</option><option value="bantam">BANTAM FACTORY runs</option><option value="comparison">Comparisons</option><option value="single">Other solo runs</option></select></label><span id="filter-count" role="status"></span></div><nav class="series-nav" aria-label="Fight series">${LAUNCH_SECTIONS.map(s=>`<a href="#${s.id}">${escape(s.title)}</a>`).join('')}${codexPanels?'<a href="#codex">Codex</a>':''}${referenceNav}</nav>${codexPanels}${panels}<p id="no-matches" class="empty-state" hidden>No cards match this view. <button id="clear-filters">Show all cards</button></p>${references}</section><section class="shell method"><details><summary>How to read a fight card <span>Clocks, checks & conditions +</span></summary><div><p>PASS requires both accepted work and clean completion. OUTPUT_ONLY means the artifact passed but the run did not finish cleanly. A timeout is not time to successful completion. Missing token counters remain unknown, never zero.</p><p>The roster shows which systems ran each task. A solo card contains one recorded attempt. Completed comparisons include every planned contender. These are selected development work orders; the recording dates and conditions are attached to each card.</p><p>Time bars show elapsed run time, not progress or correctness. Local and frontier models are distinguished in the replay. Read each card's conditions for configuration and accounting details. Open a contender to read its actions, inspect its delivered files and see its test results. Cards with a demo also let you try the recorded tool. This static site loads no external assets and sends no telemetry.</p></div></details></section></main><footer class="shell"><a class="brand" href="index.html">BANTAM FACTORY</a><a href="index.html#contact">Talk to the lab ↗</a><a href="https://github.com/BANTAM-ADMIN/bantam-factory/blob/main/LICENSE">Apache-2.0 ↗</a></footer><script src="assets/showcase/rooster.js"></script><script src="assets/showcase/brand.js"></script><script>(${galleryBrowser.toString()})();</script></body></html>`;
}

function galleryBrowser(){
  const $=id=>document.getElementById(id),cards=[...document.querySelectorAll('.fight-section .card')];
  $('filters').hidden=false;
  function filter(){
    const query=$('fight-search').value.trim().toLowerCase(),mode=$('fight-mode').value;
    let count=0;
    for(const card of cards){card.hidden=!(card.dataset.search.includes(query)&&(mode==='all'||card.dataset.mode===mode));if(!card.hidden)count++;}
    document.querySelectorAll('.earlier-fights').forEach(group=>{
      group.hidden=![...group.querySelectorAll('.card')].some(card=>!card.hidden);
      if(!group.hidden&&(query||mode!=='all'))group.open=true;
    });
    document.querySelectorAll('.fight-section').forEach(section=>{section.hidden=![...section.querySelectorAll('.card')].some(card=>!card.hidden);});
    $('filter-count').textContent=`${count} of ${cards.length} cards`;$('no-matches').hidden=count>0;
  }
  $('fight-search').oninput=filter;$('fight-mode').onchange=filter;
  $('clear-filters').onclick=()=>{$('fight-search').value='';$('fight-mode').value='all';filter();$('fight-search').focus();};
  document.querySelector('.series-nav').onclick=()=>{$('fight-search').value='';$('fight-mode').value='all';filter();};
  filter();
}

export function writeFightGallery({root,replace=false}){
  const data=buildFightGallery(root),files=[['index.html',renderFactoryShowcase(data,{intro:!!featuredFight(data)})],['fights.html',renderFightGallery(data)],['gallery.json',JSON.stringify(data,null,2)+'\n']];
  for(const [name]of files){const file=path.join(root,name);if(fs.existsSync(file)&&(!replace||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('Refusing to replace gallery output');}
  for(const [name,content]of files)fs.writeFileSync(path.join(root,name),content,{flag:replace?'w':'wx'});
  return {published:data.cards.filter(c=>c.recorded).length,planned:data.cards.length};
}

// Publication staging copies explicit reviewed filenames, never the enclosing
// docs directory or arbitrary files found beside a card. A partial gallery is
// useful locally but is not the planned launch artifact.
function stageCardFiles(dir,prefix,files,workOrder=prefix.split('/').pop()){
  const manifest=JSON.parse(readBounded(path.join(dir,'package.json')));
  if(manifest.schema!=='bantam.factory-showcase-package.v1'||manifest.private!==false||manifest.redacted!==true)throw Error('Expected public detailed package');
  for(const name of ['index.html','showcase.json']){
    const bytes=readBounded(path.join(dir,name)),receipt=manifest.files?.find(f=>f.path===name);
    if(!receipt||receipt.bytes!==bytes.length||receipt.sha256!==sha(bytes))throw Error('Detailed package hash mismatch');
  }
  for(const name of ['README.md','index.html','showcase.json','package.json','share/index.html','share/fight-card.json','share/package.json','share/share-card.png'])
    files.push([`${prefix}/${name}`,readBounded(path.join(dir,name))]);
  // The share manifest also names its SVG. Verify it before including it.
  const bytes=readBounded(path.join(dir,'share/share-card.svg'));
  const shareManifest=JSON.parse(readBounded(path.join(dir,'share/package.json')));
  const receipt=shareManifest.files?.find(f=>f.path==='share-card.svg');
  if(!receipt||receipt.bytes!==bytes.length||receipt.sha256!==sha(bytes))throw Error('SVG hash mismatch');
  files.push([`${prefix}/share/share-card.svg`,bytes]);
  const rows=buildLaunchData(readBounded(path.join(dir,'showcase.json'))).series[0].cards[0].rows;
  const demo=readFightDemo(dir,rows);
  if(demo)for(const name of demo.files)files.push([`${prefix}/demo/${name}`,readBounded(path.join(dir,'demo',name))]);
  const work=readFightWork(dir,workOrder,rows);
  if(work)for(const name of work.files)files.push([`${prefix}/work/${name}`,readBounded(path.join(dir,'work',name))]);
}

export function stageFightGallery({root,output}){
  const data=buildFightGallery(root);
  if(data.cards.some(card=>!card.recorded))throw Error('All planned launch cards must be recorded before publication');
  if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('Expected fresh absolute publication output');
  const files=[['index.html',renderFactoryShowcase(data,{intro:!!featuredFight(data)})],['fights.html',renderFightGallery(data)],['gallery.json',JSON.stringify(data,null,2)+'\n'],...fightBrandFiles(),...showcaseAssets()];
  const feature=featuredFight(data);
  if(feature)files.push(['assets/motion/index.html',renderFightIntro(feature)],['assets/motion/player.html',renderIntroPlayer(feature)]);
  for(const card of data.cards)stageCardFiles(path.join(root,card.id),card.id,files);
  for(const card of data.codex?.cards??[])stageCardFiles(path.join(root,'codex',card.id),`codex/${card.id}`,files,card.workOrder);
  if(data.references){
    files.push(['references/README.md',readBounded(path.join(root,'references','README.md'))]);
    for(const card of data.references.cards)stageCardFiles(path.join(root,'references',card.id),`references/${card.id}`,files);
  }
  fs.mkdirSync(output,{recursive:true});
  for(const [name,bytes]of files){const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});}
  return {cards:data.cards.length,files:files.length};
}
