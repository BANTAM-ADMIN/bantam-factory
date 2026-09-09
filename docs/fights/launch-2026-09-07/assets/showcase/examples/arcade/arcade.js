'use strict';
const $=id=>document.getElementById(id);
const duration=ms=>`${Math.floor(ms/60000)}m ${Math.round(ms%60000/1000)}s`;
let data,selected;
const recordEpoch=new WeakMap();
function fact(value,label){const box=document.createElement('div');box.className='fact';const strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=value;span.textContent=label;box.append(strong,span);return box;}
async function showRecord(run,container){
 const epoch=(recordEpoch.get(container)??0)+1;recordEpoch.set(container,epoch);container.replaceChildren();const link=document.createElement('a');link.href=run.record;link.download='';link.textContent='Download the full build record ↓';container.append(link);
 const response=await fetch(run.record);if(!response.ok)throw Error('Build record unavailable');const record=await response.json();if(epoch!==recordEpoch.get(container))return;
 const brief=document.createElement('pre');brief.textContent=record.prompt;container.append(brief);const checks=document.createElement('p');checks.textContent=record.verification;container.append(checks);
 for(const [i,row] of record.actions.entries()){
  const entry=document.createElement('details');entry.className='action';const summary=document.createElement('summary'),pre=document.createElement('pre');
  summary.textContent=`${i+1}. ${row.title||row.action?.a?.replaceAll('_',' ')||'Recorded action'}`;
  pre.textContent=JSON.stringify(row.action??row.command,null,2)+(row.observation?'\n\n'+row.observation:'');entry.append(summary,pre);container.append(entry);
 }
 if(record.finalResponse){const final=document.createElement('pre');final.textContent=record.finalResponse;container.append(final);}
}
function selectVersion(run){
 recordEpoch.set($('build-actions'),(recordEpoch.get($('build-actions'))??0)+1);selected=run;$('game').src=run.file;$('game').title=run.title;$('game-title').textContent=run.title;
 $('build-model').textContent=run.model;$('build-title').textContent=run.title;$('build-facts').replaceChildren(fact(duration(run.wallMs),'recorded run time'),fact(run.actionCount,'recorded actions'));
 $('request').textContent=run.prompt;$('features').textContent=run.features;
 $('download').href=run.file;$('full-size').href=run.file;
 for(const button of $('versions').children)button.setAttribute('aria-pressed',String(button.dataset.id===run.id));
 $('build-record').open=false;$('build-actions').replaceChildren();
}
function showCorner(side){const run=data.comparisons.find(r=>r.id===$(side).value);$(side+'-game').src=run.file;$(side+'-game').title=run.title+' · '+run.label;$(side+'-facts').textContent=`${run.model} · ${duration(run.wallMs)} · ${run.result}`;$(side+'-review').textContent=run.review;$(side+'-file').href=run.file;$(side+'-record').open=false;$(side+'-actions').replaceChildren();recordEpoch.set($(side+'-actions'),(recordEpoch.get($(side+'-actions'))??0)+1);}
$('reload').addEventListener('click',()=>{if(selected)$('game').src=selected.file;});
$('build-record').addEventListener('toggle',()=>{if($('build-record').open&&selected)showRecord(selected,$('build-actions')).catch(e=>$('build-actions').textContent=e.message);});
(async()=>{
 const response=await fetch('builds.json');if(!response.ok)throw Error('The build records could not be loaded.');data=await response.json();
 for(const run of data.versions){const button=document.createElement('button');button.type='button';button.textContent=run.label;button.dataset.id=run.id;button.addEventListener('click',()=>selectVersion(run));$('versions').append(button);}
 selectVersion(data.versions.at(-1));$('comparison-note').textContent=data.comparisonNote;$('shared-brief').textContent=data.sharedBrief;$('conditions').textContent=data.conditions;
 for(const side of ['left','right']){for(const run of data.comparisons){const option=document.createElement('option');option.value=run.id;option.textContent=run.label;$(side).append(option);}$(side).value=data.defaults[side];$(side).addEventListener('change',()=>showCorner(side));$(side+'-record').addEventListener('toggle',()=>{if($(side+'-record').open)showRecord(data.comparisons.find(r=>r.id===$(side).value),$(side+'-actions')).catch(e=>$(side+'-actions').textContent=e.message);});showCorner(side);}
 for(const run of data.comparisons){const row=document.createElement('tr');for(const value of [run.label,duration(run.wallMs),run.usage.astraCalls,run.usage.freshInputTokens,run.usage.cacheHitTokens,run.usage.outputTokens,run.usage.apiEquivalent]){const cell=document.createElement(row.children.length?'td':'th');if(!row.children.length)cell.scope='row';cell.textContent=typeof value==='number'?value.toLocaleString('en-US'):value??'Not recorded';row.append(cell);}$('usage-rows').append(row);}$('usage-note').textContent=data.usageNote;
 for(const metric of [{title:'Time to delivery',value:r=>r.wallMs,format:duration},{title:'Fresh input tokens',value:r=>r.usage.freshInputTokens,format:n=>n.toLocaleString('en-US')}]){
  const chart=document.createElement('div'),heading=document.createElement('h4');chart.className='comparison-meter';heading.textContent=metric.title;chart.append(heading);
  const max=Math.max(...data.comparisons.map(metric.value));
  for(const run of data.comparisons){const row=document.createElement('div'),label=document.createElement('span'),value=document.createElement('strong'),bar=document.createElement('meter');row.className='meter-row'+(run.id.startsWith('astra-factory')?' factory':'');label.textContent=run.label;value.textContent=metric.format(metric.value(run));bar.min=0;bar.max=max;bar.value=metric.value(run);bar.setAttribute('aria-label',run.label+': '+value.textContent);row.append(label,value,bar);chart.append(row);}
  $('comparison-meters').append(chart);
 }
 if(data.contextImprovement){$('context-improvement').hidden=false;$('context-saving').textContent=data.contextImprovement.percentLessFreshInput+'%';$('context-improvement-copy').textContent=data.contextImprovement.description;}
 const links=document.createElement('div');links.className='record-links';for(const run of data.comparisons){const link=document.createElement('a');link.href=run.record;link.textContent=run.label+' · full record ↗';links.append(link);}$('comparison-records').append(links);
})().catch(error=>{$('build-facts').textContent=error.message;$('game-title').textContent='Build record unavailable';});
