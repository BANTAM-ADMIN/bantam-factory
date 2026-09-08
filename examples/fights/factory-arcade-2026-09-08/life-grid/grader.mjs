import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const show=grid=>grid.map(row=>row.map(cell=>cell?'#':'.').join(''));
await grade('life-grid',async check=>{
  const {parseGrid:parse,step,run}=await import(pathToFileURL(path.join(workspace,'life-grid.js')));
  await check('preserved-parser-and-bounded-neighbours',()=>{
    assert.deepEqual(parse(['.#']),[[false,true]]);
    assert.deepEqual(parse(['##','##']),[[true,true],[true,true]]);
    for(const bad of [[],'x',null,['#','##'],['#x'],[''],[3]])assert.throws(()=>parse(bad),Error,JSON.stringify(bad));
    // A corner cell has three neighbours, so a 2x2 block survives unchanged.
    assert.deepEqual(show(step(parse(['##','##']))),['##','##']);
    // Bounded, only the middle cell has two neighbours. With wrapping every
    // cell would have two and the whole row would survive as '###'.
    assert.deepEqual(show(step(parse(['###']))),['.#.']);
    assert.deepEqual(show(step(parse(['#..','...','..#']))),['...','...','...']);
  });
  await check('step-rules-and-immutability',()=>{
    assert.deepEqual(show(step(parse(['...','###','...']))),['.#.','.#.','.#.'],'a blinker turns');
    assert.deepEqual(show(step(step(parse(['...','###','...'])))),['...','###','...'],'and turns back');
    assert.deepEqual(show(step(parse(['.#.','.#.','.#.']))),['...','###','...']);
    assert.deepEqual(show(step(parse(['#.','..']))),['..','..'],'a lone cell dies');
    assert.deepEqual(show(step(parse(['##.','#..','...']))),['##.','##.','...'],'three neighbours breed');
    // The centre of a plus has exactly four live neighbours and must die;
    // only a rule that stops at three gets this right.
    assert.deepEqual(show(step(parse(['.#.','###','.#.']))),['###','#.#','###'],'four neighbours crowd it out');
    const grid=parse(['##','##']),before=JSON.stringify(grid);
    step(grid);
    assert.equal(JSON.stringify(grid),before,'step does not mutate its input');
    const forRun=parse(['...','###','...']),snapshot=JSON.stringify(forRun);
    run(forRun,3);
    assert.equal(JSON.stringify(forRun),snapshot,'run does not mutate its input');
  });
  await check('early-stability-versus-oscillation',()=>{
    const block=run(parse(['##','##']),5);
    assert.equal(block.stable,true);assert.equal(block.generations,1);
    const blinker=run(parse(['...','###','...']),5);
    assert.equal(blinker.stable,false,'a two-generation oscillator is not stable');
    assert.equal(blinker.generations,5,'it runs to the requested count');
    assert.deepEqual(blinker.rows,['.#.','.#.','.#.']);
    const dead=run(parse(['#..','...','...']),5);
    assert.equal(dead.stable,true,'an empty grid repeats itself');
    assert.equal(dead.generations,2);
    const blinker2=run(parse(['...','###','...']),2);
    assert.equal(blinker2.stable,false);
    assert.equal(blinker2.generations,2);
    assert.deepEqual(blinker2.rows,['...','###','...']);
  });
  await check('generation-accounting-and-population',()=>{
    const zero=run(parse(['###']),0);
    assert.deepEqual(zero,{rows:['###'],generations:0,stable:false,population:3},'zero generations is the input');
    assert.equal(run(parse(['##','##']),5).population,4);
    assert.equal(run(parse(['...','###','...']),5).population,3);
    assert.equal(run(parse(['#..','...','...']),5).population,0);
    assert.deepEqual(Object.keys(run(parse(['#']),0)),['rows','generations','stable','population']);
    assert.deepEqual(run(parse(['#']),0).rows,['#']);
    assert.equal(run(parse(['##','##']),1).generations,1);
    assert.equal(run(parse(['##','##']),0).stable,false,'zero generations proves nothing');
  });
  await check('validation-and-cli-contract',()=>{
    for(const gens of [-1,1.5,'3',null,NaN,{}])assert.throws(()=>run(parse(['#']),gens),Error,JSON.stringify(gens));
    for(const grid of [null,'x',[],[[]],[[1,0]],[['#']],[[true],[true,false]]])
      assert.throws(()=>run(grid,1),Error,JSON.stringify(grid));
    for(const grid of [null,'x',[],[[1,0]]])assert.throws(()=>step(grid),Error,JSON.stringify(grid));
    const dir=fixture('life-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({rows:['...','###','...'],generations:5,extra:true}));
      const r=cli(workspace,'life-grid.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({rows:['.#.','.#.','.#.'],generations:5,stable:false,population:3})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'life-grid.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"rows":["#"],"generations":-1}','{"rows":["#x"],"generations":1}','{"rows":[],"generations":1}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'life-grid.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
