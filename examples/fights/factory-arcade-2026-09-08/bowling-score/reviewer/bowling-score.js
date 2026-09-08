import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function scoreGame(rolls){
  if(!Array.isArray(rolls))throw Error('invalid rolls');
  for(const roll of rolls)
    if(!Number.isSafeInteger(roll)||roll<0||roll>10)throw Error('invalid roll');

  // Split into frames first so an illegal frame is rejected before scoring.
  const frames=[];
  let i=0;
  for(let f=0;f<10;f++){
    if(i>=rolls.length){frames.push([]);continue;}
    if(f<9){
      if(rolls[i]===10){frames.push([10]);i+=1;continue;}
      const pair=rolls.slice(i,i+2);
      if(pair.length===2&&pair[0]+pair[1]>10)throw Error('frame exceeds ten pins');
      frames.push(pair);i+=pair.length;continue;
    }
    const tenth=[];
    while(tenth.length<3&&i<rolls.length){
      tenth.push(rolls[i]);i+=1;
      if(tenth.length===2){
        if(tenth[0]!==10&&tenth[0]+tenth[1]>10)throw Error('frame exceeds ten pins');
        if(tenth[0]!==10&&tenth[0]+tenth[1]<10)break;
      }
      if(tenth.length===3&&tenth[0]===10&&tenth[1]!==10&&tenth[1]+tenth[2]>10)
        throw Error('frame exceeds ten pins');
    }
    frames.push(tenth);
  }
  if(i<rolls.length)throw Error('rolls beyond a complete game');

  // A flat view for bonus lookups: the tenth frame's own rolls are never a
  // separate frame, but earlier strikes and spares still read forward into it.
  const flat=frames.flat();
  const starts=[];
  let at=0;
  for(const frame of frames){starts.push(at);at+=frame.length;}

  const out=[];
  let cumulative=0,broken=false;
  for(let f=0;f<10;f++){
    const frame=frames[f];
    let score=null;
    if(frame.length){
      if(f===9){
        // The tenth frame scores its own rolls only; its bonus rolls are part
        // of it, not a further frame to score again.
        const needed=frame[0]===10||(frame.length>=2&&frame[0]+frame[1]===10)?3:2;
        if(frame.length===needed)score=frame.reduce((a,b)=>a+b,0);
      }
      else if(frame[0]===10){
        const bonus=flat.slice(starts[f]+1,starts[f]+3);
        if(bonus.length===2)score=10+bonus[0]+bonus[1];
      }
      else if(frame.length===2&&frame[0]+frame[1]===10){
        const bonus=flat.slice(starts[f]+2,starts[f]+3);
        if(bonus.length===1)score=10+bonus[0];
      }
      else if(frame.length===2)score=frame[0]+frame[1];
    }
    if(score===null)broken=true;
    if(broken){out.push({rolls:frame,score:score===null?null:score,cumulative:null});continue;}
    cumulative+=score;
    out.push({rolls:frame,score,cumulative});
  }
  const scored=out.filter(f=>f.cumulative!==null);
  return {frames:out,total:scored.length?scored[scored.length-1].cumulative:0,
    complete:out.every(f=>f.cumulative!==null)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(scoreGame(input.rolls))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
