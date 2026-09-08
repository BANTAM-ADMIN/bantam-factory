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

export function step(grid){throw Error('Implement step, run and the CLI');}
export function run(grid,generations){throw Error('Implement step, run and the CLI');}
