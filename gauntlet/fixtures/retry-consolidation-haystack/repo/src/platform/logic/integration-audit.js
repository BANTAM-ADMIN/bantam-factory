// Does the self-improvement pipeline's output actually reach the agent loop?
//
// Audited 2026-07-30: of the 29 proposal modules `self-improve.js` registers,
// 3 are imported from src/ or bin/, 13 only from test/, and 13 by nothing at all
// -- 4,336 lines built, sometimes verified, never executed by a run. The build
// and score steps of governed self-improvement demonstrably work; integration is
// the step that does not happen, and a remedy that never reaches the loop cannot
// change a run's behaviour.
//
// This makes that measurable so the next generated module is noticed rather than
// accumulated. See
// docs/superpowers/reports/2026-07-30-self-improvement-integration-audit.md
//
// Two traps this deliberately avoids, both of which the manual audit fell into
// first:
//   - the registry names its own files as STRING LITERALS, so a bare-filename
//     grep counts them as imports and reports zero orphans;
//   - searching only src/ and bin/ misfiles test-covered modules as entirely
//     unreferenced. Test coverage is a different state from production wiring and
//     is reported separately.

import fs from "node:fs";
import path from "node:path";

const REGISTRY = "src/self-improve.js";

/** Filenames the improvement registry claims each proposal builds. */
export function proposalModules(root = ".") {
  let source;
  try { source = fs.readFileSync(path.join(root, REGISTRY), "utf8"); } catch { return []; }
  const files = new Set();
  for (const [, list] of source.matchAll(/files:\s*\[([^\]]*)\]/g)) {
    for (const [, name] of list.matchAll(/["']([^"']+\.m?js)["']/g)) files.add(name);
  }
  return [...files];
}

function* sourceFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".bantam") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p, depth + 1);
    else if (e.isFile() && /\.m?js$/.test(e.name)) yield p;
  }
}

// Only a real module specifier counts. `files: ["x.js"]` in the registry does not.
function importsModule(source, moduleFile) {
  const stem = moduleFile.replace(/\.m?js$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spec = `["'][^"']*/?${stem}\\.m?js["']`;
  return new RegExp(`(?:from|import\\s*\\()\\s*${spec}`).test(source);
}

// wc -l semantics: a trailing newline terminates the last line, it does not start
// a new empty one.
function countLines(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch { return 0; }
}

/**
 * Split every generated proposal module by how it is reached.
 *
 * @returns {{wired:Array,testOnly:Array,unreferenced:Array,missing:string[],totals:object}}
 */
export function auditIntegration(root = ".") {
  const wired = [];
  const testOnly = [];
  const unreferenced = [];
  const missing = [];

  const prodRoots = ["src", "bin"].map((d) => path.join(root, d));
  const testRoots = [path.join(root, "test")];
  const read = (roots) => {
    const out = [];
    for (const r of roots) for (const f of sourceFiles(r)) out.push([f, fs.readFileSync(f, "utf8")]);
    return out;
  };
  const prod = read(prodRoots);
  const tests = read(testRoots);

  for (const file of proposalModules(root)) {
    const full = path.join(root, "src", file);
    if (!fs.existsSync(full)) { missing.push(file); continue; }
    const self = path.resolve(full);
    const entry = { file, lines: countLines(full) };

    const prodImporters = prod
      .filter(([p, s]) => path.resolve(p) !== self && importsModule(s, file))
      .map(([p]) => path.basename(p));
    if (prodImporters.length) { wired.push({ ...entry, importers: prodImporters }); continue; }

    const testImporters = tests
      .filter(([p, s]) => importsModule(s, file))
      .map(([p]) => path.basename(p));
    if (testImporters.length) testOnly.push({ ...entry, importers: testImporters });
    else unreferenced.push(entry);
  }

  const sum = (xs) => xs.reduce((n, m) => n + m.lines, 0);
  return {
    wired, testOnly, unreferenced, missing,
    totals: {
      wiredLines: sum(wired),
      testOnlyLines: sum(testOnly),
      unreferencedLines: sum(unreferenced),
      shelvedLines: sum(testOnly) + sum(unreferenced),
    },
  };
}

/** Human summary. "" is never returned; a clean tree says so explicitly. */
export function formatIntegrationAudit(audit) {
  const { wired, testOnly, unreferenced, totals } = audit;
  const shelved = [...testOnly, ...unreferenced];
  if (!shelved.length) {
    return `[integration-audit] every generated proposal module is wired into the agent loop (${wired.length} wired).`;
  }
  const lines = [
    `[integration-audit] ${wired.length} wired, ${testOnly.length} tested-but-not-wired, `
    + `${unreferenced.length} unreferenced (${totals.shelvedLines} lines never executed by a run).`,
  ];
  for (const m of [...shelved].sort((a, b) => b.lines - a.lines).slice(0, 10)) {
    const how = m.importers ? `test-only (${m.importers.join(", ")})` : "no import at all";
    lines.push(`  ${m.file.padEnd(30)} ${String(m.lines).padStart(5)} lines  ${how}`);
  }
  lines.push("A remedy that never reaches the loop cannot change a run. Give each an explicit");
  lines.push("call site behind a flag, or retire it -- the registry can rebuild it on demand.");
  return lines.join("\n");
}

// CLI: `node integration-audit.js [root]`
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  console.log(formatIntegrationAudit(auditIntegration(process.argv[2] || ".")));
}
