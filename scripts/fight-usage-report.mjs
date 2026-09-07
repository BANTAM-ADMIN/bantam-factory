// Read-only projection of recorded local wire evidence. Never repairs or
// replaces historical receipts, and never substitutes native/global estimates.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {aggregateExchanges,responseUsage,responseMeasurements} from './fight-model-proxy.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const counter=value=>Number.isSafeInteger(value)&&value>=0;
const fields=['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'];
const MAX_ROWS=10000,MAX_BODY=16*1024*1024,MAX_INDEX=32*1024*1024,MAX_TOTAL=1024*1024*1024;

export function deriveSavedWireUsage(wireDirectory) {
  if(!path.isAbsolute(wireDirectory)||fs.realpathSync(wireDirectory)!==path.resolve(wireDirectory)
      ||!fs.lstatSync(wireDirectory).isDirectory())throw Error('wire directory must be a real absolute directory, not a symlink');
  let totalBytes=0,verifiedBodies=0;
  const read=(name,limit)=>{
    const file=path.join(wireDirectory,name);
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.size>limit||totalBytes+stat.size>MAX_TOTAL)throw Error(`evidence size/type limit: ${name}`);
      const bytes=fs.readFileSync(fd);
      if(bytes.length>limit||totalBytes+bytes.length>MAX_TOTAL)throw Error(`evidence size limit: ${name}`);
      totalBytes+=bytes.length;return bytes;
    }finally{fs.closeSync(fd);}
  };
  const indexBytes=read('exchanges.jsonl',MAX_INDEX),admitted=new Map(),settled=new Map();
  const lines=indexBytes.toString('utf8').split(/\r?\n/).filter(line=>line.trim());
  if(lines.length>MAX_ROWS*2)throw Error('exchange count limit');
  for(const line of lines){
    const row=JSON.parse(line);
    if(!row||Array.isArray(row)||!Number.isSafeInteger(row.index)||row.index<1||row.index>MAX_ROWS
        ||!['request','response'].includes(row.phase))throw Error('invalid exchange index/phase');
    const target=row.phase==='request'?admitted:settled;
    if(target.has(row.index))throw Error(`duplicate ${row.phase} index ${row.index}`);
    target.set(row.index,row);
  }
  for(const index of settled.keys())if(!admitted.has(index))throw Error(`response without request ${index}`);
  const requests=[],unsealedResponseIndices=[];
  for(const [index,request]of [...admitted].sort(([a],[b])=>a-b)){
    if(index!==requests.length+1||typeof request.generation!=='boolean'||typeof request.route!=='string'
        ||!request.route.startsWith('/')||request.route.startsWith('//')||request.route.includes('\\')
        ||!['GET','POST'].includes(request.method)||!counter(request.requestBytes)||!HASH.test(request.requestSha256??'')){
      throw Error(`invalid request metadata ${index}`);
    }
    const stem=String(index).padStart(5,'0'),requestFile=`${stem}.request.body`,responseFile=`${stem}.response.body`;
    const requestBytes=read(requestFile,MAX_BODY);
    if(requestBytes.length!==request.requestBytes||hash(requestBytes)!==request.requestSha256)throw Error(`request body mismatch ${index}`);
    verifiedBodies++;
    const response=settled.get(index);
    let raw=null;
    if(response){
      for(const key of ['index','route','method','generation','requestBytes','requestSha256']){
        if(response[key]!==request[key])throw Error(`request/response binding mismatch ${index}`);
      }
      if(typeof response.finished!=='boolean'||!counter(response.responseBytes)||!HASH.test(response.responseSha256??'')
          ||(response.status!=null&&(!Number.isInteger(response.status)||response.status<100||response.status>599))
          ||(response.contentType!=null&&(typeof response.contentType!=='string'||response.contentType.length>1024))){
        throw Error(`invalid response metadata ${index}`);
      }
      raw=read(responseFile,MAX_BODY);
      if(raw.length!==response.responseBytes||hash(raw)!==response.responseSha256)throw Error(`response body mismatch ${index}`);
      verifiedBodies++;
    }else unsealedResponseIndices.push(index);
    // A saved usage object is not trusted: derive it again from the body that
    // the finalized receipt hashes. Unsealed response files supply no proof.
    const usage=request.generation&&raw?responseUsage(raw.toString('utf8'),response.contentType):null;
    const measurements=request.generation&&raw?responseMeasurements(raw.toString('utf8'),response.contentType):null;
    const settlement=response?.settlement;
    requests.push({index,route:request.route,generation:request.generation,finished:response?.finished??false,
      status:response?.status??null,requestFile,responseFile:response?responseFile:null,
      requestBytes:requestBytes.length,responseBytes:raw?.length??0,
      requestSha256:request.requestSha256,responseSha256:response?.responseSha256??null,
      usage,measurements,settlement:{
        reason:typeof settlement?.reason==='string'?settlement.reason.slice(0,120)
          :!response?'unsettled-recording':response.finished?'upstream-ended':response.error==='client disconnected'?'client-disconnected':'incomplete-response',
        at:typeof settlement?.at==='string'?settlement.at:null,
        upstreamEnded:settlement?.upstreamEnded===true||response?.finished===true,
        clientDisconnected:settlement?.clientDisconnected===true||response?.error==='client disconnected',
        recorderClosing:settlement?.recorderClosing===true,
      }});
  }
  const gaps=requests.filter(row=>row.generation&&(!row.finished||row.status!==200
    ||fields.some(field=>!counter(row.measurements?.[field])))).map(row=>({
    index:row.index,reason:row.settlement.reason,finished:row.finished,status:row.status,responseBytes:row.responseBytes,
    missingFields:fields.filter(field=>row.status!==200||!counter(row.measurements?.[field])),
  }));
  return {schema:'bantam.fight-usage-report.v1',source:'saved-local-wire',usage:aggregateExchanges(requests),requests,gaps,
    integrity:{verified:unsealedResponseIndices.length===0,verifiedBodies,unsealedResponseIndices,
      indexFile:'exchanges.jsonl',indexSha256:hash(indexBytes)},
    attribution:'Recorded endpoint counters; not native or global estimates. Hash consistency is not independent log authenticity.'};
}
