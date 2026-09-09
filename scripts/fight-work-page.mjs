const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

export function renderWorkLane(entry) {
  const E = escape;
  return `<section class="recorded-work" data-work-arm="${E(entry.arm)}" data-work-sha="${E(entry.sha256)}">
    <nav class="work-views" aria-label="${E(entry.arm)} recorded work">${[['story','Story'],['actions',`Actions · ${entry.actions}`],['files',`Files · ${entry.files}`],['checks','Tests'],['terminal','Replay log']].map(([id,label]) => `<button type="button" data-work-view="${id}" aria-pressed="${id==='story'}">${E(label)}</button>`).join('')}</nav>
    <div class="work-story"><h5>${E(entry.explanation.title)}</h5>${entry.explanation.paragraphs.map(p => `<p>${E(p.text)}</p>${p.actions.length?`<div class="story-evidence"><button type="button" data-evidence="${E(p.actions.join(','))}">Show the evidence ↗</button></div>`:''}`).join('')}
    <div class="work-delivery"><span>${entry.changedFiles} workspace change${entry.changedFiles===1?'':'s'}</span><button type="button" data-work-view="files">Open the work →</button></div></div>
    <div class="work-content" hidden aria-live="polite"></div>
    <div class="work-terminal-panel" hidden><div class="work-terminal" data-playing="false"><div class="work-terminal-head"><span>TERMINAL / RECORDED WORK</span><button type="button" data-follow-terminal aria-pressed="true">Following ↓</button></div><div class="work-terminal-log" tabindex="0" role="region" aria-label="Recorded terminal messages"><div class="terminal-entries"></div><p class="terminal-cursor">Opening the recorded work…</p></div><div class="work-terminal-foot"><span class="terminal-state">Loading</span><span class="terminal-position">0.0s</span></div></div><p class="terminal-timing-note">Messages follow saved times. “By” marks a response available by the next recorded turn. “Observed” marks when the recorder received a native event.</p></div>
    <div class="work-download"><a href="../work/${E(entry.path)}" download>Download action record & files ↓</a><span>Recorded work</span></div>
  </section>`;
}

export function fightWorkBrowser(replayEvents) {
  'use strict';
  const cache = new Map();
  const terminals = new WeakMap();
  let replay = window.__launchState?.() ?? {t:0,mode:'results',playing:false};
  const E = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const printed = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const seconds = value => typeof value === 'number' ? (value/1000).toFixed(1) + 's' : 'Sequence only';
  const code = value => `<pre tabindex="0"><code>${E(printed(value) ?? 'No result was recorded.')}</code></pre>`;
  const names = {'factory-verification':'Factory · run project tests', 'factory-cli-check':'Factory · check the command-line contract',
    'supervisor-review':'Supervisor · review an edge case',
    'supervisor-dispatch':'Astra · assign work and await evidence', 'supervisor-enqueue':'Astra · assign work',
    'supervisor-wait':'Astra · wait for worker evidence', 'supervisor-check':'Astra · review the candidate',
    'supervisor-read':'Astra · read the delivered source', 'supervisor-evidence':'Astra · inspect worker evidence',
    'supervisor-steer':'Astra · correct the worker', 'supervisor-finish':'Astra · accept the complete job',
    'integrate-worker':'Factory · integrate verified work', 'settle-worker':'Factory · record worker outcome', inspect:'Inspect the workspace', done:'Deliver the work'};
  function actionTitle(action) {
    const r = action.source.startsWith('factory-worker-') ? action.request?.action : action.request;
    if (names[action.name]) return names[action.name];
    if (typeof r === 'object' && r) {
      const file = r.p ?? r.path ?? r.filePath ?? r.file_path;
      if (file) return action.name.replaceAll('_', ' ') + ' · ' + file.replace(/^\/workspace\//, '');
      if (r.description) return r.description;
      const command = r.c ?? r.command ?? r.cmd;
      if (command) return command.split('\n')[0].slice(0, 130);
    }
    return action.name.replaceAll('_', ' ');
  }
  async function load(section) {
    const arm = section.dataset.workArm, expected = section.dataset.workSha;
    if (!cache.has(expected)) cache.set(expected, (async () => {
      const response = await fetch('../work/' + arm + '.json', {credentials:'omit'});
      if (!response.ok) throw Error('The recorded work could not be loaded.');
      const bytes = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if (digest !== expected) throw Error('The work file does not match this card’s receipt.');
      return JSON.parse(new TextDecoder().decode(bytes));
    })().catch(error => {cache.delete(expected); throw error;}));
    return cache.get(expected);
  }
  function terminalState(section) {
    if(!terminals.has(section))terminals.set(section,{following:true,work:null,events:null,pending:null,count:0,clock:-1,error:null});
    return terminals.get(section);
  }
  function follow(section,enabled) {
    const state=terminalState(section);state.following=enabled;
    const button=section.querySelector('[data-follow-terminal]');
    button.setAttribute('aria-pressed',String(enabled));button.textContent=enabled?'Following ↓':'Follow latest ↓';
    if(enabled){const log=section.querySelector('.work-terminal-log');log.scrollTop=log.scrollHeight;}
  }
  function paintTerminal(section) {
    const state=terminalState(section);
    if(!state.work)return;
    const {work,events}=state,ended=replay.mode==='results'||replay.t>=work.wallMs;
    const at=ended?work.wallMs:replay.t;
    const visible=events.filter(event=>event.atMs<=at);
    const entries=section.querySelector('.terminal-entries'),log=section.querySelector('.work-terminal-log');
    const rewind=at<state.clock||visible.length<state.count;
    if(rewind){entries.replaceChildren();state.count=0;}
    const changed=visible.length!==state.count;
    if(changed){
      const fragment=document.createDocumentFragment();
      for(const event of visible.slice(state.count)){
        const item=document.createElement('article');item.className='terminal-entry';item.dataset.kind=event.kind;item.dataset.terminalEvent=event.id;
        const when=event.precision==='untimed'?'untimed':event.precision==='final'?'final':(event.precision==='by'?'by ':event.precision==='observed'?'observed ':'')+seconds(event.atMs);
        item.innerHTML=`<div class="terminal-entry-head"><time>${E(when)}</time><strong>${E(event.title)}</strong></div>${event.body?`<pre><code>${E(event.body)}</code></pre>`:''}`;
        fragment.append(item);
      }
      entries.append(fragment);state.count=visible.length;
    }
    state.clock=at;
    section.querySelector('.work-terminal').dataset.playing=String(replay.playing&&!ended);
    const cursor=section.querySelector('.terminal-cursor');cursor.hidden=ended;cursor.textContent='Waiting for the next recorded message';
    section.querySelector('.terminal-state').textContent=ended?'Run ended · '+work.outcome:replay.playing?'Replaying recorded work':'Replay paused';
    section.querySelector('.terminal-position').textContent=seconds(at);
    if((changed||rewind)&&state.following)log.scrollTop=log.scrollHeight;
  }
  function syncReplay() {
    document.querySelectorAll('.recorded-work').forEach(section=>{
      section.dataset.replay=String(replay.mode==='replay');
      const active=replay.mode==='replay'||section.dataset.currentView==='terminal';
      section.querySelector('.work-terminal-panel').hidden=!active;
      if(!active||section.closest('.lane')?.hidden)return;
      const state=terminalState(section);
      if(state.work){paintTerminal(section);return;}
      if(state.pending||state.error)return;
      state.pending=load(section).then(work=>{
        state.work=work;state.events=replayEvents(work);
        if(section.isConnected)paintTerminal(section);
      }).catch(error=>{
        state.error=error.message;
        if(section.isConnected){section.querySelector('.terminal-cursor').textContent=error.message;section.querySelector('.terminal-state').textContent='Record unavailable';}
      }).finally(()=>{state.pending=null;});
    });
  }
  function actionsView(work) {
    const stages = work.stations?.filter(s=>s.type==='station.started') ?? [];
    const stageNames = {'intake-1':'Intake', 'agent-1':'Build & review', 'agent-loop-1':'Build & review', 'verification-1':'Verification'};
    return `<p class="work-help">Every recorded invocation and factory check, in order. Expand an entry for its input and result.</p>${stages.length?`<div class="factory-route" aria-label="Recorded factory stations">${stages.map(s=>`<span>${E(stageNames[s.station] ?? s.station)}<small>${seconds(s.atMs)}</small></span>`).join('<b aria-hidden="true">→</b>')}</div>`:''}
      <ol class="action-feed">${work.actions.map((a, i) => `<li class="action-entry ${a.source.startsWith('factory-')&&a.source!=='factory-turn'?'factory-check':''}" data-action="${E(a.id)}"><details><summary><span class="action-index">${i+1}</span><span><strong>${E(actionTitle(a))}</strong><small>${E(a.category)}${a.turn!==undefined?` · turn ${a.turn+1}`:''} · ${E(seconds(a.atMs))}${a.exitCode!==null?` · exit ${E(a.exitCode)}`:''}</small></span><b aria-hidden="true">+</b></summary><div class="action-body"><h6>Input</h6>${code(a.request)}<h6>Recorded result</h6>${code(a.output)}${a.supervisor?.text?`<div class="supervisor-note"><h6>Factory direction · ${E(a.supervisor.phase)}</h6>${code(a.supervisor.text)}</div>`:''}</div></details></li>`).join('')}</ol>
      ${work.events?.length?`<details class="work-extra"><summary>Other recorded events</summary>${code(work.events)}</details>`:''}
      ${work.coverage.replayedToolRecords?`<p class="work-help">${work.coverage.replayedToolRecords} copied history entries were matched to their original tool calls.</p>`:''}`;
  }
  function filesView(work) {
    return `<label class="file-picker">Delivered workspace<select data-file-picker aria-label="Recorded file">${work.files.map((file,i)=>`<option value="${i}">${E(file.path)} · ${E(file.state)}</option>`).join('')}</select></label>
      <div class="file-toolbar"><div class="file-views">${[['after','Delivered'],['diff','Changes'],['before','Starter']].map(([key,title])=>`<button type="button" data-file-view="${key}" aria-pressed="${key==='after'}">${title}</button>`).join('')}</div><button type="button" data-download-file>Save file ↓</button></div><div class="file-content"></div>`;
  }
  function checksView(work) {
    const checkView = check => {
      let grade;try{grade=JSON.parse(check.stdout);}catch{}
      const groups=grade?.schema==='bantam.factory-card-grade.v1'&&Array.isArray(grade.groups)
        &&grade.groups.every(g=>g&&typeof g.name==='string'&&typeof g.pass==='boolean')?grade.groups:null;
      const tests=String(check.stdout??'').match(/^# tests (\d+)$/m)?.[1];
      const passed=String(check.stdout??'').match(/^# pass (\d+)$/m)?.[1];
      const failed=String(check.stdout??'').match(/^# fail (\d+)$/m)?.[1];
      const mutation=check.mutationReview?.schema==='bantam.test-mutation-review.v1';
      const verdict=mutation?(check.exitCode===1?'CAUGHT':check.exitCode===0?'MISSED':'UNKNOWN'):(check.exitCode===0?'PASS':check.exitCode===null?'UNKNOWN':'FAIL');
      const good=mutation?check.exitCode===1:check.exitCode===0;
      return `<section class="check-result${mutation?' mutation-review':''}"><div class="check-heading"><h5>${E(check.title)}</h5><span class="${verdict==='UNKNOWN'?'':good?'good':'bad'}">${verdict} · exit ${E(check.exitCode??'unknown')}</span></div>
        ${mutation?`<p>${E(check.description)}</p><details class="work-extra"><summary>Exact source change and control results</summary>${code(check.mutationReview)}</details>`:''}
        ${groups?`<ul class="grade-groups">${groups.map(g=>`<li class="grade-entry"><span class="${g.pass?'good':'bad'}">${g.pass?'✓':'×'}</span><div><strong>${E(g.name.replaceAll('-',' '))}</strong>${g.error?`<details><summary>See the failure</summary>${code(g.error)}</details>`:''}</div></li>`).join('')}</ul>`:tests?`<p class="test-counts"><strong>${E(passed??'?')}</strong> passed · <strong>${E(failed??'?')}</strong> failed · ${E(tests)} tests</p>`:''}
        <details class="work-extra"><summary>Full recorded output</summary>${code(check.stdout)}${check.stderr?code(check.stderr):''}</details></section>`;
    };
    return `<p class="work-help">Original acceptance checks and any separately labeled post-run reviews.</p>${work.checks.map(checkView).join('')}
      <details class="work-extra"><summary>The supplied work order</summary>${code(work.task)}</details>
      <details class="work-extra"><summary>${work.finalResponseKind==='last-message'?'The last recorded assistant message':'The contender’s final response'}</summary>${code(work.finalResponse || 'No final response was recorded.')}</details>`;
  }
  function paintFile(section, work) {
    const selected = work.files[Number(section.querySelector('[data-file-picker]').value)];
    const view = section.dataset.fileView || 'after';
    section.querySelectorAll('[data-file-view]').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.fileView===view)));
    const value = selected[view];
    section.querySelector('.file-content').innerHTML = `<p class="file-state">${E(selected.state)} · ${E(selected.path)}</p>${code(value ?? (view==='before'?'This file was added during the run.':'This file was deleted during the run.'))}<p class="file-hash">${view==='before'?'Original starter':view==='after'?'Displayed delivery':'Recorded before / after'}${view==='diff'?'':` SHA-256<br>${E(view==='before'?selected.beforeSha256:selected.displaySha256)}`}</p>`;
    section.querySelector('[data-download-file]').disabled = value === null;
  }
  async function show(section, view, evidence) {
    section.dataset.currentView = view;
    section.querySelectorAll('.work-views [data-work-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.workView===view)));
    section.querySelector('.work-story').hidden = view !== 'story';
    const content = section.querySelector('.work-content');
    content.hidden = view === 'story' || view === 'terminal';
    syncReplay();
    if (view === 'story' || view === 'terminal') return;
    content.innerHTML = '<p class="work-help">Opening the recorded work…</p>';
    try {
      const work = await load(section);
      if (section.dataset.currentView !== view || !section.isConnected) return;
      content.innerHTML = view==='actions'?actionsView(work):view==='files'?filesView(work):checksView(work);
      if (view==='files') paintFile(section,work);
      if (evidence) {
        const items = evidence.split(',').map(id=>content.querySelector(`[data-action="${id}"]`)).filter(Boolean);
        for(const item of items)item.querySelector('details').open=true;
        items[0]?.scrollIntoView({block:'center',behavior:'smooth'});
      }
    } catch (error) {if(section.dataset.currentView===view)content.innerHTML=`<p class="work-help" role="alert">${E(error.message)} Use the download below to open the saved file.</p>`;}
  }
  function mount() {
    document.querySelectorAll('.recorded-work:not([data-mounted])').forEach(section=>{
      section.dataset.mounted='true';
      section.addEventListener('click',async event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.hasAttribute('data-follow-terminal')){follow(section,!terminalState(section).following);return;}
        if(button.dataset.evidence) {await show(section,'actions',button.dataset.evidence);return;}
        if(button.dataset.workView) {await show(section,button.dataset.workView);return;}
        if(button.dataset.fileView) {section.dataset.fileView=button.dataset.fileView;paintFile(section,await load(section));return;}
        if(button.hasAttribute('data-download-file')) {
          const work=await load(section), file=work.files[Number(section.querySelector('[data-file-picker]').value)], view=section.dataset.fileView||'after';
          const value=file[view];if(value===null)return;
          const url=URL.createObjectURL(new Blob([value],{type:'text/plain;charset=utf-8'})), link=document.createElement('a');
          link.href=url;link.download=file.path.split('/').pop()+(view==='diff'?'.diff':'');link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
        }
      });
      section.addEventListener('change',async event=>{if(event.target.matches('[data-file-picker]'))paintFile(section,await load(section));});
      section.querySelector('.work-terminal-log').addEventListener('scroll',event=>{
        const log=event.currentTarget;
        if(terminalState(section).following&&log.scrollHeight-log.clientHeight-log.scrollTop>50)follow(section,false);
      },{passive:true});
      // Arrow keys inside code/file controls belong to the work viewer.
      section.addEventListener('keydown',event=>event.stopPropagation());
    });
    syncReplay();
  }
  document.addEventListener('fight-lanes-built',mount);
  document.addEventListener('fight-replay-tick',event=>{replay=event.detail;syncReplay();});
  mount();
}

export const FIGHT_WORK_CSS = `
.check-result{margin-bottom:25px}.check-heading{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.check-heading h5{font-size:14px;margin:0}.check-heading>span{font:10px var(--mono);white-space:nowrap}.test-counts{font-size:12px;color:var(--muted);margin:18px 0}.test-counts strong{font:22px var(--mono);color:var(--ink)}.grade-groups{list-style:none;padding:0;margin:14px 0}.grade-entry{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.grade-entry>span{font:18px var(--mono)}.grade-entry>div{min-width:0;flex:1}.grade-entry strong{font-size:12px;font-weight:400;line-height:1.6;text-transform:capitalize}.grade-entry summary{font-size:11px;padding:8px 0;color:var(--gold);cursor:pointer}
.recorded-work{margin:18px -2px 0;min-width:0}.work-views{display:flex;gap:4px;border-bottom:1px solid var(--line);padding-bottom:8px;flex-wrap:wrap}.work-views button,.file-toolbar button{background:transparent;border:0;border-radius:5px;color:var(--muted);font-size:12px;padding:9px 11px;min-height:36px}.work-views [aria-pressed=true],.file-views [aria-pressed=true]{background:var(--ink);color:var(--bg)}.work-story{padding:20px 2px 4px}.work-story h5{font-size:22px;line-height:1.25;letter-spacing:-.025em;margin:0 0 12px}.work-story p{font-size:14px;line-height:1.75;color:var(--ink);margin:0 0 12px}.story-evidence{display:flex;gap:5px;flex-wrap:wrap;margin:-2px 0 15px}.story-evidence button{background:transparent;border:1px solid var(--line);color:var(--gold);font:10px var(--mono);padding:5px 8px;border-radius:4px;min-height:30px}.work-delivery{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--line);margin-top:22px;padding:14px 0 4px;font-size:11px;color:var(--muted)}.work-delivery button{border:0;background:transparent;color:var(--gold);font-size:12px;padding:8px 0}.work-download{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--muted);padding-top:16px;margin-top:12px;border-top:1px solid var(--line)}.work-download a{color:var(--muted)}.work-content{min-height:260px;padding-top:16px}.work-help{font-size:12px;line-height:1.6;color:var(--muted);margin:0 0 16px}.action-feed{list-style:none;padding:0;margin:0;max-height:620px;overflow:auto;overscroll-behavior:contain;scrollbar-color:var(--line) transparent}.action-entry{border-bottom:1px solid var(--line)}.action-entry summary{display:flex;gap:10px;align-items:flex-start;padding:13px 3px;cursor:pointer;list-style:none}.action-index{font:10px var(--mono);color:var(--muted);border:1px solid var(--line);min-width:25px;height:25px;display:grid;place-items:center;border-radius:50%;flex-shrink:0}.action-entry summary>span:nth-child(2){min-width:0;flex:1}.action-entry summary strong{font-size:12px;font-weight:500;line-height:1.5;display:block;overflow-wrap:anywhere}.action-entry summary small{display:block;font:9px/1.5 var(--mono);color:var(--muted);margin-top:5px}.action-entry summary>b{font-size:14px;color:var(--gold);font-weight:400}.factory-check .action-index{border-color:var(--gold);color:var(--gold)}.factory-check summary strong{color:var(--gold)}.action-body{padding:0 0 14px}.recorded-work h6{font:10px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 7px;color:var(--muted)}.recorded-work pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:#101c15;border:1px solid var(--line);border-radius:5px;padding:13px;max-height:400px;overflow:auto;font:11px/1.6 var(--mono);color:var(--ink);margin:0;overscroll-behavior:contain}.supervisor-note{border-left:2px solid var(--gold);padding-left:10px}.factory-route{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 18px;border:1px solid var(--line);padding:12px;border-radius:5px}.factory-route span{font-size:11px}.factory-route small{display:block;color:var(--muted);font:9px var(--mono);margin-top:5px}.factory-route>b{color:var(--gold);font-weight:400}.file-picker{display:block;font-size:11px;color:var(--muted)}.file-picker select{display:block;width:100%;max-width:100%;margin:8px 0 12px;font:11px var(--mono)}.file-toolbar{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.file-views{display:flex}.file-state{font:11px var(--mono);margin:14px 0 10px;overflow-wrap:anywhere}.file-hash{font:9px/1.6 var(--mono);color:var(--muted);overflow-wrap:anywhere}.work-extra{border-bottom:1px solid var(--line);padding-bottom:15px;margin-bottom:15px}.work-extra summary{font-size:12px;padding:8px 0 15px;cursor:pointer}.work-extra summary span{float:right}.lane:has(.recorded-work)>.lane-tail{margin-top:15px}.lane:has(.recorded-work) .lane-metrics{margin:8px 0 20px;grid-template-columns:repeat(2,minmax(0,1fr))}.lane:has(.recorded-work) .lane-tail{border-top:0;padding-top:0}.lane:has(.recorded-work) .lane-proof{padding-bottom:4px}.lane:has(.recorded-work) .receipt-scope{display:none}.lane:has(.recorded-work) .lane-tail>details{margin-top:5px}.lane:has(.recorded-work) .lane-details .lane-metrics dd{font-size:17px}
@media(max-width:700px){#lane-list[data-layout=compare]:has(.recorded-work){grid-template-columns:1fr}#lane-list[data-layout=compare] .lane:has(.recorded-work){padding:20px}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-main{grid-template-columns:1fr auto;gap:10px}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-name{font-size:22px;min-height:0}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-model{min-height:0}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-hardware,#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-generation{min-height:0;font-size:11px}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-time{font-size:40px}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-status{grid-row:2;font-size:10px;justify-self:end}#lane-list[data-layout=compare] .lane:has(.recorded-work) .lane-track{grid-row:3}.work-story h5{font-size:21px}.work-views{gap:2px}.work-views button{font-size:11px;padding:9px}.action-feed{max-height:470px}.work-content{min-height:0}}
`;
