import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProbe } from '../src/probe.js';

const ok = { code: 0, signal: null, stdout: '', stderr: '' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-tmp-tool-test-'));
  const workspace = path.join(root, 'workspace');
  const tool = path.join(root, 'nested', 'tool');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(tool, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tool, 'bin', 'node'), '#!/bin/sh\nexec /usr/bin/node "$@"\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(tool, 'bin') + path.delimiter + originalPath;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, tool };
}
const spec = {
  a: 'probe', question: 'Does an assertion failure retain its receipt with a temporary toolchain?',
  inputs: [], setup: 'printf fixture > fixture.txt', witness: 'test -s fixture.txt', check: 'exit 7',
};
function scratchMount(args) {
  return args.find(arg => typeof arg === 'string' && arg.endsWith(':/tmp:rw')).slice(0, -':/tmp:rw'.length);
}

test('temporary toolchain mountpoints belong to the probe owner before Docker starts', async t => {
  const { workspace, tool } = fixture(t);
  let scratch, calls = 0;
  const result = await runProbe(workspace, spec, { processRunner: async (file, args) => {
    assert.equal(file, 'docker');
    scratch = scratchMount(args);
    const mountpoint = path.join(scratch, path.relative('/tmp', tool));
    assert.ok(fs.existsSync(mountpoint), 'reserve nested mountpoint before Docker can create root-owned directories');
    assert.equal(fs.statSync(mountpoint).uid, process.getuid());
    return { ...ok, code: ++calls === 3 ? 7 : 0 };
  } });
  assert.equal(calls, 3);
  assert.equal(result.probeEvidence.stages[2].code, 7);
  assert.equal(result.probeEvidence.projection.status, 'assertion_failed');
  assert.equal(fs.existsSync(scratch), false);
});

test('a fixture cannot redirect a later toolchain mountpoint through a scratch symlink', async t => {
  const { workspace, tool, root } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  let calls = 0;
  const result = await runProbe(workspace, spec, { processRunner: async (_file, args) => {
    calls++;
    const scratch = scratchMount(args);
    const first = path.join(scratch, path.relative('/tmp', tool).split(path.sep)[0]);
    fs.rmSync(first, { recursive: true, force: true });
    fs.symlinkSync(outside, first);
    return ok;
  } });
  assert.equal(calls, 1, 'reject the redirected mount before executing the next stage');
  assert.match(result.probeEvidence.stages[1].error, /mountpoint.*symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('real Docker temporary toolchain retains failed assertion and removes all probe scratch', {
  skip: process.env.BANTAM_PROBE_DOCKER_TEST !== '1', timeout: 45000,
}, async t => {
  const { workspace } = fixture(t);
  const result = await runProbe(workspace, {
    ...spec, setup: 'node -e "require(\'fs\').writeFileSync(\'/tmp/marker\', \'preserved\')"',
    witness: 'test "$(cat /tmp/marker)" = preserved',
  }, { dockerImage: 'ubuntu:24.04', timeoutMs: 10000 });
  assert.deepEqual(result.probeEvidence.stages.map(stage => stage.code), [0, 0, 7], result.observation);
  assert.equal(result.probeEvidence.projection.status, 'assertion_failed');
  assert.deepEqual(fs.readdirSync(workspace), []);
});
