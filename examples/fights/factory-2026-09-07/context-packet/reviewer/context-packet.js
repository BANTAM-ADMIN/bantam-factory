import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function packContext(sections,maxBytes){
  if(!Array.isArray(sections)||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('invalid packet input');
  const ids=new Set();
  const entries=Array.from(sections,(s,index)=>{
    if(!object(s)||typeof s.id!=='string'||s.id.length===0||ids.has(s.id)||typeof s.text!=='string'
      ||!Number.isSafeInteger(s.priority)||s.priority<0||typeof s.required!=='boolean')throw Error('invalid section');
    ids.add(s.id);
    const frame='### '+JSON.stringify(s.id)+'\n'+s.text+'\n';
    return {id:s.id,required:s.required,priority:s.priority,index,frame,cost:Buffer.byteLength(frame,'utf8')};
  });
  const required=entries.filter(s=>s.required);
  let bytes=required.reduce((n,s)=>n+s.cost,0);
  if(bytes>maxBytes)throw Error('required sections exceed budget');
  const chosen=[...required];
  for(const s of entries.filter(s=>!s.required).sort((a,b)=>b.priority-a.priority||a.index-b.index)){
    if(bytes+s.cost<=maxBytes){chosen.push(s);bytes+=s.cost;}
  }
  const selected=new Set(chosen.map(s=>s.id));
  return {text:chosen.map(s=>s.frame).join(''),bytes,included:chosen.map(s=>s.id),
    omitted:entries.filter(s=>!selected.has(s.id)).map(s=>s.id)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('usage: context-packet.js INPUT_JSON_FILE');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!object(input))throw Error('input must be an object');
    process.stdout.write(JSON.stringify(packContext(input.sections,input.maxBytes))+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=2;}
}
