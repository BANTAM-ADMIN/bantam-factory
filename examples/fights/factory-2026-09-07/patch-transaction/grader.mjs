import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const edit=(start,end,before,after)=>({start,end,before,after});
await grade('patch-transaction',async check=>{
  const {applyEdit:one,applyTransaction:batch}=await import(pathToFileURL(path.join(workspace,'patch-transaction.js')));
  await check('preserve-single-edit-api',()=>{
    assert.equal(one('abc',edit(0,0,'','!')),'!abc');
    assert.equal(one('abc',edit(3,3,'','!')),'abc!');
    assert.equal(one('a\r\nb',edit(1,3,'\r\n','\n')),'a\nb');
    assert.throws(()=>one('abc',edit(0,1,'x','q')),Error);
    for(const x of [null,[],edit(-1,1,'a','x'),edit(0,4,'abc',''),edit(1,0,'','')])assert.throws(()=>one('abc',x),Error);
  });
  await check('original-coordinates-and-order-independence',()=>{
    const source='alpha beta gamma\r\n',edits=[edit(0,5,'alpha','A'),edit(11,16,'gamma','longer replacement'),edit(6,10,'beta','')];
    const expected={text:'A  longer replacement\r\n',applied:3};
    assert.deepEqual(batch(source,edits),expected);
    assert.deepEqual(batch(source,[edits[2],edits[0],edits[1]]),expected);
    assert.deepEqual(batch('abcdef',[edit(0,2,'ab','X'),edit(2,4,'cd','Y'),edit(4,6,'ef','Z')]),{text:'XYZ',applied:3});
    assert.deepEqual(batch('abc',[edit(3,3,'','!'),edit(0,0,'','?')]),{text:'?abc!',applied:2});
  });
  await check('conflicts-and-atomic-preconditions',()=>{
    const bad=[
      [edit(0,3,'abc','x'),edit(2,4,'cd','y')],
      [edit(1,1,'','a'),edit(1,1,'','b')],
      [edit(1,3,'bc','a'),edit(1,1,'','b')],
      [edit(1,3,'bc','a'),edit(3,3,'','b')],
      [edit(0,4,'abcd','a'),edit(2,2,'','b')],
      [edit(0,1,'a','q'),edit(2,3,'wrong','q')],
      [edit(2,2,'',''),edit(2,2,'','')],
    ];
    for(const pair of bad)for(const edits of [pair,[...pair].reverse()]){
      const before=JSON.stringify(edits);assert.throws(()=>batch('abcd',edits),Error);assert.equal(JSON.stringify(edits),before);
    }
    assert.deepEqual(batch('abcd',[edit(0,1,'a','A'),edit(3,3,'','!')]),{text:'Abc!d',applied:2});
  });
  await check('validation-unicode-and-immutability',()=>{
    for(const [source,edits]of [[null,[]],['x',null],['x',{}],['x',[null]],['x',[[]]],
      ['x',[edit(0.5,1,'x','')]],['x',[edit(0,1,'x',3)]],['x',[edit('0',1,'x','')]],
      ['x',[edit(0,Number.MAX_SAFE_INTEGER+1,'x','')]],['x',[{start:0,end:1,after:''}]]])assert.throws(()=>batch(source,edits),Error);
    const input=[{...edit(1,3,'😀','雪'),extra:'ignored'},edit(5,5,'','!')];
    const before=JSON.stringify(input);input.forEach(Object.freeze);Object.freeze(input);
    assert.deepEqual(batch('a😀b\n',input),{text:'a雪b\n!',applied:2});assert.equal(JSON.stringify(input),before);
    assert.deepEqual(batch('',[]),{text:'',applied:0});
    assert.deepEqual(batch('',[edit(0,0,'','')]),{text:'',applied:1});
    assert.deepEqual(batch('last line',[]),{text:'last line',applied:0});
  });
  await check('cli-transaction-and-errors',()=>{
    const dir=fixture('patch-transaction-grade-');
    try{
      const file=path.join(dir,'patch input.json');
      fs.writeFileSync(file,JSON.stringify({source:'abc',edits:[edit(1,2,'b','LONG')]}));
      const good=cli(workspace,'patch-transaction.js',[file]);
      assert.equal(good.status,0,good.stderr);assert.equal(good.stderr,'');assert.ok(good.stdout.endsWith('\n'));
      assert.deepEqual(JSON.parse(good.stdout),{text:'aLONGc',applied:1});
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){const bad=cli(workspace,'patch-transaction.js',args);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());}
      for(const input of ['{','null',JSON.stringify({source:'abc',edits:[edit(0,1,'wrong','')]})]){fs.writeFileSync(file,input);const bad=cli(workspace,'patch-transaction.js',[file]);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
