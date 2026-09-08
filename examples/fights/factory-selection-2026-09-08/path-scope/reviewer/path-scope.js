import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Existing, working helper. Preserve its exported behavior.
export function normalizeSegments(input){
  if(typeof input!=='string')throw Error('invalid path');
  const segments=[];
  for(const part of input.split('/')){
    if(part===''||part==='.')continue;
    if(part==='..'){segments.pop();continue;}
    segments.push(part);
  }
  return segments;
}

export function resolveWithin(root,candidate){
  if(typeof root!=='string'||typeof candidate!=='string')throw Error('invalid input');
  if(!root||!candidate||root.includes('\0')||candidate.includes('\0'))throw Error('invalid input');
  if(!root.startsWith('/'))throw Error('root must be absolute');
  const rootSegments=normalizeSegments(root);
  const segments=normalizeSegments(candidate.startsWith('/')?candidate:root+'/'+candidate);
  const resolved='/'+segments.join('/');
  const inside=segments.length>=rootSegments.length&&rootSegments.every((s,i)=>segments[i]===s);
  return {inside,resolved,relative:inside?segments.slice(rootSegments.length).join('/'):null};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(resolveWithin(input.root,input.candidate))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
