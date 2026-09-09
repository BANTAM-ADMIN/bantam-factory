#!/usr/bin/env node
// Passive exchange of observations. Never executes candidates, imports plugins,
// uploads evidence, or promotes imported claims into accepted factory facts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'bantam.fight-card-exchange.v1';
export const LIMITS = Object.freeze({ jsonBytes: 32 * 1024 * 1024, attachments: 20000, attachmentBytes: 256 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024 * 1024, results: 256, depth: 32, nodes: 1000000 });
const TRUST = 'untrusted-unsigned-observation';
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`fight-card exchange: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f\\:%?#]/.test(value)
      || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe relative path');
  return value;
}

function inspectData(value) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('JSON structure limit');
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) fail('non-JSON value');
    if (typeof item === 'number' && !Number.isFinite(item)) fail('nonfinite number');
    if (typeof item === 'string' && item.length > LIMITS.jsonBytes) fail('string limit');
    if (item === null || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe object key');
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.jsonBytes) fail('JSON must be a bounded nonsymlink regular file');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  inspectData(result);
  return result;
}

function seal(value, label) {
  if (!object(value) || Object.keys(value).length > LIMITS.attachments) fail(`invalid ${label}`);
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([file, digest]) => {
    safeRelative(file);
    if (hex(digest)) return { path: file, sha256: digest };
    // Candidate symlinks are described, never followed or attached.
    if (label === 'candidate seal' && typeof digest === 'string' && digest.startsWith('symlink:')) {
      return { path: file, symlinkTarget: digest.slice(8) };
    }
    fail(`invalid digest in ${label}`);
  });
}

function validateSeal(entries, { symlinks = false } = {}) {
  if (!Array.isArray(entries) || entries.length > LIMITS.attachments) fail('invalid seal entries');
  const names = new Set();
  for (const entry of entries) {
    if (!object(entry)) fail('invalid seal record');
    safeRelative(entry.path);
    if (names.has(entry.path)) fail('duplicate seal path');
    names.add(entry.path);
    const fields = Object.keys(entry).sort().join(',');
    if (fields === 'path,sha256' && hex(entry.sha256)) continue;
    if (symlinks && fields === 'path,symlinkTarget' && typeof entry.symlinkTarget === 'string' && entry.symlinkTarget.length <= 2048) continue;
    fail('invalid seal record');
  }
}

function validateMetrics(value) {
  if (value === null) return;
  if (!object(value)) fail('invalid metric object');
  const walk = item => {
    for (const [key, child] of Object.entries(item)) {
      if (key === 'coverage') {
        if (!object(child)) fail('invalid coverage');
        for (const [metric, record] of Object.entries(child)) {
          if (!['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'].includes(metric)
              || !object(record) || !integer(record.measuredRequests) || !integer(record.totalRequests)
              || record.measuredRequests > record.totalRequests || typeof record.complete !== 'boolean'
              || !Array.isArray(record.missingRequestIndices)
              || record.missingRequestIndices.length !== record.totalRequests-record.measuredRequests
              || record.missingRequestIndices.some(index=>index!==null&&!integer(index))
              || (record.complete && (record.totalRequests===0 || record.measuredRequests!==record.totalRequests))) fail('invalid metric coverage');
        }
        continue; // Metric names here label coverage records, not numeric counters.
      }
      if (/(?:Tokens|Bytes|Requests|Ms)$/.test(key) || ['turns', 'requests', 'measuredRequests'].includes(key)) {
        if (child !== null && !integer(child)) fail(`invalid counter ${key}`);
      }
      if (key === 'prefixReuse' && child !== null && (typeof child !== 'number' || !Number.isFinite(child) || child < 0 || child > 1)) fail('invalid prefix reuse');
      if (object(child)) walk(child);
    }
  };
  walk(value);
  if (value.inputTokens != null && value.cacheHitTokens != null && value.cacheHitTokens > value.inputTokens) fail('cache exceeds input');
  if (value.inputTokens != null && value.cacheHitTokens != null && value.freshInputTokens != null
      && value.freshInputTokens !== value.inputTokens - value.cacheHitTokens) fail('inconsistent fresh input');
}

const keyOf = row => `${row.repeat}/${row.card}/${row.arm}`;
function fieldsOnly(value, fields, label) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) fail(`invalid ${label} fields`);
}
function relativeList(value) {
  if (!Array.isArray(value) || value.length > LIMITS.attachments) fail('invalid path list');
  value.forEach(safeRelative);
}
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function validateIdentity(row) {
  if (!object(row) || !identifier(row.card) || !identifier(row.arm) || !integer(row.repeat) || row.repeat < 1 || row.repeat > 100) fail('invalid result identity');
}

function denied(file) {
  return file.split('/').some(part => ['.git', 'node_modules', 'cache', 'caches', '.cache', '.credentials.yaml', 'auth.json', 'credentials.json'].includes(part)
    || /^\.env(?:\.|$)/i.test(part) || /(?:^|[._-])(?:secret|credentials|auth)(?:[._-]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx|env)$/i.test(part));
}

function attachmentKind(file, runPrefixes) {
  if (denied(file) || file === 'fight-card.json') return null;
  if (file === 'manifest.json') return 'manifest';
  if (file === 'local-model.json') return 'model';
  if (['INTERRUPTED.md', 'INTERRUPTION.md', 'operator-cleanup.json', 'operator-interruption.json', 'operator-container-cleanup.json'].includes(file)) return 'operator-record';
  if (runPrefixes.some(root => file === `${root.slice(0, root.lastIndexOf('/'))}/events.ndjson`)) return 'card-events';
  const prefix = runPrefixes.find(root => file.startsWith(`${root}/`));
  if (!prefix) return null;
  const rel = file.slice(prefix.length + 1);
  if (rel === 'task.md') return 'task';
  if (rel === 'result.json' || rel === 'command.json') return 'result';
  if (rel === 'run.json') return 'bantam-run';
  if (rel === 'server-usage.json') return 'server-counter-window';
  if (['operator-cleanup.json', 'operator-container-cleanup.json', 'native/operator-cleanup.json'].includes(rel)) return 'operator-record';
  if (/^(?:(?:public|hidden)\.)?(?:stdout|stderr)\.log$/.test(rel)) return 'stream';
  if (/^wire\/\d{5,8}\.request\.body$/.test(rel)) return 'wire-request';
  if (/^wire\/\d{5,8}\.response\.body$/.test(rel)) return 'wire-response';
  if (/^wire\/(?:exchanges\.jsonl|usage\.json)$/.test(rel)) return 'wire-index';
  if (/^native\/(?:stdout\.log|stderr\.log|result\.json|launch\.json|cleanup\.json)$/.test(rel)) return 'native-record';
  if (/^native\/native\/usage\.json$/.test(rel)) return 'native-record';
  if (/^native\/native-home\/sessions\/[^/]+\/[^/]+\/session\.jsonl$/.test(rel)) return 'native-session';
  if (/^native-sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/.test(rel)) return 'native-session';
  if (/^factory\/(?:[^/]+\/)*(?:traveler\.json|traveler\.jsonl|events\.jsonl)$/.test(rel)) return 'factory-traveler';
  if (/^factory\/journal\/lanes\/factory\.[a-zA-Z0-9._-]+\.jsonl$/.test(rel)) return 'factory-traveler';
  if (rel.startsWith('ws/') && rel.split('/').some(part => part.startsWith('.bantam') || ['.codex', '.repobrief'].includes(part))) return null;
  if (rel.startsWith('ws/') && /\.(?:[cm]?js|ts|json|md|txt|py|sh|yaml|yml|toml|csv|jsonl)$/.test(rel)) return 'candidate';
  return null;
}

function regularInside(root, rel) {
  safeRelative(rel);
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail(`symlink attachment: ${rel}`);
  }
  const stat = fs.lstatSync(cursor);
  if (!stat.isFile() || stat.size > LIMITS.attachmentBytes) fail(`invalid attachment file: ${rel}`);
  return { file: cursor, stat };
}

function fileDigest(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > LIMITS.attachmentBytes) fail('invalid opened attachment');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > LIMITS.attachmentBytes) fail('attachment grew beyond limit');
      digest.update(buffer.subarray(0, count));
    }
    return { sha256: digest.digest('hex'), bytes };
  } finally { fs.closeSync(descriptor); }
}

export function validateFightCard(card) {
  inspectData(card);
  const fields = ['schema', 'createdAt', 'trust', 'privacy', 'run', 'plan', 'cards', 'results', 'attachments', 'omissions'];
  if (!object(card) || Object.keys(card).some(key => !fields.includes(key)) || fields.some(key => !(key in card))
      || card.schema !== SCHEMA || card.trust !== TRUST) fail('unsupported exchange schema');
  if (!timestamp(card.createdAt)) fail('invalid creation time');
  fieldsOnly(card.privacy, ['localOnly', 'redacted', 'containsSensitiveEvidence', 'warning'], 'privacy');
  if (!object(card.privacy) || card.privacy.localOnly !== true || card.privacy.redacted !== false
      || card.privacy.containsSensitiveEvidence !== true || typeof card.privacy.warning !== 'string') fail('missing privacy declaration');
  fieldsOnly(card.run, ['design', 'startedAt', 'finishedAt', 'complete', 'baseCommit', 'manifestSha256', 'modelId', 'modelFileSha256',
    'endpoint', 'limits', 'configuration', 'sourceSeal', 'kitSeal', 'sourceMismatches', 'kitMismatches', 'operatorEvidence'], 'run');
  if (!object(card.run) || typeof card.run.complete !== 'boolean' || !hex(card.run.manifestSha256)) fail('invalid run metadata');
  if (card.run.modelFileSha256 !== null && !hex(card.run.modelFileSha256)) fail('invalid model digest');
  const cloudOnly = Array.isArray(card.plan) && card.plan.length>0 && card.plan.every(row=>['codex-astra','codex-sol','codex-terra','bantam-codex-astra','bantam-codex-sol','bantam-codex-terra','claude-sonnet','claude-opus','claude-fable'].includes(row?.arm));
  const noLocalIdentity = cloudOnly && card.run.modelId===null && card.run.endpoint===null && card.run.modelFileSha256===null;
  if ((!noLocalIdentity && typeof card.run.modelId !== 'string') || typeof card.run.design !== 'string' || !object(card.run.configuration)) fail('invalid model/configuration metadata');
  if (!timestamp(card.run.startedAt) || (card.run.finishedAt !== null && !timestamp(card.run.finishedAt))
      || typeof card.run.baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(card.run.baseCommit)
      || (!noLocalIdentity && typeof card.run.endpoint !== 'string') || !object(card.run.limits)) fail('invalid run identity/time');
  validateMetrics(card.run.limits); relativeList(card.run.sourceMismatches); relativeList(card.run.kitMismatches); relativeList(card.run.operatorEvidence);
  validateSeal(card.run.sourceSeal); validateSeal(card.run.kitSeal);
  if (!Array.isArray(card.plan) || !card.plan.length || card.plan.length > LIMITS.results || !Array.isArray(card.results)
      || card.results.length > LIMITS.results || !Array.isArray(card.cards) || !card.cards.length || card.cards.length > LIMITS.results) fail('invalid result collections');
  const plan = new Set();
  for (const row of card.plan) {
    fieldsOnly(row, ['card', 'arm', 'repeat'], 'plan'); validateIdentity(row);
    if (plan.has(keyOf(row))) fail('duplicate plan entry'); plan.add(keyOf(row));
  }
  const cards = new Map();
  for (const row of card.cards) {
    fieldsOnly(row, ['id', 'taskSha256', 'materialSeal', 'graderSeal'], 'card');
    if (!object(row) || !identifier(row.id) || cards.has(row.id) || (row.taskSha256 !== null && !hex(row.taskSha256))) fail('invalid card definition');
    validateSeal(row.materialSeal); validateSeal(row.graderSeal);
    const expected = card.run.kitSeal.filter(entry => entry.path === 'grader-support.mjs' || entry.path === `${row.id}/grader.mjs` || entry.path === `${row.id}/card.json`);
    if (expected.length !== 3 || JSON.stringify(row.graderSeal) !== JSON.stringify(expected)) fail('missing or inconsistent grader seal');
    cards.set(row.id, row);
  }
  const plannedCards = new Set(card.plan.map(row => row.card));
  if (cards.size !== plannedCards.size || [...plannedCards].some(id => !cards.has(id))) fail('plan/card definition mismatch');
  const observed = new Set();
  for (const row of card.results) {
    fieldsOnly(row, ['card', 'arm', 'repeat', 'outcome', 'pass', 'candidatePass', 'processCompleted', 'acceptedCompletion', 'wallMs',
      'startedAt', 'operatorInterventions', 'taskSha256', 'materialSeal', 'finalFiles', 'tampered', 'grade', 'usage', 'nativeUsage',
      'execution', 'runtime', 'nativeMetrics', 'nativeProcess', 'serverUsage', 'serverUsageRole', 'gradingTiming', 'contenderPlusGradingWallMs', 'evidence'], 'result');
    validateIdentity(row);
    if (!plan.has(keyOf(row)) || observed.has(keyOf(row)) || !cards.has(row.card)) fail('unexpected/duplicate result');
    observed.add(keyOf(row));
    if (!['PASS', 'FAIL', 'OUTPUT_ONLY', 'TIMEOUT', 'SETUP_ERROR'].includes(row.outcome)
        || row.pass !== (row.outcome === 'PASS') || typeof row.candidatePass !== 'boolean'
        || typeof row.processCompleted !== 'boolean' || ![true, false, null].includes(row.acceptedCompletion)) fail('invalid judgment/completion');
    if (row.pass && (!row.candidatePass || !row.processCompleted)) fail('contradictory pass');
    if (!integer(row.wallMs) || !integer(row.operatorInterventions)) fail('invalid wall/intervention counter');
    if (row.gradingTiming !== null) {
      fieldsOnly(row.gradingTiming, ['publicWallMs', 'hiddenWallMs', 'totalWallMs'], 'grading timing');
      if (!Object.values(row.gradingTiming).every(integer) || row.gradingTiming.totalWallMs !== row.gradingTiming.publicWallMs + row.gradingTiming.hiddenWallMs) fail('invalid grading timing');
    }
    if (row.contenderPlusGradingWallMs !== null && (!integer(row.contenderPlusGradingWallMs) || row.gradingTiming === null
      || row.contenderPlusGradingWallMs !== row.wallMs + row.gradingTiming.totalWallMs)) fail('invalid combined wall time');
    if (row.startedAt !== null && !timestamp(row.startedAt)) fail('invalid result time');
    relativeList(row.tampered);
    if (!hex(row.taskSha256) || row.taskSha256 !== cards.get(row.card).taskSha256) fail('cross-card task mismatch');
    validateSeal(row.materialSeal); validateSeal(row.finalFiles, { symlinks: true });
    if (JSON.stringify(row.materialSeal) !== JSON.stringify(cards.get(row.card).materialSeal)) fail('cross-card material mismatch');
    if (row.grade !== null) {
      if (!object(row.grade) || row.grade.card !== row.card || !Array.isArray(row.grade.groups)
          || row.grade.groups.some(group => !object(group) || typeof group.name !== 'string' || typeof group.pass !== 'boolean')
          || typeof row.grade.pass !== 'boolean' || row.grade.pass !== (row.grade.groups.length > 0 && row.grade.groups.every(group => group.pass))) fail('invalid grader judgment');
      if (new Set(row.grade.groups.map(group => group.name)).size !== row.grade.groups.length) fail('duplicate grader group');
    }
    if (row.candidatePass && row.grade?.pass !== true) fail('candidate pass without passing judgment');
    validateMetrics(row.usage); validateMetrics(row.nativeUsage); validateMetrics(row.nativeMetrics);
    validateMetrics(row.serverUsage);
    if (row.serverUsageRole !== 'supplementary-endpoint-window-not-wire-replacement'
      || (row.serverUsage !== null && (row.serverUsage.source !== 'server-counter-window' || typeof row.serverUsage.attribution !== 'string'))) fail('invalid supplemental counter attribution');
    if (row.nativeProcess !== null && !object(row.nativeProcess)) fail('invalid native process metadata');
    if (!object(row.execution) || !['timedOut', 'aborted', 'bufferExceeded', 'graderTimedOut'].every(key => typeof row.execution[key] === 'boolean')) fail('invalid execution metadata');
    fieldsOnly(row.execution, ['exitCode', 'timedOut', 'aborted', 'bufferExceeded', 'publicExit', 'hiddenExit', 'graderTimedOut'], 'execution');
    for (const key of ['exitCode', 'publicExit', 'hiddenExit']) if (row.execution[key] !== null && (!integer(row.execution[key]) || row.execution[key] > 255)) fail('invalid exit code');
    if (row.pass && (row.execution.exitCode !== 0 || row.execution.publicExit !== 0 || row.execution.hiddenExit !== 0
      || row.execution.timedOut || row.execution.aborted || row.execution.bufferExceeded || row.execution.graderTimedOut || row.tampered.length)) fail('pass with failed execution/integrity');
    relativeList(row.evidence);
  }
  if (card.run.complete && (observed.size !== plan.size || card.run.finishedAt === null)) fail('completed run missing planned rows or finish time');
  if (!Array.isArray(card.attachments) || card.attachments.length > LIMITS.attachments || !Array.isArray(card.omissions)) fail('attachment count limit');
  const attachments = new Map(); let bytes = 0;
  const prefixes = card.plan.map(row => `repeat-${row.repeat}/${row.card}/${row.arm}`);
  for (const attachment of card.attachments) {
    if (!object(attachment) || Object.keys(attachment).sort().join(',') !== 'bytes,kind,path,sha256') fail('invalid attachment metadata');
    safeRelative(attachment.path);
    if (attachments.has(attachment.path) || attachmentKind(attachment.path, prefixes) !== attachment.kind
        || !hex(attachment.sha256) || !integer(attachment.bytes) || attachment.bytes > LIMITS.attachmentBytes) fail('invalid attachment');
    if ((bytes += attachment.bytes) > LIMITS.totalBytes) fail('total attachment byte limit');
    attachments.set(attachment.path, attachment);
  }
  for (const row of card.results) for (const file of row.evidence) {
    const sharedEvents = `repeat-${row.repeat}/${row.card}/events.ndjson`;
    if (!attachments.has(file) || (!file.startsWith(`repeat-${row.repeat}/${row.card}/${row.arm}/`) && file !== sharedEvents)) fail('missing or cross-run evidence attachment');
    const attachment = attachments.get(file), prefix = `repeat-${row.repeat}/${row.card}/${row.arm}/`;
    if (attachment.kind === 'task' && attachment.sha256 !== row.taskSha256) fail('task attachment digest mismatch');
    if (attachment.kind === 'candidate') {
      const candidatePath = file.slice(`${prefix}ws/`.length);
      if (row.finalFiles.find(entry => entry.path === candidatePath)?.sha256 !== attachment.sha256) fail('candidate changed after recorded result');
    }
  }
  if (attachments.get('manifest.json')?.sha256 !== card.run.manifestSha256) fail('manifest attachment digest mismatch');
  for (const file of card.run.operatorEvidence) if (attachments.get(file)?.kind !== 'operator-record') fail('missing operator record attachment');
  for (const entry of card.omissions) {
    fieldsOnly(entry, ['path', 'reason'], 'omission'); safeRelative(entry.path);
    if (!['symlink-not-followed', 'attachment-byte-limit'].includes(entry.reason)) fail('unknown omission reason');
  }
  return { valid: true, schema: SCHEMA, trust: TRUST, results: card.results.length, attachments: attachments.size,
    declaredBytes: bytes, verifiedAttachments: false, warning: 'Schema validity is not authenticity or semantic correctness.' };
}

export function verifyFightCardAttachments(card, outputRoot) {
  const result = validateFightCard(card);
  const root = fs.realpathSync(outputRoot);
  for (const attachment of card.attachments) {
    const { file, stat } = regularInside(root, attachment.path);
    if (stat.size !== attachment.bytes) fail(`attachment size mismatch: ${attachment.path}`);
    const actual = fileDigest(file);
    if (actual.bytes !== attachment.bytes || actual.sha256 !== attachment.sha256) fail(`attachment digest mismatch: ${attachment.path}`);
  }
  return { ...result, verifiedAttachments: true, warning: 'Matching bytes are still untrusted unsigned observations, not authentic claims.' };
}

export function writeFightCardExport(outputRoot) {
  const root = fs.realpathSync(outputRoot);
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = readJson(manifestFile);
  if (manifest.schema !== 'bantam.factory-fights.v1' || !Array.isArray(manifest.results) || !Array.isArray(manifest.plan)) fail('expected fresh factory manifest');
  const sourceSeal = seal(manifest.sourceSeal, 'source seal'), kitSeal = seal(manifest.kitSeal, 'kit seal');
  const plan = manifest.plan.map(row => ({ card: row.card, arm: row.arm, repeat: row.repeat }));
  plan.forEach(validateIdentity);
  const prefixes = plan.map(row => `repeat-${row.repeat}/${row.card}/${row.arm}`);
  const attachments = [], omissions = [];
  let totalBytes = 0, visited = 0;
  const walk = (rel = '', depth = 0) => {
    if (depth > LIMITS.depth) fail('attachment directory depth limit');
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > LIMITS.nodes) fail('attachment scan limit');
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (denied(file)) continue;
      if (entry.isSymbolicLink()) { omissions.push({ path: file, reason: 'symlink-not-followed' }); continue; }
      if (entry.isDirectory()) { walk(file, depth + 1); continue; }
      const kind = attachmentKind(file, prefixes);
      if (!kind || !entry.isFile()) continue;
      safeRelative(file);
      const stat = fs.lstatSync(path.join(root, file));
      if (stat.size > LIMITS.attachmentBytes) { omissions.push({ path: file, reason: 'attachment-byte-limit' }); continue; }
      if (attachments.length >= LIMITS.attachments || totalBytes + stat.size > LIMITS.totalBytes) fail('attachment budget exceeded');
      const digest = fileDigest(path.join(root, file)); totalBytes += digest.bytes;
      attachments.push({ path: file, ...digest, kind });
    }
  };
  walk();
  const cards = [...new Set(plan.map(row => row.card))].map(id => {
    const rows = manifest.results.filter(row => row.card === id);
    return { id, taskSha256: rows[0]?.taskSha256 ?? null,
      materialSeal: seal(rows[0]?.materialSeal ?? {}, 'material seal'),
      graderSeal: kitSeal.filter(entry => entry.path === 'grader-support.mjs' || entry.path === `${id}/grader.mjs` || entry.path === `${id}/card.json`) };
  });
  const results = manifest.results.map(row => {
    validateIdentity(row);
    const prefix = `repeat-${row.repeat}/${row.card}/${row.arm}`;
    const saved = readJson(path.join(root, prefix, 'result.json'));
    if (JSON.stringify(saved) !== JSON.stringify(row)) fail(`manifest/result mismatch: ${prefix}`);
    const launch = row.nativeLaunch;
    return { card: row.card, arm: row.arm, repeat: row.repeat, outcome: row.outcome, pass: row.pass,
      candidatePass: row.candidatePass, processCompleted: row.processCompleted, acceptedCompletion: row.acceptedCompletion ?? null,
      wallMs: row.wallMs, startedAt: row.startedAt ?? null, operatorInterventions: row.operatorInterventions,
      gradingTiming: row.gradingTiming ?? null, contenderPlusGradingWallMs: row.contenderPlusGradingWallMs ?? null,
      taskSha256: row.taskSha256, materialSeal: seal(row.materialSeal, 'material seal'), finalFiles: seal(row.finalFiles, 'candidate seal'),
      tampered: row.tampered, grade: row.grade ?? null, usage: row.usage ?? null, nativeUsage: row.nativeUsage ?? null,
      execution: Object.fromEntries(['exitCode', 'timedOut', 'aborted', 'bufferExceeded', 'publicExit', 'hiddenExit', 'graderTimedOut'].map(key => [key, row[key] ?? null])),
      runtime: launch ? { schema: launch.schema, version: launch.runtime?.version ?? launch.nativeVersion ?? null,
        image: launch.runtime?.image ?? launch.container?.image ?? null, lockSha256: launch.runtime?.lock ?? null,
        node: launch.runtime?.node ?? null, executableSha256: launch.executableDigest ?? null } : null,
      nativeMetrics: row.nativeMetadata?.native ? Object.fromEntries(Object.entries(row.nativeMetadata.native)
        .filter(([key]) => !['sessions', 'artifacts', 'errors', 'skipped'].includes(key))) : row.nativeMetadata?.usage ?? null,
      nativeProcess: row.nativeMetadata?.process ?? (row.nativeMetadata ? Object.fromEntries(['code', 'signal', 'timedOut', 'aborted', 'bufferExceeded', 'wallMs']
        .filter(key => key in row.nativeMetadata).map(key => [key, row.nativeMetadata[key]])) : null),
      serverUsage: row.serverUsage ?? null,
      serverUsageRole: 'supplementary-endpoint-window-not-wire-replacement',
      evidence: attachments.filter(attachment => attachment.path.startsWith(`${prefix}/`)
        || attachment.path === `repeat-${row.repeat}/${row.card}/events.ndjson`).map(attachment => attachment.path) };
  });
  const card = { schema: SCHEMA, createdAt: new Date().toISOString(), trust: TRUST,
    privacy: { localOnly: true, redacted: false, containsSensitiveEvidence: true,
      warning: 'Raw evidence and free-text metadata may contain private source, prompts, filesystem paths or incidental secrets. Filename exclusions are not content redaction. Review before intentionally sharing; this tool never uploads.' },
    run: { design: manifest.design, startedAt: manifest.startedAt, finishedAt: manifest.finishedAt ?? null, complete: manifest.complete === true,
      baseCommit: manifest.baseCommit, manifestSha256: hash(fs.readFileSync(manifestFile)), modelId: manifest.modelId,
      modelFileSha256: manifest.modelFileSha256 ?? null, endpoint: manifest.endpoint, limits: manifest.limits,
      configuration: manifest.configuration, sourceSeal, kitSeal, sourceMismatches: manifest.sourceMismatches ?? [], kitMismatches: manifest.kitMismatches ?? [],
      operatorEvidence: attachments.filter(attachment => attachment.kind === 'operator-record').map(attachment => attachment.path) },
    plan, cards, results, attachments, omissions };
  validateFightCard(card);
  const destination = path.join(root, 'fight-card.json');
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isFile()) fail('refusing nonregular export destination');
  // Re-exporting is explicit; only this generated report is replaced.
  const temporary = path.join(root, `.fight-card-${crypto.randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(card, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > LIMITS.jsonBytes) fail('export JSON byte limit');
  fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, destination);
  return { path: destination, ...validateFightCard(card) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, target, option, root, ...extra] = process.argv.slice(2);
    if (!target || extra.length || (command === 'export' && option)
        || (command === 'validate' && option && (option !== '--verify-root' || !root)) || !['export', 'validate'].includes(command)) {
      fail('usage: export OUTPUT_ROOT | validate CARD_JSON [--verify-root BUNDLE_ROOT]');
    }
    const result = command === 'export' ? writeFightCardExport(target)
      : option ? verifyFightCardAttachments(readJson(target), root) : validateFightCard(readJson(target));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
