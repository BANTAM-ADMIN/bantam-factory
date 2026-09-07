import test from "node:test";
import assert from "node:assert/strict";
import {directNodeCheckScript, nodeCheckSelfSpawnRefusal} from "../src/node-check-self-spawn.js";

const source = `import {spawnSync} from 'node:child_process';
import {api} from './subject.mjs';
const entry = new URL(import.meta.url).pathname;
function run(args) { return spawnSync(process.execPath, [entry, ...args], {encoding:'utf8'}); }
const result = run(['fixture.json']);`;
const options = {workspace:'/work',path:'check.mjs',source,isCheck:true,
  initialSourcePaths:['subject.mjs'],sourcePaths:['subject.mjs','check.mjs']};
const inspect = (body = source, other = {}, command = 'node check.mjs') => nodeCheckSelfSpawnRefusal(command, {...options, source:body, ...other});

test('positive narrow source shape is refused without rewriting or granting proof', () => {
  const result = inspect();
  assert.equal(result.kind, 'node-check-self-spawn');
  assert.equal(result.command, 'node check.mjs');
  assert.equal(result.candidateVerified, false);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.locator.line, 3);
  assert.equal(result.spawn.line, 4);
  assert.equal(result.invocation.line, 5);
  assert.deepEqual(result.subjects, [{specifier:'./subject.mjs',path:'subject.mjs'}]);
  assert.match(result.correction, /not executed/);
  assert.match(result.correction, /not verified CLI entrypoints/);
  assert.ok(result.correction.length <= 700);
  assert.ok(inspect(source.replaceAll('spawnSync', 'syncSpawn').replace('{syncSpawn}', '{spawnSync as syncSpawn}')));
});

test('known guarded child programs and environment protocols are not classified', () => {
  for (const body of [
    source.replace("const result = run(['fixture.json']);", "if (!process.argv.includes('--child')) run(['--child']);"),
    source.replace("const result = run(['fixture.json']);", "const result = process.argv.length < 3 ? run(['child']) : 0;"),
    source.replace("const result = run(['fixture.json']);", "process.env.CHILD || run(['child']);"),
    "import {argv} from 'node:process';\n" + source,
    source.replace("{encoding:'utf8'}", "{encoding:'utf8', env:{CHILD:'1'}}"),
    source.replace("const result = run(['fixture.json']);", "if (isParent()) run(['child']);"),
  ]) assert.equal(inspect(body), null, body);
});

test('other entrypoints, URLs, imports, shadowed/reassigned bindings and uncalled helpers remain unclassified', () => {
  for (const body of [
    source.replace('new URL(import.meta.url)', "new URL('./subject.mjs', import.meta.url)"),
    source.replace("'node:child_process'", "'./child_process.mjs'"),
    source.replace('const entry', 'let entry'),
    source.replace('function run(args)', 'function run(process)'),
    source.replace('const result', 'spawnSync = custom;\nconst result'),
    source.replace('const result', 'entry = other;\nconst result'),
    source.replace('const result', 'run = other;\nconst result'),
    'const URL = FakeURL;\n' + source,
    'class URL {}\n' + source,
    source.replace("run(['fixture.json'])", "run()"),
    source.replace("run(['fixture.json'])", "run('fixture.json')"),
    source.replace("run(['fixture.json'])", "run([...args])"),
    source.replace("const result = run(['fixture.json']);", "function unused() { return run(['fixture.json']); }"),
    source.replace("const result = run(['fixture.json']);", "assert.throws(() => run(['fixture.json']));"),
    source.replace('return spawnSync', 'const changed = true; return spawnSync'),
  ]) assert.equal(inspect(body), null, body);
});

test('only controller-classified direct newly authored regular check scripts qualify', () => {
  for (const other of [{isCheck:false}, {isCheck:'true'}, {initialSourcePaths:['subject.mjs','check.mjs']},
    {sourcePaths:['subject.mjs']}, {path:'different.mjs'}, {workspace:'relative'}]) assert.equal(inspect(source,other), null);
  for (const command of ['node check.mjs child', 'node -e "code"', 'node check.mjs && echo ok',
    'cd /work && node check.mjs', 'node "$FILE"', 'node /tmp/check.mjs', "node 'check.mjs", 'node check.mjs 2>&1']) {
    assert.equal(inspect(source,{},command), null, command);
  }
  assert.ok(inspect(source,{},'node --test check.mjs'));
  assert.ok(inspect(source,{},'node /work/check.mjs'));
  assert.ok(inspect(source,{},'node check.mjs\n'));
  assert.equal(directNodeCheckScript('node "/work/my check.mjs"\n'), '/work/my check.mjs');
  assert.equal(directNodeCheckScript('node check.mjs && echo ok'), null);
});

test('malformed and oversized source yields no analysis or execution', () => {
  assert.equal(inspect('{'),null);
  assert.equal(inspect(' '.repeat(256*1024+1)),null);
});
