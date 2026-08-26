// Which modules does nothing actually run?
//
// integration-audit answers this for files named in the self-improve proposal
// registry -- and only those. Modules outside that list were invisible to it, so
// the ratchet built on it guarded 1,587 lines while 2,995 sat unwatched, including
// three that nothing imports at all, not even a test.
//
// A guard that only watches where you already looked is not a guard. This scans
// every module under src/ against every consumer that could plausibly run it:
// src/, bin/, and examples/ -- the last of which a first version of this scan
// omitted, wrongly reporting several live tools as orphans.

import fs from "node:fs";
import path from "node:path";

const CODE = /\.m?js$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (CODE.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * @param {string} root
 * @returns {{orphans: Array<{file,lines,kind}>, totals: {unreferencedLines, testOnlyLines, orphanLines}}}
 */
export function auditOrphans(root = ".") {
  const modules = walk(path.join(root, "src"));
  const consumers = [
    ...modules,
    ...walk(path.join(root, "bin")),
    ...walk(path.join(root, "examples")),
  ];
  const consumerText = new Map(consumers.map((f) => [f, safeRead(f)]));
  const testText = walk(path.join(root, "test")).map(safeRead).join("\n");

  const orphans = [];
  for (const file of modules) {
    const base = path.basename(file);
    // Require actual import SYNTAX, not a quoted filename. The proposal registry
    // stores module names in plain arrays -- `files: ["turn-parallelism.js"]` --
    // and a first version of this check matched those, reporting shelved modules
    // as wired. That is precisely the defect this audit exists to find, so it had
    // to not have it.
    const quoted = base.replace(/\./g, "\\.");
    const spec = `["'\`][^"'\`]*${quoted}["'\`]`;
    const referenced = new RegExp(
      `(?:\\bfrom\\s*${spec})|(?:\\bimport\\s*\\(\\s*${spec})|(?:\\brequire\\s*\\(\\s*${spec})`,
    );
    const inProduction = consumers.some((c) => c !== file && referenced.test(consumerText.get(c) ?? ""));
    if (inProduction) continue;

    // Some modules are never imported because they are SPAWNED: preview-runner.mjs
    // and lock-recovery-child.js are launched by path with execFileSync. Their
    // filename appears in a plain string, which is indistinguishable from the
    // proposal registry's `files: ["x.js"]` arrays.
    //
    // The audit cannot tell those apart, so it must not choose. Reporting a spawned
    // entry point as dead code would invite deleting something load-bearing --
    // exactly the confident-wrong-answer failure this audit exists to catch.
    const nameOnly = new RegExp("[\"'`/]" + quoted + "[\"'`]");
    const mentioned = consumers.some((c) => c !== file && nameOnly.test(consumerText.get(c) ?? ""));

    // A standalone CLI is nobody's import and still very much alive:
    // health-dashboard.js declares `Usage: node src/health-dashboard.js [--json]`
    // and produces real output when run. Calling it dead code would have been the
    // third false-positive class in this audit, after omitting examples/ and
    // matching bare quoted filenames.
    const own = consumerText.get(file) ?? "";
    const isEntryPoint = /^#!/.test(own) || /^\s*\/\/[^\n]*\bUsage:\s*node\b/m.test(own);

    let kind;
    if (isEntryPoint) kind = "cli-entry";
    else if (referenced.test(testText)) kind = "test-only";
    else if (mentioned) kind = "possibly-spawned";
    else kind = "unreferenced";

    orphans.push({
      file: path.relative(root, file),
      lines: (consumerText.get(file) ?? "").split("\n").length,
      kind,
    });
  }
  orphans.sort((a, b) => b.lines - a.lines);

  const sum = (kind) => orphans.filter((o) => !kind || o.kind === kind).reduce((n, o) => n + o.lines, 0);
  return {
    orphans,
    totals: {
      orphanLines: sum(null),
      testOnlyLines: sum("test-only"),
      possiblySpawnedLines: sum("possibly-spawned"),
      cliEntryLines: sum("cli-entry"),
      unreferencedLines: sum("unreferenced"),
    },
  };
}

function safeRead(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

export function formatOrphanAudit(audit) {
  const lines = [`[orphan-audit] ${audit.orphans.length} module(s), ${audit.totals.orphanLines} lines, `
    + `that no production or example file imports`];
  for (const o of audit.orphans) {
    lines.push(`  ${String(o.lines).padStart(4)}  ${o.kind.padEnd(12)} ${o.file}`);
  }
  const dead = audit.orphans.filter((o) => o.kind === "unreferenced");
  if (dead.length) {
    lines.push(`  ${dead.length} module(s) are imported by NOTHING, not even a test: `
      + `${dead.map((o) => path.basename(o.file)).join(", ")}`);
  }
  const spawned = audit.orphans.filter((o) => o.kind === "possibly-spawned");
  if (spawned.length) {
    lines.push(`  ${spawned.length} module(s) are named in a string but never imported. `
      + "These may be SPAWNED entry points (execFileSync by path) or dead registry "
      + "entries; this audit cannot tell, and does not guess: "
      + `${spawned.map((o) => path.basename(o.file)).join(", ")}`);
  }
  return lines.join("\n");
}
