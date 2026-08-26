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

// D14. Citation cannot distinguish "unwired by design" from "unwired by
// drift": one barrel import certifies every module the barrel re-exports.
// This walks actual reachability from things a person can run. Barrel edges
// are export-level — importing { A } from a barrel reaches only the module A
// is re-exported from; a namespace or side-effect import reaches everything,
// because it genuinely does.
//
// Tiers: "production" (reachable from bin/, CLI entry points, examples/),
// "script" (additionally reachable when scripts/ are roots — the lab
// surface, visible and legitimate), "exempted" (named, with a reason, so an
// unreachable module is a recorded choice), "unreachable" (drift; the
// ratchet's business).
export function auditReachability(root = ".", { exemptions = [] } = {}) {
  // Everything in the walk is absolute: roots enter relative when root is
  // ".", while resolved import targets are absolute, and a set that mixes
  // the two silently reaches nothing. The fixtures could not catch this —
  // mkdtemp roots are always absolute — so a relative-root test pins it.
  root = path.resolve(root);
  const srcModules = walk(path.join(root, "src"));
  const text = new Map();
  const read = (file) => {
    if (!text.has(file)) text.set(file, safeRead(file));
    return text.get(file);
  };

  const importClauses = (body) => {
    const clauses = [];
    for (const match of body.matchAll(/import\s+([^'"]*?)\s*from\s*["'`]([^"'`]+)["'`]/g)) {
      clauses.push({ kind: "import", clause: match[1].trim(), spec: match[2] });
    }
    for (const match of body.matchAll(/export\s+([^'"]*?)\s*from\s*["'`]([^"'`]+)["'`]/g)) {
      clauses.push({ kind: "reexport", clause: match[1].trim(), spec: match[2] });
    }
    for (const match of body.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      clauses.push({ kind: "import", clause: "*", spec: match[1] });
    }
    for (const match of body.matchAll(/require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      clauses.push({ kind: "import", clause: "*", spec: match[1] });
    }
    for (const match of body.matchAll(/import\s*["'`]([^"'`]+)["'`]/g)) {
      clauses.push({ kind: "import", clause: "*", spec: match[1] });
    }
    return clauses;
  };

  const clauseNames = (clause) => {
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (!named) return null;
    return named[1].split(",").map((raw) => raw.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean);
  };

  const resolveSpec = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  // export name -> source file, for barrel-style re-exports.
  const reexportMap = (file) => {
    const map = new Map();
    for (const match of read(file).matchAll(/export\s*\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g)) {
      const target = resolveSpec(file, match[2]);
      if (!target) continue;
      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) map.set(name, target);
      }
    }
    return map;
  };

  // Demanded-use reachability, deliberately not ESM loading semantics: at
  // runtime, importing one name from a barrel executes every module the
  // barrel re-exports, which is exactly why module loading is useless as a
  // drift signal here. A `export { X } from "./x.js"` clause fires only when
  // some reachable importer demands one of its names (or imports the file as
  // a namespace/default/side-effect, which demands everything). A module's
  // own plain imports always fire — they execute whenever the module does.
  const reach = (roots) => {
    const seen = new Map();
    const queue = roots.map((file) => ({ file, demand: null }));
    while (queue.length) {
      const { file, demand } = queue.shift();
      const prior = seen.get(file);
      if (prior?.full) continue;
      let effective = demand;
      if (demand === null) {
        seen.set(file, { full: true, names: null });
      } else if (!prior) {
        seen.set(file, { full: false, names: new Set(demand) });
      } else {
        effective = demand.filter((name) => !prior.names.has(name));
        if (!effective.length) continue;
        for (const name of effective) prior.names.add(name);
      }
      const demanded = effective === null ? null : new Set(effective);
      for (const { kind, clause, spec } of importClauses(read(file))) {
        const target = resolveSpec(file, spec);
        if (!target) continue;
        if (kind === "reexport") {
          // Fires only when demanded (or on a full visit). Once fired, the
          // re-exported module executes fully.
          const names = clauseNames(clause);
          const wanted = demanded === null
            || names === null
            || names.some((name) => demanded.has(name));
          if (wanted) queue.push({ file: target, demand: null });
          continue;
        }
        const names = clauseNames(clause);
        // A named import demands those names from the target; anything else
        // (namespace, default, side-effect, dynamic, require) demands all.
        queue.push({ file: target, demand: names });
      }
    }
    return new Set([...seen.entries()].filter(([, entry]) => entry.full || entry.names.size > 0).map(([file]) => file));
  };

  const cliEntries = srcModules.filter((file) => {
    const body = read(file);
    return /^#!/.test(body) || /^\s*\/\/[^\n]*\bUsage:\s*node\b/m.test(body);
  });
  const productionRoots = [...walk(path.join(root, "bin")), ...walk(path.join(root, "examples")), ...cliEntries];
  const production = reach(productionRoots);
  const withScripts = reach([...productionRoots, ...walk(path.join(root, "scripts"))]);

  const exemptionRows = exemptions.map((entry) => ({
    file: path.resolve(root, entry.file),
    relative: entry.file,
    reason: String(entry.reason ?? ""),
    used: false,
  }));

  const modules = srcModules.map((file) => {
    let tier;
    if (production.has(file)) tier = "production";
    else if (withScripts.has(file)) tier = "script";
    else {
      const exemption = exemptionRows.find((row) => row.file === file);
      if (exemption) { exemption.used = true; tier = "exempted"; }
      else tier = "unreachable";
    }
    const row = { file: path.relative(root, file), lines: read(file).split("\n").length, tier };
    if (tier === "exempted") row.reason = exemptionRows.find((entry) => entry.file === file).reason;
    return row;
  });
  const stale = exemptionRows.filter((row) => !row.used);
  if (stale.length) {
    throw new Error(`reachability exemption does not match any unreachable module: ${stale.map((row) => row.relative).join(", ")}`);
  }
  modules.sort((a, b) => b.lines - a.lines);
  const lines = (tier) => modules.filter((m) => m.tier === tier).reduce((n, m) => n + m.lines, 0);
  return {
    modules,
    totals: {
      productionLines: lines("production"),
      scriptLines: lines("script"),
      exemptedLines: lines("exempted"),
      unreachableLines: lines("unreachable"),
    },
  };
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
