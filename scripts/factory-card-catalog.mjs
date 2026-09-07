// Versioned, reviewed task identities. Never resolve paths from imported labels.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FACTORY_KITS = Object.freeze({
  'factory-2026-09-06': Object.freeze(['receipt-reducer', 'snapshot-drift', 'job-planner']),
  'factory-2026-09-07': Object.freeze(['context-packet', 'patch-transaction', 'stream-framer']),
});
export const PUBLIC_FACTORY_CARDS = Object.freeze(Object.fromEntries(Object.entries({
  'receipt-reducer': {title:'Receipt reducer',kind:'BUILD',number:'01',description:'Turn a noisy stream of events into a trustworthy account of what happened.'},
  'snapshot-drift': {title:'Snapshot drift',kind:'EXTEND',number:'02',description:'Bind a snapshot to real files. Detect what changed, and validate what did not.'},
  'job-planner': {title:'Job planner',kind:'REPAIR',number:'03',description:'Order dependent work deterministically. Propagate failure without losing the plan.'},
  'context-packet': {title:'Context packet',kind:'BUILD',number:'01',description:'Fit complete, attributable context sections into a strict UTF-8 byte budget.'},
  'patch-transaction': {title:'Patch transaction',kind:'EXTEND',number:'02',description:'Check every preimage, then apply a set of compatible edits as one transaction.'},
  'stream-framer': {title:'Stream framer',kind:'REPAIR',number:'03',description:'Recover complete events across arbitrary byte chunks, with explicit stream termination.'},
}).map(([id,metadata])=>[id,Object.freeze(metadata)])));

export function factoryKit(id='factory-2026-09-06') {
  if (typeof id !== 'string' || !Object.hasOwn(FACTORY_KITS,id)) throw Error('unsupported factory kit identity');
  return {id, root:path.join(ROOT,'examples/fights',id), cards:[...FACTORY_KITS[id]]};
}
