import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
function checkEdit(source,edit){
  if(typeof source!=='string'||edit===null||typeof edit!=='object'||Array.isArray(edit)
    ||!Number.isSafeInteger(edit.start)||!Number.isSafeInteger(edit.end)
    ||edit.start<0||edit.start>edit.end||edit.end>source.length
    ||typeof edit.before!=='string'||typeof edit.after!=='string')throw Error('invalid edit');
  if(source.slice(edit.start,edit.end)!==edit.before)throw Error('preimage mismatch');
}
export function applyEdit(source,edit){
  checkEdit(source,edit);
  return source.slice(0,edit.start)+edit.after+source.slice(edit.end);
}
export function applyTransaction(source,edits){
  if(typeof source!=='string'||!Array.isArray(edits))throw Error('invalid transaction');
  for(const edit of edits)checkEdit(source,edit);
  for(let i=0;i<edits.length;i++)for(let j=i+1;j<edits.length;j++){
    const a=edits[i],b=edits[j],ai=a.start===a.end,bi=b.start===b.end;
    const conflict=ai&&bi?a.start===b.start:ai?a.start>=b.start&&a.start<=b.end
      :bi?b.start>=a.start&&b.start<=a.end:Math.max(a.start,b.start)<Math.min(a.end,b.end);
    if(conflict)throw Error('conflicting edits');
  }
  const ordered=[...edits].sort((a,b)=>a.start-b.start);
  let cursor=0,text='';
  for(const edit of ordered){text+=source.slice(cursor,edit.start)+edit.after;cursor=edit.end;}
  return {text:text+source.slice(cursor),applied:edits.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('usage: patch-transaction.js INPUT_JSON_FILE');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('input must be an object');
    process.stdout.write(JSON.stringify(applyTransaction(input.source,input.edits))+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=2;}
}
