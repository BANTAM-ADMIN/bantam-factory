import {hasShellControlOutsideQuotes,splitShellWords} from './shell-lex.js';
import {canonicalEncode} from './factory/fact-fabric.js';

const HASH=/^[a-f0-9]{64}$/;
const SOURCES=new Set(['shell','automatic','scoped','landing','completion']);
const FLAGS=['invalidated','blocked','timedOut','interrupted','aborted','bufferExceeded','error','signal','uncertainty','cached'];
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const clean=v=>!FLAGS.some(key=>Boolean(v?.[key]));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const command=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4096;

function words(value){
  if(!command(value)||hasShellControlOutsideQuotes(value))return null;
  const result=splitShellWords(value);return result.length?result:null;
}
function same(a,b){const x=words(a),y=words(b);return Boolean(x&&y&&x.length===y.length&&x.every((v,i)=>v===y[i]));}
function configuredExecution(actual,configured){
  if(same(actual,configured))return true;
  const a=words(actual),b=words(configured);
  if(!a||!b||a.length!==b.length+1||b[1]!=='--test'||!/^(?:node|nodejs)$/.test(b[0]?.split('/').at(-1)??'')
      ||b.some(v=>/^--test-timeout(?:=|$)/.test(v)))return false;
  const timeout=/^--test-timeout=([1-9]\d*)$/.exec(a[2]??'');
  return Boolean(timeout&&Number(timeout[1])>=5000&&Number(timeout[1])<=60000
    &&a.filter((_,i)=>i!==2).every((v,i)=>v===b[i]));
}
function entries(turn,index){
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
    ||p.generation!==generation||p.cwd!==workspace||p.configuredCommand!==configuredCommand
    ||!command(p.command)||!command(p.executedCommand)||p.statusScope!=='execution'||p.statusCommand!==p.executedCommand
    ||!configuredExecution(p.executedCommand,configuredCommand)
    ||!integer(p.exitCode)||p.exitCode>255||!['pass','fail'].includes(p.status)
    ||(p.status==='fail'?p.exitCode===0:p.exitCode!==0))return null;
  if(p.source==='shell'&&!s)return null;
  if(s!=null){
    if(!record(s)||!clean(s)||!HASH.test(s.outputSha256??'')
      ||['command','executedCommand','generation','exitCode','cwd','workspaceReadOnly','sandbox']
        .some(k=>(p[k]??null)!==(s[k]??null)))return null;
  }
  if(p.source!=='shell'&&!same(p.command,configuredCommand))return null;
  const observedCounts=counts(p.counts,p.status);
  if(observedCounts===false||(observedCounts&&p.countsScope!=='single-execution'))return null;
  return {status:p.status,command:p.executedCommand,generation,exitCode:p.exitCode,counts:observedCounts,
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
    for(const entry of entries(turns[index],index)){
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

export function verificationFailureContext(failure,{facts=[]}={}){
  if(!record(failure)||!integer(failure.generation)||!integer(failure.turn)||!integer(failure.exitCode)
    ||failure.exitCode<1||failure.exitCode>255||!command(failure.command))return null;
  const shown=quoted(failure.command,640);
  let text=`EXECUTION FAILURE: the configured verifier exited ${failure.exitCode} on the CURRENT tree (generation ${failure.generation}, turn ${failure.turn+1}).`
    +` Recorded command${shown.truncated?' (excerpt)':''}: ${shown.text}.`;
  const c=counts(failure.counts,'fail');
  if(c)text+=` Recorded tests: ${c.passed} passed, ${c.failed} failed, ${c.total} total.`;
  const instruction=' A new working hypothesis is not execution evidence. Inspect the actual failing API call and operand in the current source; a retyped helper or print-only probe is not the failing program. Repair a demonstrated source or fixture defect, then run the configured verifier directly. Unrelated green checks cannot settle this failure. This is observed execution state, not an oracle or permission to finish.';
  let remaining=2400-text.length-instruction.length;
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
