import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const hit=(value,depth)=>({found:true,value,depth,reason:null});
const miss=(depth,reason)=>({found:false,value:null,depth,reason});
await grade('json-pointer',async check=>{
  const {resolvePointer:resolve}=await import(pathToFileURL(path.join(workspace,'json-pointer.js')));
  await check('token-escaping-and-whole-document',()=>{
    const doc={'a/b':1,'m~n':2,'':3,'~1':4};
    assert.deepEqual(resolve(doc,''),hit(doc,0),'empty pointer is the document');
    assert.deepEqual(resolve(doc,'/a~1b'),hit(1,1));
    assert.deepEqual(resolve(doc,'/m~0n'),hit(2,1));
    assert.deepEqual(resolve(doc,'/'),hit(3,1),'empty token is the empty key');
    assert.deepEqual(resolve(doc,'/~01'),hit(4,1),'~01 decodes to ~1');
    assert.deepEqual(resolve(42,''),hit(42,0));
    assert.deepEqual(resolve(null,''),hit(null,0));
  });
  await check('object-keys-and-own-property-discipline',()=>{
    assert.deepEqual(resolve({a:{b:{c:7}}},'/a/b/c'),hit(7,3));
    assert.deepEqual(resolve({a:1},'/b'),miss(0,'missing-key'));
    for(const key of ['constructor','__proto__','toString','hasOwnProperty','valueOf'])
      assert.deepEqual(resolve({x:1},'/'+key),miss(0,'missing-key'),key+' is not inherited');
    assert.deepEqual(resolve({constructor:9},'/constructor'),hit(9,1),'an own key of that name resolves');
    assert.deepEqual(resolve({a:{b:1}},'/a/b/c'),miss(2,'not-a-container'));
    assert.deepEqual(resolve({a:null},'/a/b'),miss(1,'not-a-container'),'null is not a container');
    assert.deepEqual(resolve({a:'str'},'/a/0'),miss(1,'not-a-container'),'a string is not a container');
    assert.deepEqual(resolve({a:undefined},'/a'),hit(undefined,1));
  });
  await check('array-indices-and-canonical-form',()=>{
    const doc={a:[10,20,30]};
    assert.deepEqual(resolve(doc,'/a/0'),hit(10,2));
    assert.deepEqual(resolve(doc,'/a/2'),hit(30,2));
    assert.deepEqual(resolve(doc,'/a/3'),miss(1,'index-out-of-range'));
    assert.deepEqual(resolve(doc,'/a/-'),miss(1,'index-out-of-range'),'dash never resolves');
    for(const bad of ['01','+1','1.0',' 1','1 ','','-1','0x1','1e0'])
      assert.deepEqual(resolve(doc,'/a/'+bad),miss(1,'invalid-index'),JSON.stringify(bad));
    assert.deepEqual(resolve({a:[]},'/a/0'),miss(1,'index-out-of-range'));
    assert.deepEqual(resolve({a:[[5]]},'/a/0/0'),hit(5,3));
    assert.deepEqual(resolve({a:['x']},'/a/length'),miss(1,'invalid-index'),'length is not an index');
  });
  await check('miss-receipts-and-depth',()=>{
    assert.deepEqual(resolve({a:{b:[{c:1}]}},'/a/b/0/c'),hit(1,4));
    assert.deepEqual(resolve({a:{b:[{c:1}]}},'/a/b/0/d'),miss(3,'missing-key'));
    assert.deepEqual(resolve({a:{b:[{c:1}]}},'/a/b/9/c'),miss(2,'index-out-of-range'));
    assert.deepEqual(resolve({a:{b:[{c:1}]}},'/a/z/0/c'),miss(1,'missing-key'));
    assert.deepEqual(resolve({a:1},'/a/b/c'),miss(1,'not-a-container'),'stops at the first failure');
    const nested={a:{b:1}};
    const out=resolve(nested,'/a');
    assert.equal(out.value,nested.a,'returns the referenced value itself');
    out.value.b=2;assert.equal(nested.a.b,2,'not a copy');
    assert.deepEqual(Object.keys(resolve({},'')),['found','value','depth','reason']);
  });
  await check('validation-and-cli-contract',()=>{
    for(const bad of [null,3,{},[],'a','a/b','~','/~','/~2','/a~','/x/~3y'])
      assert.throws(()=>resolve({a:1},bad),Error,JSON.stringify(bad));
    const dir=fixture('pointer-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({document:{a:[{b:1}]},pointer:'/a/0/b',extra:true}));
      const r=cli(workspace,'json-pointer.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify(hit(1,3))+'\n');
      fs.writeFileSync(file,JSON.stringify({document:{a:1},pointer:'/zz'}));
      const m=cli(workspace,'json-pointer.js',[file]);assert.equal(m.status,0,m.stderr);
      assert.equal(m.stdout,JSON.stringify(miss(0,'missing-key'))+'\n','a miss still exits 0');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'json-pointer.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"pointer":"/a"}','{"document":{},"pointer":"a"}','{"document":{},"pointer":3}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'json-pointer.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
