import { pathToFileURL } from 'node:url';
import { assert, fs, path, fixture, cli, grade } from '../grader-support.mjs';
const workspace = path.resolve(process.argv[2]);
const job = (id,deps=[],state='pending') => ({id,deps,state});
await grade('job-planner', async check => {
  const { planJobs: plan } = await import(pathToFileURL(path.join(workspace,'job-plan.js')));
  await check('lexical-kahn-not-dfs-or-waves', () => {
    const spec = [job('z'),job('B'),job('A',['B']),job('a',['z']),job('m')];
    const expected = {order:['B','A','m','z','a'],ready:['B','m','z'],blocked:[]};
    const before = JSON.stringify(spec);
    assert.deepEqual(plan(spec),expected); assert.equal(JSON.stringify(spec),before,'input must not change');
    assert.deepEqual(plan([...spec].reverse()),expected);
    assert.deepEqual(plan([job('aa',['z']),job('b'),job('z',[],'succeeded')]),
      {order:['b','aa'],ready:['aa','b'],blocked:[]},'full graph ordering is filtered only afterward');
  });
  await check('all-failed-ancestors-across-completed-nodes', () => {
    const spec = [job('out',['left','right','passed']),job('right',['F2']),job('left',['F1']),
      job('passed',['F1'],'succeeded'),job('F2',['F1'],'failed'),job('F1',[],'failed'),job('clear')];
    assert.deepEqual(plan(spec),{order:['clear'],ready:['clear'],blocked:[
      {id:'left',causes:['F1']},{id:'out',causes:['F1','F2']},{id:'right',causes:['F1','F2']},
    ]});
    assert.deepEqual(plan([job('x',['ok']),job('ok',['fail'],'succeeded'),job('fail',[],'failed')]),
      {order:[],ready:[],blocked:[{id:'x',causes:['fail']}]});
  });
  await check('ready-is-current-not-simulated-and-identities-are-opaque', () => {
    assert.deepEqual(plan([job('constructor',['__proto__']),job('__proto__',[],'succeeded'),job('雪\t\n',['constructor']),job(' ')]),
      {order:[' ','constructor','雪\t\n'],ready:[' ','constructor'],blocked:[]});
    assert.deepEqual(plan([]),{order:[],ready:[],blocked:[]});
  });
  await check('all-graph-cycles-and-invalid-input', () => {
    for (const spec of [null,{},[null],[[]],[job('')],[job('x'),job('x')],
      [job('x',['missing'])],[job('x',['x'])],[job('x',['y'],'succeeded'),job('y',['x'],'failed')],
      [job('x',['y','y']),job('y')],[{...job('x'),deps:'y'}],[{...job('x'),deps:[1]}],
      [{...job('x'),state:'done'}],[{...job('x'),id:4}],[{id:'x',deps:[]}]]) assert.throws(() => plan(spec));
    assert.deepEqual(plan([{...job('ignored-extra'),note:{a:1}}]),{order:['ignored-extra'],ready:['ignored-extra'],blocked:[]});
  });
  await check('cli-plan-and-errors', () => {
    const dir = fixture('planner-grade-');
    try {
      const input = path.join(dir,'plan with space.json');
      fs.writeFileSync(input,JSON.stringify([job('z'),job('b'),job('a',['b'])]));
      const good = cli(workspace,'job-plan.js',[input]);
      assert.equal(good.status,0,good.stderr); assert.equal(good.stderr,''); assert.ok(good.stdout.endsWith('\n'));
      assert.deepEqual(JSON.parse(good.stdout),{order:['b','a','z'],ready:['b','z'],blocked:[]});
      fs.writeFileSync(input,JSON.stringify([job('cycle',['cycle'])]));
      for (const args of [[input],[],[input,'extra'],[path.join(dir,'absent')]]) {
        const bad = cli(workspace,'job-plan.js',args);
        assert.equal(bad.status,2); assert.equal(bad.stdout,''); assert.ok(bad.stderr.trim());
      }
      fs.writeFileSync(input,'{invalid');
      const bad = cli(workspace,'job-plan.js',[input]);
      assert.equal(bad.status,2); assert.equal(bad.stdout,''); assert.ok(bad.stderr.trim());
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
