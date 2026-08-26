// Edit-time context enrichment: two bounded footers appended to a successful
// edit's observation, both built from facts the grounding KB already holds.
//
// [impact] — symbols the edit text mentions that are defined somewhere in the
// repo get a cross-file reference list. Specimen: swb2-django-aliasin
// (2026-07-17) wrote `clone.clear_select_clause()` — a call whose other
// reference sites include related_lookups.py, the gold patch's second file,
// which the model never opened across four runs.
//
// [family] — a NEW definition whose name is an affix-variant of an existing
// pair gets the family's implementations. Specimen: swb2-django-escapeseq:
// adding `escapeseq` beside `safeseq` implies the base pair escape/safe; the
// gold body is the sibling convention (`conditional_escape`), which sat 45
// lines out of the model's read window in every failing run.
//
// Both say only true, repo-derived facts; neither mentions any task.

import { detectCrossFileReaders, familyFindings as coreFamilyFindings } from "./logic/completeness-critic.js";

const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g;

const GENERIC_NAMES = new Set([
  "self", "this", "return", "import", "export", "const", "class", "function",
  "async", "await", "print", "value", "values", "result", "results", "error",
  "errors", "object", "objects", "content", "context", "request", "response",
  "settings", "options", "kwargs", "args", "None", "True", "False", "default",
]);

function editText(action, { addedOnly = false } = {}) {
  const parts = addedOnly
    ? [action?.new, action?.content, action?.text]
    : [action?.old, action?.new, action?.content, action?.text];
  if (action?.a === "write_batch" && Array.isArray(action.files)) {
    parts.push(...action.files.map((file) => file?.content));
  }
  return parts.filter((t) => typeof t === "string").join("\n");
}

function normalizeRel(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function definedNames(db) {
  const names = new Map(); // name -> [files]
  let rows;
  try { rows = db.query("defines", "?", "?"); } catch { return names; }
  for (const [file, name] of rows) {
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(normalizeRel(file));
  }
  return names;
}

/**
 * Cross-file reference map for KB-defined symbols the edit mentions.
 * Bounded: at most `maxSymbols` symbols, each with 1..maxRefs other files;
 * a symbol referenced more widely is repo furniture, not a signal.
 */
export function impactFooter({ ground, action, editedFile, seen, maxSymbols = 3, maxRefs = 8 }) {
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map) || !ground?.db) return "";
  const text = editText(action);
  if (!text) return "";
  const names = definedNames(ground.db);
  if (!names.size) return "";
  const edited = normalizeRel(editedFile);
  const mentioned = [...new Set(text.match(IDENT_RE) ?? [])];
  const findings = [];
  for (const name of mentioned) {
    if (findings.length >= maxSymbols) break;
    if (seen?.has(name) || GENERIC_NAMES.has(name) || !names.has(name)) continue;
    const refs = [];
    for (const [file, record] of records) {
      const rel = normalizeRel(file);
      if (rel === edited) continue;
      if (typeof record?.source === "string" && record.source.includes(name)) {
        refs.push(rel);
        if (refs.length > maxRefs) break;
      }
    }
    if (!refs.length || refs.length > maxRefs) continue;
    seen?.add(name);
    findings.push(`\`${name}\` is also referenced in: ${refs.join(", ")}`);
  }
  if (!findings.length) return "";
  return `\n[impact] Cross-file references for symbols in this edit — if the change alters their contract, these sites are affected:\n  ${findings.join("\n  ")}`;
}


// Numeric-keyed constant tables written from memory are a measured defect
// class: the 2026-08-18 bake-off's arm-C shifted the entire GGML quant enum
// by one (the real enum has deleted entries; recalled versions assume
// contiguity) while every byte-derived fact in the same tool was exact. The
// note fires at the moment of risk — a literal int->value table landing in an
// edit — and points at the countermeasure: read the table from an
// authoritative source; never recall it.
const INT_KEY_ENTRY_RE = /(?:^|[{,\n])\s*\d{1,4}\s*:\s*[("'\[{a-zA-Z]/g;
export function constantTableFooter(action) {
  const text = editText(action);
  if (!text) return "";
  const hits = text.match(INT_KEY_ENTRY_RE) ?? [];
  if (hits.length < 3) return "";
  return `\n[provenance] This edit embeds a numeric-keyed constant table (${hits.length} entries).`
    + ` If those numbers mirror an external standard (an enum, a format spec, a protocol), do not`
    + ` trust recall: real enums have holes from deleted entries, and remembered tables shift.`
    + ` Read the authoritative table from a source reachable here (search the mounted toolchain or`
    + ` installed packages for it) and verify at least two entries before relying on the mapping.`;
}

// A file-scoped search for a symbol hides the symbol's cross-file readers —
// swb2-django-aliasin (2026-07-17): the model searched `has_select_fields`
// scoped to query.py, saw 2 same-file hits, and never learned it is read in
// related_lookups.py:93 to gate clearing an __in subquery's columns — the
// exact causal link to the bug. When a search narrows to one file/subtree and
// the query is a KB-defined symbol, surface up to `maxHits` usage sites that
// live OUTSIDE the searched scope, from the KB's cached sources.

export function crossScopeUsageFooter({ action, ground, maxHits = 6 }) {
  // Detection lives in the completeness critic (one source of truth); this
  // formats its structured challenge into the [cross-file] footer string.
  const challenges = detectCrossFileReaders({ ground, action, maxHits });
  if (!challenges.length) return '';
  const c = challenges[0];
  const q = c.target;
  const scopeRel = normalizeRel(action.p).replace(/\/+$/, '');
  const hits = c.sites.map((s) => `${s.file}:${s.line}: ${s.excerpt}`);
  return `\n[cross-file] Your search for \`${q}\` was scoped to ${scopeRel}, but \`${q}\` is also used outside it:\n  ${hits.join('\n  ')}\nThese call sites show how \`${q}\` is consumed elsewhere — check them before assuming its role.`;
}

// An edit that hand-rolls an operation on a shared named resource, when the
// repo already has a function doing that operation more completely.
// swb2-django-fallbackauth (2026-07-17): the model set
// request.session[HASH_SESSION_KEY] = ... (re-mint) but not cycle_key(); the
// canonical helper update_session_auth_hash() does BOTH and sits 20 lines away
// in the same file — invisible to the cross-file footer, which excludes
// same-file peers. When an edit references a rarely-used KB symbol, surface the
// OTHER functions that reference it (same file included), with a tight window
// so adjacent operations (the cycle_key() beside the assignment) are visible.
function enclosingFunction(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = /^(\s*)(?:async\s+)?(?:def|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
    if (m) return m[2];
  }
  return null;
}

export function peerFunctionFooter({ ground, action, editedFile, seen, maxRefs = 6, maxPeers = 2, window = 3 }) {
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map) || !ground?.db) return '';
  const text = editText(action);
  if (!text) return '';
  const edited = normalizeRel(editedFile);
  const mentioned = [...new Set(text.match(IDENT_RE) ?? [])]
    .filter((n) => !GENERIC_NAMES.has(n) && n.length >= 4);
  for (const name of mentioned) {
    if (seen?.has(`peer:${name}`)) continue;
    let defined;
    try { defined = ground.db.query('defines', '?', name).length > 0; } catch { continue; }
    if (!defined) continue;
    // Collect reference sites across KB SOURCE (tests/repro carry the operation
    // being tested, not the canonical implementation an edit should mirror).
    const sites = [];
    let total = 0;
    for (const [file, record] of records) {
      const rel = normalizeRel(file);
      if (/(?:^|\/)tests?\//.test(rel) || /(?:^|\/|_)test[_.]/.test(rel) || /(?:^|\/)repro\.py$/.test(rel)) continue;
      if (typeof record?.source !== 'string' || !record.source.includes(name)) continue;
      const lines = record.source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!new RegExp(`\\b${name}\\b`).test(lines[i])) continue;
        total += 1;
        if (total > maxRefs) break;
        // A definition line of `name` itself is not a peer USE.
        if (new RegExp(`^\\s*(?:async\\s+)?(?:def|function|class)\\s+${name}\\b|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=|^\\s*${name}\\s*=`).test(lines[i])) continue;
        sites.push({ file: normalizeRel(file), lines, idx: i });
      }
      if (total > maxRefs) break;
    }
    if (total === 0 || total > maxRefs) continue; // absent or too common to be a signal
    // Write sites (the operation being hand-rolled) rank above reads — they
    // carry the adjacent steps (cycle_key beside the HASH_SESSION_KEY assignment)
    // an edit may be missing. The edited region's own text is skipped so the
    // model is not shown its own line back.
    // Writes (the operation being hand-rolled) rank above reads: they carry the
    // adjacent steps — cycle_key()/rotate_token() beside the assignment — an
    // edit may be missing. A read-only enclosing function (e.g. the one the
    // model is editing, which only *checks* the hash) naturally sorts below.
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
      // Once at least one write-peer is shown, stop at reads — the canonical
      // pattern is a write, and read sites add noise, not the missing step.
      if (sawWrite && !site.write) break;
      seenFns.add(`${site.file}:${fn}`);
      if (site.write) sawWrite = true;
      const from = Math.max(0, site.idx - window);
      const to = Math.min(site.lines.length, site.idx + window + 1);
      peers.push(`— \`${fn}\` (${site.file}:${site.idx + 1}):\n${site.lines.slice(from, to).join('\n')}`);
      if (peers.length >= maxPeers) break;
    }
    if (!peers.length) continue;
    seen?.add(`peer:${name}`);
    return `\n[peer] \`${name}\` is also handled elsewhere in this repo. These functions operate on it — check whether they do something around it your edit is missing:\n${peers.join('\n')}`;
  }
  return '';
}


function definitionBlock(records, file, name, maxLines = 10) {
  const record = records.get(file) ?? records.get(`${file}`);
  const source = record?.source;
  if (typeof source !== "string") return null;
  const lines = source.split("\n");
  const defRe = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|function|class)\\s+${name}\\b|^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    const m = defRe.exec(lines[i]);
    if (!m) continue;
    const indent = (m[1] ?? m[2] ?? "").length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && block.length < maxLines; j++) {
      const line = lines[j];
      const stripped = line.trim();
      if (stripped && !line.startsWith(" ".repeat(indent + 1)) && /^(?:@|(?:async\s+)?def |function |class |})/.test(stripped) && j > i + 1) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return null;
}

/**
 * Structured family finding for a NEW definition whose name is an affix-variant
 * of an existing pair. Detection lives in the completeness critic (one source of
 * truth); this delegates. The legacy `symbolsIn` parameter is accepted and
 * ignored — the critic imports its own.
 */
export function familyFindings({ ground, action, editedFile }) {
  return coreFamilyFindings({ ground, action, editedFile });
}

export function familyBlocks(ground, finding, maxLines = 10) {
  const records = ground?.factIndex?.records;
  if (!(records instanceof Map)) return { baseBlock: null, mateBlock: null };
  return {
    baseBlock: definitionBlock(records, finding.baseFile, finding.base, maxLines),
    mateBlock: definitionBlock(records, finding.mateFile, finding.mate, maxLines),
  };
}

/** Edit-observation formatting of the first unseen family finding. */
export function familyFooter({ ground, action, editedFile, seen, symbolsIn }) {
  for (const finding of familyFindings({ ground, action, editedFile, symbolsIn })) {
    if (seen?.has(`family:${finding.name}`)) continue;
    const { baseBlock, mateBlock } = familyBlocks(ground, finding);
    const shown = [
      baseBlock ? `— \`${finding.base}\` (${finding.baseFile}):\n${baseBlock}` : null,
      mateBlock ? `— \`${finding.mate}\` (${finding.mateFile}):\n${mateBlock}` : null,
    ].filter(Boolean).join("\n");
    if (!shown) continue;
    seen?.add(`family:${finding.name}`);
    return `\n[family] \`${finding.name}\` joins an existing naming family (\`${finding.base}\` + \`${finding.mate}\`). Their implementations carry the conventions the new member is expected to share:\n${shown}`;
  }
  return "";
}

/**
 * Shorten a `uses <symbol>` answer to the part that changes a decision.
 *
 * The KB lists up to 60 call sites. Pasted unprompted into an observation that
 * is worth ~200 characters of steer, that spends more of the prompt than the
 * repeated searches it is answering. The count is what reframes the task — a
 * 14-site contract is not a one-site fix — and the first few sites are where to
 * start reading; the rest are one `query` away.
 */
export function trimSiteList(line, symbol, { maxSites = 6 } = {}) {
  if (typeof line !== "string" || line.length <= 400) return line;
  const at = line.indexOf(": ");
  if (at === -1) return line;
  const sites = line.slice(at + 2).replace(/\.\s*$/, "").split(", ");
  if (sites.length <= maxSites) return line;
  const kept = sites.slice(0, maxSites).join(", ");
  return `${line.slice(0, at + 2)}${kept}`
    + ` … +${sites.length - maxSites} more (\`query uses ${symbol}\` lists them all).`;
}
