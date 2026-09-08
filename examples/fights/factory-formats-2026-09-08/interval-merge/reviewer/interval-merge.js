import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function mergeIntervals(intervals){
  if(!Array.isArray(intervals))throw Error('invalid input');
  const parsed=[];
  for(let i=0;i<intervals.length;i++){
    const entry=intervals[i];
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('invalid interval');
    const {start,end}=entry;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||!(start<end))throw Error('invalid interval');
    parsed.push({start,end});
  }
  parsed.sort((a,b)=>a.start-b.start||a.end-b.end);
  const merged=[];
  for(const range of parsed){
    const last=merged[merged.length-1];
    // Touching counts as joinable: the result must be the smallest set of
    // ranges covering the same values, so [1,3) and [3,4) become [1,4).
    if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);
    else merged.push({start:range.start,end:range.end});
  }
  let covered=0n;
  for(const range of merged)covered+=BigInt(range.end)-BigInt(range.start);
  return {merged,covered:Number(covered),dropped:intervals.length-merged.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(mergeIntervals(input.intervals))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
