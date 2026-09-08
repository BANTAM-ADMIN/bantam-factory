// Deliberately flawed: build metadata affects precedence, a prerelease ranks
// above its release, prerelease identifiers never compare numerically, and any
// prerelease is admitted into every range.
const PATTERN=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parse(v){
  const m=PATTERN.exec(v);
  if(!m)throw Error('invalid version');
  return {major:+m[1],minor:+m[2],patch:+m[3],
    prerelease:m[4]===undefined?[]:m[4].split('.'),build:m[5]===undefined?[]:m[5].split('.')};
}

export function compareVersions(a,b){
  const x=parse(a),y=parse(b);
  for(const key of ['major','minor','patch']){const d=x[key]-y[key];if(d)return d<0?-1:1;}
  const left=[...x.prerelease,...x.build],right=[...y.prerelease,...y.build];
  for(let i=0;i<Math.max(left.length,right.length);i++){
    if(left[i]===undefined)return -1;
    if(right[i]===undefined)return 1;
    if(left[i]!==right[i])return left[i]<right[i]?-1:1;
  }
  return 0;
}

export function satisfies(version,range){
  for(const clause of String(range).split('||')){
    const comparators=clause.trim().split(/\s+/).filter(Boolean);
    if(comparators.every(text=>{
      const op=['>=','<=','>','<','='].find(o=>text.startsWith(o))??'=';
      const d=compareVersions(version,text.slice(op==='='&&!text.startsWith('=')?0:op.length));
      return op==='='?d===0:op==='>'?d>0:op==='>='?d>=0:op==='<'?d<0:d<=0;
    }))return true;
  }
  return false;
}
