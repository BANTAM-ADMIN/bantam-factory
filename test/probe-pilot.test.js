import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grader = path.join(root,'examples/fights/probe-git-name-status/grader.mjs');
// Reviewer oracle for gauge qualification only. It is never candidate material.
const reference = `export function parseNameStatusZ(text) {
  if (text === '') return [];
  if (!text.endsWith('\\0')) throw Error('terminator');
  const fields = text.split('\\0'); fields.pop();
  const result = [];
  while (fields.length) {
    const status = fields.shift();
    if (!/^[AMDTU]$/.test(status) && !(/^[RC][0-9]{1,3}$/.test(status) && Number(status.slice(1)) <= 100)) throw Error('status');
    const rename = /^[RC]/.test(status);
    const first = fields.shift();
    const destination = rename ? fields.shift() : first;
    if (!first || !destination) throw Error('path');
    result.push({status,source:rename ? first : null,path:destination});
  }
  return result;
}`;

function grade(source) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(),'probe-pilot-gauge-'));
  try {
    fs.writeFileSync(path.join(workspace,'package.json'),' {"type":"module"}');
    fs.writeFileSync(path.join(workspace,'changed-paths.js'),source);
    const env = {...process.env}; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    return spawnSync(process.execPath,[grader,workspace],{encoding:'utf8',env,timeout:20000});
  } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
}

test('probe pilot independent gauge accepts reviewer oracle and a real Git witness', () => {
  const result = grade(reference);
  assert.equal(result.status,0,result.stdout + result.stderr);
  assert.match(result.stdout,/5\/5 groups passed/);
});
for (const [name, source] of [
  ['stub', 'export function parseNameStatusZ() {return [];}'],
  ['swapped destination', reference.replace('path:destination','path:first')],
  ['missing final NUL accepted', reference.replace("if (!text.endsWith('\\0')) throw Error('terminator');", "if (!text.endsWith('\\0')) text += '\\0';")],
  ['whitespace mangled', reference.replace('path:destination','path:destination.replace(/\\s/g, " ")')],
  ['zero padding wrongly rejected', reference.replace('const rename =', "if (/^[RC]0[0-9]/.test(status)) throw Error('padding'); const rename =")],
]) test(`probe pilot independent gauge rejects ${name}`, () => {
  const result = grade(source);
  assert.notEqual(result.status,0);
  assert.equal(result.error,undefined);
  assert.match(result.stderr,/AssertionError|Error: padding/);
});
