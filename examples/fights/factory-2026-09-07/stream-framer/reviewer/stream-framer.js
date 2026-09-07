import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function createDecoder(){
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='',data=[],event='',terminated=false,finished=false,failed=false;
  const guard=fn=>{
    if(failed||finished)throw Error('decoder is closed');
    try{return fn();}catch(error){failed=true;throw error;}
  };
  const consume=frames=>{
    let index;
    while((index=buffer.indexOf('\n'))!==-1){
      let line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      if(line.endsWith('\r'))line=line.slice(0,-1);
      if(terminated){if(line!=='')throw Error('data after termination');continue;}
      if(line===''){
        if(data.length){
          const value=data.join('\n');
          if(value==='[DONE]')terminated=true;
          else frames.push({event:event||'message',data:value});
        }
        data=[];event='';continue;
      }
      if(line.startsWith(':'))continue;
      const colon=line.indexOf(':');
      const field=colon===-1?line:line.slice(0,colon);
      let value=colon===-1?'':line.slice(colon+1);
      if(value.startsWith(' '))value=value.slice(1);
      if(field==='data')data.push(value);
      else if(field==='event')event=value;
    }
  };
  return {
    push(chunk){return guard(()=>{
      if(!(chunk instanceof Uint8Array))throw Error('chunk must be Uint8Array');
      buffer+=decoder.decode(chunk,{stream:true});
      const frames=[];consume(frames);return frames;
    });},
    finish(){return guard(()=>{
      buffer+=decoder.decode();
      if(buffer!==''||data.length||event!=='')throw Error('incomplete frame');
      if(!terminated)throw Error('missing termination');
      finished=true;return [];
    });},
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('usage: stream-framer.js INPUT_JSON_FILE');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.chunks))throw Error('invalid chunk input');
    const chunks=input.chunks.map(text=>{
      if(typeof text!=='string'||Buffer.from(text,'base64').toString('base64')!==text)throw Error('noncanonical base64');
      return Buffer.from(text,'base64');
    });
    const decoder=createDecoder(),frames=[];
    for(const chunk of chunks)frames.push(...decoder.push(chunk));
    frames.push(...decoder.finish());process.stdout.write(JSON.stringify({frames})+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=2;}
}
