import {canonicalAuditCommand,isConfiguredAuditCommand} from './verification-command.js';
import {canonicalEncode} from './factory/fact-fabric.js';
import {workspacePrefixedCommand} from './contract-audit-recovery.js';
import path from 'node:path';

const HASH=/^[a-f0-9]{64}$/;
const SOURCES=new Set(['shell','automatic','scoped','landing','completion']);
const FLAGS=['invalidated','blocked','timedOut','interrupted','aborted','bufferExceeded','error','signal','uncertainty','cached'];
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const clean=v=>!FLAGS.some(key=>Boolean(v?.[key]));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const command=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4096;

function same(a,b) { return isConfiguredAuditCommand(a,b); }
const configuredExecution = isConfiguredAuditCommand;
function shellVerifierCommand(value,workspace,cwd) {
  if (!command(value)) return null;
  return canonicalAuditCommand(value) ?? workspacePrefixedCommand(value,workspace,cwd);
}
export function verificationExecutionEntries(turn,index){
  if(!record(turn)||turn.controllerStop||turn.shellScopeRollback?.violations?.length)return [];
  if(!Object.hasOwn(turn,'verificationReceipts'))return [{verificationEvidence:turn.verificationEvidence??null,shellExecution:turn.shellExecution??null}];
  const e=turn.verificationReceipts;
  if(!record(e)||e.schema!=='bantam.verification-receipts.v1'||e.authority!=='controller-execution-order'||e.turn!==index
      ||!Array.isArray(e.entries)||e.entries.length<1||e.entries.length>16
      ||!e.entries.every((r,i)=>record(r)&&r.sequence===i&&Object.hasOwn(r,'verificationEvidence')&&Object.hasOwn(r,'shellExecution')
        &&(r.verificationEvidence===null||record(r.verificationEvidence))&&(r.shellExecution===null||record(r.shellExecution))
        &&Boolean(r.verificationEvidence||r.shellExecution)))return [];
  try{
    for(const key of ['verificationEvidence','shellExecution'])if(turn[key]!=null
      &&!e.entries.some(r=>r[key]!=null&&canonicalEncode(r[key])===canonicalEncode(turn[key])))return [];
  }catch{return [];}
  return e.entries;
}
function counts(value,status){
  if(value==null)return null;
  if(!record(value)||!['passed','failed','total'].every(k=>integer(value[k]))
    ||value.passed+value.failed>value.total||(status==='pass'&&(value.failed!==0||value.passed===0||value.total===0)))return false;
  return {passed:value.passed,failed:value.failed,total:value.total};
}
function measured(entry,{generation,configuredCommand,workspace}){
  const p=entry.verificationEvidence,s=entry.shellExecution;
  if(!record(p)||p.schema!==1||!SOURCES.has(p.source)||!clean(p)||!HASH.test(p.outputSha256??'')
    ||p.generation!==generation||p.cwd!==workspace
    ||!command(p.command)||!command(p.executedCommand)||p.statusScope!=='execution'||p.statusCommand!==p.executedCommand
    ||!integer(p.exitCode)||p.exitCode>255||!['pass','fail'].includes(p.status)
    ||(p.status==='fail'?p.exitCode===0:p.exitCode!==0))return null;
  if(p.source==='shell'&&!s)return null;
  if(s!=null){
    if(!record(s)||!clean(s)||!HASH.test(s.outputSha256??'')
      ||!command(s.command)||p.command.trim()!==s.command.trim()
      ||['executedCommand','generation','exitCode','cwd','workspaceReadOnly','sandbox']
        .some(k=>(p[k]??null)!==(s[k]??null)))return null;
  }
  if(p.source==='shell'){
    const actual=shellVerifierCommand(p.executedCommand,workspace,s.cwd);
    const requested=shellVerifierCommand(p.command,workspace,s.cwd);
    if((p.configuredCommand!=null&&p.configuredCommand!==configuredCommand)
      ||!configuredExecution(actual,configuredCommand)||!configuredExecution(requested,configuredCommand))return null;
  }else if(p.configuredCommand!==configuredCommand||!same(p.command,configuredCommand)
    ||!configuredExecution(p.executedCommand,configuredCommand))return null;
  const observedCounts=counts(p.counts,p.status);
  if(observedCounts===false||(observedCounts&&p.countsScope!=='single-execution'))return null;
  return {status:p.status,command:p.executedCommand,generation,exitCode:p.exitCode,counts:observedCounts,
    failureSites:(Array.isArray(p.failureSites)?p.failureSites:[]).filter(v=>record(v)
      && typeof v.file==='string' && v.file.length<=2048 && !/[\x00-\x1f\x7f]/.test(v.file)
      && integer(v.line) && v.line>0).slice(0,4),
    failingTests:(Array.isArray(p.failingTests)?p.failingTests:[]).filter(v=>typeof v==='string').slice(0,4)
      .map(v=>v.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160))};
}

// Advisory current state only. A different green program does not retire this
// failure; a changed generation requires new evidence, not a claim of success.
export function currentConfiguredFailure(turns=[],{generation,configuredCommand,workspace}={}){
  if(!Array.isArray(turns)||!integer(generation)||!command(configuredCommand)
    ||typeof workspace!=='string'||!workspace.startsWith('/')||/[\0\r\n]/.test(workspace))return null;
  const settings={generation,configuredCommand:configuredCommand.trim(),workspace};
  let failure=null;
  for(let index=Math.max(0,turns.length-128);index<turns.length;index++){
    for(const entry of verificationExecutionEntries(turns[index],index)){
      const p=measured(entry,settings);if(!p)continue;
      if(p.status==='pass')failure=null;
      else{const {status,...fields}=p;failure={...fields,turn:index};}
    }
  }
  return failure;
}

// Limit the rendered JSON string, not raw characters: quotes and lone UTF-16
// surrogates can expand during escaping. Optional context cannot crowd out the
// fixed execution-state instruction.
function quoted(value,limit){
  const clean=value.replace(/[\x00-\x1f\x7f]/g,' ');
  let end=Math.min(clean.length,limit-2),text=JSON.stringify(clean.slice(0,end));
  while(text.length>limit){end--;text=JSON.stringify(clean.slice(0,end));}
  return {text,truncated:end<clean.length};
}

export function verificationFailureContext(failure,{facts=[],readSource,workspace}={}){
  if(!record(failure)||!integer(failure.generation)||!integer(failure.turn)||!integer(failure.exitCode)
    ||failure.exitCode<1||failure.exitCode>255||!command(failure.command))return null;
  const shown=quoted(failure.command,640);
  let text=`EXECUTION FAILURE: the configured verifier exited ${failure.exitCode} on the CURRENT tree (generation ${failure.generation}, turn ${failure.turn+1}).`
    +` Recorded command${shown.truncated?' (excerpt)':''}: ${shown.text}.`;
  const c=counts(failure.counts,'fail');
  if(c)text+=` Recorded tests: ${c.passed} passed, ${c.failed} failed, ${c.total} total.`;
  const instruction=' A new working hypothesis is not execution evidence. Inspect the actual failing API call and operand in the current source; a retyped helper or print-only probe is not the failing program. Repair a demonstrated source or fixture defect, then run the configured verifier directly. Unrelated green checks cannot settle this failure. This is observed execution state, not an oracle or permission to finish.';
  let remaining=2400-text.length-instruction.length;
  // Bind the current failure to the actual stack location before adding
  // hypotheses. A nearby passing assertion is not a reproduction of this one.
  for(const site of (Array.isArray(failure.failureSites)?failure.failureSites:[]).slice(0,2)){
    if(!record(site)||typeof site.file!=='string'||site.file.length>2048
      ||/[\x00-\x1f\x7f]/.test(site.file)||!integer(site.line)||site.line<1
      ||typeof workspace!=='string'||typeof readSource!=='function')continue;
    const relative=path.relative(workspace,path.resolve(workspace,site.file));
    if(!relative||relative.startsWith('../')||path.isAbsolute(relative))continue;
    try{
      const source=readSource(relative);
      if(typeof source!=='string'||source.length>256*1024)continue;
      const lines=source.split('\n');
      if(site.line>lines.length)continue;
      const excerpt=lines.slice(Math.max(0,site.line-3),site.line)
        .map((s,i)=>`${Math.max(1,site.line-2)+i}${Math.max(1,site.line-2)+i===site.line?' >':'  '} ${s}`).join('\n');
      if(excerpt.length>650)continue;
      const rendered=`\nFailing stack site: ${JSON.stringify(relative)}:${site.line}. Current source (\">\" marks that line):\n${excerpt}\nReproduce this exact call and input, including transformations; a neighboring passing call does not explain this failure.`;
      if(rendered.length>remaining)continue;
      text+=rendered;remaining-=rendered.length;
    }catch{ /* Missing/unsafe source never changes execution state. */ }
  }
  // Preserve complete bounded structural facts before optional case names.
  // Truncating a fact can remove the important distinction or its limitations.
  for(const fact of Array.isArray(facts)?facts.slice(0,4):[]){
    if(typeof fact!=='string'||!fact.trim()||fact.length>1000)continue;
    const quotedFact=JSON.stringify(fact.replace(/[\x00-\x1f\x7f]/g,' '));
    if(quotedFact.length>1000)continue;
    const rendered=`\nCurrent source fact: ${quotedFact}`;
    if(rendered.length>remaining)continue;
    text+=rendered;remaining-=rendered.length;
  }
  const names=(Array.isArray(failure.failingTests)?failure.failingTests:[]).filter(v=>typeof v==='string').slice(0,3)
    .map(v=>quoted(v,180).text);
  for(const name of names){
    const rendered=` Failing case: ${name}.`;
    if(rendered.length>remaining)break;text+=rendered;remaining-=rendered.length;
  }
  text+=instruction;
  return {schema:1,phase:'failure',generation:failure.generation,text};
}
