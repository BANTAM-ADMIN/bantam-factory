import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const R=(inside,resolved,relative)=>({inside,resolved,relative});
await grade('path-scope',async check=>{
  const mod=await import(pathToFileURL(path.join(workspace,'path-scope.js')));
  const {resolveWithin:within,normalizeSegments:norm}=mod;
  await check('preserved-helper-and-normalization',()=>{
    assert.deepEqual(norm('/a//b/./c'),['a','b','c']);
    assert.deepEqual(norm('a/../../b'),['b']);
    assert.deepEqual(norm(''),[]);
    assert.deepEqual(norm('/'),[]);
    assert.deepEqual(norm('a/b/..'),['a']);
    assert.throws(()=>norm(null),Error);
    assert.deepEqual(within('/a/b','/a/b'),R(true,'/a/b',''));
    assert.deepEqual(within('/a/b','/a/b/'),R(true,'/a/b',''));
    assert.deepEqual(within('/a//b/','c//d'),R(true,'/a/b/c/d','c/d'));
    assert.deepEqual(within('/','x/y'),R(true,'/x/y','x/y'));
    assert.deepEqual(within('/','/'),R(true,'/',''));
  });
  await check('traversal-and-root-clamping',()=>{
    assert.deepEqual(within('/a/b','../c'),R(false,'/a/c',null));
    assert.deepEqual(within('/a/b','x/../y'),R(true,'/a/b/y','y'));
    assert.deepEqual(within('/a/b','/a/b/../../c'),R(false,'/c',null));
    assert.deepEqual(within('/a/b','../b/c'),R(true,'/a/b/c','c'));
    assert.deepEqual(within('/a/b','/a/../../../x'),R(false,'/x',null));
    assert.deepEqual(within('/a/b','..'),R(false,'/a',null));
    assert.deepEqual(within('/a/b','.'),R(true,'/a/b',''));
    assert.deepEqual(within('/','../../..'),R(true,'/',''));
  });
  await check('prefix-collisions-and-boundaries',()=>{
    assert.deepEqual(within('/a/b','/a/bc'),R(false,'/a/bc',null));
    assert.deepEqual(within('/a/b','/a/bc/d'),R(false,'/a/bc/d',null));
    assert.deepEqual(within('/a/b','/a/b2'),R(false,'/a/b2',null));
    assert.deepEqual(within('/srv/ws','/srv/wsx'),R(false,'/srv/wsx',null));
    assert.deepEqual(within('/a/b','/a/b/c'),R(true,'/a/b/c','c'));
    assert.deepEqual(within('/a/b','/a'),R(false,'/a',null));
    assert.deepEqual(within('/ab','/ab/c'),R(true,'/ab/c','c'));
  });
  await check('hostile-names-and-relative-receipts',()=>{
    assert.deepEqual(within('/a/b','..foo'),R(true,'/a/b/..foo','..foo'));
    assert.deepEqual(within('/a/b','...'),R(true,'/a/b/...','...'));
    assert.deepEqual(within('/a/b','.hidden/x'),R(true,'/a/b/.hidden/x','.hidden/x'));
    assert.deepEqual(within('/a/b','c\\d'),R(true,'/a/b/c\\d','c\\d'));
    assert.deepEqual(within('/a/b','\\..\\..'),R(true,'/a/b/\\..\\..','\\..\\..'));
    assert.deepEqual(within('/a/b','雪/😀'),R(true,'/a/b/雪/😀','雪/😀'));
    assert.deepEqual(within('/a/b','__proto__/x'),R(true,'/a/b/__proto__/x','__proto__/x'));
    assert.deepEqual(within('/a/b','deep/nest/leaf'),R(true,'/a/b/deep/nest/leaf','deep/nest/leaf'));
  });
  await check('validation-and-cli-contract',()=>{
    for(const root of [null,3,{},[],'','relative','a/b'])assert.throws(()=>within(root,'x'),Error,JSON.stringify(root));
    for(const candidate of [null,3,{},[],''])assert.throws(()=>within('/a',candidate),Error,JSON.stringify(candidate));
    assert.throws(()=>within('/a\u0000b','x'),Error);
    assert.throws(()=>within('/a','x\u0000y'),Error);
    assert.deepEqual(within('/a b','c d'),{inside:true,resolved:'/a b/c d',relative:'c d'},'ordinary spaces are legal');
    const frozen=Object.freeze({root:'/a/b',candidate:'c'});
    assert.deepEqual(within(frozen.root,frozen.candidate),R(true,'/a/b/c','c'));
    const dir=fixture('scope-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({root:'/srv/ws',candidate:'../ws/sub/../file.txt',extra:true}));
      const r=cli(workspace,'path-scope.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify(R(true,'/srv/ws/file.txt','file.txt'))+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'path-scope.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"root":"rel","candidate":"x"}','{"root":"/a"}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'path-scope.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
