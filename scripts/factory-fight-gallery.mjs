// Offline index of reviewed public cards. Never runs models or publishes files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildLaunchData} from './factory-launch.mjs';
import {PUBLIC_FACTORY_CARDS,FACTORY_KITS} from './factory-card-catalog.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${(value/1000).toFixed(1)}s`:'Unknown';
const passed=row=>row.recorded===true&&row.outcome==='PASS'&&row.completed===true&&row.accepted===true
  &&row.publicExit===0&&row.hiddenExit===0&&row.protectedChanges===0&&row.groupsTotal>0&&row.groupsPassed===row.groupsTotal;

function readBounded(file,max=4*1024*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('Expected bounded regular public file');
  return fs.readFileSync(file);
}

export function buildFightGallery(root){
  if(!path.isAbsolute(root)||!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw Error('Expected absolute gallery directory');
  const cards=[...FACTORY_KITS['factory-2026-09-07'],...FACTORY_KITS['factory-2026-09-06']].map(id=>{
    const metadata=PUBLIC_FACTORY_CARDS[id];
    const dir=path.join(root,id);
    if(!fs.existsSync(dir))return {id,...metadata,recorded:false,rows:[]};
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
    return {id,...metadata,recorded:true,sourceSha256:sha(source),rows:card.rows.map(row=>({label:row.label,
      arm:row.arm,outcome:row.outcome,passed:passed(row),wallMs:row.wallMs,groupsPassed:row.groupsPassed,
      groupsTotal:row.groupsTotal,accountingComplete:row.accounting.complete}))};
  });
  return {schema:'bantam.fight-gallery.v1',public:true,rawEvidenceIncluded:false,cards};
}

export function renderFightGallery(data){
  const cards=data.cards,recorded=cards.filter(c=>c.recorded),rows=recorded.flatMap(c=>c.rows);
  const local=rows.filter(r=>r.arm==='bantam-local-27b');
  const panels=cards.map((card,i)=>{
    const meta=PUBLIC_FACTORY_CARDS[card.id];
    if(!meta)throw Error('Unrecognized public task');
    const href=`${card.id}/share/index.html`;
    return `<article class="card${card.recorded?'':' pending'}"><div class="card-top"><span>${escape(meta.kind)}</span><span>${String(i+1).padStart(2,'0')} / ${String(cards.length).padStart(2,'0')}</span></div>
      ${card.recorded?`<a class="preview" href="${href}" aria-label="Watch ${escape(meta.title)}"><img src="${card.id}/share/share-card.png" width="1200" height="630" alt="Recorded ${escape(meta.title)} fight card" loading="lazy"></a>`:''}
      <div class="card-body"><h2>${escape(meta.title)}</h2><p>${escape(meta.description)}</p>
      ${card.recorded?`<table><caption class="sr-only">Recorded ${escape(meta.title)} outcomes</caption><thead><tr><th>System</th><th>Result</th><th>Wall time</th></tr></thead><tbody>${card.rows.map(row=>`<tr${row.arm==='bantam-local-27b'?' class="bantam"':''}><th scope="row">${escape(row.label)}</th><td>${escape(row.outcome)}</td><td>${time(row.wallMs)}</td></tr>`).join('')}</tbody></table><p class="meter">${card.rows.every(r=>r.accountingComplete===true)?'All lanes report complete totals.':'Partial accounting disclosed in the replay.'}</p><a class="watch" href="${href}">Watch the fight <span aria-hidden="true">↗</span></a><a class="download" href="${card.id}/share/fight-card.json" download>Get the measurements ↓</a><a class="download" href="${card.id}/README.md">Read conditions and accounting notes</a>`:'<p class="queued">Not published yet · no result claimed</p>'}
      </div></article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="BANTAM fights: useful work, independent checks, replayable outcomes. Compare local and frontier coding systems."><title>BANTAM fights · Your model. A better factory.</title><style>
    :root{color-scheme:dark;--ink:#f5f1e8;--muted:#b0bdb4;--gold:#edac48;--line:#35453e}*{box-sizing:border-box}body{margin:0;background:#111c17;color:var(--ink);font:16px/1.6 system-ui,sans-serif}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid var(--gold);outline-offset:5px}header,main,footer{max-width:1280px;margin:auto;padding:32px}nav{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:center}.brand{font-size:21px;font-weight:900;letter-spacing:.22em;color:var(--gold);text-decoration:none}.nav-link{color:var(--muted);font-size:14px}.eyebrow{color:var(--gold);font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:800}.hero{padding:78px 0 42px;max-width:930px}h1{font-size:clamp(48px,7vw,92px);line-height:1.02;letter-spacing:-.065em;margin:20px 0 26px}h1 em{color:var(--gold);font-style:normal}.intro{max-width:690px;color:var(--muted);font-size:21px}.stats{display:flex;gap:48px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:25px}.stats strong{display:block;font-size:36px;line-height:1.2;letter-spacing:-.05em}.stats span{font-size:13px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:26px}.card{background:#1b2922;border:1px solid var(--line);border-radius:16px;overflow:hidden}.card-top{display:flex;justify-content:space-between;padding:17px 24px;color:var(--gold);font:12px/1.4 ui-monospace,monospace;letter-spacing:.12em}.preview{display:block;background:#f1eee5}.preview img{display:block;width:100%;height:auto}.card-body{padding:25px}.card-body h2{font-size:29px;letter-spacing:-.035em;line-height:1.15;margin:0 0 12px}.card-body p{color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px}th,td{padding:11px 0;border-bottom:1px solid var(--line);text-align:left;overflow-wrap:anywhere}thead th{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}td:last-child,th:last-child{text-align:right;white-space:nowrap}td{font-family:ui-monospace,monospace}tbody th{font-weight:500;padding-right:10px}.bantam{color:var(--gold)}.meter{font-size:12px}.watch{display:flex;justify-content:space-between;padding:12px 16px;border-radius:7px;background:var(--gold);color:#152018;font-weight:800;text-decoration:none;margin-top:24px}.download{display:block;text-align:center;margin-top:15px;font-size:12px;color:var(--muted)}.pending{background:transparent;border-style:dashed}.queued{padding:24px 0;font-size:13px}.method{margin:52px 0 20px;padding:30px;border:1px solid var(--line);border-radius:14px;max-width:100%;color:var(--muted)}.method h2{color:var(--ink);margin-top:0}.method p{max-width:930px}footer{color:var(--muted);font-size:13px;border-top:1px solid var(--line)}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}@media(max-width:760px){header,main,footer{padding:22px}.hero{padding:40px 0 28px}.grid{grid-template-columns:1fr}.stats{gap:25px}.intro{font-size:18px}.card-body{padding:20px}.method{padding:22px}}@media(prefers-reduced-motion:no-preference){.watch{transition:background .15s}.watch:hover{background:#ffc56c}}
    @media(max-width:760px){.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.stats strong{font-size:28px}.stats span{display:block;line-height:1.35;font-size:11px}}
    </style></head><body><header><nav><a class="brand" href="https://github.com/BANTAM-ADMIN/bantam-factory">BANTAM</a><a class="nav-link" href="https://github.com/BANTAM-ADMIN/bantam-factory#start-with-what-you-already-have">Put your model to work ↗</a></nav><section class="hero"><p class="eyebrow">The factory, on the clock</p><h1>Small model.<br><em>Serious work.</em></h1><p class="intro">Build it. Extend it. Fix it. BANTAM takes on useful coding jobs alongside other harnesses and frontier models. Watch the work earn its finish.</p></section><div class="stats"><div><strong>${recorded.length}/${cards.length}</strong><span>work orders published</span></div><div><strong>${local.filter(r=>r.passed).length}/${local.length}</strong><span>BANTAM local attempts passed</span></div><div><strong>${rows.length}</strong><span>recorded system attempts</span></div></div></header><main><section class="grid" aria-label="Recorded fight cards">${panels}</section><section class="method"><p class="eyebrow">Proof you can inspect</p><h2>Clocks, checks and receipts. Not just a leaderboard.</h2><p>Every published card retains its full planned roster. PASS requires both accepted work and clean completion. OUTPUT_ONLY means the artifact passed but the run did not finish cleanly. A timeout is not time to successful completion. Missing token counters remain unknown, never zero.</p><p>Local contenders use the same recorded model; frontier references use different models. These are individual system observations on development tasks, not a universal ranking or a held-out reliability study. Configuration differences and partial accounting are explained on each card. Read each card's accompanying notes for runtime, scheduling and measurement details.</p><p>Downloadable JSON makes the measurements portable. Private transcripts, source code and machine details are omitted. This static gallery loads no external assets, sends no telemetry, and grants no permission to execute imported evidence.</p></section></main><footer>Your model. Your hardware. A better coding factory. · <a href="https://github.com/BANTAM-ADMIN/bantam-factory">Try BANTAM</a></footer></body></html>`;
}

export function writeFightGallery({root,replace=false}){
  const data=buildFightGallery(root),files=[['index.html',renderFightGallery(data)],['gallery.json',JSON.stringify(data,null,2)+'\n']];
  for(const [name]of files){const file=path.join(root,name);if(fs.existsSync(file)&&(!replace||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('Refusing to replace gallery output');}
  for(const [name,content]of files)fs.writeFileSync(path.join(root,name),content,{flag:replace?'w':'wx'});
  return {published:data.cards.filter(c=>c.recorded).length,planned:data.cards.length};
}

// Publication staging copies explicit reviewed filenames, never the enclosing
// docs directory or arbitrary files found beside a card. A partial gallery is
// useful locally but is not this six-card launch artifact.
export function stageFightGallery({root,output}){
  const data=buildFightGallery(root);
  if(data.cards.some(card=>!card.recorded))throw Error('All six launch cards must be recorded before publication');
  if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('Expected fresh absolute publication output');
  const files=[['index.html',renderFightGallery(data)],['gallery.json',JSON.stringify(data,null,2)+'\n']];
  for(const card of data.cards){
    const dir=path.join(root,card.id),manifest=JSON.parse(readBounded(path.join(dir,'package.json')));
    if(manifest.schema!=='bantam.factory-showcase-package.v1'||manifest.private!==false||manifest.redacted!==true)throw Error('Expected public detailed package');
    for(const name of ['index.html','showcase.json']){
      const bytes=readBounded(path.join(dir,name)),receipt=manifest.files?.find(f=>f.path===name);
      if(!receipt||receipt.bytes!==bytes.length||receipt.sha256!==sha(bytes))throw Error('Detailed package hash mismatch');
    }
    for(const name of ['README.md','index.html','showcase.json','package.json','share/index.html','share/fight-card.json','share/package.json','share/share-card.png'])
      files.push([`${card.id}/${name}`,readBounded(path.join(dir,name))]);
    // The share manifest also names its SVG. Verify it before including it.
    const bytes=readBounded(path.join(dir,'share/share-card.svg'));
    const shareManifest=JSON.parse(readBounded(path.join(dir,'share/package.json')));
    const receipt=shareManifest.files?.find(f=>f.path==='share-card.svg');
    if(!receipt||receipt.bytes!==bytes.length||receipt.sha256!==sha(bytes))throw Error('SVG hash mismatch');
    files.push([`${card.id}/share/share-card.svg`,bytes]);
  }
  fs.mkdirSync(output,{recursive:true});
  for(const [name,bytes]of files){const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});}
  return {cards:data.cards.length,files:files.length};
}
