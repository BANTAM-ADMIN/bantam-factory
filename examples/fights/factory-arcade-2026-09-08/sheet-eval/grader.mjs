import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
await grade('sheet-eval',async check=>{
  const {evaluateSheet:evaluate}=await import(pathToFileURL(path.join(workspace,'sheet-eval.js')));
  const val=(cells,ref)=>evaluate(cells).values[ref];
  await check('arithmetic-precedence-and-references',()=>{
    assert.equal(val({A1:'=2+3*4'},'A1'),14);
    assert.equal(val({A1:'=(2+3)*4'},'A1'),20);
    assert.equal(val({A1:'=10-2-3'},'A1'),5,'subtraction is left associative');
    assert.equal(val({A1:'=100/5/2'},'A1'),10,'division is left associative');
    assert.equal(val({A1:'=-5+2'},'A1'),-3,'a unary minus');
    assert.equal(val({A1:'= 2 + 3 '},'A1'),5,'whitespace is insignificant');
    assert.equal(val({A1:1,B1:'=A1+1'},'B1'),2);
    assert.equal(val({A1:'=ZZ9+7'},'A1'),7,'an absent cell reads as zero');
    assert.equal(val({A1:2.5,B1:'=A1*2'},'B1'),5);
    assert.deepEqual(evaluate({A1:1,B1:2}).values,{A1:1,B1:2});
    assert.deepEqual(evaluate({}),{values:{},errors:{},order:[]});
  });
  await check('cycle-detection-without-recursion',()=>{
    assert.deepEqual(evaluate({A1:'=B1+1',B1:'=A1'}),{values:{},errors:{A1:'cycle',B1:'cycle'},order:[]});
    assert.deepEqual(evaluate({A1:'=A1'}).errors,{A1:'cycle'},'a self reference is a cycle');
    assert.deepEqual(evaluate({A1:'=B1',B1:'=C1',C1:'=A1'}).errors,
      {A1:'cycle',B1:'cycle',C1:'cycle'},'every member of the loop is at fault');
    const mixed=evaluate({A1:'=B1',B1:'=A1',C1:5});
    assert.equal(mixed.values.C1,5,'an unrelated cell still evaluates');
    assert.deepEqual(mixed.errors,{A1:'cycle',B1:'cycle'});
    const feeder=evaluate({X1:'=A1+1',A1:'=B1',B1:'=A1'});
    assert.equal(feeder.errors.A1,'cycle');
    assert.equal(feeder.errors.B1,'cycle');
    assert.equal(feeder.errors.X1,'depends-on-error','a cell feeding off a cycle is not itself a cycle');
  });
  await check('error-kinds-and-propagation',()=>{
    assert.deepEqual(evaluate({A1:'=1/0'}).errors,{A1:'divide-by-zero'});
    assert.deepEqual(evaluate({A1:'=1/0',B1:'=A1+1'}).errors,{A1:'divide-by-zero',B1:'depends-on-error'});
    assert.deepEqual(evaluate({A1:'=1+'}).errors,{A1:'parse'});
    assert.deepEqual(evaluate({A1:'=1+',B1:'=A1'}).errors,{A1:'parse',B1:'depends-on-error'});
    assert.deepEqual(evaluate({A1:'=2+*3'}).errors,{A1:'parse'});
    assert.deepEqual(evaluate({A1:'=(1+2'}).errors,{A1:'parse'});
    assert.deepEqual(evaluate({A1:'=1 2'}).errors,{A1:'parse'});
    assert.equal(evaluate({A1:'=0/1'}).values.A1,0,'dividing zero is fine');
    const chain=evaluate({A1:'=1/0',B1:'=A1',C1:'=B1'});
    assert.equal(chain.errors.C1,'depends-on-error','the failure travels along the chain');
    assert.equal(Object.keys(chain.values).length,0);
    const partial=evaluate({A1:'=1/0',B1:7});
    assert.deepEqual(partial.values,{B1:7},'one bad cell does not abort the sheet');
  });
  await check('resolution-order-and-deep-chains',()=>{
    const out=evaluate({C1:'=B1+1',B1:'=A1+1',A1:1});
    assert.deepEqual(out.values,{A1:1,B1:2,C1:3});
    assert.deepEqual(out.order,['A1','B1','C1'],'dependencies resolve before dependents');
    for(let i=1;i<out.order.length;i++)assert.ok(out.order.indexOf('A1')<out.order.indexOf('C1'));
    const deep={};
    for(let i=1;i<=400;i++)deep['A'+i]=i===1?1:`=A${i-1}+1`;
    const long=evaluate(deep);
    assert.equal(long.values.A400,400,'a four-hundred cell chain resolves');
    assert.equal(Object.keys(long.errors).length,0);
    assert.equal(long.order.length,400);
    assert.equal(long.order[0],'A1');
    assert.equal(long.order[399],'A400');
    const wide={A1:1};
    for(let i=2;i<=50;i++)wide['B'+i]='=A1+1';
    assert.equal(evaluate(wide).order.length,50);
  });
  await check('validation-and-cli-contract',()=>{
    for(const bad of [null,'x',[],3,{a1:1},{A0:1},{'A1000':1},{A1:true},{A1:null},{A1:'A2'},
      {A1:NaN},{A1:Infinity},{A1:[]},{'1A':1}])
      assert.throws(()=>evaluate(bad),Error,JSON.stringify(bad));
    const frozen=Object.freeze({A1:1,B1:'=A1+1'});
    assert.deepEqual(evaluate(frozen).values,{A1:1,B1:2});
    assert.deepEqual(frozen,{A1:1,B1:'=A1+1'},'input unchanged');
    const dir=fixture('sheet-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({cells:{A1:'=B1+1',B1:'=A1'},extra:true}));
      const r=cli(workspace,'sheet-eval.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      const out=JSON.parse(r.stdout);
      assert.deepEqual(out.errors,{A1:'cycle',B1:'cycle'});
      assert.deepEqual(out.values,{});
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'sheet-eval.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"cells":"x"}','{"cells":{"a1":1}}','{"cells":{"A1":true}}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'sheet-eval.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
