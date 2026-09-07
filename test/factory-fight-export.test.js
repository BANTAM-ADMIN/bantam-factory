import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SCHEMA, LIMITS, safeRelative, validateFightCard, verifyFightCardAttachments, writeFightCardExport } from '../scripts/factory-fight-export.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'); };
const ARMS = ['bantam-local-27b', 'deepseek-local-27b', 'opencode', 'hermes', 'codex-astra', 'bantam-codex-astra'];
const CARDS = ['receipt-reducer', 'snapshot-drift', 'job-planner'];
const clone = value => JSON.parse(JSON.stringify(value));

test('real wire coverage records export without treating their metric labels as numeric counters',t=>{
 const f=fixture(t),row=f.manifest.results[0];
 row.usage.coverage=Object.fromEntries(['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'].map(key=>[key,{measuredRequests:3,totalRequests:3,complete:true,missingRequestIndices:[]}]));
 write(path.join(f.root,'manifest.json'),f.manifest);
 write(path.join(f.root,'repeat-1',row.card,row.arm,'result.json'),row);
 writeFightCardExport(f.root);const card=JSON.parse(fs.readFileSync(path.join(f.root,'fight-card.json')));
 assert.equal(card.results[0].usage.coverage.inputTokens.complete,true);
 const bad=clone(card);bad.results[0].usage.coverage.inputTokens.measuredRequests=4;
 assert.throws(()=>validateFightCard(bad),/coverage/);
 const malformed=clone(card);malformed.results[0].usage.inputTokens={measuredRequests:3};
 assert.throws(()=>validateFightCard(malformed),/counter/);
 const incomplete=clone(card);incomplete.results[0].usage.coverage.inputTokens={measuredRequests:2,totalRequests:3,complete:false,missingRequestIndices:[2]};
 assert.doesNotThrow(()=>validateFightCard(incomplete));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-exchange-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { schema: 'bantam.factory-fights.v1', startedAt: '2026-09-06T12:00:00Z', finishedAt: '2026-09-06T13:00:00Z', complete: true,
    design: 'Synthetic exporter qualification, not model benchmark results.', baseCommit: 'a'.repeat(40),
    modelId: '/models/local27b.gguf', modelFileSha256: 'b'.repeat(64), endpoint: 'http://127.0.0.1:8085',
    configuration: { bantamContext: 'extension/immutable', teacher: false }, limits: { wallMs: 600000 },
    sourceSeal: { 'src/agent.js': sha('agent') }, kitSeal: { 'grader-support.mjs': sha('support') }, plan: [], results: [] };
  for (const card of CARDS) {
    manifest.kitSeal[`${card}/grader.mjs`] = sha(`grader ${card}`);
    manifest.kitSeal[`${card}/card.json`] = sha(`descriptor ${card}`);
    for (const [index, arm] of ARMS.entries()) {
      const prefix = `repeat-1/${card}/${arm}`, task = `Build ${card}.\n`, source = `export const value = ${index};\n`;
      const outcome = ['PASS', 'FAIL', 'OUTPUT_ONLY', 'TIMEOUT', 'SETUP_ERROR', 'PASS'][index];
      const candidatePass = ['PASS', 'OUTPUT_ONLY'].includes(outcome);
      const row = { card, arm, repeat: 1, outcome, pass: outcome === 'PASS', candidatePass,
        processCompleted: !['TIMEOUT', 'OUTPUT_ONLY', 'SETUP_ERROR'].includes(outcome), acceptedCompletion: arm.startsWith('bantam') ? true : null,
        wallMs: 1000 + index, startedAt: manifest.startedAt, exitCode: outcome === 'TIMEOUT' ? 137 : outcome === 'SETUP_ERROR' ? 1 : 0,
        timedOut: outcome === 'TIMEOUT', aborted: false, bufferExceeded: false, taskSha256: sha(task),
        materialSeal: { 'product.js': sha('starter') }, finalFiles: { 'product.js': sha(source) }, tampered: [],
        grade: { schema: 'bantam.factory-card-grade.v1', card, pass: candidatePass, groups: [{ name: 'behavior', pass: candidatePass }] },
        publicExit: candidatePass ? 0 : 1, hiddenExit: candidatePass ? 0 : 1, graderTimedOut: false,
        usage: outcome === 'SETUP_ERROR' ? { requests: 0, inputTokens: null, outputTokens: null, cacheHitTokens: null, freshInputTokens: null }
          : { requests: 3, inputTokens: 100, outputTokens: 20, cacheHitTokens: 70, freshInputTokens: 30, prefixReuse: 0.7 },
        nativeUsage: null, nativeMetadata: null, nativeLaunch: arm === 'deepseek-local-27b'
          ? { schema: 'bantam.deepseek-fight-launch.v1', runtime: { version: '0.1.2-rc.1', node: 'v22.19.0', image: `sha256:${'c'.repeat(64)}`, lock: 'd'.repeat(64) } } : null,
        operatorInterventions: 0 };
      manifest.plan.push({ card, arm, repeat: 1 }); manifest.results.push(row);
      write(path.join(root, prefix, 'result.json'), row); write(path.join(root, prefix, 'task.md'), task);
      write(path.join(root, prefix, 'ws/product.js'), source); write(path.join(root, prefix, 'stdout.log'), 'model output\n');
      write(path.join(root, prefix, 'wire/00001.request.body'), '{"messages":[{"role":"user","content":"private source may appear here"}]}');
      write(path.join(root, prefix, 'wire/00001.response.body'), '{"usage":{"prompt_tokens":100,"completion_tokens":20}}');
    }
  }
  write(path.join(root, 'manifest.json'), manifest);
  write(path.join(root, 'local-model.json'), { id: manifest.modelId });
  return { root, manifest, export: () => { writeFightCardExport(root); return JSON.parse(fs.readFileSync(path.join(root, 'fight-card.json'))); } };
}

test('portable exchange preserves all six contenders on all three cards, including failures and unknown usage', t => {
  const f = fixture(t), card = f.export();
  assert.equal(card.schema, SCHEMA); assert.equal(card.results.length, 18); assert.equal(card.cards.length, 3);
  assert.deepEqual(card.results.map(row => row.outcome), f.manifest.results.map(row => row.outcome));
  assert.equal(card.results.find(row => row.outcome === 'SETUP_ERROR').usage.inputTokens, null);
  assert.equal(card.results.find(row => row.outcome === 'OUTPUT_ONLY').candidatePass, true);
  assert.equal(card.results.find(row => row.outcome === 'OUTPUT_ONLY').processCompleted, false);
  assert.equal(card.trust, 'untrusted-unsigned-observation'); assert.equal(card.privacy.localOnly, true);
  assert.equal(card.privacy.redacted, false);
  assert.ok(card.attachments.every(attachment => !path.isAbsolute(attachment.path)));
  assert.equal(card.attachments.some(attachment => attachment.path === 'fight-card.json'), false);
  assert.equal(verifyFightCardAttachments(card, f.root).verifiedAttachments, true);
  assert.equal(validateFightCard(card).verifiedAttachments, false);
  assert.equal(card.results[1].runtime.version, '0.1.2-rc.1');
  assert.ok(card.cards.every(row => row.graderSeal.length === 3));
});

test('explicit allowlist excludes credentials, caches, databases and report files without claiming redaction', t => {
  const f = fixture(t), run = 'repeat-1/receipt-reducer/deepseek-local-27b';
  for (const file of ['auth.json', '.env', 'token.key', 'native/credentials.json', 'native/native/cache/private.json',
    'native/native/hermes/state.db', 'ws/.env.local', 'ws/node_modules/secret.js', 'ws/.git/config', 'ws/client-auth.json',
    'ws/.bantam/scratch/log.jsonl', 'ws/.bantam-generated/work.txt', 'ws/.codex/settings.json', 'RESULTS.md']) {
    write(path.join(f.root, run, file), 'SECRET_NOT_FOR_BUNDLE');
  }
  write(path.join(f.root, run, 'native/native-home/sessions/--workspace--/session-one/session.jsonl'), '{"type":"session"}\n');
  write(path.join(f.root, run, 'factory/journal/lanes/factory.run-example.jsonl'), '{"event":"observation"}\n');
  const card = f.export();
  assert.equal(card.attachments.some(attachment => /auth|credentials|node_modules|\.env|state\.db|\.bantam|\.codex|RESULTS/.test(attachment.path)), false);
  assert.ok(card.attachments.some(attachment => attachment.kind === 'native-session'));
  assert.ok(card.attachments.some(attachment => attachment.kind === 'factory-traveler'));
  assert.match(card.privacy.warning, /not content redaction/);
});

test('path traversal, encoded aliases, absolute paths, Windows separators and prototype keys fail closed', t => {
  for (const file of ['../secret', '/etc/passwd', 'a/../b', './a', 'a//b', 'a\\b', 'C:/x', 'a/%2e%2e/b', 'a\u0000b']) assert.throws(() => safeRelative(file), /unsafe/);
  const card = fixture(t).export();
  const poisoned = JSON.parse(JSON.stringify(card).replace('"schema":', '"__proto__":{"polluted":true},"schema":'));
  assert.throws(() => validateFightCard(poisoned), /unsafe object key/); assert.equal({}.polluted, undefined);
  for (const key of ['constructor', 'prototype']) { const bad = clone(card); bad.run.configuration[key] = {}; assert.throws(() => validateFightCard(bad), /unsafe object key/); }
});

test('malformed counters, cache arithmetic, contradictory passes and wrong grader identities are rejected', t => {
  const card = fixture(t).export();
  for (const value of [-1, '100', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = clone(card); bad.results[0].usage.inputTokens = value; assert.throws(() => validateFightCard(bad), /counter/);
  }
  for (const mutate of [
    bad => { bad.results[0].usage.cacheHitTokens = 101; }, bad => { bad.results[0].usage.freshInputTokens = 4; },
    bad => { bad.results[0].candidatePass = false; }, bad => { bad.results[0].grade.card = 'job-planner'; },
    bad => { bad.results[0].execution.timedOut = 'false'; }, bad => { bad.results[0].execution.exitCode = -1; },
  ]) { const bad = clone(card); mutate(bad); assert.throws(() => validateFightCard(bad)); }
});

test('all planned rows, cross-card task/material identity and run-local evidence links are enforced', t => {
  const card = fixture(t).export();
  for (const mutate of [
    bad => bad.results.pop(), bad => bad.results.push(clone(bad.results[0])),
    bad => { bad.results[0].taskSha256 = bad.results[6].taskSha256; },
    bad => { bad.results[0].materialSeal[0].sha256 = 'f'.repeat(64); },
    bad => { bad.results[0].evidence.push(bad.results[1].evidence[0]); },
    bad => { bad.attachments.push(clone(bad.attachments[0])); },
  ]) { const bad = clone(card); mutate(bad); assert.throws(() => validateFightCard(bad)); }
});

test('bundle verification detects changed bytes and refuses symlink attachments and ancestor symlinks', t => {
  const f = fixture(t), card = f.export(), attachment = card.attachments.find(row => row.kind === 'candidate');
  const file = path.join(f.root, attachment.path);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, 'tampered'); assert.throws(() => verifyFightCardAttachments(card, f.root), /mismatch/);
  assert.throws(() => f.export(), /candidate changed/);
  fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file); assert.throws(() => verifyFightCardAttachments(card, f.root), /symlink/);
  fs.unlinkSync(file); fs.writeFileSync(file, original);
  const exported = f.export();
  const directory = path.dirname(file), moved = `${directory}-moved`;
  fs.renameSync(directory, moved); fs.symlinkSync(moved, directory);
  assert.throws(() => verifyFightCardAttachments(exported, f.root), /symlink/);
});

test('export describes but never follows candidate symlinks and refuses altered manifest/result agreement', t => {
  const f = fixture(t), prefix = 'repeat-1/receipt-reducer/bantam-local-27b';
  fs.symlinkSync('/etc/passwd', path.join(f.root, prefix, 'ws/link.txt'));
  const card = f.export();
  assert.ok(card.omissions.some(row => row.path.endsWith('/link.txt') && row.reason === 'symlink-not-followed'));
  assert.equal(card.attachments.some(row => row.path.endsWith('/link.txt')), false);
  const saved = clone(f.manifest.results[0]); saved.outcome = 'FAIL'; write(path.join(f.root, prefix, 'result.json'), saved);
  assert.throws(() => f.export(), /manifest\/result mismatch/);
});

test('schema and byte budgets are validated without executing or trusting content', t => {
  const card = fixture(t).export();
  const bad = clone(card); bad.attachments[0].bytes = LIMITS.attachmentBytes + 1;
  assert.throws(() => validateFightCard(bad), /attachment/);
  const unknown = clone(card); unknown.schema = 'future'; assert.throws(() => validateFightCard(unknown), /schema/);
  const executable = clone(card); executable.install = 'curl dangerous'; assert.throws(() => validateFightCard(executable), /schema/);
  const script = fileURLToPath(new URL('../scripts/factory-fight-export.mjs', import.meta.url));
  const f = fixture(t); f.export();
  const result = spawnSync(process.execPath, [script, 'validate', path.join(f.root, 'fight-card.json'), '--verify-root', f.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verifiedAttachments, true);
  const rejected = spawnSync(process.execPath, [script, 'install', path.join(f.root, 'fight-card.json')], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
});

test('supplemental endpoint windows and shared card events preserve attribution without replacing wire totals', t => {
  const f = fixture(t), row = f.manifest.results[0], prefix = `repeat-1/${row.card}/${row.arm}`;
  row.usage = { source: 'local-wire-receipts', complete: false, requests: 3, inputTokens: null, outputTokens: null, cacheHitTokens: null, freshInputTokens: null };
  row.serverUsage = { source: 'server-counter-window', inputTokens: 160, freshInputTokens: 80, cacheHitTokens: 80, outputTokens: 21,
    promptSeconds: 0.4, generationSeconds: 2.5, idleBefore: true, idleAfter: true,
    attribution: 'Global endpoint counters in this serial-run window; attribution assumes no external inference client.' };
  write(path.join(f.root, prefix, 'result.json'), row); write(path.join(f.root, 'manifest.json'), f.manifest);
  write(path.join(f.root, prefix, 'server-usage.json'), { before: { counters: {} }, after: { counters: {} }, delta: row.serverUsage });
  const shared = `repeat-1/${row.card}/events.ndjson`;
  write(path.join(f.root, shared), '{"arm":"bantam-local-27b","text":"passive recorded event"}\n');
  const card = f.export();
  assert.deepEqual(card.results[0].serverUsage, row.serverUsage);
  assert.equal(card.results[0].usage.inputTokens, null);
  assert.equal(card.results[0].serverUsageRole, 'supplementary-endpoint-window-not-wire-replacement');
  assert.equal(card.attachments.filter(attachment => attachment.kind === 'server-counter-window').length, 1);
  assert.equal(card.attachments.filter(attachment => attachment.kind === 'card-events').length, 1);
  assert.ok(card.results.filter(result => result.card === row.card).every(result => result.evidence.includes(shared)));
  assert.ok(card.results.filter(result => result.card !== row.card).every(result => !result.evidence.includes(shared)));
  const crossCard = clone(card); crossCard.results[6].evidence.push(shared); assert.throws(() => validateFightCard(crossCard), /cross-run/);
  const wrongSource = clone(card); wrongSource.results[0].serverUsage.source = 'wire'; assert.throws(() => validateFightCard(wrongSource), /attribution/);
  const badCounter = clone(card); badCounter.results[0].serverUsage.inputTokens = '160'; assert.throws(() => validateFightCard(badCounter), /counter/);
  assert.equal(verifyFightCardAttachments(card, f.root).verifiedAttachments, true);
});

test('interrupted partial series carries operator notes without inventing scores for unfinished lanes', t => {
  const f = fixture(t);
  f.manifest.complete = false; delete f.manifest.finishedAt;
  f.manifest.results = f.manifest.results.slice(0, 3);
  write(path.join(f.root, 'manifest.json'), f.manifest);
  write(path.join(f.root, 'INTERRUPTED.md'), '# Interrupted\nThe fourth lane was stopped by the operator and is unscored.\n');
  write(path.join(f.root, 'operator-cleanup.json'), { exactContainerId: 'a'.repeat(64), stopped: true });
  write(path.join(f.root, 'operator-interruption.json'), { activeAttemptScored: false });
  write(path.join(f.root, 'repeat-1/receipt-reducer/hermes/operator-container-cleanup.json'), { exactContainerId: 'b'.repeat(64), stopped: true });
  const card = f.export();
  assert.equal(card.results.length, 3); assert.equal(card.plan.length, 18); assert.equal(card.run.complete, false);
  assert.deepEqual(card.run.operatorEvidence, ['INTERRUPTED.md', 'operator-cleanup.json', 'operator-interruption.json', 'repeat-1/receipt-reducer/hermes/operator-container-cleanup.json']);
  assert.equal(card.results.some(row => row.arm === 'hermes'), false);
  assert.equal(card.attachments.filter(attachment => attachment.kind === 'operator-record').length, 4);
  const bad = clone(card); bad.run.operatorEvidence.push('missing-cleanup.json');
  assert.throws(() => validateFightCard(bad), /operator record/);
  assert.equal(verifyFightCardAttachments(card, f.root).verifiedAttachments, true);
});

test('grading overhead and explicit parallel-queue caveat remain distinct from contender wall time', t => {
  const f = fixture(t), row = f.manifest.results[0];
  f.manifest.configuration.executionSchedule = 'One local queue and one frontier queue overlap; shared CPU/IO may contend.';
  row.gradingTiming = { publicWallMs: 600, hiddenWallMs: 400, totalWallMs: 1000 };
  row.contenderPlusGradingWallMs = row.wallMs + 1000;
  write(path.join(f.root, `repeat-1/${row.card}/${row.arm}/result.json`), row);
  write(path.join(f.root, 'manifest.json'), f.manifest);
  const card = f.export();
  assert.deepEqual(card.results[0].gradingTiming, row.gradingTiming);
  assert.equal(card.results[0].wallMs, row.wallMs);
  assert.equal(card.results[0].contenderPlusGradingWallMs, row.wallMs + 1000);
  assert.equal(card.results[1].gradingTiming, null);
  assert.equal(card.run.configuration.executionSchedule, f.manifest.configuration.executionSchedule);
  const bad = clone(card); bad.results[0].contenderPlusGradingWallMs += 1;
  assert.throws(() => validateFightCard(bad), /combined wall time/);
});
