import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
await grade('poker-hand',async check=>{
  const {evaluateHand:ev,compareHands:cmp}=await import(pathToFileURL(path.join(workspace,'poker-hand.js')));
  const is=(cards,rank,category,tiebreak)=>assert.deepEqual(ev(cards),{rank,category,tiebreak},cards.join(' '));
  await check('categories-and-ranking',()=>{
    is(['Ah','Kh','Qh','Jh','Th'],8,'straight-flush',[14]);
    is(['9c','9d','9h','9s','2c'],7,'four-of-a-kind',[9,2]);
    is(['9c','9d','9h','2s','2c'],6,'full-house',[9,2]);
    is(['Ah','Jh','9h','5h','3h'],5,'flush',[14,11,9,5,3]);
    is(['6h','5c','4d','3s','2h'],4,'straight',[6]);
    is(['9c','9d','9h','5s','2c'],3,'three-of-a-kind',[9,5,2]);
    is(['Kc','Kd','Qh','Qs','2c'],2,'two-pair',[13,12,2]);
    is(['Kc','Kd','9h','5s','2c'],1,'one-pair',[13,9,5,2]);
    is(['Qh','9c','7d','5s','3h'],0,'high-card',[12,9,7,5,3]);
    is(['2c','2d','2h','2s','3c'],7,'four-of-a-kind',[2,3]);
  });
  await check('wheel-and-straight-boundaries',()=>{
    is(['Ah','2c','3d','4s','5h'],4,'straight',[5]);
    is(['5h','4h','3h','2h','Ah'],8,'straight-flush',[5]);
    is(['Ah','Kc','Qd','Js','Th'],4,'straight',[14]);
    is(['Qh','Kc','Ad','2s','3h'],0,'high-card',[14,13,12,3,2],'an ace is not both ends');
    is(['Ac','Kc','Qc','2c','3c'],5,'flush',[14,13,12,3,2],'that wrap is only a flush');
    is(['2c','3d','4h','5s','7c'],0,'high-card',[7,5,4,3,2]);
    is(['6c','5d','4h','3s','2c'],4,'straight',[6]);
    is(['Ah','2h','3h','4h','6h'],5,'flush',[14,6,4,3,2],'nearly a wheel');
  });
  await check('tiebreak-groups-and-kickers',()=>{
    assert.deepEqual(ev(['9c','9d','9h','9s','2c']).tiebreak,[9,2],'quad then kicker');
    assert.deepEqual(ev(['2c','2d','2h','2s','Ac']).tiebreak,[2,14]);
    assert.deepEqual(ev(['9c','9d','9h','2s','2c']).tiebreak,[9,2],'trips then pair');
    assert.deepEqual(ev(['2c','2d','2h','9s','9c']).tiebreak,[2,9]);
    assert.deepEqual(ev(['Kc','Kd','3h','3s','Ac']).tiebreak,[13,3,14],'pairs before the kicker');
    assert.deepEqual(ev(['Ac','Ad','Kh','Qs','2c']).tiebreak,[14,13,12,2]);
    assert.deepEqual(ev(['Ah','Kh','9h','5h','3h']).tiebreak,[14,13,9,5,3],'flush is all five descending');
    assert.equal(ev(['Ah','2c','3d','4s','5h']).tiebreak.length,1,'a straight is one value');
  });
  await check('comparison-and-exact-ties',()=>{
    assert.equal(cmp(['5h','4h','3h','2h','Ah'],['6h','5h','4h','3h','2h']),-1,'wheel is the lowest straight-flush');
    assert.equal(cmp(['Ah','2c','3d','4s','5h'],['6h','5c','4d','3s','2h']),-1);
    assert.equal(cmp(['Kc','Kd','Qh','Qs','3c'],['Kc','Kd','Qh','Qs','2c']),1,'kicker breaks two pair');
    assert.equal(cmp(['Ah','Kd','Qh','Js','9c'],['Ac','Kh','Qs','Jd','9h']),0,'suits never break a tie');
    assert.equal(cmp(['2c','2d','2h','2s','3c'],['Ac','Ad','Ah','Ks','Qc']),1,'quads beat aces up');
    assert.equal(cmp(['Ah','Jh','9h','5h','3h'],['6c','5d','4h','3s','2c']),1,'flush beats a straight');
    assert.equal(cmp(['9c','9d','9h','2s','2c'],['Ah','Jh','9h','5h','3h']),1,'a boat beats a flush');
    assert.equal(cmp(['Kc','Kd','9h','5s','2c'],['Kh','Ks','9c','5d','2h']),0);
    assert.equal(cmp(['3c','3d','9h','5s','2c'],['2c','2d','9h','5s','3h']),1,'higher pair wins');
  });
  await check('validation-and-cli-contract',()=>{
    for(const bad of [null,'x',{},[],['Ah'],['Ah','Kh','Qh','Jh'],['Ah','Kh','Qh','Jh','Th','9h'],
      ['Ah','Ah','2c','3d','4s'],['Xh','2c','3d','4s','5h'],['Ax','2c','3d','4s','5h'],
      ['A','2c','3d','4s','5h'],['ah','2c','3d','4s','5h'],[null,'2c','3d','4s','5h'],new Array(5)])
      assert.throws(()=>ev(bad),Error,JSON.stringify(bad));
    assert.throws(()=>cmp(['Ah','Kh','Qh','Jh','Th'],['Ah','Ah','2c','3d','4s']),Error);
    const frozen=Object.freeze(['Ah','2c','3d','4s','5h']);
    assert.deepEqual(ev(frozen),{rank:4,category:'straight',tiebreak:[5]});
    assert.deepEqual(frozen,['Ah','2c','3d','4s','5h'],'input unchanged');
    const dir=fixture('poker-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      const hands=[['Ah','2c','3d','4s','5h'],['6h','5c','4d','3s','2h'],['6c','5h','4c','3c','2c']];
      fs.writeFileSync(file,JSON.stringify({hands,extra:true}));
      const r=cli(workspace,'poker-hand.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      const out=JSON.parse(r.stdout);
      assert.deepEqual(out.results.map(x=>x.category),['straight','straight','straight']);
      assert.deepEqual(out.best,[1,2],'an exact tie keeps both indices, ascending');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'poker-hand.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"hands":[]}','{"hands":"x"}','{"hands":[["Ah"]]}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'poker-hand.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
