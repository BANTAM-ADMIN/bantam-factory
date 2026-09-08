import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ESCAPABLE='\\*?[]!-';
const reEscape=c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const classEscape=c=>c.replace(/[\\\]^]/g,'\\$&');

function compileSegment(seg){
  let out='';
  for(let i=0;i<seg.length;i++){
    const c=seg[i];
    if(c==='\\'){
      const n=seg[i+1];
      if(n===undefined||!ESCAPABLE.includes(n))throw Error('invalid escape');
      out+=reEscape(n);i++;continue;
    }
    if(c==='*'){while(seg[i+1]==='*')i++;out+='[^/]*';continue;}
    if(c==='?'){out+='[^/]';continue;}
    if(c==='['){
      let j=i+1,neg=false;
      if(seg[j]==='!'||seg[j]==='^'){neg=true;j++;}
      let body='',first=true;
      for(;;j++,first=false){
        if(j>=seg.length)throw Error('unclosed class');
        const d=seg[j];
        if(d===']'&&!first)break;
        if(d==='\\'){
          const n=seg[j+1];
          if(n===undefined||!ESCAPABLE.includes(n))throw Error('invalid escape');
          body+=classEscape(n);j++;continue;
        }
        body+=d==='-'?'-':classEscape(d);
      }
      out+='['+(neg?'^':'')+body+']';i=j;continue;
    }
    out+=reEscape(c);
  }
  return new RegExp('^'+out+'$','s');
}

function compilePattern(pattern){
  let negated=false,body=pattern;
  if(body.startsWith('!')){negated=true;body=body.slice(1);}
  if(!body)throw Error('empty pattern body');
  const segs=body.split('/');
  if(segs.some(s=>s===''))throw Error('empty pattern segment');
  return {negated,parts:segs.map(s=>s==='**'?{globstar:true}:{globstar:false,re:compileSegment(s)})};
}

function matchParts(parts,segs,pi,si){
  while(pi<parts.length){
    const part=parts[pi];
    if(part.globstar){
      for(let k=si;k<=segs.length;k++)if(matchParts(parts,segs,pi+1,k))return true;
      return false;
    }
    if(si>=segs.length)return false;
    if(!part.re.test(segs[si]))return false;
    pi++;si++;
  }
  return si===segs.length;
}

export function selectPaths(paths,patterns){
  if(!Array.isArray(paths)||!Array.isArray(patterns))throw Error('invalid input');
  const seen=new Set();
  for(let i=0;i<paths.length;i++){
    const p=paths[i];
    if(typeof p!=='string'||!p||seen.has(p)||p.includes('\0'))throw Error('invalid path');
    if(p.startsWith('/')||p.endsWith('/'))throw Error('invalid path');
    if(p.split('/').some(s=>s===''||s==='.'||s==='..'))throw Error('invalid path');
    seen.add(p);
  }
  const compiled=[];
  for(let i=0;i<patterns.length;i++){
    const q=patterns[i];
    if(typeof q!=='string'||!q)throw Error('invalid pattern');
    compiled.push(compilePattern(q));
  }
  const decisions=paths.map(p=>{
    const segs=p.split('/');
    let included=false,pattern=-1;
    for(let i=0;i<compiled.length;i++){
      if(matchParts(compiled[i].parts,segs,0,0)){included=!compiled[i].negated;pattern=i;}
    }
    return {path:p,included,pattern};
  });
  return {selected:decisions.filter(d=>d.included).map(d=>d.path),decisions};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(selectPaths(input.paths,input.patterns))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
