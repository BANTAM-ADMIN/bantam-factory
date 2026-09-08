// Reviewed, observable work travels separately from measurement-only exports.
// Explicit members and seals keep native session/configuration files private.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ARMS = new Set(['bantam-local-27b', 'deepseek-local-27b', 'hermes', 'opencode',
  'codex-astra', 'codex-sol', 'codex-terra', 'bantam-codex-astra', 'claude-sonnet', 'claude-opus', 'claude-fable']);
const BINDING = ['arm', 'wallMs', 'outcome', 'accepted', 'completed', 'publicExit', 'hiddenExit', 'protectedChanges'];
const WORK_KEYS = ['schema', 'card', ...BINDING, 'startedAt', 'task', 'taskSha256', 'source', 'actions',
  'stations', 'events', 'finalResponse', 'finalResponseKind', 'files', 'checks', 'sources', 'coverage', 'explanation'];
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v, max) => typeof v === 'string' && v.length <= max;
function read(file, max = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error('Expected bounded regular work asset');
  return fs.readFileSync(file);
}
function directory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Work assets must be in a regular directory');
}
function safeFile(name) {
  return text(name, 200) && /^[a-zA-Z0-9_./@+-]+$/.test(name) && !name.startsWith('/')
    && !name.split('/').some(p => ['', '..', '.git', '.bantam', 'node_modules'].includes(p));
}
function binding(row) { return Object.fromEntries(BINDING.map(key => [key, row[key]])); }

export function validateFightWork(value, row, card) {
  if (value?.schema !== 'bantam.fight-work.v1' || value.card !== card || !ARMS.has(value.arm)
      || Object.keys(value).some(key => !WORK_KEYS.includes(key))
      || BINDING.some(key => value[key] !== row[key]) || row.recorded !== true
      || !text(value.task, 40000) || sha(value.task) !== value.taskSha256
      || !text(value.finalResponse, 200000) || !['delivery', 'last-message', 'none'].includes(value.finalResponseKind)
      || !Array.isArray(value.actions) || value.actions.length > 2000
      || !Array.isArray(value.files) || value.files.length > 100 || !Array.isArray(value.checks)
      || !Array.isArray(value.stations) || !Array.isArray(value.events)
      || !Array.isArray(value.sources) || !value.sources.some(s => s.kind === 'run-manifest' && hex(s.sha256)))
    throw Error('Invalid or unbound recorded work');
  const ids = new Set();
  for (const action of value.actions) {
    if (!/^action-[1-9]\d*$/.test(action.id) || ids.has(action.id) || !text(action.name, 100)
        || !text(action.source, 100) || !text(action.state, 100)
        || !['inspect', 'edit', 'command', 'finish', 'other'].includes(action.category)
        || !['atMs', 'endedMs'].every(key => action[key] === null || number(action[key]))
        || Object.keys(action).some(key => !['id', 'name', 'category', 'request', 'output', 'atMs', 'endedMs',
          'exitCode', 'state', 'source', 'turn', 'supervisor'].includes(key))) throw Error('Invalid recorded action');
    ids.add(action.id);
  }
  if (value.coverage?.recordedActions !== value.actions.length
      || value.coverage.withResults !== value.actions.filter(a => a.output !== null).length) throw Error('Action coverage mismatch');
  const names = new Set();
  for (const file of value.files) {
    if (!safeFile(file.path) || names.has(file.path) || !['added', 'changed', 'deleted', 'unchanged'].includes(file.state)
        || !['before', 'after'].every(key => file[key] === null || text(file[key], 1024 * 1024))
        || !text(file.diff, 2 * 1024 * 1024)
        || (file.after !== null && (!hex(file.afterSha256) || sha(file.after) !== file.displaySha256))
        || (file.before !== null && !hex(file.beforeSha256))) throw Error('Invalid delivered file');
    names.add(file.path);
  }
  const story = value.explanation;
  if (!story || !text(story.title, 100) || !story.title || !Array.isArray(story.paragraphs)
      || Object.keys(story).some(key => !['title', 'paragraphs'].includes(key))
      || !story.paragraphs.length || story.paragraphs.length > 3
      || story.paragraphs.some(p => !text(p.text, 900) || !p.text || !Array.isArray(p.actions)
        || Object.keys(p).some(key => !['text', 'actions'].includes(key))
        || p.actions.length > 6 || p.actions.some(id => !ids.has(id)))) throw Error('Explanation must refer to recorded actions');
  return value;
}

function entryFor(value, bytes) {
  return {path: value.arm + '.json', bytes: bytes.length, sha256: sha(bytes), ...binding(value),
    actions: value.actions.length, files: value.files.length,
    changedFiles: value.files.filter(file => file.state !== 'unchanged').length,
    taskSha256: value.taskSha256, explanation: value.explanation};
}

export function writeFightWork({output, card, rows, inputs}) {
  if (!path.isAbsolute(output) || fs.existsSync(output) || inputs.length !== rows.length) throw Error('Expected fresh work output and complete roster');
  const entries = [], assets = [];
  for (const row of rows) {
    const file = inputs.find(input => path.basename(input) === row.arm + '.json');
    if (!file || !path.isAbsolute(file)) throw Error('Missing recorded contender work');
    const bytes = read(file), value = validateFightWork(JSON.parse(bytes), row, card);
    entries.push(entryFor(value, bytes)); assets.push([row.arm + '.json', bytes]);
  }
  if (new Set(entries.map(e => e.path)).size !== rows.length || new Set(entries.map(e => e.taskSha256)).size !== 1)
    throw Error('Work roster or task mismatch');
  const receipt = {schema: 'bantam.reviewed-fight-work.v1', card, files: entries};
  fs.mkdirSync(output, {recursive: true});
  for (const [name, bytes] of assets) fs.writeFileSync(path.join(output, name), bytes, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return receipt;
}

export function readFightWork(root, card, rows) {
  const folder = path.join(root, 'work');
  if (!fs.existsSync(folder)) return null;
  directory(folder);
  const receipt = JSON.parse(read(path.join(folder, 'package.json'), 128 * 1024));
  if (receipt.schema !== 'bantam.reviewed-fight-work.v1' || receipt.card !== card
      || !Array.isArray(receipt.files) || receipt.files.length !== rows.length
      || new Set(receipt.files.map(e => e.path)).size !== rows.length) throw Error('Incomplete reviewed work roster');
  for (const row of rows) {
    const entry = receipt.files.find(e => e.path === row.arm + '.json');
    if (!entry || !ARMS.has(row.arm)) throw Error('Unexpected work asset');
    const bytes = read(path.join(folder, entry.path));
    const value = validateFightWork(JSON.parse(bytes), row, card);
    if (JSON.stringify(entry) !== JSON.stringify(entryFor(value, bytes))) throw Error('Work asset hash or summary mismatch');
  }
  if (new Set(receipt.files.map(e => e.taskSha256)).size !== 1) throw Error('Work order mismatch');
  return {receipt, files: [...receipt.files.map(e => e.path), 'package.json']};
}
