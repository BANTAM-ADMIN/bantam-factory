import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const INDEX=/^(0|[1-9][0-9]*)$/;

function decodeToken(token){
  let out='';
  for(let i=0;i<token.length;i++){
    const c=token[i];
    if(c!=='~'){out+=c;continue;}
    const n=token[i+1];
    if(n==='0')out+='~';
    else if(n==='1')out+='/';
    else throw Error('invalid escape');
    i++;
  }
  return out;
}

export function resolvePointer(document,pointer){
  if(typeof pointer!=='string')throw Error('invalid pointer');
  if(pointer!==''&&!pointer.startsWith('/'))throw Error('invalid pointer');
  const tokens=pointer===''?[]:pointer.slice(1).split('/').map(decodeToken);
  let value=document,depth=0;
  const miss=reason=>({found:false,value:null,depth,reason});
  for(const token of tokens){
    if(Array.isArray(value)){
      if(token==='-')return miss('index-out-of-range');
      if(!INDEX.test(token))return miss('invalid-index');
      const index=Number(token);
      if(index>=value.length)return miss('index-out-of-range');
      value=value[index];
    }
    else if(value!==null&&typeof value==='object'){
      if(!Object.prototype.hasOwnProperty.call(value,token))return miss('missing-key');
      value=value[token];
    }
    else return miss('not-a-container');
    depth++;
  }
  return {found:true,value,depth,reason:null};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    if(!Object.prototype.hasOwnProperty.call(input,'document'))throw Error('document required');
    process.stdout.write(JSON.stringify(resolvePointer(input.document,input.pointer))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
