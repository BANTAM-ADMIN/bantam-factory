// Source-blind review replay of one archived failed inline Node assertion.
// This reads no candidate implementation and executes no benchmark code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'acorn';
import { assertionInput, reviewAssertionGrounding } from '../src/assertion-grounding.js';
import { failedAssertionSite } from '../src/failed-assertion-site.js';
import { ModelClient } from '../src/model.js';
import { startModelRecorder } from './fight-model-proxy.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ['--run', '--turn', '--output']) if (!args.get(key)) throw Error(`Missing ${key}`);
const run = path.resolve(args.get('--run')), output = path.resolve(args.get('--output'));
const endpoint = args.get('--endpoint') || 'http://127.0.0.1:8085';
const read = file => JSON.parse(fs.readFileSync(path.join(run, file), 'utf8'));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const film = read('worker-1-result.json'), index = Number(args.get('--turn')) - 1;
if (!Number.isSafeInteger(index) || index < 0 || index >= film.turns.length) throw Error('Invalid archived turn');
const turn = film.turns[index], command = (turn.action ?? turn.parsedAction)?.c;
const assertion = assertionInput(command, () => { throw Error('This replay requires inline captured source'); });
const receipt = turn.shellExecution;
if (!assertion || !receipt || receipt.exitCode !== 1 || receipt.command !== command
    || ['timedOut', 'interrupted', 'invalidated', 'blocked', 'bufferExceeded', 'error'].some(k => receipt[k]))
  throw Error('No complete archived direct failed check');
// Archived observations contain controller annotations after stderr. Recover
// only a complete empty-stdout Node failure and verify its exact receipt hash;
// never pass those later annotations off as measured process output.
const stderr = (turn.rawObservation ?? turn.observation)
  .match(/\[stderr\]\n([\s\S]*?\nNode\.js v[^\n]*)/)?.[1] + '\n';
if (hash('\n' + stderr) !== receipt.outputSha256) throw Error('Cannot recover exact archived process output');
const focusSite = failedAssertionSite({ assertion, output: stderr });
if (!focusSite) throw Error('The exact failed assertion site could not be bound');
// Optional independent control: review the first preceding assertion without
// pretending it failed or giving its containing bundle any execution credit.
let controlSite = null;
if (args.get('--mode') === 'control') {
  const tree = parse(assertion, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const call = tree.body.map(node => node.expression).find(node => node?.type === 'CallExpression'
    && node.start < focusSite.start && node.callee.type === 'MemberExpression');
  if (!call) throw Error('No preceding assertion control found');
  controlSite = { sourceSha256: hash(assertion), start: call.start, end: call.end,
    line: call.loc.start.line, column: call.loc.start.column, expression: assertion.slice(call.start, call.end) };
}
const task = fs.readFileSync(path.join(run, 'task.txt'), 'utf8');
const slots = await fetch(endpoint + '/slots', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
if (!Array.isArray(slots) || slots.some(slot => slot.is_processing)) throw Error('Model busy or unavailable');
fs.mkdirSync(output, { recursive: false });
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2));
save('scope.json', { run, turn: index + 1, command, focusSite, controlSite, originalExecution: receipt,
  taskSha256: hash(task), assertionSha256: hash(assertion), executionEvidence: false,
  scope: 'Whole-bundle versus exact-site semantic review only. No candidate source or actual failure value goes to the reviewer. No check or generated action is executed.',
  sourceSha256: Object.fromEntries(['src/assertion-grounding.js', 'src/failed-assertion-site.js'].map(file =>
    [file, hash(fs.readFileSync(new URL('../' + file, import.meta.url)))])) });
const recorder = await startModelRecorder({ upstream: endpoint, output: path.join(output, 'model-wire') });
const model = new ModelClient({ endpoint: recorder.endpoint, apiUrl: null, apiDialect: 'llamacpp',
  profile: 'qwen', nPredict: 2400, seed: 4127 });
try {
  for (const mode of controlSite ? ['control'] : ['bundle', 'site']) {
    const result = await reviewAssertionGrounding({ model, task, assertion, scope: 'focused',
      ...(mode === 'site' ? { focusSite } : mode === 'control' ? { focusSite: controlSite } : {}) });
    save(mode + '-review.json', result);
    console.log(JSON.stringify({ mode, verdict: result.verdict, reason: result.reason, executionEvidence: false }));
  }
} finally { await recorder.close(); await model.close?.(); }
console.log(JSON.stringify({ output, status: 'review replays retained; no execution credit' }));
