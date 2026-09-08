import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const move=n=>({op:'move',n});
const turn=deg=>({op:'turn',deg});
await grade('turtle-canvas',async check=>{
  const {runTurtle:run}=await import(pathToFileURL(path.join(workspace,'turtle-canvas.js')));
  await check('movement-heading-and-canvas',()=>{
    assert.deepEqual(run([move(2),turn(90),move(1)],{width:3,height:2}),
      {canvas:['###','  #'],marked:4,position:{col:2,row:1},heading:'south'});
    assert.deepEqual(run([],{width:2,height:2}),
      {canvas:['  ','  '],marked:0,position:{col:0,row:0},heading:'east'});
    assert.equal(run([turn(90)],{width:2,height:2}).heading,'south');
    assert.equal(run([turn(180)],{width:2,height:2}).heading,'west');
    assert.equal(run([turn(-90)],{width:2,height:2}).heading,'north');
    assert.equal(run([turn(360)],{width:2,height:2}).heading,'east','a full turn returns east');
    assert.equal(run([turn(3600)],{width:2,height:2}).heading,'east');
    assert.equal(run([turn(-3600)],{width:2,height:2}).heading,'east');
    assert.deepEqual(run([move(2),move(-1)],{width:3,height:1}).position,{col:1,row:0},'negative moves reverse');
    assert.deepEqual(run([move(1)],{width:2,height:1}).canvas,['##'],'the start cell is marked too');
    assert.equal(run([move(2)],{width:3,height:1}).canvas.length,1);
    assert.equal(run([],{width:4,height:3}).canvas.every(r=>r.length===4),true,'every row is width wide');
  });
  await check('clipping-at-the-boundary',()=>{
    assert.deepEqual(run([move(99)],{width:3,height:1}),
      {canvas:['###'],marked:3,position:{col:2,row:0},heading:'east'},'a long move stops at the edge');
    assert.deepEqual(run([move(99),turn(90),move(1)],{width:3,height:2}).canvas,['###','  #'],
      'the turtle keeps working after a clip');
    assert.deepEqual(run([turn(-90),move(5)],{width:2,height:2}).position,{col:0,row:0},'north from the top clips');
    assert.equal(run([turn(-90),move(5)],{width:2,height:2}).marked,1);
    assert.deepEqual(run([move(-5)],{width:3,height:1}).position,{col:0,row:0},'west from the left clips');
    assert.deepEqual(run([turn(90),move(99)],{width:2,height:3}).position,{col:0,row:2});
    assert.equal(run([move(99)],{width:1,height:1}).marked,1);
  });
  await check('pen-state-and-mark-characters',()=>{
    assert.deepEqual(run([{op:'pen',down:false},move(2)],{width:3,height:1}),
      {canvas:['   '],marked:0,position:{col:2,row:0},heading:'east'},'a raised pen still moves');
    assert.deepEqual(run([{op:'pen',down:false},move(1),{op:'pen',down:true},move(1)],{width:3,height:1}).canvas,
      ['  #'],'only cells entered with the pen down are marked');
    assert.deepEqual(run([{op:'mark',ch:'*'},move(1)],{width:2,height:1}).canvas,['**']);
    assert.deepEqual(run([move(1),{op:'mark',ch:'*'},move(1)],{width:3,height:1}).canvas,['##*'],
      'the character changes only for later marks');
    assert.deepEqual(run([{op:'mark',ch:'~'},move(0)],{width:2,height:1}).canvas,['~ ']);
    assert.equal(run([{op:'pen',down:false}],{width:2,height:1}).canvas[0],'  ','no move means no start mark');
  });
  await check('distinct-cell-accounting',()=>{
    assert.equal(run([move(1),move(-1)],{width:2,height:1}).marked,2,'overdraw counts once');
    assert.equal(run([move(2),move(-2),move(2)],{width:3,height:1}).marked,3);
    assert.equal(run([move(0)],{width:2,height:1}).marked,1,'a zero move still marks the start');
    assert.equal(run([move(99)],{width:5,height:1}).marked,5,'clipped cells still count');
    const over=run([move(1),{op:'mark',ch:'*'},move(-1)],{width:2,height:1});
    assert.equal(over.marked,2,'remarking does not add a count');
    assert.deepEqual(over.canvas,['*#'],'but it does overwrite the character');
    assert.equal(run([{op:'pen',down:false},move(3)],{width:4,height:1}).marked,0);
  });
  await check('validation-and-cli-contract',()=>{
    for(const options of [null,'x',[],{width:0,height:1},{width:1,height:0},{width:201,height:1},
      {width:1,height:201},{width:1.5,height:1},{width:'2',height:1},{height:1},{width:1}])
      assert.throws(()=>run([],options),Error,JSON.stringify(options));
    for(const program of [null,'x',{},[null],[[]],[3],[{op:'fly'}],[{op:'move'}],[{op:'move',n:1.5}],
      [{op:'turn',deg:45}],[{op:'turn',deg:3601}],[{op:'pen'}],[{op:'pen',down:1}],
      [{op:'mark',ch:'ab'}],[{op:'mark',ch:' '}],[{op:'mark',ch:''}],new Array(1)])
      assert.throws(()=>run(program,{width:3,height:3}),Error,JSON.stringify(program));
    const frozen=Object.freeze([Object.freeze(move(1))]),opts=Object.freeze({width:2,height:1,extra:1});
    assert.equal(run(frozen,opts).marked,2);
    const dir=fixture('turtle-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({program:[move(2),turn(90),move(1)],options:{width:3,height:2},extra:true}));
      const r=cli(workspace,'turtle-canvas.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({canvas:['###','  #'],marked:4,position:{col:2,row:1},heading:'south'})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'turtle-canvas.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"program":[],"options":{"width":0,"height":1}}','{"program":"x","options":{"width":1,"height":1}}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'turtle-canvas.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
