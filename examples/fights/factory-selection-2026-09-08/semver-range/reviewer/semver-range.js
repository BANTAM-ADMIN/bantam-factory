import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PATTERN=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const NUMERIC=/^(0|[1-9]\d*)$/;
const IDENT=/^[0-9A-Za-z-]+$/;
const OPS=['>=','<=','>','<','='];

function parse(v){
  if(typeof v!=='string')throw Error('invalid version');
  const m=PATTERN.exec(v);
  if(!m)throw Error('invalid version');
  const prerelease=m[4]===undefined?[]:m[4].split('.');
  if(prerelease.some(p=>!IDENT.test(p)||(/^\d+$/.test(p)&&!NUMERIC.test(p))))throw Error('invalid prerelease');
  const build=m[5]===undefined?[]:m[5].split('.');
  if(build.some(b=>!IDENT.test(b)))throw Error('invalid build');
  return {major:+m[1],minor:+m[2],patch:+m[3],prerelease,build};
}

function comparePrerelease(a,b){
  if(!a.length&&!b.length)return 0;
  if(!a.length)return 1;
  if(!b.length)return -1;
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const x=a[i],y=b[i];
    if(x===undefined)return -1;
    if(y===undefined)return 1;
    const xn=NUMERIC.test(x),yn=NUMERIC.test(y);
    if(xn&&yn){const d=Number(x)-Number(y);if(d)return d<0?-1:1;continue;}
    if(xn!==yn)return xn?-1:1;
    if(x!==y)return x<y?-1:1;
  }
  return 0;
}

function compareParsed(x,y){
  for(const key of ['major','minor','patch']){const d=x[key]-y[key];if(d)return d<0?-1:1;}
  return comparePrerelease(x.prerelease,y.prerelease);
}

export function compareVersions(a,b){return compareParsed(parse(a),parse(b));}

function parseComparator(text){
  const op=OPS.find(o=>text.startsWith(o))??'=';
  return {op,version:parse(text.slice(op===
    '='&&!text.startsWith('=')?0:op.length))};
}

export function satisfies(version,range){
  if(typeof range!=='string')throw Error('invalid range');
  const parsed=parse(version);
  const clauses=range.split('||');
  if(!clauses.length)throw Error('invalid range');
  let matched=false;
  for(const clause of clauses){
    const parts=clause.trim().split(/\s+/).filter(Boolean);
    if(!parts.length)throw Error('invalid range');
    const comparators=parts.map(parseComparator);
    const holds=comparators.every(c=>{
      const d=compareParsed(parsed,c.version);
      return c.op==='='?d===0:c.op==='>'?d>0:c.op==='>='?d>=0:c.op==='<'?d<0:d<=0;
    });
    if(!holds)continue;
    if(parsed.prerelease.length&&!comparators.some(c=>c.version.prerelease.length
      &&c.version.major===parsed.major&&c.version.minor===parsed.minor&&c.version.patch===parsed.patch))continue;
    matched=true;
  }
  return matched;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    const {versions,range}=input;
    if(!Array.isArray(versions))throw Error('versions array required');
    for(const v of versions)parse(v);
    // Validate the range even when there is nothing to test it against.
    satisfies('0.0.0',range);
    const sorted=versions.map((v,i)=>({v,i})).sort((a,b)=>compareVersions(a.v,b.v)||a.i-b.i).map(x=>x.v);
    const satisfying=sorted.filter(v=>satisfies(v,range));
    process.stdout.write(JSON.stringify({sorted,satisfying})+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
