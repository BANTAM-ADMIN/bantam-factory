import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const base={attempt:1,elapsedMs:0,baseMs:7,maxDelayMs:50,budgetMs:1000,retryAfterMs:null,retryable:true};
const yes=delayMs=>({retry:true,delayMs,reason:'scheduled'}),no=reason=>({retry:false,delayMs:null,reason});
await grade('retry-budget',async check=>{
  const {nextRetry:next}=await import(pathToFileURL(path.join(workspace,'retry-budget.js')));
  await check('exponential-backoff-and-cap',()=>{
    for(const [attempt,delay]of [[1,7],[2,14],[3,28],[4,50],[20,50]])assert.deepEqual(next({...base,attempt}),yes(delay));
    assert.deepEqual(next({...base,baseMs:100,maxDelayMs:20}),yes(20));
    assert.deepEqual(next({...base,retryable:false,elapsedMs:2000}),no('non-retryable'));
  });
  await check('retry-hints-and-budget-boundaries',()=>{
    assert.deepEqual(next({...base,retryAfterMs:80}),yes(80));
    assert.deepEqual(next({...base,retryAfterMs:2}),yes(7));
    assert.deepEqual(next({...base,elapsedMs:993}),yes(7));
    assert.deepEqual(next({...base,elapsedMs:994}),no('budget-exhausted'));
    assert.deepEqual(next({...base,elapsedMs:1001,baseMs:0}),no('budget-exhausted'));
    assert.deepEqual(next({...base,budgetMs:79,retryAfterMs:80}),no('budget-exhausted'));
  });
  await check('huge-attempts-zero-and-safe-arithmetic',()=>{
    const max=Number.MAX_SAFE_INTEGER;
    assert.deepEqual(next({...base,attempt:max}),yes(50));
    assert.deepEqual(next({...base,attempt:max,baseMs:0,budgetMs:0}),yes(0));
    assert.deepEqual(next({...base,attempt:max,maxDelayMs:0,budgetMs:0}),yes(0));
    assert.deepEqual(next({...base,baseMs:max,maxDelayMs:max,budgetMs:max}),yes(max));
    assert.deepEqual(next({...base,elapsedMs:max,budgetMs:max,baseMs:1}),no('budget-exhausted'));
    assert.deepEqual(next({...base,elapsedMs:max,budgetMs:max,baseMs:0}),yes(0));
    assert.deepEqual(next({...base,attempt:53,baseMs:1,maxDelayMs:max,budgetMs:max}),yes(2**52));
  });
  await check('validation-and-immutability',()=>{
    for(const o of [null,[],3,{},'x'])assert.throws(()=>next(o),Error);
    for(const key of Object.keys(base)){
      const missing={...base};delete missing[key];assert.throws(()=>next(missing),Error);
    }
    for(const key of ['attempt','elapsedMs','baseMs','maxDelayMs','budgetMs','retryAfterMs'])for(const value of [-1,1.5,'2',Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>next({...base,[key]:value,retryable:false}),Error);
    assert.throws(()=>next({...base,attempt:0}),Error);assert.throws(()=>next({...base,retryable:1}),Error);
    assert.deepEqual(next(Object.freeze({...base,extra:'ignored'})),yes(7));
  });
  await check('cli-and-error-contract',()=>{
    const dir=fixture('retry-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      for(const [input,expected]of [[base,yes(7)],[{...base,retryable:false},no('non-retryable')],[{...base,budgetMs:0},no('budget-exhausted')]]){
        fs.writeFileSync(file,JSON.stringify(input));const r=cli(workspace,'retry-budget.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.equal(r.stdout,JSON.stringify(expected)+'\n');
      }
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){const r=cli(workspace,'retry-budget.js',args);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.ok(r.stderr.trim());}
      for(const input of ['{','null','[]','{}']){fs.writeFileSync(file,input);const r=cli(workspace,'retry-budget.js',[file]);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.ok(r.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
