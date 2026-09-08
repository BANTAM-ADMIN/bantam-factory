import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const NAME=/^[a-z][a-z0-9-]*$/;
const SHORT=/^[A-Za-z]$/;

function compileSpec(spec){
  if(!spec||typeof spec!=='object'||Array.isArray(spec))throw Error('invalid spec');
  const options=new Map(),shorts=new Map();
  for(const name of Object.keys(spec)){
    if(!NAME.test(name))throw Error('invalid option name');
    const entry=spec[name];
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('invalid option');
    if(entry.type!=='boolean'&&entry.type!=='string')throw Error('invalid type');
    const multiple=entry.multiple===undefined?false:entry.multiple;
    if(typeof multiple!=='boolean')throw Error('invalid multiple');
    if(multiple&&entry.type!=='string')throw Error('multiple requires a string option');
    if(entry.short!==undefined){
      if(typeof entry.short!=='string'||!SHORT.test(entry.short))throw Error('invalid short');
      if(shorts.has(entry.short))throw Error('duplicate short');
      shorts.set(entry.short,name);
    }
    options.set(name,{type:entry.type,multiple});
  }
  return {options,shorts};
}

export function parseArgs(argv,spec){
  if(!Array.isArray(argv))throw Error('invalid argv');
  for(const token of argv)if(typeof token!=='string')throw Error('invalid argv');
  const {options,shorts}=compileSpec(spec);
  // A null-prototype bag so a name such as constructor is an ordinary key.
  const out=Object.create(null),positionals=[],seen=new Set();
  const assign=(name,value)=>{
    const config=options.get(name);
    if(config.multiple){(out[name]??=[]).push(value);return;}
    if(seen.has(name))throw Error('repeated option');
    seen.add(name);out[name]=value;
  };
  let i=0;
  for(;i<argv.length;i++){
    const token=argv[i];
    if(token==='--'){i++;break;}
    if(token.startsWith('--')){
      const body=token.slice(2);
      const eq=body.indexOf('=');
      const name=eq<0?body:body.slice(0,eq);
      if(eq<0&&name.startsWith('no-')&&options.get(name.slice(3))?.type==='boolean'){
        assign(name.slice(3),false);continue;
      }
      const config=options.get(name);
      if(!config)throw Error('unknown option');
      if(config.type==='boolean'){
        if(eq>=0)throw Error('boolean takes no value');
        assign(name,true);continue;
      }
      if(eq>=0){assign(name,body.slice(eq+1));continue;}
      const next=argv[i+1];
      if(next===undefined||(next.startsWith('-')&&next!=='-'))throw Error('missing value');
      assign(name,next);i++;continue;
    }
    if(token.startsWith('-')&&token!=='-'){
      const letters=token.slice(1);
      for(let j=0;j<letters.length;j++){
        const name=shorts.get(letters[j]);
        if(!name)throw Error('unknown short option');
        const config=options.get(name);
        if(config.type==='boolean'){assign(name,true);continue;}
        const inline=letters.slice(j+1);
        if(inline!==''){assign(name,inline);j=letters.length;break;}
        const next=argv[i+1];
        if(next===undefined||(next.startsWith('-')&&next!=='-'))throw Error('missing value');
        assign(name,next);i++;j=letters.length;break;
      }
      continue;
    }
    positionals.push(token);
  }
  for(;i<argv.length;i++)positionals.push(argv[i]);
  return {options:Object.assign({},out),positionals};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(parseArgs(input.argv,input.spec))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
