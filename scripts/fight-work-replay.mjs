// Pure projection of reviewed work. A "by" time is an upper bound from the
// next factory turn, never a fabricated tool-completion timestamp.
export function workReplayEvents(work) {
  const events=[];
  const timed=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=work.wallMs;
  const text=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
  const fields=value=>value&&typeof value==='object'&&!Array.isArray(value)
    ?Object.entries(value).map(([key,value])=>key+': '+(typeof value==='string'&&value.includes('\n')?'\n':'')+(text(value)??'null')).join('\n')
    :text(value)??'No output was recorded.';
  const add=(id,atMs,kind,title,body,precision='exact')=>events.push({id,atMs,kind,title,body,precision,order:events.length});
  const byNextTurn=action=>work.actions.find(next=>
    (action.source.startsWith('factory-worker-')
      ? next.source===action.source&&next.request?.job===action.request?.job
      : next.source==='factory-turn')&&Number.isInteger(next.turn)
    &&Number.isInteger(action.turn)&&next.turn>action.turn&&timed(next.atMs))?.atMs;
  add('work-order',0,'request','WORK ORDER',work.task);
  for(const [i,station] of (work.stations??[]).entries()){
    if(!timed(station.atMs))continue;
    const names={'intake-1':'Intake','agent-1':'Build & review','agent-loop-1':'Build & review','verification-1':'Verification'};
    add('station-'+i,station.atMs,'factory',station.type.replaceAll('.',' ').toUpperCase(),
      [names[station.station]??station.station,station.status,station.verdict].filter(Boolean).join(' · '));
  }
  for(const action of work.actions){
    const at=timed(action.atMs)?action.atMs:null,next=byNextTurn(action);
    const factory=action.source.startsWith('factory-')&&action.source!=='factory-turn';
    const title=action.name.replaceAll('_',' ');
    const clock=action.source==='native-tool-receipt'?'observed':'exact';
    if(at!==null){
      add(action.id+'-request',at,factory?'factory':'request',(factory?'FACTORY / ':'$ ')+title,fields(action.request),clock);
    }else{
      const by=timed(next)?next:work.wallMs;
      add(action.id+'-request',by,factory?'factory':'request',(factory?'FACTORY / ':'$ ')+title,fields(action.request),timed(next)?'by':'untimed');
    }
    const end=timed(action.endedMs)&&action.endedMs>=(at??0)?action.endedMs:null;
    const by=end??(timed(next)?next:work.wallMs),precision=end!==null?clock:timed(next)?'by':'untimed';
    if(action.output!==null&&action.output!==undefined&&action.output!==''){
      add(action.id+'-response',by,'response','RESPONSE / '+title+(action.exitCode!==null?' · exit '+action.exitCode:''),fields(action.output),precision);
    }
    if(action.supervisor?.text){
      add(action.id+'-direction',timed(next)?next:work.wallMs,'factory','FACTORY DIRECTION',action.supervisor.text,timed(next)?'by':'untimed');
    }
  }
  for(const [i,event] of (work.events??[]).entries()){
    add('event-'+i,timed(event.atMs)?event.atMs:work.wallMs,'event',event.type.replaceAll('/',' / ').toUpperCase(),'',timed(event.atMs)?'exact':'untimed');
  }
  if(work.finalResponse)add('final-response',work.wallMs,'delivery',work.finalResponseKind==='last-message'?'LAST RECORDED MESSAGE':'FINAL RESPONSE',work.finalResponse,'final');
  add('run-ended',work.wallMs,'finish','RUN ENDED / '+work.outcome,
    'Project accepted: '+(work.accepted===true?'yes':work.accepted===false?'no':'unknown')+'\nClean completion: '+(work.completed===true?'yes':work.completed===false?'no':'unknown'),'final');
  for(const [i,check] of work.checks.entries()){
    add('check-'+i,work.wallMs,'check','POST-RUN CHECK / '+check.title+' · exit '+(check.exitCode??'unknown'),
      [check.stdout,check.stderr].filter(Boolean).join('\n'),'final');
  }
  return events.sort((a,b)=>a.atMs-b.atMs||a.order-b.order);
}

export const WORK_TERMINAL_CSS=String.raw`
.work-terminal{background:#202922;color:#f0f2e6;border:1px solid #566452;margin:18px 0 0;min-width:0;font-family:var(--mono)}
.work-terminal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;background:#2e3930;border-bottom:1px solid #566452}
.work-terminal-head>span{font:10px var(--mono);color:#f0f2e6;letter-spacing:.06em}.work-terminal-head>span::before{content:'●';color:#e9ba4b;padding-right:8px}
.work-terminal-head button{font:9px var(--mono);border:1px solid #82927b;color:#f0f2e6;background:transparent;padding:6px 9px;min-height:30px;cursor:pointer}.work-terminal-head button[aria-pressed=true]{color:#f1ce70;border-color:#b89f5a}
.work-terminal-log{height:420px;overflow:auto;overscroll-behavior:contain;scrollbar-color:#7d8d73 #202922;padding:10px 14px;outline-offset:-3px}
.terminal-entry{margin:0 0 21px;min-width:0}.terminal-entry-head{display:flex;align-items:baseline;gap:10px;color:#f1ce70;font:10px/1.7 var(--mono);margin-bottom:6px}.terminal-entry-head time{color:#b6c7ac;white-space:nowrap;min-width:55px;font-size:9px}.terminal-entry-head strong{font-weight:500;overflow-wrap:anywhere}
.terminal-entry[data-kind=response] .terminal-entry-head{color:#b2d8bb}.terminal-entry[data-kind=factory] .terminal-entry-head{color:#f4c680}.terminal-entry[data-kind=finish] .terminal-entry-head,.terminal-entry[data-kind=delivery] .terminal-entry-head{color:#ffe187}
.recorded-work .terminal-entry pre,.recorded-work .terminal-entry pre code{color:#f0f2e6;background:transparent;font:11px/1.75 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;overflow:visible;border:0;border-radius:0;margin:0;padding:0;tab-size:2}
.work-terminal-foot{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 13px;border-top:1px solid #566452;font:9px/1.7 var(--mono);color:#c0cfb7;background:#263127}.work-terminal-foot .terminal-position{color:#f1ce70;white-space:nowrap}.terminal-cursor{font:11px var(--mono);color:#f1ce70;margin:5px 0 10px}.terminal-cursor::after{content:' ▌';animation:terminal-blink 1.2s steps(1) infinite}.work-terminal[data-playing=false] .terminal-cursor::after{animation:none}
.terminal-timing-note{font:9px/1.7 var(--mono);color:var(--muted);margin:8px 0 12px}.recorded-work[data-replay=true]>.work-views,.recorded-work[data-replay=true]>.work-story,.recorded-work[data-replay=true]>.work-content,.recorded-work[data-replay=true]>.work-download{display:none!important}
@keyframes terminal-blink{50%{opacity:0}}
@media(max-width:700px){.work-terminal-log{height:355px;padding:10px 12px}.recorded-work .terminal-entry pre,.recorded-work .terminal-entry pre code{font-size:10px}.terminal-entry-head{font-size:9px;gap:7px}.terminal-entry-head time{font-size:8px;min-width:48px}.work-terminal-foot{font-size:8px}.terminal-timing-note{font-size:8px}.work-terminal-head>span{font-size:9px}}
@media(prefers-reduced-motion:reduce){.terminal-cursor::after{animation:none}}
`;
