import fs from 'node:fs';
import path from 'node:path';

const OMIT = new Set(['.git', '.bantam', 'node_modules']);

// A small initial tree lets a worker inspect source and tests together without
// spending a model call discovering the names beneath each directory. Names
// only: this does not count as reading a file or grant edit authority. Never
// follow symlinks, and bound traversal as well as the rendered output.
export function workspaceListing(workspace, { depth = 0, maxEntries = 120, maxChars = 6000 } = {}) {
  const lines = [];
  let visited = 0, chars = 0, clipped = false;
  const visit = (directory, relative, level) => {
    const entries = [];
    const handle = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++visited > maxEntries) { clipped = true; break; }
        if (!OMIT.has(entry.name)) entries.push(entry);
      }
    } finally { handle.closeSync(); }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      // Escape control characters so a filename cannot forge listing lines.
      const display = /[\x00-\x1f\x7f]/.test(name) ? JSON.stringify(name) : name;
      const line = display + (entry.isDirectory() ? '/' : '');
      if (chars + line.length + 1 > maxChars) { clipped = true; return; }
      lines.push(line); chars += line.length + 1;
      if (entry.isDirectory() && level < depth && visited < maxEntries) {
        try { visit(path.join(directory, entry.name), name, level + 1); }
        catch { /* inaccessible children remain listed */ }
      }
    }
  };
  try { visit(workspace, '', 0); }
  catch (error) { return `(could not list workspace: ${error.message})`; }
  const marker = '\n[listing clipped; use list_dir for additional paths]';
  return clipped
    ? lines.join('\n').slice(0, Math.max(0, maxChars - marker.length)) + marker
    : lines.join('\n');
}
