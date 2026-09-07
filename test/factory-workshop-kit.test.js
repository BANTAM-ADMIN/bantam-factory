import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runShellProcess} from '../src/executor.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const kit=path.join(root,'examples/fights/factory-2026-09-07');
const cards=['context-packet','patch-transaction','stream-framer'];
const read=(...parts)=>fs.readFileSync(path.join(kit,...parts),'utf8');
const q=value=>`'${String(value).replaceAll("'","'\\''")}'`;
const docker={skip:process.env.BANTAM_FIGHT_KIT_DOCKER_TEST!=='1',timeout:45000};
const references=Object.fromEntries(cards.map(card=>[card,read(card,'reviewer',`${card}.js`)]));
function replace(source,before,after){assert.ok(source.includes(before),`mutation target not found: ${before}`);return source.replace(before,after);}

async function runGrade(t,card,source,{publicTests=false}={}){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'factory-workshop-gauge-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.cpSync(path.join(kit,card,'starter'),workspace,{recursive:true});
  const metadata=JSON.parse(read(card,'card.json'));
  fs.writeFileSync(path.join(workspace,metadata.deliverables[0]),source);
  const grader=path.join(kit,card,'grader.mjs');
  // Candidate code is imported/executed ONLY inside offline, read-only Docker.
  const result=await runShellProcess(workspace,`${publicTests?'npm test && ':''}node ${q(grader)} ${q(workspace)}`,{
    shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,dockerImage:'ubuntu:24.04',
    readOnlyHostFiles:[grader,path.join(kit,'grader-support.mjs')],timeoutMs:30000,
  });
  assert.equal(result.timedOut,false,result.stderr);assert.equal(result.aborted,false,result.stderr);
  assert.equal(result.bufferExceeded,false,result.stderr);
  let output;
  try{output=JSON.parse(result.stdout.trim().split('\n').at(-1));}
  catch(error){assert.fail(`missing complete grader receipt: ${result.stdout}\n${result.stderr}\n${error}`);}
  assert.equal(output.schema,'bantam.factory-card-grade.v1');assert.equal(output.card,card);
  assert.deepEqual(output.groups.map(group=>group.name),metadata.groups);
  assert.ok(output.groups.every(group=>typeof group.pass==='boolean'));
  assert.equal(output.pass,output.groups.every(group=>group.pass));
  return {result,output};
}

test('workshop materials publish five independent groups and protected identical starters',()=>{
  for(const card of cards){
    const metadata=JSON.parse(read(card,'card.json'));
    assert.equal(metadata.id,card);assert.equal(new Set(metadata.groups).size,5);
    const task=read(card,'task.md');
    for(const phrase of ['npm test','Node.js builtins','read-only','os.tmpdir()'])assert.ok(task.includes(phrase),`${card}: ${phrase}`);
    for(const file of [...metadata.protected,...metadata.deliverables])assert.ok(fs.statSync(path.join(kit,card,'starter',file)).isFile());
    for(const excluded of ['grader.mjs','reviewer','task.md'])assert.equal(fs.existsSync(path.join(kit,card,'starter',excluded)),false);
    for(const group of metadata.groups)assert.ok(read(card,'grader.mjs').includes(`check('${group}'`),group);
    assert.deepEqual(JSON.parse(read(card,'starter','package.json')).scripts,{test:'node --test'});
  }
});
for(const card of cards){
  test(`workshop gauge accepts ${card} reference plus public tests in readonly Docker`,docker,async t=>{
    const {result,output}=await runGrade(t,card,references[card],{publicTests:true});
    assert.equal(result.code,0,result.stdout+result.stderr);assert.equal(output.pass,true,JSON.stringify(output));
  });
  test(`workshop gauge rejects ${card} untouched starter in readonly Docker`,docker,async t=>{
    const {result,output}=await runGrade(t,card,read(card,'starter',`${card}.js`));
    assert.equal(result.code,1,result.stdout+result.stderr);assert.equal(output.pass,false,JSON.stringify(output));
  });
}

const c=references['context-packet'],p=references['patch-transaction'],s=references['stream-framer'];
const mutations=[
  ['context-packet','character count instead of UTF-8 bytes',replace(c,"Buffer.byteLength(frame,'utf8')",'frame.length')],
  ['context-packet','exact-fit optional sections omitted',replace(c,'bytes+s.cost<=maxBytes','bytes+s.cost<maxBytes')],
  ['context-packet','stop after first oversized optional',replace(c,'if(bytes+s.cost<=maxBytes){chosen.push(s);bytes+=s.cost;}','if(bytes+s.cost<=maxBytes){chosen.push(s);bytes+=s.cost;}else break;')],
  ['context-packet','lexical rather than input-order ties',replace(c,'b.priority-a.priority||a.index-b.index',"b.priority-a.priority||(a.id<b.id?-1:a.id>b.id?1:0)")],
  ['context-packet','required overflow accepted',replace(c,"if(bytes>maxBytes)throw Error('required sections exceed budget');",'')],
  ['context-packet','duplicate identities accepted',replace(c,'||ids.has(s.id)','')],
  ['context-packet','sparse source slots silently skipped',replace(c,'Array.from(sections,(s,index)=>{','sections.map((s,index)=>{')],
  ['patch-transaction','sequential shifted coordinates',replace(p,'const ordered=[...edits].sort((a,b)=>a.start-b.start);','return {text:edits.reduce((text,edit)=>applyEdit(text,edit),source),applied:edits.length};\n  const ordered=[...edits].sort((a,b)=>a.start-b.start);')],
  ['patch-transaction','stale preimages accepted',replace(p,"if(source.slice(edit.start,edit.end)!==edit.before)throw Error('preimage mismatch');",'')],
  ['patch-transaction','insertion at replacement endpoint allowed',replace(p,'a.start>=b.start&&a.start<=b.end','a.start>b.start&&a.start<b.end')],
  ['patch-transaction','adjacent replacements rejected',replace(p,'Math.max(a.start,b.start)<Math.min(a.end,b.end)','Math.max(a.start,b.start)<=Math.min(a.end,b.end)')],
  ['patch-transaction','caller array sorted in place',replace(p,'const ordered=[...edits].sort','const ordered=edits.sort')],
  ['patch-transaction','invalid source accepted on empty work',replace(p,"if(typeof source!=='string'||!Array.isArray(edits))throw Error('invalid transaction');","if(Array.isArray(edits)&&edits.length===0)return {text:String(source),applied:0};\n  if(typeof source!=='string'||!Array.isArray(edits))throw Error('invalid transaction');")],
  ['stream-framer','per-chunk UTF-8 replacement decoding',replace(s,'decoder.decode(chunk,{stream:true})',"Buffer.from(chunk).toString('utf8')")],
  ['stream-framer','multiline data concatenated without newline',replace(s,"data.join('\\n')","data.join('')")],
  ['stream-framer','event leaks across frame boundaries',replace(s,"data=[];event='';continue;","data=[];continue;")],
  ['stream-framer','whitespace trimmed instead of one space',replace(s,"if(value.startsWith(' '))value=value.slice(1);",'value=value.trim();')],
  ['stream-framer','missing termination accepted',replace(s,"if(!terminated)throw Error('missing termination');",'')],
  ['stream-framer','nonblank data after termination ignored',replace(s,"if(terminated){if(line!=='')throw Error('data after termination');continue;}",'if(terminated)continue;')],
  ['stream-framer','failed decoder reused',replace(s,'failed=true;throw error;','throw error;')],
  ['stream-framer','CLI permissive base64',replace(s,"if(typeof text!=='string'||Buffer.from(text,'base64').toString('base64')!==text)throw Error('noncanonical base64');", "if(typeof text!=='string')throw Error('invalid base64');")],
];
for(const [card,name,source]of mutations){
  test(`workshop gauge rejects ${card}: ${name}`,docker,async t=>{
    const {result,output}=await runGrade(t,card,source);
    assert.equal(result.code,1,result.stdout+result.stderr);assert.equal(output.pass,false,JSON.stringify(output));
  });
}
