import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function validateRoot(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('root must be a non-symlink directory');
}
function validatePath(selected) {
  if (typeof selected !== 'string' || !selected || selected.startsWith('/')
    || selected.includes('\\') || selected.includes('\0')
    || selected.split('/').some(part => !part || part === '.' || part === '..')) throw Error('invalid selected path');
}
function inspect(root, selected) {
  const parts = selected.split('/'); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return {kind:'missing'}; throw error; }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return {kind:'unsafe'};
    if (i === parts.length - 1) {
      const bytes = fs.readFileSync(current);
      return {kind:'file',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mode:stat.mode & 0o777};
    }
  }
}
export function createManifest(root, paths) {
  validateRoot(root);
  if (!Array.isArray(paths)) throw Error('paths must be an array');
  const seen = new Set();
  for (const selected of paths) {
    validatePath(selected);
    if (seen.has(selected)) throw Error('duplicate selection');
    seen.add(selected);
  }
  return {version:1,files:[...paths].sort().map(selected => {
    const current = inspect(root, selected);
    if (current.kind !== 'file') throw Error(`${current.kind} selected path`);
    return {path:selected,sha256:current.sha256,size:current.size,mode:current.mode};
  })};
}
// Add verifyManifest and the CLI without weakening createManifest.
