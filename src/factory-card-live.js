import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {publicFightProgress} from './factory-card-progress.js';

const BRAND=fs.readFileSync(new URL('../docs/brand/bantam-mark.svg',import.meta.url),'utf8');
const encode=v=>JSON.stringify(v).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const EMPTY={schema:'bantam.fight-progress.v1',lanes:[],finished:false,complete:false,stopped:false,updatedAt:null};
export function renderLiveFight(snapshot=EMPTY,{live=false}={}){
 const data=publicFightProgress(snapshot);
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BANTAM · Factory live</title>
<style>
:root{color-scheme:light;--paper:#f2f0e7;--ink:#202b26;--muted:#65716a;--line:#d4d8cf;--gold:#d99224;--green:#207653}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,sans-serif;border-top:6px solid var(--gold)}main{max-width:1440px;margin:auto;padding:38px 5vw 56px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.2em}.brand svg{width:38px;height:45px}.tag,.eyebrow,.phase,dt{font:11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.tag{border:1px solid var(--line);padding:9px 12px;border-radius:30px}.hero{padding:55px 0 28px;max-width:960px}.eyebrow{color:var(--muted)}h1{font-size:clamp(38px,5.4vw,76px);letter-spacing:-.055em;line-height:1.02;margin:14px 0 20px}p{line-height:1.6;color:var(--muted)}.summary{display:flex;gap:30px;align-items:center;border-block:1px solid var(--line);padding:18px 0;margin:16px 0 26px;flex-wrap:wrap}.summary strong{font-size:28px;font-variant-numeric:tabular-nums}.summary span{font-size:12px;color:var(--muted);display:block}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:18px}.lane{background:#fffdf7;border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 12px 25px #27382b06;min-width:0}.lane[data-phase=running]{border-color:var(--gold);box-shadow:0 0 0 2px #d9922415}.lane[data-outcome=PASS]{border-top:4px solid var(--green)}.lane[data-outcome=FAIL],.lane[data-outcome=TIMEOUT],.lane[data-outcome=SETUP_ERROR]{border-top:4px solid #a94f43}.lane h2{font-size:23px;letter-spacing:-.03em;margin:12px 0 4px}.phase{color:var(--muted)}.clock{font:44px ui-monospace,monospace;letter-spacing:-.07em;margin:18px 0}.acceptance{border-block:1px solid var(--line);padding:12px 0;font-size:13px;line-height:1.8}dl{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0}dt{color:var(--muted)}dd{margin:5px 0 0;font-size:20px;font-variant-numeric:tabular-nums}.coverage{font-size:12px;line-height:1.6;color:var(--muted)}footer{margin-top:34px;border-top:1px solid var(--line);padding-top:20px;font-size:13px;display:flex;align-items:start;gap:24px;justify-content:space-between}button{background:var(--ink);color:white;border:0;padding:12px 18px;border-radius:8px;cursor:pointer;font:inherit;white-space:nowrap}button:focus-visible{outline:3px solid var(--gold);outline-offset:3px}#connection{font-size:12px;min-height:18px}footer p{margin:0;max-width:840px}@media(max-width:600px){main{padding:24px 20px}.hero{padding-top:30px}footer{flex-direction:column}.tag{font-size:9px}}
</style><main><header><div class="brand">${BRAND} BANTAM</div><div class="tag" id="mode">${live?'LIVE · READ ONLY':'RECORDED SNAPSHOT'}</div></header>
<section class="hero"><div class="eyebrow">The factory floor / real work, recorded</div><h1>Watch the work.<br>Follow the evidence.</h1><p>One work order. Different production processes. Acceptance, elapsed work time and measured token use—without exposing private transcripts.</p></section>
<div class="summary" id="summary"></div><div id="connection" role="status"></div><section class="grid" id="lanes" aria-label="Comparison participants"></section>
<footer><p>Local contenders share one serial model queue; frontier tools may overlap. Tokens update when receipts arrive, not token-by-token. “So far” is not a final total. Missing usage stays unknown. Settling and grading are separate from contender work time. No prompts, code or account details are included.</p><button id="download">Download public data</button></footer></main>
<script>let state=${encode(data)};const live=${live?'true':'false'};
const num=v=>Number.isSafeInteger(v)&&v>=0?v.toLocaleString('en-US'):'Unknown';
const el=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
function render(next){state=next;const rows=state.lanes,summary=document.getElementById('summary');summary.replaceChildren();
 for(const [value,label]of [[rows.filter(r=>r.outcome==='PASS').length+'/'+rows.length,'passed attempts'],[rows.filter(r=>r.phase==='finished').length,'results recorded'],[rows.filter(r=>['running','settling','grading'].includes(r.phase)).length,'active lanes']]){const d=el('div','');d.append(el('strong',String(value)),el('span',label));summary.append(d);}
 const grid=document.getElementById('lanes');grid.replaceChildren();
 for(const row of rows){const card=el('article','','lane');card.dataset.phase=row.phase;card.dataset.outcome=row.outcome||'';
 card.append(el('div',row.outcome||row.phase,'phase'),el('h2',row.label),el('div',row.card+' · attempt '+row.repeat,'coverage'),el('div',row.elapsedMs===null?'—':(row.elapsedMs/1000).toFixed(1)+'s','clock'));
 const acceptance=el('div','','acceptance');acceptance.append(el('div',row.groupsTotal===null?'Independent grade: pending':'Independent grade: '+row.groupsPassed+'/'+row.groupsTotal),el('div','Artifact accepted: '+(row.candidatePass===null?'pending':row.candidatePass?'yes':'no')),el('div','Process completed: '+(row.processCompleted===null?'pending':row.processCompleted?'yes':'no')));card.append(acceptance);
 const dl=el('dl','');for(const [key,label]of [['inputTokens','Input'],['outputTokens','Output'],['cacheHitTokens','Prefix cache'],['freshInputTokens','Fresh input']]){const d=el('div','');d.append(el('dt',label),el('dd',num(row.tokens[key])));dl.append(d);}card.append(dl);
 card.append(el('div',(row.accountingScope==='final'?'Final receipts':'Receipts so far')+' · '+num(row.measuredRequests)+' / '+num(row.requests)+' measured requests','coverage'));
 if(!row.accountingComplete&&Object.values(row.measuredSubset).some(v=>v!==null))card.append(el('div','Measured subset only — input '+num(row.measuredSubset.inputTokens)+', output '+num(row.measuredSubset.outputTokens)+', cache '+num(row.measuredSubset.cacheHitTokens)+', fresh '+num(row.measuredSubset.freshInputTokens),'coverage'));
 grid.append(card);}
 if(!rows.length)grid.append(el('p','Waiting for recorded execution to begin.'));
 document.getElementById('mode').textContent=state.finished?(state.complete?'COMPARISON FINISHED':'COMPARISON INCOMPLETE'):live?'LIVE · READ ONLY':'RECORDED SNAPSHOT';
}
render(state);let events;
if(live&&!state.finished){events=new EventSource('./events');events.onmessage=event=>{try{render(JSON.parse(event.data));document.getElementById('connection').textContent='Connected · receipt-driven updates';if(state.finished){events.close();document.getElementById('connection').textContent='Final snapshot received. The CLI also saved a standalone page.';}}catch{document.getElementById('connection').textContent='Invalid update; last snapshot retained.';}};events.onerror=()=>{document.getElementById('connection').textContent='Connection interrupted; last snapshot retained. Reconnecting does not restart work.';};}
document.getElementById('download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bantam-public-progress.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
</script></html>`;
}

export async function startLiveFight(){
 const token=crypto.randomBytes(24).toString('hex'),prefix='/'+token+'/';
 let snapshot=publicFightProgress(EMPTY),origin;const clients=new Set();
 const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
 const server=http.createServer((req,res)=>{
  const send=(code,type,body)=>{res.writeHead(code,{...headers,'content-type':type});res.end(body);};
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return send(403,'text/plain','Forbidden');
  if(req.method!=='GET')return send(405,'text/plain','Read-only viewer');
  if(req.url===prefix)return send(200,'text/html; charset=utf-8',renderLiveFight(snapshot,{live:true}));
  if(req.url===prefix+'events'){
   if(clients.size>=32)return send(503,'text/plain','Viewer connection limit');
   res.writeHead(200,{...headers,'content-type':'text/event-stream','connection':'keep-alive'});
   res.write('data: '+JSON.stringify(snapshot)+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
  }
  send(404,'text/plain','Not found');
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+server.address().port;
 const publish=value=>{snapshot=publicFightProgress(value);for(const res of clients){if(res.writableLength>1024*1024){res.destroy();clients.delete(res);}else res.write('data: '+JSON.stringify(snapshot)+'\n\n');}};
 const close=async()=>{for(const res of clients)res.end();clients.clear();await new Promise(resolve=>{
  const timer=setTimeout(()=>server.closeAllConnections(),1000);timer.unref();
  server.close(()=>{clearTimeout(timer);resolve();});
 });};
 return {url:origin+prefix,publish,close,snapshot:()=>snapshot};
}
