import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const pad=(...rolls)=>[...Array(18).fill(0),...rolls];
await grade('bowling-score',async check=>{
  const {scoreGame:score}=await import(pathToFileURL(path.join(workspace,'bowling-score.js')));
  await check('open-frames-spares-and-strikes',()=>{
    assert.equal(score(Array(20).fill(0)).total,0);
    assert.equal(score(Array(20).fill(4)).total,80,'open frames add up');
    assert.equal(score(Array(21).fill(5)).total,150,'every frame a spare');
    assert.equal(score(Array(12).fill(10)).total,300,'a perfect game');
    assert.equal(score([10,7,3,9,0,10,0,8,8,2,0,6,10,10,10,8,1]).total,167);
    const g=score([10,7,3,...Array(16).fill(0)]);
    assert.equal(g.frames[0].score,20,'a strike takes the next two rolls');
    assert.equal(g.frames[1].score,10,'a spare takes the next one');
    assert.equal(g.frames[0].cumulative,20);
    assert.equal(g.frames[1].cumulative,30);
    assert.deepEqual(g.frames[0].rolls,[10]);
    assert.deepEqual(g.frames[1].rolls,[7,3]);
  });
  await check('tenth-frame-and-bonus-rolls',()=>{
    assert.equal(score(pad(4,5)).total,9,'an open tenth takes two rolls');
    assert.equal(score(pad(5,5,7)).total,17,'a tenth spare adds its third roll once');
    assert.equal(score(pad(10,3,7)).total,20,'a strike restores fresh pins');
    assert.equal(score(pad(10,10,10)).total,30);
    assert.equal(score(pad(0,10,5)).total,15,'a spare of 0 then 10');
    assert.deepEqual(score(pad(10,3,7)).frames[9].rolls,[10,3,7]);
    assert.deepEqual(score(pad(4,5)).frames[9].rolls,[4,5]);
    assert.equal(score(pad(4,5)).frames.length,10);
    const openTenth=score([...Array(18).fill(0),10]);
    assert.equal(openTenth.frames[9].score,null,'a tenth strike still needs its two bonus rolls');
    assert.equal(openTenth.complete,false);
    const twoOfThree=score([...Array(18).fill(0),10,4]);
    assert.equal(twoOfThree.frames[9].score,null,'two of three rolls is not a scored tenth');
    const nine=score([...Array(16).fill(0),10,10,3,4]);
    assert.equal(nine.frames[8].score,23,'a ninth-frame strike reads into the tenth');
  });
  await check('incomplete-games-and-null-scores',()=>{
    const one=score([10]);
    assert.equal(one.frames[0].score,null);
    assert.equal(one.frames[0].cumulative,null);
    assert.equal(one.complete,false);
    assert.equal(one.total,0);
    assert.deepEqual(one.frames[0].rolls,[10]);
    assert.equal(one.frames.length,10);
    assert.deepEqual(one.frames[5].rolls,[],'unplayed frames are empty');
    const two=score([10,4]);
    assert.equal(two.frames[0].score,null,'a strike still needs two bonus rolls');
    const three=score([10,4,3]);
    assert.equal(three.frames[0].score,17);
    assert.equal(three.frames[1].score,7);
    assert.equal(three.frames[2].score,null,'later frames stay null');
    assert.equal(three.total,24,'the total is the last scored cumulative');
    assert.equal(three.complete,false,'some frames scored is not a complete game');
    assert.equal(score([]).total,0);
    assert.equal(score([]).complete,false);
    const spare=score([7,3]);
    assert.equal(spare.frames[0].score,null,'a spare needs its bonus');
  });
  await check('illegal-frames-and-validation',()=>{
    for(const bad of [null,'x',{},[1.5],['3'],[-1],[11],[null],new Array(1)])
      assert.throws(()=>score(bad),Error,JSON.stringify(bad));
    assert.throws(()=>score([6,5]),Error,'two rolls over ten pins');
    assert.throws(()=>score([...Array(12).fill(10),1]),Error,'rolls beyond a complete game');
    assert.throws(()=>score(pad(10,3,9)),Error,'a tenth frame over ten on fresh pins');
    assert.throws(()=>score(pad(6,5)),Error,'an open tenth over ten');
    assert.throws(()=>score([...Array(20).fill(0),3]),Error,'an extra roll after an open tenth');
    const frozen=Object.freeze([10,7,3,...Array(16).fill(0)]);
    assert.equal(score(frozen).total,score([10,7,3,...Array(16).fill(0)]).total);
    assert.deepEqual(frozen.slice(0,3),[10,7,3],'input unchanged');
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('bowling-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({rolls:Array(12).fill(10),extra:true}));
      const r=cli(workspace,'bowling-score.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      const parsed=JSON.parse(r.stdout);
      assert.equal(parsed.total,300);assert.equal(parsed.complete,true);
      assert.equal(r.stdout,JSON.stringify(score(Array(12).fill(10)))+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'bowling-score.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"rolls":"x"}','{"rolls":[6,5]}','{"rolls":[11]}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'bowling-score.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
