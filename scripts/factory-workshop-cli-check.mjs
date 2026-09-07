#!/usr/bin/env node
// Supplementary post-flight checks, never a replacement for frozen card scores.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runShellProcess} from '../src/executor.js';

const SELF=fileURLToPath(import.meta.url);
const CARDS=['context-packet','patch-transaction','stream-framer'];
const PAYLOAD_BYTES=128*1024;
const SCHEMA='bantam.workshop-cli-check.v1';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;

// Pure fixture construction. No workspace access and no candidate execution.
export function workshopCLICase(card){
  const payload='x'.repeat(128*1024);
  if(card==='context-packet'){
    const id='large-cli',text='### '+JSON.stringify(id)+'\n'+payload+'\n';
    const bytes=Buffer.byteLength(text,'utf8');
    return {input:{sections:[{id,text:payload,priority:0,required:true}],maxBytes:bytes},
      expected:{text,bytes,included:[id],omitted:[]}};
  }
  if(card==='patch-transaction'){
    const source='head:'+payload+'\nend';
    return {input:{source,edits:[{start:0,end:5,before:'head:',after:'HEAD:'}]},
      expected:{text:'HEAD:'+payload+'\nend',applied:1}};
  }
  if(card==='stream-framer'){
    const wire='data: '+payload+'\n\ndata: [DONE]\n\n';
    return {input:{chunks:[Buffer.from(wire,'utf8').toString('base64')]},
      expected:{frames:[{event:'message',data:payload}]}};
  }
  throw Error('unknown workshop card');
}

// This function is serialized into a fixed command and executes ONLY inside
// the Docker shell below. The candidate gets piped stdout, never an inherited
// terminal, so premature process.exit can be distinguished from a clean write.
async function controller(card,workspace,makeCase){
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const {createHash}=await import('node:crypto');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const specimen=makeCase(card),expected=Buffer.from(JSON.stringify(specimen.expected)+'\n');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-workshop-cli-postflight-'));
  let record;
  try{
    const input=path.join(dir,'input.json');fs.writeFileSync(input,JSON.stringify(specimen.input));
    const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,[path.join(workspace,card+'.js'),input],{
      cwd:workspace,env,timeout:5000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
    });
    const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
    record={schema:'bantam.workshop-cli-check.v1',card,payloadBytes:128*1024,
      expectedStdoutBytes:expected.length,actualStdoutBytes:stdout.length,
      expectedStdoutSha256:hash(expected),actualStdoutSha256:hash(stdout),
      stdoutExact:stdout.equals(expected),stderrBytes:stderr.length,
      stderrEmpty:stderr.length===0,exitCode:result.status,signal:result.signal,
      spawnErrorCode:result.error?.code??null};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
  process.stdout.write(JSON.stringify(record)+'\n');
}

function sourceHash(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('candidate entry must be a regular file no larger than 8 MiB');
  return sha(fs.readFileSync(file));
}

/** Run after the live series settles. This never writes into the workspace. */
export async function checkWorkshopCLI(workspace,card,{run=runShellProcess}={}){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace)||!CARDS.includes(card))throw Error('requires an absolute workspace and known workshop card');
  const stat=fs.lstatSync(workspace);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('workspace must be a real directory');
  const subject=path.join(workspace,card+'.js'),before=sourceHash(subject);
  const specimen=workshopCLICase(card),expected=Buffer.from(JSON.stringify(specimen.expected)+'\n');
  const script=`await (${controller.toString()})(${JSON.stringify(card)},${JSON.stringify(workspace)},${workshopCLICase.toString()});`;
  const base={schema:SCHEMA,card,scope:'supplementary-large-output-pipeline',
    supplementary:true,canonicalScoreChanged:false,payloadBytes:PAYLOAD_BYTES,
    expectedStdoutBytes:expected.length,expectedStdoutSha256:sha(expected),
    candidateBeforeSha256:before,helperSha256:sha(fs.readFileSync(SELF))};
  let result;
  try{
    result=await run(workspace,`node --input-type=module -e ${quote(script)}`,{
      shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:15000,
    });
  }catch{
    return {...base,status:'UNAVAILABLE',pass:null,reason:'sandbox invocation failed',
      candidateAfterSha256:sourceHash(subject),candidateUnchanged:sourceHash(subject)===before};
  }
  const after=sourceHash(subject);
  const outer={exitCode:Number.isInteger(result.code)?result.code:null,timedOut:result.timedOut===true,
    aborted:result.aborted===true,bufferExceeded:result.bufferExceeded===true};
  const unavailable=reason=>({...base,status:'UNAVAILABLE',pass:null,reason,outer,
    candidateAfterSha256:after,candidateUnchanged:after===before});
  if(result.code!==0||outer.timedOut||outer.aborted||outer.bufferExceeded)return unavailable('sandbox controller did not finish cleanly');
  let record;
  try{record=JSON.parse(result.stdout.trim());}catch{return unavailable('missing complete diagnostic receipt');}
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(record?.schema!==SCHEMA||record.card!==card||record.payloadBytes!==PAYLOAD_BYTES
    ||record.expectedStdoutBytes!==expected.length||record.expectedStdoutSha256!==base.expectedStdoutSha256
    ||!count(record.actualStdoutBytes)||!count(record.stderrBytes)||!digest(record.actualStdoutSha256)
    ||typeof record.stdoutExact!=='boolean'||typeof record.stderrEmpty!=='boolean'
    ||!(record.exitCode===null||Number.isInteger(record.exitCode))
    ||!(record.signal===null||typeof record.signal==='string'&&/^SIG[A-Z0-9]{1,12}$/.test(record.signal))
    ||!(record.spawnErrorCode===null||typeof record.spawnErrorCode==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(record.spawnErrorCode)))return unavailable('invalid diagnostic receipt');
  const stdoutExact=record.stdoutExact&&record.actualStdoutBytes===expected.length&&record.actualStdoutSha256===base.expectedStdoutSha256;
  const stderrEmpty=record.stderrEmpty&&record.stderrBytes===0;
  const pass=record.exitCode===0&&record.signal===null&&record.spawnErrorCode===null&&stdoutExact&&stderrEmpty&&before===after;
  return {...base,status:pass?'PASS':'FAIL',pass,outer,
    actualStdoutBytes:record.actualStdoutBytes,actualStdoutSha256:record.actualStdoutSha256,
    stdoutExact,stderrBytes:record.stderrBytes,stderrEmpty,exitCode:record.exitCode,
    signal:record.signal,spawnErrorCode:record.spawnErrorCode,
    candidateAfterSha256:after,candidateUnchanged:after===before};
}

if(process.argv[1]&&path.resolve(process.argv[1])===SELF){
  if(process.argv.length!==4){process.stderr.write('usage: factory-workshop-cli-check.mjs ABS_WORKSPACE CARD\n');process.exitCode=2;}
  else checkWorkshopCLI(process.argv[2],process.argv[3]).then(record=>{
    process.stdout.write(JSON.stringify(record)+'\n');process.exitCode=record.pass===true?0:record.pass===false?1:2;
  }).catch(error=>{process.stderr.write(String(error.message)+'\n');process.exitCode=2;});
}
