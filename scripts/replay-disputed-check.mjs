// Replay one preserved decision, never execute the returned action. The only
// treatment is restoring the worker's own preceding bounded hypothesis.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { formatWorkingNoteReanchor } from '../src/agent.js';
import { recordTurns, stateAsOf } from '../src/logic/runlog.js';
import { pendingContractAudit } from '../src/contract-audit-recovery.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ['--run', '--turn', '--think-request', '--act-request', '--verify', '--output'])
  if (!args.get(key)) throw Error(`Missing ${key}`);
const run = path.resolve(args.get('--run')), output = path.resolve(args.get('--output'));
const endpoint = args.get('--endpoint') || 'http://127.0.0.1:8085';
const index = Number(args.get('--turn')) - 1;
const read = file => JSON.parse(fs.readFileSync(path.join(run, file), 'utf8'));
const film = read('worker-1-result.json');
if (!Number.isSafeInteger(index) || index < 1 || index >= film.turns.length) throw Error('Invalid recorded turn');
const history = film.turns.slice(0, index), last = history.at(-1);
const generation = last.verificationWorkflow?.generation ?? last.shellExecution?.generation;
const pending = pendingContractAudit(history, { generation, configuredCommand: args.get('--verify') });
if (!pending?.needsFocused) throw Error('Selected decision has no pending focused execution');
const note = formatWorkingNoteReanchor(stateAsOf(recordTurns(history), history.length), {
  recoveryEvidence: pending, pendingVerification: pending, retireAfterVerifiedPass: true,
  suppressBeforeFirstEdit: true,
});
if (!note) throw Error('No eligible preceding hypothesis; do not invent a replacement');
const thought = read(args.get('--think-request')), action = read(args.get('--act-request'));
const tail = '<|im_start|>assistant\n<think>\n';
if (!thought.prompt.endsWith(tail) || !action.prompt.startsWith(thought.prompt)) throw Error('Unsupported or mismatched recorded request pair');
if (action.prompt !== film.turns[index].prompt) throw Error('Recorded action request does not match selected turn');
const health = await fetch(endpoint + '/slots', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
if (!Array.isArray(health) || health.some(slot => slot.is_processing)) throw Error('Model busy or slot health unavailable');
fs.mkdirSync(output, { recursive: false });
const save = (file, value) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
save('scope.json', { run, turn: index + 1, generation, pending, endpoint,
  scope: 'Two single-decision replays; generated actions are NEVER executed. Not an end-to-end result.',
  sourceSha256: Object.fromEntries(['src/agent.js', 'src/logic/runlog.js', 'src/contract-audit-recovery.js'].map(file =>
    [file, hash(fs.readFileSync(new URL('../' + file, import.meta.url)))])),
  originalThoughtRequestSha256: hash(JSON.stringify(thought)),
  originalActionRequestSha256: hash(JSON.stringify(action)), seed: 4127,
  treatment: 'Only the worker-authored preceding hypothesis, rendered by the production continuity formatter.', note });
const complete = async (name, request) => {
  save(name + '.request.json', request);
  const response = await fetch(endpoint + '/completion', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
  const body = await response.text();
  fs.writeFileSync(path.join(output, name + '.response.body'), body);
  if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
  const result = JSON.parse(body);
  console.log(JSON.stringify({ phase: name, tokens: result.tokens_predicted, stoppedLimit: result.stopped_limit }));
  return result;
};
const summary = [];
for (const arm of ['baseline', 'continuity']) {
  const prompt = arm === 'baseline' ? thought.prompt : thought.prompt.slice(0, -tail.length)
    + '<|im_start|>user\n' + note + '\n<|im_end|>\n' + tail;
  const reasoning = await complete(arm + '-think', { ...thought, prompt, seed: 4127 });
  if (reasoning.stopped_limit) throw Error(`${arm}: thinking limit reached; preserved result is incomplete`);
  const chosen = await complete(arm + '-action', { ...action,
    prompt: prompt + reasoning.content.trim() + '\n</think>\n\n', seed: 4127 });
  summary.push({ arm, reasoning: reasoning.content, action: chosen.content,
    stoppedLimit: Boolean(chosen.stopped_limit), executionEvidence: false });
  save('summary.json', summary);
}
console.log(JSON.stringify({ output, status: 'recorded; inspect results, no action executed' }));
