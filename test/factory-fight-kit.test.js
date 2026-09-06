import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShellProcess } from '../src/executor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const kit = path.join(root,'examples/fights/factory-2026-09-06');
const cards = ['receipt-reducer','snapshot-drift','job-planner'];
const read = (...parts) => fs.readFileSync(path.join(kit,...parts),'utf8');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const docker = {skip:process.env.BANTAM_FIGHT_KIT_DOCKER_TEST !== '1',timeout:45000};
const references = {
  'receipt-reducer':read('receipt-reducer','reviewer','receipt-report.js'),
  'snapshot-drift':read('snapshot-drift','starter','snapshot.js') + '\n' + read('snapshot-drift','reviewer','extension.js'),
  'job-planner':read('job-planner','reviewer','job-plan.js'),
};
function replace(source, before, after) {
  assert.ok(source.includes(before),`mutation target not found: ${before}`);
  return source.replace(before,after);
}
async function runGrade(t, card, source, {publicTests=false}={}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(),'factory-gauge-'));
  t.after(() => fs.rmSync(workspace,{recursive:true,force:true}));
  fs.cpSync(path.join(kit,card,'starter'),workspace,{recursive:true});
  const metadata = JSON.parse(read(card,'card.json'));
  fs.writeFileSync(path.join(workspace,metadata.deliverables[0]),source);
  const grader = path.join(kit,card,'grader.mjs');
  const result = await runShellProcess(workspace,
    `${publicTests ? 'npm test && ' : ''}node ${shellQuote(grader)} ${shellQuote(workspace)}`,{
      shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,dockerImage:'ubuntu:24.04',
      readOnlyHostFiles:[grader,path.join(kit,'grader-support.mjs')],timeoutMs:30000,
    });
  assert.equal(result.timedOut,false,result.stderr);
  assert.equal(result.aborted,false,result.stderr);
  assert.equal(result.bufferExceeded,false,result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.schema,'bantam.factory-card-grade.v1');
  assert.equal(output.card,card);
  assert.deepEqual(output.groups.map(group => group.name),metadata.groups);
  assert.ok(output.groups.every(group => typeof group.pass === 'boolean'));
  assert.equal(output.pass,output.groups.every(group => group.pass));
  return {result,output};
}

test('new fight cards have explicit protected materials and external independent gauges', () => {
  for (const card of cards) {
    const metadata = JSON.parse(read(card,'card.json'));
    assert.equal(metadata.id,card);
    assert.equal(new Set(metadata.groups).size,5);
    assert.ok(read(card,'task.md').includes('npm test'));
    for (const file of [...metadata.protected,...metadata.deliverables]) assert.ok(fs.statSync(path.join(kit,card,'starter',file)).isFile());
    assert.ok(!fs.existsSync(path.join(kit,card,'starter','grader.mjs')));
    assert.ok(!fs.existsSync(path.join(kit,card,'starter','reviewer')));
    const grader = read(card,'grader.mjs');
    for (const group of metadata.groups) assert.ok(grader.includes(`check('${group}'`),group);
  }
});
for (const card of cards) {
  test(`factory fight gauge accepts ${card} reviewer oracle and public tests in readonly Docker`,docker,async t => {
    const {result,output} = await runGrade(t,card,references[card],{publicTests:true});
    assert.equal(result.code,0,result.stdout + result.stderr);
    assert.equal(output.pass,true,JSON.stringify(output));
  });
  test(`factory fight gauge rejects ${card} untouched starter in readonly Docker`,docker,async t => {
    const metadata = JSON.parse(read(card,'card.json'));
    const {result,output} = await runGrade(t,card,read(card,'starter',metadata.deliverables[0]));
    assert.notEqual(result.code,0);
    assert.equal(output.pass,false);
  });
}

const r = references['receipt-reducer'];
const s = references['snapshot-drift'];
const p = references['job-planner'];
const mutations = [
  ['receipt-reducer','lost duplicate count',replace(r,'duplicates++; continue;','continue;')],
  ['receipt-reducer','conflicting IDs silently deduplicated',replace(r,"if (JSON.stringify(byId.get(e.id)) !== JSON.stringify(core)) throw Error('conflicting id');",'')],
  ['receipt-reducer','locale ordering',replace(r,'a < b ? -1 : a > b ? 1 : 0','a.localeCompare(b)')],
  ['receipt-reducer','terminal same sequence accepted',replace(r,'state.terminal.seq <= state.start','state.terminal.seq < state.start')],
  ['receipt-reducer','coerced sequence',replace(r,"const e = JSON.parse(line);","const e = JSON.parse(line); if (e && typeof e === 'object') e.seq = Number(e.seq);")],
  ['snapshot-drift','same-size content changes missed',replace(s,"current.sha256 !== entry.sha256 || current.size !== entry.size","current.size !== entry.size")],
  ['snapshot-drift','mode changes ignored',replace(s,"if (current.mode !== entry.mode) reasons.push('mode');",'')],
  ['snapshot-drift','symlinks followed',s.replaceAll('fs.lstatSync','fs.statSync')],
  ['snapshot-drift','manifest validation omitted',replace(s,'validateRoot(root); validateManifest(manifest);','validateRoot(root);')],
  ['snapshot-drift','manifest size ignored',replace(s,"current.sha256 !== entry.sha256 || current.size !== entry.size","current.sha256 !== entry.sha256")],
  ['job-planner','newly-ready queue unsorted',replace(p,'    queue.sort();','')],
  ['job-planner','only direct failure causes',replace(p,'for (const cause of ancestors.get(dep)) causes.add(cause);','')],
  ['job-planner','cycles accepted',replace(p,"if (topo.length !== jobs.size) throw Error('cycle');",'')],
  ['job-planner','future jobs reported ready',replace(p,"jobs.get(id).deps.every(dep => jobs.get(dep).state === 'succeeded')","true")],
  ['job-planner','pending results lexically sorted after topology',replace(p,'order:topo.filter(allowed),','order:topo.filter(allowed).sort(),')],
];
for (const [card,name,source] of mutations) {
  test(`factory fight gauge rejects ${card}: ${name}`,docker,async t => {
    const {result,output} = await runGrade(t,card,source);
    assert.equal(result.code,1,JSON.stringify(output));
    assert.equal(output.pass,false,JSON.stringify(output));
  });
}
