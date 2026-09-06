import { pathToFileURL } from 'node:url';
import { assert, fs, path, fixture, cli, grade } from '../grader-support.mjs';
const workspace = path.resolve(process.argv[2]);
const lines = events => events.map(event => JSON.stringify(event)).join('\r\n');
const event = (id, job, attempt, seq, type = 'started') => ({id,job,attempt,seq,type});
await grade('receipt-reducer', async check => {
  const { reduceEvents: reduce } = await import(pathToFileURL(path.join(workspace,'receipt-report.js')));
  await check('ordering-and-independent-attempts', () => {
    assert.deepEqual(reduce(lines([
      event('b-end','b',12,90,'failed'), event('a-start','Z',1,2), event('b-start','b',12,1),
      event('b-second','b',2,1), event('z','a',1,2),
    ])), {jobs:[
      {job:'Z',attempts:[{attempt:1,status:'running',startedSeq:2,finishedSeq:null}]},
      {job:'a',attempts:[{attempt:1,status:'running',startedSeq:2,finishedSeq:null}]},
      {job:'b',attempts:[{attempt:2,status:'running',startedSeq:1,finishedSeq:null},{attempt:12,status:'failed',startedSeq:1,finishedSeq:90}]},
    ],duplicates:0});
  });
  await check('deduplication-and-opaque-identities', () => {
    const start = event('__proto__','job\t雪\n',7,0), end = event('constructor','job\t雪\n',7,1,'succeeded');
    assert.deepEqual(reduce('\n \r\n' + lines([end,start,{...start,note:'ignored'},end,start])), {
      jobs:[{job:'job\t雪\n',attempts:[{attempt:7,status:'succeeded',startedSeq:0,finishedSeq:1}]}],duplicates:3,
    });
    for (const field of ['job','attempt','seq','type']) {
      const changed = {...start,[field]:({job:'other',attempt:8,seq:1,type:'failed'})[field]};
      assert.throws(() => reduce(lines([start,changed])), `conflict ${field}`);
    }
  });
  await check('invalid-fields-are-not-coerced', () => {
    const good = event('x','job',1,0);
    for (const invalid of [null,[],{},'text', {...good,id:''},{...good,job:3},{...good,attempt:0},
      {...good,attempt:1.5},{...good,attempt:'1'},{...good,attempt:Number.MAX_SAFE_INTEGER+1},
      {...good,seq:-1},{...good,seq:0.1},{...good,seq:'0'},{...good,seq:Number.MAX_SAFE_INTEGER+1},
      {...good,type:'done'}, {...good,type:null}]) assert.throws(() => reduce(lines([invalid])));
    assert.throws(() => reduce('{"id":'));
    assert.deepEqual(reduce(''), {jobs:[],duplicates:0});
  });
  await check('invalid-lifecycles-are-rejected', () => {
    const s = event('s','x',1,4), f = event('f','x',1,8,'failed');
    for (const events of [[f],[s,{...s,id:'s2'}],[s,f,{...f,id:'f2'}],
      [s,f,event('p','x',1,9,'succeeded')],[s,{...f,seq:4}],[s,{...f,seq:3}]]) {
      assert.throws(() => reduce(lines(events)));
    }
  });
  await check('cli-report-and-errors', () => {
    const dir = fixture('receipt-grade-');
    try {
      const input = path.join(dir,'input with space.jsonl');
      fs.writeFileSync(input,lines([event('s','cli',1,0),event('f','cli',1,10,'succeeded')]));
      const good = cli(workspace,'receipt-report.js',[input]);
      assert.equal(good.status,0,good.stderr); assert.equal(good.stderr,'');
      assert.deepEqual(JSON.parse(good.stdout),{jobs:[{job:'cli',attempts:[{attempt:1,status:'succeeded',startedSeq:0,finishedSeq:10}]}],duplicates:0});
      assert.ok(good.stdout.endsWith('\n'));
      fs.writeFileSync(input,'{broken');
      for (const args of [[input],[],[input,'extra'],[path.join(dir,'absent')]]) {
        const bad = cli(workspace,'receipt-report.js',args);
        assert.equal(bad.status,2); assert.equal(bad.stdout,''); assert.ok(bad.stderr.trim());
      }
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
