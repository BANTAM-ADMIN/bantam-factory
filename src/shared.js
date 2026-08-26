// Shared utilities extracted from repeated patterns
import fs from 'node:fs';
import path from 'node:path';

export function listFiles(dir, filter = /\.js$/) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = listFiles(full, filter);
      results.push(...sub.map(f => path.join(path.relative(dir, full), f)));
    } else if (filter.test(entry.name)) {
      results.push(entry.name);
    }
  }
  return results;
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

export function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}