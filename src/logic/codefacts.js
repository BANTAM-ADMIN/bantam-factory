// Turn a codebase into logical facts the reasoning engine can query. This is the "interface"
// layer — the crux I flagged: the system is only as grounded as this extraction. It is
// deliberately deterministic (regex/scan, no LLM), so the facts are stable and reproducible.
//
// Facts asserted:
//   file(path)                 a source file exists
//   defines(file, symbol)      file defines a top-level function/const/class
//   imports(file, module)      file imports/requires a module specifier
//   calls(file, symbol)        file references a defined symbol as a call: `symbol(`
//
// Rules derive the useful stuff:
//   symbol(S)                  S is defined somewhere
//   depends(A, B)              file A calls a symbol that file B defines
//   reaches(A, B)              A transitively depends on B  (impact analysis / blast radius)

import fs from "node:fs";
import path from "node:path";
import { isTestPath } from "../scope-guard.js";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { codePositions } from "../collateral.js";

// Deduplicate import check: ensure no duplicate imports in this file
const _importDedupeGuard = [fs, path, isTestPath];

const DEF_PATTERNS = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  // Python defs, nested included (indentation is allowed on purpose: the
  // sibling-definition gate needs helpers-inside-functions like the
  // serializer's queryset_iterator twins, not just module top-level names).
  /(?:^|\n)[ \t]*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // Module-level UPPER_CASE constants (`HASH_SESSION_KEY = "..."`): the named
  // resources whose peer write-sites carry the operation an edit may be
  // hand-rolling (fallbackauth: HASH_SESSION_KEY assigned in login and
  // update_session_auth_hash, both beside cycle_key). Column-0 only, and the
  // uppercase convention keeps this from matching ordinary assignments.
  /(?:^|\n)([A-Z_][A-Z0-9_]{3,})\s*=(?!=)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
];
// Capture static imports AND re-export barrels (`export * from './x'`, `export {a} from './x'`) — the
// latter are the single most common cause of missed dependency edges through index files. Also capture
// dynamic import()/require() with a LITERAL specifier (a real, resolvable edge; a non-literal
// `import(expr)` is intentionally left uncaptured, unresolvable statically), and bare SIDE-EFFECT
// imports (`import "./x.js"` — no `from`, no parens) whose specifier is still a literal, resolvable
// edge; missing these dropped a whole class of real dependencies (a test that imports a module only
// for its registration side effects would look unaffected by an edit to that module).
const IMPORT_RE = /(?:(?:import|export)[^"'`]*from\s*["'`]([^"'`]+)["'`]|(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)|import\s+["'`]([^"'`]+)["'`])/g;
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

function extractJsImports(source) {
  try {
    const tree = parse(source, { ecmaVersion: "latest", sourceType: "module",
      allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    const imports = [];
    const literal = node => {
      if (node?.type === "Literal" && typeof node.value === "string") imports.push(node.value);
      else if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
        imports.push(node.quasis[0].value.cooked);
      }
    };
    simple(tree, {
      ImportDeclaration: node => literal(node.source),
      ExportNamedDeclaration: node => literal(node.source),
      ExportAllDeclaration: node => literal(node.source),
      ImportExpression: node => literal(node.source),
      CallExpression: node => {
        if (node.callee.type === "Identifier" && node.callee.name === "require") literal(node.arguments[0]);
      },
    });
    return imports;
  } catch {
    // Keep dependency hints for TypeScript and temporarily incomplete edits.
    // Quoted subprocess programs, comments and example strings belong to
    // another context; they must never fabricate unresolved module edges.
    const positions = codePositions(source), imports = [];
    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(source))) {
      if (positions[match.index] && !/[\w$.]/.test(source[match.index - 1] ?? "")) {
        imports.push(match[1] || match[2] || match[3]);
      } else IMPORT_RE.lastIndex = match.index + 1;
    }
    return imports;
  }
}

// Python import specifiers, line-scanned (Python imports are statement-per-line). Produces the same
// flat spec list JS extraction does — module references, relative ones keeping their leading dots
// (".models", "..db.query") so resolvePyImport can walk packages, absolute ones dotted
// ("django.db.models"). This is what makes `imports`/`depends`/`reaches`/`unresolved` — and the whole
// blast-radius critic, forecast, scoped-verify, and kb-diff — non-empty on the django/sympy/flask
// repos the SWE-bench rounds run on. Off with BANTAM_PY_IMPORTS=0.
const PY_FROM_RE = /^\s*from\s+(\.*[A-Za-z0-9_.]*)\s+import\s+(.+)$/;
const PY_IMPORT_RE = /^\s*import\s+(.+)$/;
function pyImportNames(rest) {
  // names in `import a, b as x, c` or `from . import (a, b)` — take each name before ` as `
  return rest.replace(/[()\\]/g, " ").split("#")[0].split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter((n) => /^[A-Za-z_]\w*$/.test(n));
}
export function extractPyImports(source) {
  const specs = [];
  // `from . import X` members: X may be a submodule OR a symbol re-exported from the package's
  // __init__ (django does this constantly: `from . import Field, Error`). These resolve submodule-first,
  // then fall back to the package — and are NEVER "unresolved" (the symbol is real, just in __init__).
  const soft = new Set();
  for (const line of String(source).split("\n")) {
    let m;
    if ((m = PY_FROM_RE.exec(line))) {
      const mod = m[1];
      if (/^\.+$/.test(mod)) {
        for (const name of pyImportNames(m[2])) { const s = mod + name; specs.push(s); soft.add(s); }
      } else specs.push(mod); // `.models`, `..pkg.utils`, `a.b.c` — the module itself is the dependency
    } else if ((m = PY_IMPORT_RE.exec(line))) {
      for (const seg of m[1].split(",")) {
        const name = seg.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_][\w.]*$/.test(name)) specs.push(name);
      }
    }
  }
  return { specs, soft: [...soft] };
}

// Only skip directories that are universally NOT source in ANY repo. Earlier this also listed
// BANTAM's own runtime dirs (runs/skills/jobs/jobs-clean) — but this walker runs over the TARGET
// workspace, so those names silently excluded legitimate source (a backend's `jobs/`, a plugin
// `skills/`) from the graph, making edits there invisible to scoped verification.
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".bantam"]);

// Project-scoped exclusions: a `.bantamignore` at the walk root lists one
// directory name (or root-relative path) per line. Born 2026-08-19 when the
// chair's KB at this repo's root swallowed 31,612 files — benches/ and a
// sibling project — bloating both the index and the newly persistent cache.
// Comments (#) and blank lines are ignored; entries match directory names at
// any depth or root-relative paths.
function loadIgnores(root) {
  try {
    const lines = fs.readFileSync(path.join(root, ".bantamignore"), "utf8").split("\n");
    const names = new Set();
    const rels = new Set();
    for (const raw of lines) {
      const l = raw.trim().replace(/\/+$/, "");
      if (!l || l.startsWith("#")) continue;
      if (l.includes("/")) rels.add(l); else names.add(l);
    }
    return { names, rels };
  } catch { return { names: new Set(), rels: new Set() }; }
}
// TS/JSX share JS's import/export/def syntax, so the regex extraction works on them directly — this
// unlocks the whole graph (barrels, test facts, affects/reaches, scoped verify) for TypeScript repos.
// .py is load-bearing for the sibling-definition done-gate: the 2026-07-17
// Verified slice showed the KB blind to Python (the serializer twin
// queryset_iterator was invisible to `defines`). Python now contributes
// import/depends/unresolved edges too (extractPyImports + resolvePyImport),
// so `reaches`, the transitive-dependent critic, forecast, scoped verify, and
// kb-diff are live on the django/sympy/flask decks. BANTAM_PY_IMPORTS=0 reverts
// Python to defines-only.
const DEFAULT_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts", ".py"];

/**
 * Thrown by walk() when a workspace exceeds `maxFiles` source files. It is the
 * signal that this is not a project but a directory OF projects — a home
 * folder, a `Desktop/PROJECTS` — and indexing it is the wrong thing to do at
 * any speed: each indexed file holds ~44 KB of heap (measured 2026-09-05, 1,139
 * files → 49 MB), and a 672,891-file tree took the process to the 4 GB heap
 * limit and killed it. Stop counting at the ceiling; do not touch the rest.
 */
export class WorkspaceTooLargeError extends Error {
  constructor(root, files, maxFiles) {
    super(`workspace has more than ${maxFiles} source files (stopped counting at ${files}): ${root}`);
    this.name = "WorkspaceTooLargeError";
    this.root = root;
    this.files = files;
    this.maxFiles = maxFiles;
  }
}

export function walk(root, exts, { maxFiles = Infinity } = {}) {
  const out = [];
  const ig = loadIgnores(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || ig.names.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (ig.rels.size && ig.rels.has(path.relative(root, full).split(path.sep).join("/"))) continue;
        stack.push(full);
      }
      else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(path.join(dir, e.name));
        if (out.length > maxFiles) throw new WorkspaceTooLargeError(root, out.length, maxFiles);
      }
    }
  }
  return out;
}

// Resolve a workspace-relative base path to a real file in the set (JS/TS resolution: exact, then
// .js/.mjs/.ts/…, then index.*, plus the TS ESM `./y.js`→y.ts convention). Returns the key or null.
const RESOLVE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"];
function matchFile(base, fileRels) {
  const candidates = [base];
  for (const e of RESOLVE_EXTS) candidates.push(`${base}${e}`, path.posix.join(base, `index${e}`));
  if (/\.js$/.test(base)) { const stem = base.replace(/\.js$/, ""); candidates.push(`${stem}.ts`, `${stem}.tsx`); }
  for (const c of candidates) if (fileRels.has(c)) return c;
  return null;
}

// Resolve an import specifier from `fromRel` to a real file. A leading "." is relative resolution;
// otherwise, if a tsconfig/jsconfig alias map is present, try that (`@/x` -> `src/x`, or a bare
// baseUrl-relative import) — near-universal in real TS repos, and a missed edge here is a false
// clear once the graph gates scoped verification. External packages (e.g. "zod") still return null.
function resolveImport(fromRel, spec, fileRels, aliasConfig = null) {
  if (!spec) return null;
  if (spec[0] === ".") {
    return matchFile(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)), fileRels);
  }
  return resolveAlias(spec, aliasConfig, fileRels);
}

// Resolve a Python import spec (from extractPyImports) to a real file in the set, or null.
// A module resolves to `<base>.py` or `<base>/__init__.py` (a package). Relative specs (leading
// dots) walk up from the importing module's package; absolute dotted specs resolve from the
// workspace root and, for src-layout repos (flask), a `src/` root. External packages (numpy, os)
// resolve to nothing — correctly no edge and, being non-relative, no false `unresolved`.
const PY_ROOTS = ["", "src"];
function matchPyFile(base, fileRels) {
  for (const c of [`${base}.py`, path.posix.join(base, "__init__.py")]) if (fileRels.has(c)) return c;
  return null;
}
export function resolvePyImport(fromRel, spec, fileRels) {
  if (!spec) return null;
  const dots = /^(\.+)/.exec(spec);
  if (dots) {
    const level = dots[1].length;
    const modPart = spec.slice(level).replace(/\./g, "/");
    let dir = path.posix.dirname(fromRel);
    for (let i = 1; i < level; i++) dir = path.posix.dirname(dir); // 1 dot = the module's own package
    const base = modPart ? path.posix.join(dir, modPart) : dir;
    return matchPyFile(base, fileRels);
  }
  const modPath = spec.replace(/\./g, "/");
  for (const root of PY_ROOTS) {
    const hit = matchPyFile(root ? path.posix.join(root, modPath) : modPath, fileRels);
    if (hit) return hit;
  }
  return null;
}

function resolveAlias(spec, aliasConfig, fileRels) {
  if (!aliasConfig) return null;
  const { baseUrl, paths } = aliasConfig;
  const joinBase = (p) => path.posix.normalize(path.posix.join(baseUrl || ".", p));
  for (const [pattern, targets] of paths) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (spec !== pattern) continue;
      for (const t of targets) { const hit = matchFile(joinBase(t), fileRels); if (hit) return hit; }
    } else {
      const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
      if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
      const captured = spec.slice(prefix.length, spec.length - suffix.length);
      for (const t of targets) { const hit = matchFile(joinBase(t.replace("*", captured)), fileRels); if (hit) return hit; }
    }
  }
  // A bare baseUrl-relative import ("utils/foo" -> <baseUrl>/utils/foo) when baseUrl is set.
  if (baseUrl != null) { const hit = matchFile(joinBase(spec), fileRels); if (hit) return hit; }
  return null;
}

// Strip JSONC comments (string-aware) and trailing commas so a real-world tsconfig parses.
function stripJsonc(s) {
  let out = "", inStr = false, q = "", esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// Read compilerOptions.paths/baseUrl from tsconfig.json (or jsconfig.json). Returns
// { baseUrl, paths: [[pattern, [targets]], ...] } with root-relative posix targets, or null. `extends`
// and multi-file project references are not followed (a documented v1 limitation).
export function readAliasConfig(root, readFile = fs.readFileSync) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let raw;
    try { raw = String(readFile(path.join(root, name), "utf8")); } catch { continue; }
    let cfg;
    try { cfg = JSON.parse(raw); } catch { try { cfg = JSON.parse(stripJsonc(raw)); } catch { continue; } }
    const co = cfg?.compilerOptions;
    if (!co) continue;
    const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : (co.paths ? "." : null);
    const paths = [];
    if (co.paths && typeof co.paths === "object") {
      for (const [pattern, targets] of Object.entries(co.paths)) {
        if (Array.isArray(targets)) paths.push([pattern, targets.filter((t) => typeof t === "string")]);
      }
    }
    if (baseUrl == null && !paths.length) continue;
    return { baseUrl, paths };
  }
  return null;
}

/** Read source files once into independently replaceable extraction records. */
export function createCodeFactIndex(root, { exts = DEFAULT_EXTS, readFile = fs.readFileSync, onProgress, maxFiles = Infinity } = {}) {
  const absoluteRoot = path.resolve(root);
  const records = new Map();
  // Walk first so progress has a denominator: on a big repository the first
  // chat request sat behind an invisible index build and felt unresponsive
  // (operator taste report, 2026-08-18). The walk is cheap next to reading
  // and extracting every file; knowing the total is what buys the bar.
  const files = [...walk(absoluteRoot, exts, { maxFiles })];   // throws WorkspaceTooLargeError past the ceiling
  files.forEach((file, i) => {
    const relative = portableRelative(absoluteRoot, file);
    let source;
    try { source = readFile(file, "utf8"); } catch { return; }
    records.set(relative, extractFileRecord(relative, String(source)));
    if (onProgress && (i % 20 === 0 || i === files.length - 1)) {
      try { onProgress({ done: i + 1, total: files.length }); } catch { /* progress must never break the build */ }
    }
  });
  return { root: absoluteRoot, exts: [...exts], records };
}

/** Return a new index with only the named source records reread or removed. */
/** Would the walk skip this root-relative path? (SKIP_DIRS and .bantamignore, at any depth.) */
function walkWouldSkip(relative, ig) {
  const parts = relative.split("/");
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (SKIP_DIRS.has(parts[i]) || ig.names.has(parts[i])) return true;
    if (ig.rels.size && ig.rels.has(parts.slice(0, i + 1).join("/"))) return true;
  }
  return false;
}

export function refreshCodeFactIndex(index, changedPaths, { readFile = fs.readFileSync } = {}) {
  if (!index?.root || !(index.records instanceof Map)) {
    return { ok: false, error: "code fact index is unavailable", refreshed: [], removed: [], ignored: [] };
  }
  const nextRecords = new Map(index.records);
  // A path the walk would skip is evicted, never re-read: a directory added to
  // .bantamignore used to survive every reconcile (2026-08-24, PREFIXTESTING/).
  const ig = loadIgnores(index.root);
  const refreshed = [];
  const removed = [];
  const ignored = [];
  const seen = new Set();
  try {
    for (const changedPath of changedPaths ?? []) {
      const relative = normalizeChangedPath(index.root, changedPath);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      if (!index.exts.some((ext) => relative.endsWith(ext))) {
        ignored.push(relative);
        continue;
      }
      const absolute = path.resolve(index.root, relative);
      let stat = null;
      try { stat = fs.lstatSync(absolute); } catch { /* file may have been deleted between listing and stat */ }
      if (!stat?.isFile() || walkWouldSkip(relative, ig)) {
        if (stat?.isSymbolicLink()) throw new Error(`refusing to refresh source through symlink: ${relative}`);
        nextRecords.delete(relative);
        removed.push(relative);
        continue;
      }
      const source = String(readFile(absolute, "utf8"));
      nextRecords.set(relative, extractFileRecord(relative, source));
      refreshed.push(relative);
    }
  } catch (error) {
    return { ok: false, error: error.message, refreshed: [], removed: [], ignored };
  }
  return {
    ok: true,
    index: { root: index.root, exts: [...index.exts], records: nextRecords },
    refreshed,
    removed,
    ignored,
  };
}

/** Materialize base and derived relations from cached extraction records. */
export function materializeCodeFacts(db, index) {
  const text = new Map();
  const symbolNames = new Set();
  const fileRels = new Set();
  const importPairs = [];
  const softByFile = new Map();   // rel -> Set of `from . import X` specs (submodule-or-symbol, never unresolved)

  for (const [rel, record] of index.records) {
    text.set(rel, record.source);
    fileRels.add(rel);
    db.fact("file", rel);
    if (isTestPath(rel)) db.fact("test", rel);   // classify test files so scoped verification can reach them
    for (const [symbol, line] of record.definedAt ?? []) {
      db.fact("defined_at", rel, symbol, line);
    }
    for (const symbol of record.exported ?? []) {
      db.fact("exported", rel, symbol);
    }
    for (const symbol of record.defines) {
      db.fact("defines", rel, symbol);
      symbolNames.add(symbol);
    }
    for (const spec of record.imports) {
      db.fact("imports", rel, spec);
      importPairs.push([rel, spec]);
    }
    if (record.softImports?.length) softByFile.set(rel, new Set(record.softImports));
  }

  // Executable files are first-class structural facts. JavaScript CLIs often
  // run at module top level and therefore have no `main()` symbol; treating
  // only named functions as entrypoints made package `bin` programs look like
  // libraries and hid their startup/dispatch ordering from every KB query.
  const entrypoints = discoverEntrypointPaths(index);
  for (const rel of entrypoints) db.fact("entrypoint", rel);

  // precise dependency edges from the RESOLVED import graph — an import that resolves to a real
  // file is a true dependency (vs. the old symbol-name heuristic, which over-linked files that
  // merely shared a name). External/bare specifiers (e.g. "zod") have no internal target. A
  // tsconfig/jsconfig alias map (if any) lets `@/x`-style imports resolve to real edges too.
  const aliasConfig = index.root ? readAliasConfig(index.root) : null;
  for (const [rel, spec] of importPairs) {
    const isPy = rel.endsWith(".py");
    const soft = isPy && softByFile.get(rel)?.has(spec);
    let target = isPy ? resolvePyImport(rel, spec, fileRels) : resolveImport(rel, spec, fileRels, aliasConfig);
    // `from . import X` where X is a symbol in the package __init__, not a submodule: fall back to the
    // package itself (the dots) — X is real, so this is a true dependency, never a broken import.
    if (!target && soft) { const dots = (/^(\.+)/.exec(spec) || [, ""])[1]; if (dots) target = resolvePyImport(rel, dots, fileRels); }
    if (target && target !== rel) db.fact("depends", rel, target);
    // A relative import (incl. a re-export barrel) that resolves to NO real file is broken — a typo or
    // a missing/renamed module the model just introduced. Track it so a pre-gate/query can flag it
    // before a full verify cycle. Bare/external specifiers (e.g. "zod") are not ours to resolve, and a
    // `from . import <symbol>` (soft) is never broken — the symbol lives in the package.
    else if (!target && !soft && spec[0] === ".") db.fact("unresolved", rel, spec);
  }

  // pass 2 — call edges. Scan each source once, then retain tokens known to be definitions.
  // The previous symbol×file regex cross-product dominated incremental refresh latency.
  for (const [rel, src] of text) {
    CALL_RE.lastIndex = 0;
    for (const match of src.matchAll(CALL_RE)) {
      const symbol = match[1];
      if (symbol.length >= 3 && symbolNames.has(symbol)) db.fact("calls", rel, symbol);
    }
  }

  // rules — deduction the LLM would otherwise do slowly and unreliably. `depends` is now a
  // precise fact (resolved import edges); `reaches` is its transitive closure.
  db.rule("symbol(S) :- defines(F, S)");
  db.rule("reaches(A, B) :- depends(A, B)");
  db.rule("reaches(A, C) :- depends(A, B), reaches(B, C)");
  db.run();

  return {
    files: index.records.size,
    defines: db.count("defines"),
    imports: db.count("imports"),
    calls: db.count("calls"),
    symbols: db.count("symbol"),
    depends: db.count("depends"),
    reaches: db.count("reaches"),
    tests: db.count("test"),
    entrypoints: db.count("entrypoint"),
    filePaths: [...text.keys()],
  };
}

function discoverEntrypointPaths(index) {
  const out = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(index.root, "package.json"), "utf8"));
    const values = typeof pkg?.bin === "string"
      ? [pkg.bin]
      : (pkg?.bin && typeof pkg.bin === "object" ? Object.values(pkg.bin) : []);
    for (const value of values) {
      if (typeof value !== "string") continue;
      const rel = value.replace(/\\/g, "/").replace(/^\.\//, "");
      if (index.records.has(rel)) out.add(rel);
    }
  } catch { /* package metadata is optional */ }
  for (const [rel, record] of index.records) {
    if (/^\s*#!/.test(record.source)) out.add(rel);
  }
  return [...out].sort();
}

/**
 * Which test files could be affected by editing `changedRels`? A test is affected if it IS one of the
 * changed files, or it transitively `reaches` (imports — through re-export barrels too) one of them.
 * This is the static under-approximation behind test-impact scoping (roadmap 1.1): a fast pre-filter to
 * pair with runtime coverage for soundness. Returns the affected test paths (workspace-relative).
 */
export function affectedTests(db, changedRels) {
  // The graph is keyed by canonical posix relatives (portableRelative), but callers pass the model's
  // raw `action.p` — which may carry `./`, `..` segments, or a trailing slash. Compare canonically, or
  // a non-canonical path silently matches nothing and its affected tests are dropped (a false clear when
  // mixed with a canonical path that keeps the plan non-empty).
  const changed = new Set((changedRels || []).map(canonRel).filter(Boolean));
  const out = new Set();
  for (const [t] of db.query("test", "?t")) {
    if (changed.has(t)) { out.add(t); continue; }
    for (const f of changed) {
      if (db.has("reaches", t, f)) { out.add(t); break; }
    }
  }
  return [...out];
}

/** Extract facts from `root` into `db`, run the rules, and return summary stats plus the cache. */
export function extractCodeFacts(db, root, options = {}) {
  const index = createCodeFactIndex(root, options);
  return { ...materializeCodeFacts(db, index), index };
}

function extractFileRecord(relative, source) {
  const defines = new Set();
  // Location as well as name. `defines(file, symbol)` alone made every symbol
  // answer a file the model then had to page through; the match offset is
  // already here, so the line costs one newline count (2026-08-16).
  const definedAt = new Map();
  // Which of those definitions are exported. When a symbol list must be cut,
  // the exported surface is what a caller is actually looking for (measured
  // 2026-08-16: `symbols src/agent.js` returned 663 names capped at an
  // arbitrary 60).
  const exported = new Set();
  const lineOf = (offset) => {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === "\n") line += 1;
    return line;
  };
  for (const re of DEF_PATTERNS) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      defines.add(match[1]);
      if (/\bexport\b/.test(match[0])) exported.add(match[1]);
      if (!definedAt.has(match[1])) {
        // Locate the captured NAME inside the match, not the match start: the
        // patterns begin with `(?:^|\n)\s*`, and that `\s*` swallows blank
        // lines, which put the recorded line one early on any declaration
        // preceded by a blank line.
        const offset = match.index + Math.max(0, match[0].lastIndexOf(match[1]));
        definedAt.set(match[1], lineOf(offset));
      }
    }
  }
  let imports, softImports = [];
  if (relative.endsWith(".py") && process.env.BANTAM_PY_IMPORTS !== "0") {
    ({ specs: imports, soft: softImports } = extractPyImports(source));
  } else {
    imports = extractJsImports(source);
  }
  return {
    path: relative, source, defines: [...defines], definedAt: [...definedAt],
    exported: [...exported], imports, softImports,
  };
}

function normalizeChangedPath(root, changedPath) {
  if (!changedPath || typeof changedPath !== "string") return null;
  const absolute = path.isAbsolute(changedPath) ? path.resolve(changedPath) : path.resolve(root, changedPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function portableRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

// Canonicalize a workspace-relative path to the same form the graph is keyed by: posix separators,
// no `./` prefix, `..` segments collapsed, no trailing slash. (Absolute paths are left as-is; they
// won't match relative keys, which is the correct "unknown file" outcome.)
function canonRel(p) {
  if (p == null) return "";
  let s = path.posix.normalize(String(p).split(path.sep).join("/"));
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s === "." ? "" : s;
}

/** Suggest existing file paths close to a (possibly wrong) one — grounding for a bad read/edit. */
export function nearestFiles(db, wrong, k = 3) {
  const target = path.basename(String(wrong));
  const scored = db.query("file", "?").map((r) => r[0]).map((p) => [p, similarity(path.basename(p), target)]);
  return scored.filter(([, s]) => s > 0.4).sort((a, b) => b[1] - a[1]).slice(0, k).map(([p]) => p);
}

function similarity(a, b) {
  if (a === b) return 1;
  const A = new Set(a.toLowerCase()), B = new Set(b.toLowerCase());
  const inter = [...A].filter((c) => B.has(c)).length;
  return inter / new Set([...A, ...B]).size;
}
