import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const rule=(id,literal,replacement)=>({id,literal,replacement});
const expected=(original,text,edits)=>({text,edits,originalBytes:Buffer.byteLength(original),redactedBytes:Buffer.byteLength(text)});
await grade('redaction-plan',async check=>{
  const {planRedactions:plan}=await import(pathToFileURL(path.join(workspace,'redaction-plan.js')));
  await check('literal-matching-and-edit-receipts',()=>{
    assert.deepEqual(plan('a.b aXb a.b',[rule('dot','a.b','Z')]),expected('a.b aXb a.b','Z aXb Z',[{start:0,end:3,id:'dot'},{start:8,end:11,id:'dot'}]));
    assert.deepEqual(plan('x\nx',[rule('x','x','')]),expected('x\nx','\n',[{start:0,end:1,id:'x'},{start:2,end:3,id:'x'}]));
    assert.deepEqual(plan('untouched',[]),expected('untouched','untouched',[]));
    assert.deepEqual(plan('',[rule('a','not found','')]),expected('','',[]));
  });
  await check('overlap-priority-and-single-pass',()=>{
    assert.deepEqual(plan('ababa',[rule('short','ab','S'),rule('long','aba','L'),rule('tail','ba','T')]),expected('ababa','LT',[{start:0,end:3,id:'long'},{start:3,end:5,id:'tail'}]));
    assert.deepEqual(plan('aaaaa',[rule('first','aa','a'),rule('second','aa','Z')]),expected('aaaaa','aaa',[{start:0,end:2,id:'first'},{start:2,end:4,id:'first'}]));
    assert.equal(plan('x',[rule('x','x','y'),rule('y','y','z')]).text,'y');
    assert.equal(plan('abcde',[rule('early','ab','E'),rule('later','bcde','L')]).text,'Ecde');
  });
  await check('unicode-bytes-and-opaque-identities',()=>{
    const text='雪😀\r\n雪';
    assert.deepEqual(plan(text,[rule('__proto__','雪','é'),rule('constructor','😀','X')]),expected(text,'éX\r\né',[
      {start:0,end:1,id:'__proto__'},{start:1,end:3,id:'constructor'},{start:5,end:6,id:'__proto__'}]));
    assert.deepEqual(plan('\u0000*',[rule('\u0000','*','雪')]),expected('\u0000*','\u0000雪',[{start:1,end:2,id:'\u0000'}]));
  });
  await check('validation-and-immutability',()=>{
    for(const text of [null,4,{},[]])assert.throws(()=>plan(text,[]),Error);
    for(const rules of [null,{},new Array(1),[null],[[]],[{}],[rule('','x','')],[rule('x','','')],[rule('x',3,'')],[rule('x','x',null)],
      [rule('x','x','a'),rule('x','y','b')]])assert.throws(()=>plan('',rules),Error);
    const rules=Object.freeze([Object.freeze({...rule('x','x','Y'),extra:1})]);
    assert.deepEqual(plan('x',rules),expected('x','Y',[{start:0,end:1,id:'x'}]));
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('redaction-grade-');try{
      const file=path.join(dir,'input with spaces.json');fs.writeFileSync(file,JSON.stringify({text:'ABAB',rules:[rule('a','AB','X')],extra:true}));
      const r=cli(workspace,'redaction-plan.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify(expected('ABAB','XX',[{start:0,end:2,id:'a'},{start:2,end:4,id:'a'}]))+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){const b=cli(workspace,'redaction-plan.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"text":"x","rules":[{}]}']){fs.writeFileSync(file,input);const b=cli(workspace,'redaction-plan.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
