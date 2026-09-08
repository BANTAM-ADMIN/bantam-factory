import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const iv=(start,end)=>({start,end});
await grade('interval-merge',async check=>{
  const {mergeIntervals:merge}=await import(pathToFileURL(path.join(workspace,'interval-merge.js')));
  await check('overlap-and-touching-coalescence',()=>{
    assert.deepEqual(merge([iv(1,3),iv(3,4)]).merged,[iv(1,4)],'touching joins');
    assert.deepEqual(merge([iv(1,5),iv(2,3)]).merged,[iv(1,5)],'contained absorbs');
    assert.deepEqual(merge([iv(1,3),iv(2,5)]).merged,[iv(1,5)],'overlap joins');
    assert.deepEqual(merge([iv(1,2),iv(3,4)]).merged,[iv(1,2),iv(3,4)],'a gap stays split');
    assert.deepEqual(merge([iv(1,2)]).merged,[iv(1,2)]);
    assert.deepEqual(merge([iv(1,4),iv(2,3),iv(3,9)]).merged,[iv(1,9)]);
  });
  await check('ordering-and-disjoint-output',()=>{
    const out=merge([iv(50,60),iv(1,5),iv(20,30),iv(5,6)]).merged;
    assert.deepEqual(out,[iv(1,6),iv(20,30),iv(50,60)]);
    for(let i=1;i<out.length;i++)assert.ok(out[i-1].end<out[i].start,'disjoint and not touching');
    assert.deepEqual(merge([iv(-10,-5),iv(-5,0),iv(2,3)]).merged,[iv(-10,0),iv(2,3)],'negatives sort');
    assert.deepEqual(merge([iv(3,4),iv(1,9),iv(2,3)]).merged,[iv(1,9)]);
    assert.deepEqual(Object.keys(merge([iv(1,2)]).merged[0]),['start','end']);
  });
  await check('coverage-accounting-and-large-spans',()=>{
    assert.equal(merge([iv(5,7),iv(1,3),iv(3,4)]).covered,5);
    assert.equal(merge([]).covered,0);
    assert.equal(merge([iv(-4,-1)]).covered,3);
    assert.equal(merge([iv(0,3000000000)]).covered,3000000000,'wider than 32 bits');
    assert.equal(merge([iv(-3000000000,3000000000)]).covered,6000000000);
    assert.equal(merge([iv(1,2),iv(10,12)]).covered,3);
    assert.deepEqual(merge([]),{merged:[],covered:0,dropped:0});
    assert.equal(merge([iv(1,3),iv(3,4),iv(9,10)]).dropped,1);
    assert.equal(merge([iv(1,2),iv(5,6)]).dropped,0);
    assert.equal(merge([iv(1,9),iv(2,3),iv(4,5)]).dropped,2);
  });
  await check('validation-and-immutability',()=>{
    for(const bad of [null,'x',{},[null],[[]],[3],[{start:1}],[{end:2}],[{start:1,end:1}],[{start:5,end:2}],
      [{start:1.5,end:2}],[{start:'1',end:2}],[{start:1,end:2.5}],[{start:Number.MAX_SAFE_INTEGER+2,end:9}],[{start:0,end:Number.MAX_SAFE_INTEGER+2}],new Array(1)])
      assert.throws(()=>merge(bad),Error,JSON.stringify(bad));
    const input=Object.freeze([Object.freeze({start:3,end:4,extra:1}),Object.freeze({start:1,end:3})]);
    assert.deepEqual(merge(input),{merged:[iv(1,4)],covered:3,dropped:1});
    assert.deepEqual(input.map(i=>[i.start,i.end]),[[3,4],[1,3]],'input order preserved');
    const out=merge([iv(1,2)]);out.merged[0].start=99;
    assert.deepEqual(merge([iv(1,2)]).merged,[iv(1,2)],'results are independent');
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('interval-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({intervals:[iv(5,7),iv(1,3),iv(3,4)],extra:true}));
      const r=cli(workspace,'interval-merge.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({merged:[iv(1,4),iv(5,7)],covered:5,dropped:1})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'interval-merge.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"intervals":"x"}','{"intervals":[{"start":2,"end":2}]}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'interval-merge.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
