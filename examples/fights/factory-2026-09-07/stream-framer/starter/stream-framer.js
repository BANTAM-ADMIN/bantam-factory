import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Deliberately flawed: transport chunks are not complete lines or frames.
export function createDecoder(){
  let ended=false;
  return {
    push(chunk){
      const frames=[];
      for(const line of Buffer.from(chunk).toString('utf8').split('\n')){
        if(line.startsWith('data:')){
          const data=line.slice(5).trim();
          if(data==='[DONE]')ended=true;
          else frames.push({event:'message',data});
        }
      }
      return frames;
    },
    finish(){return [];},
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('usage: stream-framer.js INPUT_JSON_FILE');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    const decoder=createDecoder(),frames=[];
    for(const encoded of input.chunks)frames.push(...decoder.push(Buffer.from(encoded,'base64')));
    frames.push(...decoder.finish());process.stdout.write(JSON.stringify({frames})+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=2;}
}
