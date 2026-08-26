// Breadth coverage for universally quantified directory tasks.
//
// The measured failure (2026-08-12 extension-trajectory A/B, and rebuild's own
// two adapter-migration losses in the same run): on "complete X across every
// module in <dir>" tasks, the model repairs the modules it has looked at,
// sees the weak public suite go green, and declares done with task-named
// modules it never opened. The 2026-07-30 poka-yoke table showed the advisory
// form of this fact fired 3/3 and was ignored 3/3 on this very fixture, and
// the sibling_symbol gate recorded the same asymmetry ("as advisory text was
// ignored; as a gate it was acted on") — so this ships only as a done-gate,
// not as a prompt line.
//
// Deliberately narrow, in the spirit of task-context.js: the scope is derived
// from the task's own universal quantifier over a literal directory that
// exists in the workspace. No task classification, no invented obligations —
// a task that never says "every/each/all … <dir>" has no scope and the gate
// never evaluates.

import fs from "node:fs";
import path from "node:path";

import { editPaths, turnEditApplied } from "../edit-actions.js";

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".mjs", ".mts",
  ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx", ".vue", ".svelte",
]);

// A universal quantifier and a directory token in the same clause. The 80-char
// window keeps "every module in src/adapters" while refusing to join a
// quantifier and a path from different sentences.
const QUANTIFIED_DIR = /\b(?:every|each|all)\b[^.\n]{0,80}?\b((?:src|lib|app)(?:\/[A-Za-z0-9_@.+-]+)*)\b/gi;

/**
 * The module set a universally quantified task covers.
 * @returns {{dir: string, files: string[]}|null} sorted workspace-relative
 * source files directly inside the quantified directory, or null when the task
 * quantifies nothing, the directory does not exist, or the set is too small to
 * be a breadth task / too large to be a sane obligation.
 */
export function taskCoverageScope(task, workspace, { minFiles = 3, maxFiles = 24 } = {}) {
  if (!workspace) return null;
  const root = path.resolve(workspace);
  for (const match of String(task ?? "").matchAll(QUANTIFIED_DIR)) {
    const relative = match[1].replace(/\\/g, "/");
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    let entries;
    try {
      if (!fs.statSync(absolute).isDirectory()) continue;
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => `${relative}/${entry.name}`)
      .sort();
    if (files.length < minFiles || files.length > maxFiles) continue;
    return { dir: relative, files };
  }
  return null;
}

/**
 * One-bounce done objection naming exactly the in-scope modules this run never
 * read or edited. Null when there is no scope, everything was examined, the
 * panel already shows the stragglers in full, or the single bounce is spent.
 */
export function taskCoverageObjection(scope, turns, priorRejections = 0, { panelComplete = new Set() } = {}) {
  if (!scope || priorRejections >= 1) return null;
  const inScope = new Set(scope.files);
  const examined = new Set();
  for (const shown of panelComplete) {
    if (inScope.has(shown)) examined.add(shown);
  }
  for (const turn of Array.isArray(turns) ? turns : []) {
    const action = turn.action ?? turn.parsedAction;
    if (!action) continue;
    if (action.a === "read_file" && inScope.has(action.p)) examined.add(action.p);
    if (action.a === "inspect" && Array.isArray(action.ops)) {
      for (const op of action.ops) {
        if (op?.a === "read_file" && inScope.has(op.p)) examined.add(op.p);
      }
    }
    if (turnEditApplied(turn)) {
      for (const edited of editPaths(action)) {
        if (inScope.has(edited)) examined.add(edited);
      }
    }
  }
  const unexamined = scope.files.filter((file) => !examined.has(file));
  if (!unexamined.length) return null;
  return `[coverage] done arrived with ${unexamined.length} of the ${scope.files.length} modules in ${scope.dir} never read or edited this run: ${unexamined.join(", ")}. The task covers every module in that directory. Read or edit each one now — if some already satisfy the contract, confirm that by reading them before finishing. This check fires once and will not repeat.`;
}
