import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const S={a:{type:'boolean',short:'a'},b:{type:'boolean',short:'b'},out:{type:'string',short:'o'},
  tag:{type:'string',multiple:true,short:'t'},verbose:{type:'boolean'}};
await grade('arg-parser',async check=>{
  const {parseArgs:parse}=await import(pathToFileURL(path.join(workspace,'arg-parser.js')));
  await check('long-options-and-value-forms',()=>{
    assert.deepEqual(parse(['--verbose'],S),{options:{verbose:true},positionals:[]});
    assert.deepEqual(parse(['--out=x'],S).options,{out:'x'});
    assert.deepEqual(parse(['--out','x'],S).options,{out:'x'});
    assert.deepEqual(parse(['--out='],S).options,{out:''},'the equals form accepts an empty value');
    assert.deepEqual(parse(['--out','-'],S).options,{out:'-'},'a lone dash is a value');
    assert.deepEqual(parse(['--no-verbose'],S).options,{verbose:false});
    assert.deepEqual(parse(['--tag','x','--tag','y'],S).options,{tag:['x','y']});
    assert.deepEqual(parse(['--tag=x'],S).options,{tag:['x']},'multiple always collects');
    for(const argv of [['--out'],['--out','--verbose'],['--nope'],['--verbose=1'],['--out','x','--out','y'],['--verbose','--verbose']])
      assert.throws(()=>parse(argv,S),Error,JSON.stringify(argv));
  });
  await check('short-options-and-bundling',()=>{
    assert.deepEqual(parse(['-a'],S).options,{a:true});
    assert.deepEqual(parse(['-ab'],S).options,{a:true,b:true},'booleans bundle');
    assert.deepEqual(parse(['-ox'],S).options,{out:'x'},'an inline short value');
    assert.deepEqual(parse(['-o','x'],S).options,{out:'x'});
    assert.deepEqual(parse(['-abox'],S).options,{a:true,b:true,out:'x'},'a string short ends a bundle');
    assert.deepEqual(parse(['-abo','x'],S).options,{a:true,b:true,out:'x'});
    assert.deepEqual(parse(['-t','x','-t','y'],S).options,{tag:['x','y']});
    for(const argv of [['-z'],['-az'],['-o'],['-o','-a'],['-a','-a']])
      assert.throws(()=>parse(argv,S),Error,JSON.stringify(argv));
  });
  await check('terminator-and-positionals',()=>{
    assert.deepEqual(parse(['x','y'],S),{options:{},positionals:['x','y']});
    assert.deepEqual(parse(['--','-a','--out'],S),{options:{},positionals:['-a','--out']});
    assert.deepEqual(parse(['-a','--','-b'],S),{options:{a:true},positionals:['-b']});
    assert.deepEqual(parse(['x','-a','y'],S),{options:{a:true},positionals:['x','y']},'interleaved');
    assert.deepEqual(parse(['-'],S),{options:{},positionals:['-']},'a lone dash is positional');
    assert.deepEqual(parse(['--','--'],S).positionals,['--'],'only the first terminator is special');
    assert.deepEqual(parse([],S),{options:{},positionals:[]});
  });
  await check('spec-validation-and-literal-keys',()=>{
    for(const spec of [null,'x',[],{'A':{type:'boolean'}},{'1a':{type:'boolean'}},{'-a':{type:'boolean'}},
      {a:null},{a:[]},{a:{}},{a:{type:'number'}},{a:{type:'boolean',short:'ab'}},{a:{type:'boolean',short:1}},
      {a:{type:'boolean',multiple:true}},{a:{type:'string',multiple:'yes'}},
      {a:{type:'boolean',short:'x'},b:{type:'boolean',short:'x'}}])
      assert.throws(()=>parse([],spec),Error,JSON.stringify(spec));
    const odd={constructor:{type:'string'},valueof:{type:'boolean'}};
    const got=parse(['--constructor=1','--valueof'],odd);
    assert.equal(got.options.constructor,'1','a literal key, not the inherited one');
    assert.equal(got.options.valueof,true);
    assert.equal(Object.keys(got.options).sort().join(','),'constructor,valueof');
    assert.deepEqual(Object.keys(parse([],odd).options),[],'nothing inherited leaks in');
    assert.equal(Object.prototype.hasOwnProperty.call(parse([],odd).options,'constructor'),false);
    // A collecting option whose name shadows an inherited member must still
    // start from an empty list rather than the inherited value.
    const collect={constructor:{type:'string',multiple:true}};
    assert.deepEqual(parse(['--constructor=a','--constructor=b'],collect).options,{constructor:['a','b']});
    assert.deepEqual(parse(['--constructor=a'],collect).options,{constructor:['a']});
    for(const reserved of ['__proto__','toString','Constructor'])
      assert.throws(()=>parse([],{[reserved]:{type:'boolean'}}),Error,reserved+' is not a legal option name');
    const argv=Object.freeze(['-a']),spec=Object.freeze({a:Object.freeze({type:'boolean',short:'a',extra:1})});
    assert.deepEqual(parse(argv,spec).options,{a:true});
    assert.deepEqual(argv,['-a']);
    for(const bad of [null,'x',{},[3],[null]])assert.throws(()=>parse(bad,S),Error,JSON.stringify(bad));
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('arg-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({argv:['-ab','--out=x','--','-z'],spec:S,extra:true}));
      const r=cli(workspace,'arg-parser.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({options:{a:true,b:true,out:'x'},positionals:['-z']})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'arg-parser.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"argv":"x","spec":{}}','{"argv":[],"spec":null}','{"argv":["--nope"],"spec":{}}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'arg-parser.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
