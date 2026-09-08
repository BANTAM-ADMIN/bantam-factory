// A private controller mailbox outside the model's editable workspace. Messages
// enter the existing between-turn injection path; no process or model restart.
import fs from 'node:fs';
import path from 'node:path';
import {writeJsonAtomic} from './atomic-file.js';

const MAX_BYTES = 256 * 1024;
function directory(dir, workspace) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Error('supervisor control requires an absolute directory');
  const real = fs.realpathSync(dir), ws = fs.realpathSync(workspace);
  if (real !== path.resolve(dir) || !fs.statSync(real).isDirectory() || real === ws || real.startsWith(ws + path.sep)) throw Error('supervisor control must be outside the worker workspace, without symlinks');
  return real;
}
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('invalid supervisor control file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function messages(file) {
  const rows = read(file);
  if (!Array.isArray(rows) || rows.length > 32 || rows.some((m, i) => m?.sequence !== i + 1 || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 8000)) throw Error('invalid supervisor messages');
  return rows;
}
export function createWorkerControl(dir, workspace) {
  const root = directory(dir, workspace);
  for (const [name, value] of [['steering.json', []], ['feedback.json', {revision: 0}]]) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), {flag: 'wx', mode: 0o600});
  }
}
export function queueWorkerSteering(dir, workspace, text) {
  const file = path.join(directory(dir, workspace), 'steering.json'), rows = messages(file);
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || rows.length >= 32) throw Error('steering requires 1..8000 characters and at most 32 messages per job');
  const row = {sequence: rows.length + 1, text};
  if (Buffer.byteLength(JSON.stringify([...rows, row])) > MAX_BYTES - 4096) throw Error('supervisor mailbox is full');
  writeJsonAtomic(file, [...rows, row]);
  return {queued: true, sequence: row.sequence, delivery: 'Worker will read this between actions; inspect subsequent evidence.'};
}
export function readWorkerFeedback(dir, workspace) {
  return read(path.join(directory(dir, workspace), 'feedback.json'));
}
export function workerObservation(text) {
  let value = String(text ?? '');
  // Shell observations quote the command before the real output. Large
  // heredocs used to crowd the observed failure out of the supervisor feed.
  const header = /\ncwd: [^\n]*\nsandbox: [^\n]*\nexit ([^\n]*)\n/.exec(value);
  if (header) value = `Shell exit ${header[1]}\n` + value.slice(header.index + header[0].length);
  value = value.split('\n[guidance]')[0];
  return {text: value.length <= 6000 ? value : value.slice(0, 4500) + '\n[excerpt; full observation in run evidence]\n' + value.slice(-1500), truncated: value.length > 6000};
}
export function openWorkerControl(dir, workspace) {
  const root = directory(dir, workspace), inbox = path.join(root, 'steering.json'), feedbackFile = path.join(root, 'feedback.json');
  messages(inbox); read(feedbackFile);
  let consumed = 0, revision = 0, turn = 0;
  const feedback = {revision, steeringRead: 0, action: null, observation: null};
  const save = () => {feedback.revision = ++revision; writeJsonAtomic(feedbackFile, feedback);};
  return {
    drain() {
      const all = messages(inbox);
      if (all.length < consumed) throw Error('supervisor mailbox was truncated');
      const pending = all.slice(consumed); consumed = all.length;
      if (pending.length) {feedback.steeringRead = consumed; save();}
      return pending.map(m => ({kind: 'supervisor', text: m.text}));
    },
    note(event) {
      if (event.type === 'action') {
        const a = event.action ?? {};
        feedback.action = {turn: ++turn, ...Object.fromEntries(['a', 'p', 'c', 'q', 'question'].filter(k => typeof a[k] === 'string').map(k => [k, a[k].slice(0, 500)]))};
      } else if (event.type === 'observation') {
        feedback.observation = {turn, ...workerObservation(event.observation)};
      } else if (event.type === 'verification') {
        feedback.verification = workerObservation(JSON.stringify(event.verification));
      } else return;
      save();
    },
  };
}
