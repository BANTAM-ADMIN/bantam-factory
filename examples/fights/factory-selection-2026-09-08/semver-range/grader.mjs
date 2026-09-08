import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
await grade('semver-range',async check=>{
  const {compareVersions:cmp,satisfies:sat}=await import(pathToFileURL(path.join(workspace,'semver-range.js')));
  const order=(a,b)=>{assert.equal(cmp(a,b),-1,`${a} < ${b}`);assert.equal(cmp(b,a),1,`${b} > ${a}`);};
  const same=(a,b)=>{assert.equal(cmp(a,b),0,`${a} == ${b}`);assert.equal(cmp(b,a),0,`${b} == ${a}`);};
  await check('core-precedence-and-build-metadata',()=>{
    order('1.0.0','2.0.0');order('2.0.0','2.1.0');order('2.1.0','2.1.1');
    order('1.9.0','1.10.0');order('1.0.9','1.0.10');
    same('1.0.0','1.0.0');same('1.0.0+a','1.0.0+b');same('1.0.0+build.1','1.0.0');
    same('1.0.0-rc.1+a','1.0.0-rc.1+z');
    order('1.0.0-rc+z','1.0.0+a');
    assert.equal(cmp('0.0.0','0.0.0'),0);
  });
  await check('prerelease-ordering-rules',()=>{
    order('1.0.0-alpha','1.0.0');
    order('1.0.0-alpha','1.0.0-alpha.1');
    order('1.0.0-alpha.1','1.0.0-alpha.beta');
    order('1.0.0-alpha.beta','1.0.0-beta');
    order('1.0.0-beta','1.0.0-beta.2');
    order('1.0.0-beta.2','1.0.0-beta.11');
    order('1.0.0-beta.11','1.0.0-rc.1');
    order('1.0.0-9','1.0.0-10');
    order('1.0.0-2','1.0.0-11');
    order('1.0.0-1','1.0.0-a');
    order('1.0.0-A','1.0.0-a');
    same('1.0.0-a.b','1.0.0-a.b');
  });
  await check('comparator-sets-and-unions',()=>{
    assert.equal(sat('1.2.3','>=1.0.0 <2.0.0'),true);
    assert.equal(sat('2.0.0','>=1.0.0 <2.0.0'),false);
    assert.equal(sat('1.0.0','>=1.0.0 <2.0.0'),true);
    assert.equal(sat('1.0.0','1.0.0'),true);
    assert.equal(sat('1.0.0','=1.0.0'),true);
    assert.equal(sat('1.0.1','1.0.0'),false);
    assert.equal(sat('1.0.0+meta','1.0.0'),true);
    assert.equal(sat('3.0.0','<1.0.0 || >=3.0.0'),true);
    assert.equal(sat('2.0.0','<1.0.0 || >=3.0.0'),false);
    assert.equal(sat('0.9.0','<1.0.0 || >=3.0.0'),true);
    assert.equal(sat('1.5.0','>1.0.0 <=1.5.0'),true);
    assert.equal(sat('1.5.1','>1.0.0 <=1.5.0'),false);
    assert.equal(sat('1.0.0','>1.0.0'),false);
  });
  await check('prerelease-range-admission',()=>{
    assert.equal(sat('1.2.3-rc.1','>=1.0.0 <2.0.0'),false);
    assert.equal(sat('1.2.3-rc.1','>=1.2.3-rc.0 <2.0.0'),true);
    assert.equal(sat('1.2.3-rc.1','>=1.0.0-rc.0 <2.0.0'),false);
    assert.equal(sat('1.2.3-rc.0','>=1.2.3-rc.1 <2.0.0'),false);
    assert.equal(sat('1.2.3','>=1.2.3-rc.0 <2.0.0'),true);
    assert.equal(sat('1.2.3-rc.1','=1.2.3-rc.1'),true);
    assert.equal(sat('1.2.3-rc.1','>=1.0.0 <2.0.0 || >=1.2.3-rc.0 <1.2.4'),true);
    assert.equal(sat('1.2.3-rc.1','>=1.0.0 <2.0.0 || >=9.0.0'),false);
  });
  await check('validation-and-cli-contract',()=>{
    for(const bad of ['','1','1.2','1.2.3.4','01.2.3','1.02.3','v1.2.3','1.2.3-','1.2.3+','1.2.3-01','1.2.3-a..b','1.2.3-a_b','1.2.3+a..b',' 1.2.3',null,3,{}])
      assert.throws(()=>cmp(bad,'1.0.0'),Error,JSON.stringify(bad));
    for(const bad of [null,3,{},'','>=1.0.0 ||','|| >=1.0.0','>=notaversion'])
      assert.throws(()=>sat('1.0.0',bad),Error,JSON.stringify(bad));
    assert.equal(cmp('1.2.3-a-b','1.2.3-a-b'),0);
    const dir=fixture('semver-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      const versions=['2.0.0','1.0.0-rc.1','1.0.0','1.0.0-rc.10','1.0.0-rc.2'];
      fs.writeFileSync(file,JSON.stringify({versions,range:'>=1.0.0-rc.0 <2.0.0',extra:true}));
      const r=cli(workspace,'semver-range.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      const sorted=['1.0.0-rc.1','1.0.0-rc.2','1.0.0-rc.10','1.0.0','2.0.0'];
      assert.equal(r.stdout,JSON.stringify({sorted,satisfying:['1.0.0-rc.1','1.0.0-rc.2','1.0.0-rc.10','1.0.0']})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'semver-range.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"versions":"x","range":"1.0.0"}','{"versions":["nope"],"range":"1.0.0"}','{"versions":[],"range":"bad range"}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'semver-range.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
