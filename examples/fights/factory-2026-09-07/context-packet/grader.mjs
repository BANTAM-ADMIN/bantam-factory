import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const s=(id,text,priority=0,required=false)=>({id,text,priority,required});
const frame=x=>'### '+JSON.stringify(x.id)+'\n'+x.text+'\n';
const bytes=x=>Buffer.byteLength(x,'utf8');
await grade('context-packet',async check=>{
  const {packContext:pack}=await import(pathToFileURL(path.join(workspace,'context-packet.js')));
  await check('required-sections-and-reservation',()=>{
    const input=[s('tempting','xxxxxxxx',99),s('late','must',0,true),s('first?','yes',100,true)];
    const text=frame(input[1])+frame(input[2]);
    assert.deepEqual(pack(input,bytes(text)),{text,bytes:bytes(text),included:['late','first?'],omitted:['tempting']});
    assert.throws(()=>pack(input,bytes(text)-1),Error);
    assert.deepEqual(pack([s('b','',0,true),s('a','',1,true)],100).included,['b','a']);
  });
  await check('utf8-framing-and-exact-budget',()=>{
    for(const item of [s('雪','é😀\r\n'),s('quote"\n\u0000','\n'),s('empty','')]){
      const text=frame(item),cost=bytes(text);
      assert.deepEqual(pack([item],cost),{text,bytes:cost,included:[item.id],omitted:[]});
      assert.deepEqual(pack([item],cost-1),{text:'',bytes:0,included:[],omitted:[item.id]});
    }
  });
  await check('optional-priority-skip-and-stable-ties',()=>{
    const input=[s('low','L',0),s('large','x'.repeat(200),99),s('z','Z',5),s('a','A',5),s('mid','M',3)];
    const text=frame(input[2])+frame(input[3])+frame(input[4]);
    assert.deepEqual(pack(input,bytes(text)),{text,bytes:bytes(text),included:['z','a','mid'],omitted:['low','large']});
    assert.deepEqual(pack([s('z','',1),s('a','',1)],100).included,['z','a']);
  });
  await check('validation-opaque-identities-and-immutability',()=>{
    for(const input of [null,{},new Array(1),[null],[[]],[s('','x')],[s('a','x'),s('a','y')],
      [{...s('a','x'),text:4}],[{...s('a','x'),priority:'1'}],[{...s('a','x'),priority:-1}],
      [{...s('a','x'),priority:1.5}],[{...s('a','x'),priority:Number.MAX_SAFE_INTEGER+1}],
      [{...s('a','x'),required:0}],[{id:'a',text:'x',priority:0}]])assert.throws(()=>pack(input,0),Error);
    for(const budget of [-1,1.5,'4',null,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>pack([],budget),Error);
    const input=[s('__proto__','one',1),s('constructor','two',1),{...s('\u0000','three',0,true),extra:7}];
    const before=JSON.stringify(input);input.forEach(Object.freeze);Object.freeze(input);
    assert.deepEqual(pack(input,1000).included,['\u0000','__proto__','constructor']);
    assert.equal(JSON.stringify(input),before);
    assert.deepEqual(pack([],0),{text:'',bytes:0,included:[],omitted:[]});
  });
  await check('cli-json-and-errors',()=>{
    const dir=fixture('context-packet-grade-');
    try{
      const file=path.join(dir,'input with spaces.json'),input={sections:[s('cli','value',0,true)],maxBytes:100};
      fs.writeFileSync(file,JSON.stringify(input));
      const good=cli(workspace,'context-packet.js',[file]);
      assert.equal(good.status,0,good.stderr);assert.equal(good.stderr,'');assert.ok(good.stdout.endsWith('\n'));
      assert.deepEqual(JSON.parse(good.stdout),{text:'### "cli"\nvalue\n',bytes:16,included:['cli'],omitted:[]});
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){const bad=cli(workspace,'context-packet.js',args);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());}
      for(const invalid of ['{','null',JSON.stringify({sections:input.sections,maxBytes:0})]){fs.writeFileSync(file,invalid);const bad=cli(workspace,'context-packet.js',[file]);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
