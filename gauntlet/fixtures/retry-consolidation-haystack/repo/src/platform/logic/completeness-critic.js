// Completeness critic — one engine that, given an edit and the grounded KB,
// enumerates structural completeness challenges: code the edit may have left
// undone, each backed by KB facts. It generalizes the mechanisms from the
// 2026-07-17 SWE-bench Verified round into five challenge kinds, and adds one
// the hand-built set never had: `transitive_dependent`, via the KB's `reaches`
// rule. Every Challenge carries `evidence` (fact records) so it is auditable.
//
// Pure: no model calls, no mutation of `ground`. Detectors read the grounding
// object (`{ db, factIndex }`) and plain inputs. The live gates/footers in
// edit-context.js and agent.js delegate here, so detection has one home.
//
// A Challenge:
//   { kind, target, sites: [{ file, line, excerpt? }], evidence: [{ rel, args }], rationale }

import fs from "node:fs";
import path from "node:path";
import { symbolsIn } from "../collateral.js";

const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const GENERIC_NAMES = new Set([
  "self", "this", "return", "import", "export", "const", "class", "function",
  "async", "await", "print", "value", "values", "result", "results", "error",
  "errors", "object", "objects", "content", "context", "request", "response",
  "settings", "options", "kwargs", "args", "None", "True", "False", "default",
]);

export function normalizeRel(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Tests and the harness's own repro.py exercise a symbol, they do not carry the
// canonical implementation an edit should mirror — both cross-file and peer
// detectors exclude them.
function isTestOrReproPath(rel) {
  return /(?:^|\/)tests?\//.test(rel) || /(?:^|\/|_)test[_.]/.test(rel) || /(?:^|\/)repro\.py$/.test(rel);
}

export function editText(action, { addedOnly = false } = {}) {
  const parts = addedOnly
    ? [action?.new, action?.content, action?.text]
    : [action?.old, action?.new, action?.content, action?.text];
  return parts.filter((t) => typeof t === "string").join("\n");
}

export function definedNames(db) {
  const names = new Map(); // name -> [files]
  let rows;
  try { rows = db.query("defines", "?", "?"); } catch { return names; }
  for (const [file, name] of rows) {
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(normalizeRel(file));
  }
  return names;
}

function enclosingFunction(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = /^(\s*)(?:async\s+)?(?:def|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (m) return m[2];
  }
  return null;
}

function splitAffix(name) {
  const splits = [];
  for (let i = 3; i <= name.length - 3; i++) {
    splits.push({ base: name.slice(0, i), affix: name.slice(i), kind: "suffix" });
    splits.push({ base: name.slice(name.length - i), affix: name.slice(0, name.length - i), kind: "prefix" });
  }
  return splits;
}

const DEF_LINE_RE = (name) =>
  new RegExp(`^\\s*(?:async\\s+)?(?:def|function|class)\\s+${name}\\b|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`);

// Definition line of `symbol` in an on-disk file, 1-indexed, or null.
function definitionLineOnDisk(file, symbol) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const re = DEF_LINE_RE(symbol);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  } catch { /* file gone */ }
  return null;
}

// Definition line of `symbol` in a KB-cached record source, 1-indexed, or null.
function definitionLineInRecords(records, file, symbol) {
  const source = records?.get?.(file)?.source;
  if (typeof source !== "string") return null;
  const lines = source.split("\n");
  const re = DEF_LINE_RE(symbol);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/**
 * sibling — an edited symbol defined in more than one file; the unvisited others
 * are challenges. (Generalizes agent.js siblingDefinitionFindings.)
 */
export function detectSiblings({ ground, editedSymbols, visited, workspace }) {
  const db = ground?.db;
  if (!db) return [];
  const seen = visited instanceof Set ? visited : new Set(visited ?? []);
  const out = [];
  for (const [symbol, editedFile] of editedSymbols ?? []) {
    let rows;
    try { rows = db.query("defines", "?", symbol); } catch { continue; }
    const others = [...new Set(rows.map((r) => normalizeRel(r[0])))]
      .filter((f) => f !== normalizeRel(editedFile) && !seen.has(f) && !isTestOrReproPath(f));
    if (!others.length || others.length > 3) continue; // 0: nothing; >3: repo furniture
    for (const other of others.slice(0, 2)) {
      out.push({
        kind: "sibling",
        target: symbol,
        sites: [{ file: other, line: definitionLineOnDisk(path.join(workspace ?? ".", other), symbol) }],
        evidence: [{ rel: "defines", args: [other, symbol] }],
        rationale: `\`${symbol}\` is also defined in ${other}, a file not examined; same-named definitions often share the bug or the contract.`,
      });
    }
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

/**
 * cross_file_reader — a file-scoped search for a KB-defined symbol hides the
 * symbol's readers outside that scope. (Generalizes crossScopeUsageFooter.)
 */
export function detectCrossFileReaders({ ground, action, visited, maxHits = 6 }) {
  if (action?.a !== "search") return [];
  const q = action.q, scope = action.p;
  if (typeof q !== "string" || !IDENTIFIER_RE.test(q) || q.length < 4) return [];
  if (typeof scope !== "string" || scope === "" || scope === "." || scope === "./") return [];
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map) || !ground?.db) return [];
  let defined;
  try { defined = ground.db.query("defines", "?", q).length > 0; } catch { return []; }
  if (!defined) return [];
  const scopeRel = normalizeRel(scope).replace(/\/+$/, "");
  const inScope = (rel) => rel === scopeRel || rel.startsWith(`${scopeRel}/`);
  const needle = new RegExp(`\\b${q}\\b`);
  const sites = [];
  for (const [file, record] of records) {
    const rel = normalizeRel(file);
    // Skip tests and the harness's own repro.py — a symbol's reader that matters
    // is source, not a test/repro that merely exercises it. (Mirrors detectPeers.)
    if (isTestOrReproPath(rel)) continue;
    if (inScope(rel) || typeof record?.source !== "string" || !record.source.includes(q)) continue;
    const lines = record.source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!needle.test(lines[i])) continue;
      if (/^\s*(?:async\s+)?(?:def|function|class)\s/.test(lines[i]) && lines[i].includes(q)) continue;
      sites.push({ file: rel, line: i + 1, excerpt: lines[i].trim().slice(0, 100) });
      break; // one representative line per file: a map, not a dump
    }
    if (sites.length >= maxHits) break;
  }
  if (!sites.length) return [];
  return [{
    kind: "cross_file_reader",
    target: q,
    sites,
    evidence: sites.map((s) => ({ rel: "reads", args: [s.file, q] })),
    rationale: `Your search for \`${q}\` was scoped to ${scopeRel}; it is also used outside that scope — check how it is consumed before assuming its role.`,
  }];
}

/**
 * family — a NEW definition whose name is an affix-variant of an existing pair.
 * (Generalizes familyFindings.) Returns the raw findings so edit-context can
 * reuse them for its formatted footer; detectFamily wraps them as challenges.
 */
export function familyFindings({ ground, action, editedFile }) {
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map) || !ground?.db) return [];
  const added = [...symbolsIn(editText(action, { addedOnly: true }))];
  if (!added.length) return [];
  const names = definedNames(ground.db);
  // A family's convention lives in source, not tests/repro. Resolve each name to
  // its first SOURCE definition; a name defined only in tests is not a family
  // signal an edit should mirror.
  const sourceFile = (n) => (names.get(n) ?? []).find((f) => !isTestOrReproPath(f)) ?? null;
  const definedInSource = (n) => sourceFile(n) !== null;
  const edited = normalizeRel(editedFile);
  // Test helpers describe specimens; they are not new production API members
  // that should inherit a source naming family's behavioral conventions.
  if (isTestOrReproPath(edited)) return [];
  const findings = [];
  for (const name of added) {
    const existing = names.get(name) ?? [];
    if (existing.some((f) => f !== edited)) continue; // only NEW names
    for (const { base, affix, kind } of splitAffix(name)) {
      if (!definedInSource(base)) continue;
      const mate = [...names.keys()].find((k) => {
        if (k === name || k === base || !definedInSource(k)) return false;
        const kBase = kind === "suffix"
          ? (k.endsWith(affix) ? k.slice(0, -affix.length) : null)
          : (k.startsWith(affix) ? k.slice(affix.length) : null);
        return kBase && kBase !== base && definedInSource(kBase);
      });
      if (!mate) continue;
      findings.push({ name, editedFile: edited, base, baseFile: sourceFile(base), mate, mateFile: sourceFile(mate) });
      break;
    }
  }
  return findings;
}

export function detectFamily({ ground, action, editedFile }) {
  const records = ground?.factIndex?.records;
  return familyFindings({ ground, action, editedFile }).map((f) => ({
    kind: "family",
    target: f.name,
    sites: [
      { file: f.baseFile, line: definitionLineInRecords(records, f.baseFile, f.base) },
      { file: f.mateFile, line: definitionLineInRecords(records, f.mateFile, f.mate) },
    ],
    evidence: [
      { rel: "defines", args: [f.baseFile, f.base] },
      { rel: "defines", args: [f.mateFile, f.mate] },
    ],
    rationale: `\`${f.name}\` joins the naming family \`${f.base}\`/\`${f.mate}\`; their implementations carry the conventions the new member should share.`,
  }));
}

/**
 * peer — an edit assigning a rare KB constant that other functions also write;
 * their adjacent steps (cycle_key beside a HASH_SESSION_KEY assignment) are the
 * step an edit may omit. (Generalizes peerFunctionFooter.)
 */
export function detectPeers({ ground, action, editedFile, maxRefs = 6, maxPeers = 2, window = 3 }) {
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map) || !ground?.db) return [];
  const text = editText(action);
  if (!text) return [];
  const mentioned = [...new Set(text.match(IDENT_RE) ?? [])]
    .filter((n) => !GENERIC_NAMES.has(n) && n.length >= 4);
  for (const name of mentioned) {
    let defined;
    try { defined = ground.db.query("defines", "?", name).length > 0; } catch { continue; }
    if (!defined) continue;
    const sites = [];
    let total = 0;
    let definingFile = null;
    for (const [file, record] of records) {
      const rel = normalizeRel(file);
      if (isTestOrReproPath(rel)) continue;
      if (typeof record?.source !== "string" || !record.source.includes(name)) continue;
      const lines = record.source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!new RegExp(`\\b${name}\\b`).test(lines[i])) continue;
        total += 1;
        if (total > maxRefs) break;
        if (new RegExp(`^\\s*(?:async\\s+)?(?:def|function|class)\\s+${name}\\b|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=|^\\s*${name}\\s*=`).test(lines[i])) {
          if (new RegExp(`^\\s*${name}\\s*=`).test(lines[i])) definingFile = rel;
          continue;
        }
        sites.push({ file: rel, lines, idx: i });
      }
      if (total > maxRefs) break;
    }
    if (total === 0 || total > maxRefs) continue; // absent or too common
    const isWrite = (line) => new RegExp(`\\b${name}\\b\\s*\\]?\\s*=(?!=)`).test(line);
    const ranked = sites
      .map((s) => ({ ...s, write: isWrite(s.lines[s.idx]) }))
      .sort((a, b) => (b.write ? 1 : 0) - (a.write ? 1 : 0));
    const peers = [];
    const seenFns = new Set();
    let sawWrite = false;
    for (const site of ranked) {
      const fn = enclosingFunction(site.lines, site.idx);
      if (!fn || seenFns.has(`${site.file}:${fn}`)) continue;
      if (sawWrite && !site.write) break; // write-peers first; reads add noise
      seenFns.add(`${site.file}:${fn}`);
      if (site.write) sawWrite = true;
      const from = Math.max(0, site.idx - window);
      const to = Math.min(site.lines.length, site.idx + window + 1);
      peers.push({ fn, file: site.file, line: site.idx + 1, excerpt: site.lines.slice(from, to).join("\n") });
      if (peers.length >= maxPeers) break;
    }
    if (!peers.length) continue;
    return [{
      kind: "peer",
      target: name,
      sites: peers.map((p) => ({ file: p.file, line: p.line, excerpt: p.excerpt })),
      evidence: [
        ...(definingFile ? [{ rel: "defines", args: [definingFile, name] }] : []),
        ...peers.map((p) => ({ rel: "writes", args: [p.file, name] })),
      ],
      rationale: `\`${name}\` is also written by ${peers.map((p) => `\`${p.fn}\` (${p.file}:${p.line})`).join(", ")}, which do this:\n${peers.map((p) => p.excerpt).join("\n---\n")}\nCheck whether your edit omits a step they perform.`,
    }];
  }
  return [];
}

/**
 * transitive_dependent (NEW) — files that transitively depend on the edited file
 * (via the KB's `reaches` rule) and were not examined. File granularity, bounded.
 */
export function detectTransitiveDependents({ ground, editedFiles, visited, maxDependents = 5 }) {
  const db = ground?.db;
  if (!db) return [];
  const seen = visited instanceof Set ? visited : new Set(visited ?? []);
  const out = [];
  for (const editedFile of editedFiles ?? []) {
    const F = normalizeRel(editedFile);
    let rows;
    try { rows = db.query("reaches", "?", F); } catch { continue; }
    const deps = [...new Set(rows.map((r) => normalizeRel(r[0])))]
      .filter((d) => d !== F && !seen.has(d));
    if (!deps.length || deps.length > maxDependents) continue; // 0: nothing; hub: noise
    out.push({
      kind: "transitive_dependent",
      target: F,
      sites: deps.slice(0, maxDependents).map((d) => ({ file: d, line: null })),
      evidence: deps.slice(0, maxDependents).map((d) => ({ rel: "reaches", args: [d, F] })),
      rationale: `${deps.length} file(s) transitively depend on ${F} (via the import graph) and were not examined; a contract change here can break them.`,
    });
  }
  return out;
}

/**
 * critique — run the applicable detectors for an action, dedup by
 * (kind, target, first-site file), cap total.
 */
export function critique({ action, ground, visited, editedSymbols, editedFiles, workspace, maxTotal = 6 }) {
  const all = [];
  if (editedSymbols) all.push(...detectSiblings({ ground, editedSymbols, visited, workspace }));
  if (action?.a === "search") all.push(...detectCrossFileReaders({ ground, action, visited }));
  if (action && action.p) {
    all.push(...detectFamily({ ground, action, editedFile: action.p }));
    all.push(...detectPeers({ ground, action, editedFile: action.p }));
  }
  if (editedFiles) all.push(...detectTransitiveDependents({ ground, editedFiles, visited }));
  const seen = new Set();
  const deduped = [];
  for (const c of all) {
    const key = `${c.kind}:${c.target}:${c.sites[0]?.file ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped.slice(0, maxTotal);
}
