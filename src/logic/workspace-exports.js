// The functions a workspace exports, by name.
//
// Used by the spec-gap detector, which has to decide whether a task declares
// accepted input types for the things it asks the model to write -- and therefore
// needs the names of those things without executing anything or importing them.
//
// Deliberately a regex scan rather than a parse. This runs once per run on a
// workspace of arbitrary size, and a wrong name here costs at most one gate
// evaluation; a parser dependency or an import side effect would cost more.

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "__pycache__"]);
const SOURCE = /\.[cm]?jsx?$/;

// Guard against walking something enormous. The detector only needs a
// representative surface, and a task that names a function usually names one
// declared near the top of the tree.
const MAX_FILES = 400;

const DECLARED = /export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
const ASSIGNED = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g;

/**
 * @param {string} workspace
 * @param {{maxFiles?: number}} [opts]
 * @returns {string[]} exported names, deduplicated
 */
export function workspaceExports(workspace, { maxFiles = MAX_FILES } = {}) {
  const found = new Set();
  if (!workspace) return [];
  let seen = 0;

  const walk = (dir) => {
    if (seen >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!SOURCE.test(entry.name)) continue;
      // A test file exports nothing the task is asking for.
      if (/\.(?:test|spec)\.[cm]?jsx?$/.test(entry.name)) continue;
      seen += 1;
      let src = "";
      try { src = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const [, name] of src.matchAll(DECLARED)) found.add(name);
      for (const [, name] of src.matchAll(ASSIGNED)) found.add(name);
    }
  };

  walk(workspace);
  return [...found];
}
