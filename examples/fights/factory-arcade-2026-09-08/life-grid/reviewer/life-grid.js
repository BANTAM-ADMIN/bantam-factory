import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Existing, working helper. Preserve its exported behavior.
export function parseGrid(rows){
  if(!Array.isArray(rows)||rows.length<1||rows.length>60)throw Error('invalid grid');
  const width=typeof rows[0]==='string'?rows[0].length:-1;
  if(width<1||width>60)throw Error('invalid grid');
  return rows.map(row=>{
    if(typeof row!=='string'||row.length!==width)throw Error('invalid grid');
    return [...row].map(cell=>{
      if(cell!=='.'&&cell!=='#')throw Error('invalid cell');
      return cell==='#';
    });
  });
}

function checkGrid(grid){
  if(!Array.isArray(grid)||!grid.length)throw Error('invalid grid');
  const width=Array.isArray(grid[0])?grid[0].length:-1;
  if(width<1)throw Error('invalid grid');
  for(const row of grid){
    if(!Array.isArray(row)||row.length!==width)throw Error('invalid grid');
    for(const cell of row)if(typeof cell!=='boolean')throw Error('invalid grid');
  }
  return width;
}

export function step(grid){
  const width=checkGrid(grid),height=grid.length;
  const next=[];
  for(let row=0;row<height;row++){
    const line=[];
    for(let col=0;col<width;col++){
      let live=0;
      // Bounded neighbourhood: the grid does not wrap, so a corner has three.
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        if(dr===0&&dc===0)continue;
        const r=row+dr,c=col+dc;
        if(r<0||r>=height||c<0||c>=width)continue;
        if(grid[r][c])live++;
      }
      line.push(grid[row][col]?live===2||live===3:live===3);
    }
    next.push(line);
  }
  return next;
}

const render=grid=>grid.map(row=>row.map(cell=>cell?'#':'.').join(''));
const same=(a,b)=>a.length===b.length&&a.every((row,i)=>row.every((cell,j)=>cell===b[i][j]));

export function run(grid,generations){
  checkGrid(grid);
  if(!Number.isSafeInteger(generations)||generations<0)throw Error('invalid generations');
  let current=grid.map(row=>[...row]),applied=0,stable=false;
  for(let i=0;i<generations;i++){
    const next=step(current);
    applied++;
    // Only a grid identical to the one immediately before it counts as stable;
    // a two-generation oscillator must keep running.
    if(same(next,current)){current=next;stable=true;break;}
    current=next;
  }
  return {rows:render(current),generations:applied,stable,
    population:current.reduce((sum,row)=>sum+row.filter(Boolean).length,0)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(run(parseGrid(input.rows),input.generations))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
