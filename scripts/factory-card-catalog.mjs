// Versioned, reviewed task identities. Never resolve paths from imported labels.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FACTORY_KITS = Object.freeze({
  'factory-2026-09-06': Object.freeze(['receipt-reducer', 'snapshot-drift', 'job-planner']),
  'factory-2026-09-07': Object.freeze(['context-packet', 'patch-transaction', 'stream-framer']),
  'factory-controls-2026-09-07': Object.freeze(['redaction-plan', 'retry-budget']),
  'factory-selection-2026-09-08': Object.freeze(['glob-select', 'path-scope', 'semver-range']),
  'factory-formats-2026-09-08': Object.freeze(['csv-record', 'interval-merge', 'arg-parser', 'ansi-wrap', 'json-pointer']),
  'factory-arcade-2026-09-08': Object.freeze(['poker-hand', 'bowling-score', 'life-grid', 'turtle-canvas', 'sheet-eval']),
});
export const PUBLIC_FACTORY_CARDS = Object.freeze(Object.fromEntries(Object.entries({
  'receipt-reducer': {title:'Receipt reducer',kind:'BUILD',number:'01',description:'Turn a noisy stream of events into a trustworthy account of what happened.'},
  'snapshot-drift': {title:'Snapshot drift',kind:'EXTEND',number:'02',description:'Bind a snapshot to real files. Detect what changed, and validate what did not.'},
  'job-planner': {title:'Job planner',kind:'REPAIR',number:'03',description:'Order dependent work deterministically. Propagate failure without losing the plan.'},
  'context-packet': {title:'Context packet',kind:'BUILD',number:'01',description:'Fit complete, attributable context sections into a strict UTF-8 byte budget.'},
  'patch-transaction': {title:'Patch transaction',kind:'EXTEND',number:'02',description:'Check every preimage, then apply a set of compatible edits as one transaction.'},
  'stream-framer': {title:'Stream framer',kind:'REPAIR',number:'03',description:'Recover complete events across arbitrary byte chunks, with explicit stream termination.'},
  'redaction-plan': {title:'Redaction plan',kind:'BUILD',number:'01',description:'Remove selected literals deterministically, with an exact edit receipt and byte accounting.'},
  'retry-budget': {title:'Retry budget',kind:'REPAIR',number:'02',description:'Respect backoff, server retry hints and a hard remaining-time budget without overflow.'},
  'glob-select': {title:'Glob select',kind:'BUILD',number:'01',description:'Match paths against glob patterns, last pattern deciding, with a receipt per path.'},
  'path-scope': {title:'Path scope',kind:'EXTEND',number:'02',description:'Decide whether a path stays inside a workspace root, without trusting a shared prefix.'},
  'semver-range': {title:'Semver range',kind:'REPAIR',number:'03',description:'Order versions by real precedence and admit prereleases into a range only when invited.'},
  'csv-record': {title:'CSV record',kind:'BUILD',number:'01',description:'Read quoted delimiter-separated records, embedded newlines and all, without guessing.'},
  'interval-merge': {title:'Interval merge',kind:'BUILD',number:'02',description:'Coalesce half-open ranges that touch, and count the values they cover exactly.'},
  'arg-parser': {title:'Arg parser',kind:'BUILD',number:'03',description:'Parse bundled short flags, value forms and a terminator without inventing options.'},
  'ansi-wrap': {title:'ANSI wrap',kind:'BUILD',number:'04',description:'Wrap styled text by display width, never splitting an escape or a wide glyph.'},
  'json-pointer': {title:'JSON pointer',kind:'BUILD',number:'05',description:'Resolve a pointer against own properties only, reporting a miss instead of throwing.'},
  'poker-hand': {title:'Poker hand',kind:'BUILD',number:'01',description:'Rank five-card hands, including the wheel, and break ties without consulting suits.'},
  'bowling-score': {title:'Bowling score',kind:'BUILD',number:'02',description:'Score ten frames with bonus rolls, leaving an unfinished game honestly unscored.'},
  'life-grid': {title:'Life grid',kind:'EXTEND',number:'03',description:'Advance a bounded life grid and tell real stability from a mere oscillation.'},
  'turtle-canvas': {title:'Turtle canvas',kind:'BUILD',number:'04',description:'Draw a turtle path onto a bounded canvas, clipping at the edge instead of failing.'},
  'sheet-eval': {title:'Sheet eval',kind:'REPAIR',number:'05',description:'Evaluate a sheet of formulas, reporting reference cycles rather than exhausting the stack.'},
}).map(([id,metadata])=>[id,Object.freeze(metadata)])));

export function factoryKit(id='factory-2026-09-06') {
  if (typeof id !== 'string' || !Object.hasOwn(FACTORY_KITS,id)) throw Error('unsupported factory kit identity');
  return {id, root:path.join(ROOT,'examples/fights',id), cards:[...FACTORY_KITS[id]]};
}
