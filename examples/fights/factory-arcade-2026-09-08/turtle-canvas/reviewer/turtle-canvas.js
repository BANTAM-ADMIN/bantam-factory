import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HEADINGS=['north','east','south','west'];
const STEPS=[[0,-1],[1,0],[0,1],[-1,0]];   // [dcol, drow] per heading

export function runTurtle(program,options){
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('invalid options');
  const {width,height}=options;
  if(!Number.isSafeInteger(width)||width<1||width>200)throw Error('invalid width');
  if(!Number.isSafeInteger(height)||height<1||height>200)throw Error('invalid height');
  if(!Array.isArray(program))throw Error('invalid program');

  // Validate the whole program before executing any of it.
  for(const command of program){
    if(!command||typeof command!=='object'||Array.isArray(command))throw Error('invalid command');
    if(command.op==='move'){
      if(!Number.isSafeInteger(command.n))throw Error('invalid move');
    }
    else if(command.op==='turn'){
      if(!Number.isSafeInteger(command.deg)||command.deg%90!==0
        ||command.deg<-3600||command.deg>3600)throw Error('invalid turn');
    }
    else if(command.op==='pen'){
      if(typeof command.down!=='boolean')throw Error('invalid pen');
    }
    else if(command.op==='mark'){
      if(typeof command.ch!=='string'||[...command.ch].length!==1
        ||command.ch<'!'||command.ch>'~')throw Error('invalid mark');
    }
    else throw Error('unknown op');
  }

  const cells=Array.from({length:height},()=>Array(width).fill(' '));
  let col=0,row=0,heading=1,pen=true,ch='#',marked=0,started=false;
  const mark=()=>{
    if(!pen)return;
    if(cells[row][col]===' ')marked++;
    cells[row][col]=ch;
  };
  for(const command of program){
    if(command.op==='pen'){pen=command.down;continue;}
    if(command.op==='mark'){ch=command.ch;continue;}
    if(command.op==='turn'){heading=(heading+command.deg/90%4+4)%4;continue;}
    // The starting cell is marked once, before the first move of the program.
    if(!started){started=true;mark();}
    const distance=Math.abs(command.n);
    const sign=command.n<0?-1:1;
    const [dc,dr]=STEPS[heading];
    for(let i=0;i<distance;i++){
      const nextCol=col+dc*sign,nextRow=row+dr*sign;
      // Clipped, not an error: stop at the boundary and drop the remainder.
      if(nextCol<0||nextCol>=width||nextRow<0||nextRow>=height)break;
      col=nextCol;row=nextRow;mark();
    }
  }
  return {canvas:cells.map(line=>line.join('')),marked,
    position:{col,row},heading:HEADINGS[heading]};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(runTurtle(input.program,input.options))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
