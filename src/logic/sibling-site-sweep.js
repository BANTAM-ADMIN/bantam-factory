// Sibling-site sweep: after a guard/coercion edit, find the structural twin
// the fix skipped.
//
// SWE-bench v2 autopsy (2026-08-15): 7 of 8 django failures edited the exact
// gold file, and django-15572's patch was the gold patch's FIRST HUNK,
// byte-identical — the model guarded `backend.engine.dirs` and never swept the
// `loader.get_dirs()` comprehension three lines below. Same defect as
// channel-filter's Boolean(flag) and list-ops. Facts delivered at the done
// bounce get repaired (measured 2026-08-12, again 2026-08-15); this gate
// delivers the sibling site.
//
// Deliberately narrow: only fires when an edit ADDED a guard/coercion/type
// check, only reports unedited lines whose normalized shape matches the
// edited line's pre-guard shape, at most 3 sites, one bounce per run.
// Preregistration: docs/superpowers/reports/2026-08-15-sibling-site-sweep-preregistration.md

export const SIBLING_SWEEP_MARKER = "[sibling-sweep]";
const MAX_SITES = 3;

// Shapes a "fix" takes when it guards one site of several.
const GUARD_PATTERNS = [
  { kind: "if-guard", re: /\bif\s+[\w.]+\s*\)?\s*$|\bif\s+\w+\s+and\b|\bif\s+not\s+\w/ },
  { kind: "type-check", re: /\btypeof\s+\w+\s*!==|isinstance\s*\(|Array\.isArray|Number\.isInteger/ },
  { kind: "coercion", re: /\b(?:String|Boolean|Number|int|str|float|bool)\s*\(/ },
  { kind: "throw", re: /\bthrow\s+new\s+\w*Error|\braise\s+\w*Error/ },
];

export function guardSignature(line) {
  const text = String(line ?? "");
  for (const { kind, re } of GUARD_PATTERNS) {
    if (re.test(text)) return { kind, text: text.trim() };
  }
  return { kind: null, text: text.trim() };
}

// Reduce a line to the "what does it operate on" shape: identifiers and calls,
// stripped of the guard itself, so a guarded line and its unguarded twin
// collapse to comparable tokens.
function shapeTokens(line) {
  return new Set(
    String(line)
      .replace(/["'`][^"'`]*["'`]/g, "")          // literals carry no shape
      .match(/[A-Za-z_][\w.]*(?:\s*\()?/g)?.map((t) => t.replace(/\s*\($/, "()")) ?? [],
  );
}

const STRUCTURAL = /\bfor\b|\.update\(|\.push\(|\.append\(|=\s*\w+\(|\bin\b/;
// Keywords carry no data-flow meaning: two lines both containing `for`/`in`
// are not twins on that basis (an early version reported every loop in the
// enclosing block on django-15572).
const KEYWORDS = new Set(["for", "in", "if", "not", "and", "or", "return", "const", "let",
  "var", "of", "function", "def", "class", "self", "continue", "break", "new", "await", "async"]);

/**
 * Group physical lines into logical statements by paren balance, so a
 * multi-line comprehension (django-15572's `items.update(\n … \n if …)`) is
 * compared and guard-checked as ONE unit.
 */
function logicalStatements(lines) {
  const out = [];
  let depth = 0, from = 1, buf = [];
  for (let i = 1; i <= lines.length; i += 1) {
    const line = lines[i - 1];
    if (!buf.length) from = i;
    buf.push(line);
    for (const ch of line) {
      // Braces are excluded on purpose: `{` opens a BLOCK, not a continued
      // statement, and counting it swallowed whole JS functions into one unit.
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      out.push({ from, to: i, text: buf.join(" ") });
      buf = [];
    }
  }
  if (buf.length) out.push({ from, to: lines.length, text: buf.join(" ") });
  return out;
}

function dataTokens(text) {
  return new Set(
    String(text)
      .replace(/["'`][^"'`]*["'`]/g, "")
      .match(/[A-Za-z_][\w.]*(?:\s*\()?/g)?.map((t) => t.replace(/\s*\($/, "()"))
      .filter((t) => !KEYWORDS.has(t)) ?? [],
  );
}

const loopVarOf = (text) => text.match(/\bfor\s+(\w+)\s+in\b/)?.[1] ?? null;

/** Is this statement's loop variable already truthiness-guarded? */
function loopVarGuarded(text, variable) {
  if (!variable) return false;
  const v = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bif\\s+${v}\\b(?!\\s*[=!<>])`).test(text)
    || new RegExp(`\\bif\\s+${v}\\s+and\\b`).test(text);
}

/** Unedited statements that look like the edited statement's unguarded twin. */
export function siblingSites({ content, editedLines = [], path = "", wholeFile = false }) {
  const lines = String(content ?? "").split("\n");
  const statements = logicalStatements(lines);
  const out = [];
  const seen = new Set();
  for (const lineNo of editedLines) {
    const anchorStmt = statements.find((st) => lineNo >= st.from && lineNo <= st.to);
    if (!anchorStmt) continue;
    const sig = guardSignature(anchorStmt.text);
    if (!sig.kind) continue;
    const anchorTokens = dataTokens(anchorStmt.text);
    for (const st of statements) {
      if (st.from === anchorStmt.from) continue;                       // never the edited statement
      if (seen.has(st.from)) continue;
      if (!wholeFile && !withinBlock(lines, anchorStmt.from, st.from)) continue;
      if (!STRUCTURAL.test(st.text)) continue;
      const shared = [...dataTokens(st.text)].filter((t) => anchorTokens.has(t)).length;
      const coercesLikeTheBug = sig.kind === "type-check"
        && /\b(?:String|Boolean|Number)\s*\(/.test(st.text);
      if (shared < 2 && !coercesLikeTheBug) continue;
      // Already swept? For a truthiness guard that means THIS statement's own
      // loop variable is checked; for a coercion/type fix it means the guard
      // shape the edit introduced is present here too.
      const swept = sig.kind === "if-guard"
        ? loopVarGuarded(st.text, loopVarOf(st.text))
        : guardSignature(st.text).kind === sig.kind && !coercesLikeTheBug;
      if (swept) continue;
      seen.add(st.from);
      out.push({ line: st.from, text: st.text.replace(/\s+/g, " ").trim(), path, kind: sig.kind });
      if (out.length >= MAX_SITES) return out;
    }
  }
  return out;
}

/** Same enclosing block: indentation of the candidate is >= the anchor's. */
function withinBlock(lines, anchorLine, candidateLine) {
  const indentOf = (n) => (lines[n - 1]?.match(/^\s*/)?.[0].length ?? 0);
  const base = indentOf(anchorLine);
  if (indentOf(candidateLine) < base) return false;
  const [lo, hi] = anchorLine < candidateLine ? [anchorLine, candidateLine] : [candidateLine, anchorLine];
  for (let i = lo; i <= hi; i += 1) {
    if (lines[i - 1]?.trim() && indentOf(i) < base) return false;      // left the block
  }
  return true;
}

export function siblingSweepEnabled(value = process.env.BANTAM_SIBLING_SWEEP) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

export function siblingSweepObjection(turns, priorRejections, {
  enabled = false,
  readFile = null,
  editedLinesFor = null,
} = {}) {
  if (!enabled || priorRejections >= 1 || typeof readFile !== "function") return null;
  const editedPaths = [...new Set((turns ?? [])
    .filter((t) => t?.editApplied && (t.action ?? t.parsedAction)?.p)
    .map((t) => (t.action ?? t.parsedAction).p))];
  if (!editedPaths.length) return null;

  const found = [];
  for (const p of editedPaths) {
    let content;
    try { content = readFile(p); } catch { continue; }
    if (!content) continue;
    const editedLines = typeof editedLinesFor === "function" ? editedLinesFor(p, content) : [];
    if (!editedLines?.length) continue;
    const wholeFile = content.length < 20000;
    for (const site of siblingSites({ content, editedLines, path: p, wholeFile })) {
      found.push(site);
      if (found.length >= MAX_SITES) break;
    }
    if (found.length >= MAX_SITES) break;
  }
  if (!found.length) return null;

  const list = found.map((s) => `${s.path}:${s.line} — ${s.text.slice(0, 100)}`).join("; ");
  return `${SIBLING_SWEEP_MARKER} Your fix added a ${found[0].kind} at one site, but these lines have the same shape and did NOT get it: ${list}. `
    + `A bug fixed at one of several structurally identical sites is half-fixed — the hidden tests exercise the ones the issue text did not name. `
    + `Check each site listed: apply the same change where it belongs, or state in your done summary why that site is intentionally different.`;
}

/**
 * Which lines of `content` a run's applied edits produced, derived from the
 * edit actions themselves. Deliberately not from observations: adding line
 * numbers to every replace observation would churn prompt bytes and the cache
 * for a gate that fires rarely.
 *
 * `write_file` is skipped — a whole-file write carries no delta, and treating
 * every line as edited would make every guard in the file an anchor.
 */
export function editedLinesFromTurns(turns, targetPath, content) {
  const lines = String(content ?? "").split("\n");
  const found = new Set();
  const locate = (needle) => {
    const first = String(needle ?? "").split("\n").map((l) => l.trim()).find(Boolean);
    if (!first || first.length < 4) return;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim().includes(first)) { found.add(i + 1); return; }
    }
  };
  for (const turn of turns ?? []) {
    if (!turn?.editApplied) continue;
    const action = turn.action ?? turn.parsedAction ?? {};
    if (action.a === "replace" && action.p === targetPath) locate(action.new);
    else if (action.a === "edit_lines" && action.p === targetPath && Number.isInteger(action.start)) {
      found.add(action.start);
    } else if (action.a === "patch" && Array.isArray(action.edits)) {
      for (const edit of action.edits) if (edit?.p === targetPath) locate(edit.new);
    }
  }
  return [...found].sort((a, b) => a - b);
}
