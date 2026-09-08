import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const plain=records=>({fields:null,records});
await grade('csv-record',async check=>{
  const {readRecords:read}=await import(pathToFileURL(path.join(workspace,'csv-record.js')));
  await check('quoting-escapes-and-embedded-delimiters',()=>{
    assert.deepEqual(read('a,"b,1"\r\nc,"d""e"'),plain([['a','b,1'],['c','d"e']]));
    assert.deepEqual(read('"a"'),plain([['a']]));
    assert.deepEqual(read('""'),plain([['']]),'an empty quoted field');
    assert.deepEqual(read('"""" '.trim()),plain([['"']]),'a doubled quote alone');
    assert.deepEqual(read('"a\nb"'),plain([['a\nb']]),'a newline inside quotes');
    assert.deepEqual(read('"a\r\nb"'),plain([['a\r\nb']]),'CRLF inside quotes is literal');
    assert.deepEqual(read(' a , b '),plain([[' a ',' b ']]),'spaces are ordinary');
    assert.deepEqual(read('a;b',{delimiter:';'}),plain([['a','b']]));
    assert.deepEqual(read('a,b',{delimiter:';'}),plain([['a,b']]));
    for(const bad of ['"a','a"b','a"b"','"a"b','"a"x,b'])assert.throws(()=>read(bad),Error,JSON.stringify(bad));
  });
  await check('line-endings-and-blank-records',()=>{
    assert.deepEqual(read(''),plain([]),'an empty text has no records');
    assert.deepEqual(read('a\nb'),plain([['a'],['b']]));
    assert.deepEqual(read('a\r\nb'),plain([['a'],['b']]));
    assert.deepEqual(read('a\n'),plain([['a']]),'a trailing newline adds no record');
    assert.deepEqual(read('a\r\n'),plain([['a']]));
    assert.deepEqual(read('a\n\nb'),plain([['a'],[''],['b']]),'a blank line is one empty field');
    assert.deepEqual(read('\n'),plain([['']]));
    assert.deepEqual(read(','),plain([['','']]));
    assert.deepEqual(read('a,,b'),plain([['a','','b']]));
    for(const bad of ['a\rb','a\r'])assert.throws(()=>read(bad),Error,JSON.stringify(bad));
  });
  await check('header-mode-and-field-names',()=>{
    assert.deepEqual(read('x,y\n1,2',{header:true}),{fields:['x','y'],records:[['1','2']]});
    assert.deepEqual(read('x,y',{header:true}),{fields:['x','y'],records:[]},'header only');
    assert.deepEqual(read('x,y\n',{header:true}),{fields:['x','y'],records:[]});
    assert.deepEqual(read('"a b",y\n1,2',{header:true}).fields,['a b','y']);
    assert.deepEqual(read('x,y\n1,2'),plain([['x','y'],['1','2']]),'header false keeps the first row');
    assert.throws(()=>read('',{header:true}),Error,'no header record');
    assert.throws(()=>read('x,x\n1,2',{header:true}),Error,'duplicate name');
    assert.throws(()=>read('x,\n1,2',{header:true}),Error,'empty name');
  });
  await check('ragged-records-and-validation',()=>{
    assert.throws(()=>read('a,b\nc'),Error,'short record');
    assert.throws(()=>read('a\nb,c'),Error,'long record');
    assert.throws(()=>read('a,b\nc,d\ne'),Error);
    for(const text of [null,3,{},[],undefined])assert.throws(()=>read(text),Error,JSON.stringify(text));
    for(const opts of [null,'x',[],{delimiter:''},{delimiter:'ab'},{delimiter:'"'},{delimiter:'\n'},{delimiter:'\r'},
      {delimiter:3},{header:'yes'},{header:1}])assert.throws(()=>read('a',opts),Error,JSON.stringify(opts));
    assert.deepEqual(read('a',Object.freeze({delimiter:';',header:false,extra:1})),plain([['a']]));
    assert.deepEqual(read('a,b'),plain([['a','b']]),'options may be omitted');
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('csv-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({text:'x,y\n1,"2,3"',options:{header:true},extra:true}));
      const r=cli(workspace,'csv-record.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({fields:['x','y'],records:[['1','2,3']]})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'csv-record.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"text":3}','{"text":"a","options":{"delimiter":"\\""}}','{"text":"a,b\\nc"}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'csv-record.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
