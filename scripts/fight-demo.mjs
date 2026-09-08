// A deliberately narrow reviewed-artifact path. This is not an arbitrary run
// uploader: only this audited, recorded context-packet implementation can ship.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parse} from 'acorn';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const CONTEXT_DEMO = Object.freeze({card: 'context-packet', arm: 'bantam-local-27b', wallMs: 58072,
  candidateSha256: 'ca2ddf5e46889ec3d2d68eab4c4179c6fa5452f49d0506a519020a768fa36158',
  manifestSha256: '95d4892a13b72f588347b61c80bdf928d70db0616d66a8c7ef310d4cd31799c2'});
const FUNCTIONS = ['isNonemptyString', 'isNonnegSafeInt', 'validateSections', 'frameOf', 'packContext'];
const FILES = ['context-packet.js', 'api.mjs', 'worker.mjs'];

export function contextBrowserAPI(bytes) {
  if (sha(bytes) !== CONTEXT_DEMO.candidateSha256) throw Error('This candidate has not been reviewed for public demo use');
  const source = bytes.toString('utf8'), tree = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
  const functions = tree.body.filter(node => FUNCTIONS.includes((node.declaration ?? node).id?.name));
  if (functions.length !== FUNCTIONS.length) throw Error('Reviewed API declarations are missing');
  // Preserve each function exactly. The browser supplies UTF-8 byte counting;
  // Node imports and the command-line entry point are outside the demo API.
  return "// Browser adapter for the reviewed recorded implementation.\n"
    + "const Buffer = {byteLength: text => new TextEncoder().encode(text).byteLength};\n\n"
    + functions.map(node => source.slice(node.start, node.end)).join('\n\n') + '\n';
}

export const CONTEXT_WORKER = `import {packContext} from './api.mjs';
self.onmessage = ({data}) => {
  const id = data?.id;
  try {
    if (!Array.isArray(data?.sections) || data.sections.length > 8
        || data.sections.some(s => typeof s?.text !== 'string' || s.text.length > 4000)
        || !Number.isSafeInteger(data.maxBytes) || data.maxBytes < 0 || data.maxBytes > 16384)
      throw Error('Keep this demo to eight sections, 4,000 characters each and a 16 KiB budget.');
    self.postMessage({id, result: packContext(data.sections, data.maxBytes)});
  } catch (error) { self.postMessage({id, error: String(error.message)}); }
};
`;

function read(file, maxBytes = 128 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw Error('Expected a bounded regular demo asset');
  return fs.readFileSync(file);
}

export function demoMatchesRows(receipt, rows) {
  return !!receipt && Object.entries(CONTEXT_DEMO).every(([key, value]) => receipt[key] === value)
    && rows.some(row => row.arm === receipt.arm && row.wallMs === receipt.wallMs
      && row.recorded === true && row.outcome === 'PASS' && row.accepted === true && row.completed === true
      && row.publicExit === 0 && row.hiddenExit === 0 && row.protectedChanges === 0
      && row.groupsPassed === 5 && row.groupsTotal === 5);
}

export function writeContextDemo({candidate, manifest, output}) {
  if (![candidate, manifest, output].every(p => path.isAbsolute(p)) || fs.existsSync(output)) throw Error('Expected absolute inputs and fresh demo output');
  const source = read(candidate), manifestBytes = read(manifest, 8 * 1024 * 1024);
  if (sha(manifestBytes) !== CONTEXT_DEMO.manifestSha256) throw Error('Demo must refer to the reviewed original recording');
  const recording = JSON.parse(manifestBytes), result = recording.results.find(r => r.card === CONTEXT_DEMO.card && r.arm === CONTEXT_DEMO.arm && r.repeat === 1);
  if (result?.wallMs !== CONTEXT_DEMO.wallMs || result.outcome !== 'PASS'
      || result.finalFiles?.['context-packet.js'] !== sha(source)) throw Error('Candidate does not match its recorded result');
  const files = new Map([['context-packet.js', source], ['api.mjs', contextBrowserAPI(source)], ['worker.mjs', CONTEXT_WORKER]]);
  const receipt = {schema: 'bantam.reviewed-fight-demo.v1', type: 'module', ...CONTEXT_DEMO,
    adapter: 'verbatim-api-with-browser-utf8', reviewedSourceIncluded: true,
    files: [...files].map(([name, bytes]) => ({path: name, bytes: Buffer.byteLength(bytes), sha256: sha(bytes)}))};
  fs.mkdirSync(output, {recursive: true});
  for (const [name, bytes] of files) fs.writeFileSync(path.join(output, name), bytes, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return receipt;
}

export function readFightDemo(directory, rows) {
  const root = path.join(directory, 'demo');
  if (!fs.existsSync(root)) return null;
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('Demo must be a regular directory');
  const receipt = JSON.parse(read(path.join(root, 'package.json')));
  if (receipt.schema !== 'bantam.reviewed-fight-demo.v1' || !demoMatchesRows(receipt, rows)
      || receipt.adapter !== 'verbatim-api-with-browser-utf8' || receipt.reviewedSourceIncluded !== true
      || !Array.isArray(receipt.files) || receipt.files.length !== FILES.length
      || new Set(receipt.files.map(f => f.path)).size !== FILES.length
      || receipt.files.some(f => !FILES.includes(f.path))) throw Error('Invalid or unbound reviewed demo');
  for (const file of receipt.files) {
    const bytes = read(path.join(root, file.path));
    if (file.bytes !== bytes.length || file.sha256 !== sha(bytes)) throw Error('Demo asset hash mismatch');
  }
  const source = read(path.join(root, 'context-packet.js'));
  if (read(path.join(root, 'api.mjs')).toString() !== contextBrowserAPI(source)
      || read(path.join(root, 'worker.mjs')).toString() !== CONTEXT_WORKER) throw Error('Reviewed browser adapter changed');
  return {receipt, files: [...FILES, 'package.json']};
}
