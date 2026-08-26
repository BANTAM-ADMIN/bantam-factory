// Task context that is safe for every task shape.
//
// This module deliberately extracts only literal, verifiable source paths. It
// does not classify the task, invent implementation obligations, or choose an
// execution phase. Any future semantic compiler belongs behind held-out proof,
// not behind fixture-shaped regular expressions.

import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".mjs", ".mts",
  ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx", ".vue", ".svelte",
]);

/** Return existing, workspace-contained source files explicitly named in task order. */
export function taskNamedSourcePaths(task, workspace, { limit = 6 } = {}) {
  if (!workspace || limit < 1) return [];
  const root = path.resolve(workspace);
  const matches = String(task ?? "").matchAll(/(?:^|[\s('"`])((?:src|lib|app)\/[A-Za-z0-9_@.+/-]+\.[A-Za-z0-9]+)\b/g);
  const out = [];
  for (const match of matches) {
    const relative = match[1].replace(/\\/g, "/");
    if (out.includes(relative) || !SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      if (!fs.statSync(absolute).isFile()) continue;
    } catch {
      continue;
    }
    out.push(relative);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Task-named paths this run has never edited.
 *
 * The landing note counts down turns; it did not say WHAT was still untouched.
 * Measured 2026-08-15: a run capped out having written a module and its tests
 * while never editing `bin/bantam.js`, a path the ticket names explicitly — the
 * harness held both facts and reported neither. Naming the gap at the moment
 * the budget closes is the same delivery rule every other bounce follows.
 */
export function untouchedNamedPaths(namedPaths, editedPaths) {
  const normalize = (p) => String(p ?? "").replace(/^\.\//, "");
  const edited = new Set([...(editedPaths ?? [])].map(normalize));
  return [...new Set((namedPaths ?? []).map(normalize))].filter((p) => p && !edited.has(p));
}
