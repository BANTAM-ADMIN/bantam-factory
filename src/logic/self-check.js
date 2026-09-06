// Layer-2 self-check: derive checkable deliverable invariants from the task INSTRUCTION (never the
// hidden verifier), and evaluate them as datalog. This is the substrate form of the corpus spec
// (docs/SELF_CHECK_SPEC.md): a deterministic layer produces ground facts (`immutable(F)`,
// `changed(F)`), and a Horn rule derives the answer (`violation(F) :- immutable(F), changed(F)`) —
// exactly the codefacts.js pattern (extract facts, let rules deduce). It raises the FLOOR
// (non-cheating, envelope-correct), not the ceiling; correctness for the weak_oracle majority lives
// in hidden state a from-instruction check cannot reach.
//
// This module ships the `immutable_file` rule (adversarial verdict: narrow). It catches the
// highest-value shortcut in the corpus: "fix by editing the file you were told not to touch."

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Datalog } from "./datalog.js";

const SKIP_DIRS = new Set([".git", ".bantam", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target"]);

// --- extraction (the "specify" layer; JS is fine here — it's not the exact-reasoning part) ---

// Real file extensions — so `pathlib.Path` (a Python attribute) is not mistaken for a file.
const FILE_EXT = new Set(("py c h cpp cc hpp rs go js mjs ts txt md csv tsv json yaml yml "
  + "toml ini cfg conf cbl dat pov pt pth ckpt npy npz pkl ics sh bash sql db sqlite html htm xml "
  + "png jpg pdf log lock cfg pyx").split(" "));
// A file/path token: backticked, quoted, or a bare name that ENDS in a known extension.
const FILE_TOKEN = /`([^`]+)`|"([^"]+)"|'([^']+)'|((?:\/|\.\/|~\/)?[\w/.-]+\.[A-Za-z0-9]{1,6})\b/g;
const EDIT_VERB = /(?:edit|modif\w*|chang\w*|touch\w*|alter\w*)/i;
const FORBID_RE = new RegExp(`\\b(?:do not|don'?t|must not|may not|cannot|without)\\s+${EDIT_VERB.source}`, "i");
const NEGATIVE_PREFIX_RE = /\b(?:do not|don'?t|must not|may not|cannot|without)\s+/i;
const COORDINATED_EDIT_RE = new RegExp(`(?:^|\\b(?:or|and)\\s+|,\\s*)${EDIT_VERB.source}\\b`, "i");
const EXISTING_TESTS_RE = /\b(?:existing|supplied|provided|baseline|public)\s+(?:(?:existing|supplied|provided|baseline|public)\s+)?tests?(?:\s+files?)?\b/i;
// Exclusive-edit: "only edit X" / "only edits you may make are ...". The "except" form counts ONLY when
// the same sentence carries edit/modify language ("not modify ... except X") — bare "except for X"
// ("tests should pass except for X") is not an edit-scope constraint and must NOT arm a check.
const ONLY_EDIT_RE = new RegExp(`\\bonly\\s+(?:${EDIT_VERB.source})|\\bonly\\s+edits?\\s+you\\s+may\\s+make`, "i");
const POSTPOSITIVE_ONLY_RE = /\b(?:fix|edit|modif\w*|chang\w*|touch\w*|alter\w*)\s+(?:the\s+)?(?:`[^`]+`|"[^"]+"|'[^']+'|(?:\/|\.\/|~\/)?[\w/-]+\.[A-Za-z0-9]{1,6})\s+only\b/i;
const EXCEPT_RE = /\bexcept(?:\s+for)?\b/i;
const SCOPE_START = String.raw`(?:do not|don'?t|must not|may not|cannot|without|only)`;
const SCOPE_CLAUSE_BOUNDARY = new RegExp(
  String.raw`(?:\s+(?:\u2014|\u2013|-)\s+|,\s+|\s+and\s+|\s*\(\s*)(?=${SCOPE_START}\b)`,
  "i",
);

/** Files named in a piece of text (with a real extension). Backticked/quoted win; bare needs an ext. */
function filesIn(text) {
  const out = [];
  FILE_TOKEN.lastIndex = 0;
  let m;
  while ((m = FILE_TOKEN.exec(text)) !== null) {
    const tok = (m[1] || m[2] || m[3] || m[4] || "").trim();
    const ext = tok.split(".").pop()?.toLowerCase();
    if (ext && FILE_EXT.has(ext)) out.push(tok);
  }
  return out;
}

// Segmentation that respects list structure. A prohibition ("DO NOT MODIFY") scopes to its OWN bullet;
// merging bullets would wrongly capture the deliverable in the next item. So: split into BLOCKS on
// blank lines and bullet/number markers first; join soft-wraps WITHIN a block; then sentence-split.
function sentences(text) {
  const blocks = String(text ?? "")
    .split(/\n\s*(?=[-*]\s|\d+[.)]\s)|\n{2,}/)   // new bullet / numbered item / blank line = new block
    .map((b) => b.replace(/\n(?!\n)/g, " "));      // join soft-wraps inside the block
  return blocks
    .flatMap((b) => b.split(/(?<=[.!?])\s+|;+/))
    .flatMap((s) => s.split(SCOPE_CLAUSE_BOUNDARY))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {{ mode: "forbid"|"exclusive"|"none", forbidden: string[], editable: string[], sentence: string }}
 */
export function extractImmutable(instruction) {
  const forbidden = new Set();
  const editable = new Set();
  let sentence = "", preserveExistingTests = false, existingTestExceptions = null;
  for (const s of sentences(instruction)) {
    // A negation can govern a coordinated verb: "Do not add dependencies or
    // modify package.json or existing public tests." Stop before a positive
    // contrast/permission rather than transferring the negation into it.
    const negative = NEGATIVE_PREFIX_RE.exec(s);
    const negativeTail = negative ? s.slice(negative.index + negative[0].length)
      .split(/\b(?:but|however|instead|then|you may|you can)\b/i)[0] : "";
    const coordinated = COORDINATED_EDIT_RE.exec(negativeTail);
    const forbiddenClause = coordinated ? negativeTail.slice(coordinated.index)
      .split(/\s+(?:to\s+(?:satisfy|pass|fix|make|ensure)|in order to|so that|because)\b/i)[0] : "";
    const isForbid = Boolean(forbiddenClause) || FORBID_RE.test(s);
    // This bounded class form is not the older exclusive-file form: an
    // exception to protected tests permits that test, not every other file.
    const classException = /\s+except(?:\s+for)?\s+/i.exec(forbiddenClause);
    const classParts = classException
      ? [forbiddenClause.slice(0, classException.index), forbiddenClause.slice(classException.index + classException[0].length)]
      : [forbiddenClause];
    if (isForbid && EXISTING_TESTS_RE.test(classParts[0])) {
      preserveExistingTests = true; sentence ||= s;
      const exceptions = new Set(classParts.length > 1 ? filesIn(classParts.slice(1).join(" ")) : []);
      existingTestExceptions = existingTestExceptions === null ? exceptions
        : new Set([...existingTestExceptions].filter(file => exceptions.has(file)));
      filesIn(classParts[0]).forEach(file => forbidden.add(file));
      continue;
    }
    // Exclusive only when there's an edit-scope signal: "only edit ..." OR ("except" WITH edit/forbid
    // language in the same sentence). Bare "except for X" (no edit verb) is not edit-scope.
    const isExclusive = ONLY_EDIT_RE.test(s) || POSTPOSITIVE_ONLY_RE.test(s)
      || (EXCEPT_RE.test(s) && (isForbid || EDIT_VERB.test(s)));
    if (!isExclusive && !isForbid) continue;
    const files = filesIn(isForbid && !isExclusive && forbiddenClause ? forbiddenClause : s);
    if (!files.length) continue;                    // content-class / no concrete file -> arm nothing
    if (isForbid && !isExclusive) { files.forEach((f) => forbidden.add(f)); sentence ||= s; continue; }
    if (isExclusive) {
      // "only edits ... to input.txt. Do not edit manifest.json" — the named file is editable UNLESS the
      // same sentence forbids it. A sentence with both keeps forbidden (forbidden wins below).
      files.forEach((f) => (isForbid ? forbidden : editable).add(f));
      sentence ||= s;
    }
  }
  // Forbidden always wins over editable for the same file.
  for (const f of forbidden) editable.delete(f);
  if (!forbidden.size && !editable.size && !preserveExistingTests) return { mode: "none", forbidden: [], editable: [], sentence: "" };
  const classes = preserveExistingTests ? { preserveExistingTests: true,
    ...(existingTestExceptions?.size ? { existingTestExceptions: [...existingTestExceptions] } : {}) } : {};
  if (editable.size) return { mode: "exclusive", forbidden: [...forbidden], editable: [...editable], sentence, ...classes };
  return { mode: "forbid", forbidden: [...forbidden], editable: [], sentence, ...classes };
}

// --- deterministic fact layer: hash the workspace ---

function sha(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}

function walkFiles(root, depth = 6) {
  const out = new Map();
  const rootAbs = path.resolve(root);
  const rec = (abs, rel, d) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (d > 0 && !SKIP_DIRS.has(e.name)) rec(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, d - 1); }
      else if (e.isFile()) out.set(rel ? `${rel}/${e.name}` : e.name, path.join(abs, e.name));
    }
  };
  rec(rootAbs, "", depth);
  return out;
}

const norm = (f) => String(f).replace(/^(?:\/app\/|\.\/|~\/)/, "").replace(/^\/+/, "");
const baseName = (f) => norm(f).split("/").pop();
const matchesNamedPath = (file, named) => {
  const rel = norm(file);
  const wanted = norm(named);
  return wanted.includes("/") ? rel === wanted : baseName(rel) === baseName(wanted);
};

/** Snapshot the hashes the immutable rule needs. `forbid` mode hashes named files; `exclusive` hashes all. */
function snapshot(workspace, inv) {
  if (!inv || inv.mode === "none") return { mode: "none", hashes: {} };
  const hashes = {};
  if (inv.mode === "exclusive") {
    for (const [rel, abs] of walkFiles(workspace)) hashes[rel] = sha(abs);
  } else {
    const files = walkFiles(workspace);
    for (const f of inv.forbidden) {
      const rel = norm(f);
      const matches = files.has(rel)
        ? [rel]
        : [...files.keys()].filter((k) => baseName(k) === baseName(f));
      for (const m of matches) hashes[m] = sha(files.get(m));
    }
  }
  for (const rel of inv.existingTests ?? []) {
    const value = exactPathHash(workspace, rel);
    if (value !== undefined) hashes[rel] = value;
  }
  return { mode: inv.mode, hashes };
}

// Frozen class paths are exact, may be deeper than the legacy named-file walk,
// and may include an in-workspace test-directory alias itself.
function exactPathHash(workspace, rel) {
  const root = path.resolve(workspace), full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return undefined;
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return `symlink:${crypto.createHash("sha256").update(fs.readlinkSync(full)).digest("hex")}`;
    if (!stat.isFile()) return undefined;
    const real = fs.realpathSync(full), realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) return "<outside>";
    return sha(full);
  } catch { return "<deleted>"; }
}

/**
 * Datalog-derived violations: assert immutable(F) + changed(F) facts, derive violation(F).
 * @returns {string[]} human-readable violations; [] when clean, corrupted-baseline, or none.
 */
export function immutableViolations(workspace, inv, snap) {
  if (!inv || inv.mode === "none" || !snap || snap.mode === "none") return [];
  const current = walkFiles(workspace);
  const editable = inv.editable || [];

  const db = new Datalog();
  const known = new Set(Object.keys(snap.hashes));
  for (const f of known) {
    // immutable(F): a file that existed at snapshot and is NOT in the allowed-edit set.
    const frozenTest = inv.existingTests?.includes(f);
    if (!frozenTest && inv.mode === "exclusive" && editable.some((named) => matchesNamedPath(f, named))) continue;
    db.fact("immutable", f);
    const now = frozenTest ? exactPathHash(workspace, f) : current.has(f) ? sha(current.get(f)) : "<deleted>";
    if (now !== snap.hashes[f]) db.fact("changed", f);   // changed OR deleted
  }
  db.rule("violation(F) :- immutable(F), changed(F)");
  db.run();

  return db.query("violation", "?").map(([f]) =>
    `[self-check] instruction forbids modifying \`${f}\`, but its contents changed since task start. `
    + `The grader checks this file is untouched. Revert it, then call done.`);
}
immutableViolations.snapshot = snapshot;
