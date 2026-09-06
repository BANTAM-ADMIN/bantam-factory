import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(process.argv[2]);
const { parseNameStatusZ: parse } = await import(pathToFileURL(path.join(workspace, 'changed-paths.js')));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-paths-grade-'));
let passed = 0;
function check(name, fn) { fn(); passed++; process.stdout.write(`PASS ${name}\n`); }
try {
  check('all ordinary statuses', () => assert.deepEqual(parse('A\0one\0M\0two\0D\0three\0T\0four\0U\0five\0'),
    ['A','M','D','T','U'].map((status, i) => ({status,source:null,path:['one','two','three','four','five'][i]}))));
  check('copy score and pathological paths', () => assert.deepEqual(parse('C73\0src\told\n雪\\".js\0dst\nnew\t雨\\".js\0M\0tail\0'), [
    {status:'C73',source:'src\told\n雪\\".js',path:'dst\nnew\t雨\\".js'}, {status:'M',source:null,path:'tail'}]));
  check('score boundaries', () => {
    for (const status of ['R0','R1','R99','R100','R000','R010','R099','C0','C100']) assert.deepEqual(parse(`${status}\0a\0b\0`), [{status,source:'a',path:'b'}]);
  });
  check('malformed rejected', () => {
    for (const text of ['\0','M\0\0','R100\0\0b\0','R100\0a\0\0','R100\0a\0','M\0a','Q\0a\0','R101\0a\0b\0','C-1\0a\0b\0','R\0a\0b\0','M\0a\0\0','M100\0a\0','R0000\0a\0b\0']) assert.throws(() => parse(text), text);
  });
  check('real Git rename framing and bytes', () => {
    const git = args => execFileSync('git', args, {cwd:fixture,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    git(['init','-q']);
    const before = 'old\tname\n雪.txt', after = 'new\nname\t雨.txt';
    fs.writeFileSync(path.join(fixture,before),'real rename witness\n'.repeat(20));
    git(['add','--',before]);
    git(['-c','user.name=Probe','-c','user.email=probe@invalid','commit','-qm','fixture']);
    fs.renameSync(path.join(fixture,before),path.join(fixture,after));
    git(['add','-A']);
    const stream = git(['diff','--cached','--name-status','-z','-M','-C']);
    assert.equal(stream,`R100\0${before}\0${after}\0`, 'independent fixture really produced a rename record');
    assert.deepEqual(parse(stream),[{status:'R100',source:before,path:after}]);
  });
  process.stdout.write(`Independent acceptance: ${passed}/5 groups passed\n`);
} finally { fs.rmSync(fixture,{recursive:true,force:true}); }
