import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function planRedactions(text,rules){
  if(typeof text!=='string'||!Array.isArray(rules))throw Error('invalid input');
  const ids=new Set();
  for(let i=0;i<rules.length;i++){
    const r=rules[i];
    if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.id!=='string'||!r.id||ids.has(r.id)
      ||typeof r.literal!=='string'||!r.literal||typeof r.replacement!=='string')throw Error('invalid rule');
    ids.add(r.id);
  }
  const matches=[];
  for(const [order,r]of rules.entries())for(let start=text.indexOf(r.literal);start>=0;start=text.indexOf(r.literal,start+1)){
    matches.push({start,end:start+r.literal.length,order});
  }
  matches.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start)||a.order-b.order);
  const parts=[],edits=[];let cursor=0;
  for(const m of matches){
    if(m.start<cursor)continue;
    const rule=rules[m.order];parts.push(text.slice(cursor,m.start),rule.replacement);
    edits.push({start:m.start,end:m.end,id:rule.id});cursor=m.end;
  }
  parts.push(text.slice(cursor));const output=parts.join('');
  return {text:output,edits,originalBytes:Buffer.byteLength(text,'utf8'),redactedBytes:Buffer.byteLength(output,'utf8')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(planRedactions(input.text,input.rules))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
