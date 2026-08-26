// Transactional source validation for edit actions.
//
// Exact edits are assembled completely in memory before the executor writes
// them.  This module enforces the one syntax invariant that matters at that
// boundary: a valid JavaScript file may not be replaced by an invalid one, and
// a newly-created JavaScript file must parse.  An already-invalid file is left
// editable so the agent can repair it incrementally.

import * as acorn from "acorn";
import fs from "node:fs";
import path from "node:path";

import { codePositions } from "./collateral.js";

const JAVASCRIPT_PATH = /\.(?:js|mjs|cjs)$/i;

/** Return true for source files covered by the transactional parse gate. */
export function isJavaScriptPath(filePath) {
  return JAVASCRIPT_PATH.test(String(filePath ?? ""));
}

/**
 * Parse JavaScript using the source modes the path can legally represent.
 *
 * `.mjs` and `.cjs` have fixed Node source modes. For executor calls a plain
 * `.js` follows its nearest package.json when one exists. With no package
 * boundary it may be either a classic browser script or a browser module, so
 * the syntax gate accepts either source mode.
 */
export function parseJavaScript(source, filePath = "file.js", { runtimePath = null } = {}) {
  const text = String(source ?? "");
  const ext = String(filePath).toLowerCase().match(/\.(mjs|cjs|js)$/)?.[1];
  const modes = ext === "mjs"
    ? ["module"]
    : ext === "cjs"
      ? ["script"]
      : sourceModesForJs(runtimePath);
  const errors = [];

  for (const sourceType of modes) {
    try {
      acorn.parse(text, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        locations: true,
      });
      return { ok: true, sourceType };
    } catch (error) {
      errors.push(error);
    }
  }

  // When both modes fail, report the parse that made the most progress.  It
  // normally points at the actual damaged seam rather than an earlier
  // source-mode-only token such as `export`.
  const error = errors.reduce((best, candidate) => (
    !best || Number(candidate?.pos ?? -1) > Number(best?.pos ?? -1) ? candidate : best
  ), null);
  return { ok: false, error };
}

/**
 * Validate one fully staged file transition.
 *
 * `before === null` denotes a new file.  Existing broken files deliberately
 * pass: refusing them until they become valid in one edit would make many
 * ordinary syntax repairs impossible.
 */
export function validateSourceTransition({
  path: filePath,
  before,
  after,
  runtimePath = null,
} = {}) {
  // Existing edits may arrive through an in-workspace symlink. Classify the
  // resolved target when the executor has one, so `alias.md -> module.js`
  // cannot opt valid JavaScript out of syntax validation (and the reverse
  // alias does not make a real document obey JavaScript grammar).
  const classificationPath = runtimePath ?? filePath;
  if (!isJavaScriptPath(classificationPath)) return { ok: true, applicable: false };

  const staged = parseJavaScript(after, classificationPath, { runtimePath });
  if (staged.ok) return { ok: true, applicable: true };

  const isNew = before === null || before === undefined;
  if (!isNew && !parseJavaScript(before, classificationPath, { runtimePath }).ok) {
    return { ok: true, applicable: true, baselineInvalid: true };
  }

  return {
    ok: false,
    applicable: true,
    error: staged.error,
    message: syntaxRefusal(filePath, staged.error, after, { isNew, before, runtimePath }),
  };
}

function sourceModesForJs(runtimePath) {
  // Library callers which only have a content/path specimen use the neutral
  // dual-mode parser. A real target path follows an explicit Node package
  // boundary, but a package-less web workspace remains genuinely ambiguous:
  // `<script type="module" src="game.js">` is valid without package.json.
  if (!runtimePath || !path.isAbsolute(runtimePath)) return ["module", "script"];
  let directory = path.dirname(runtimePath);
  while (true) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      return parsed?.type === "module" ? ["module"] : ["script"];
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) return ["script"];
      // Invalid package JSON makes Node fail before source execution; for this
      // syntax boundary, conservatively use the default CommonJS grammar.
      if (error instanceof SyntaxError) return ["script"];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return ["module", "script"];
    directory = parent;
  }
}

// The line span of `after` that differs from `before`, 1-based inclusive.
// Null for a new file (everything is new) or an identical transition.
function changedSpan(before, after) {
  if (before === null || before === undefined) return null;
  const a = String(before).split(/\r?\n/);
  const b = String(after ?? "").split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const start = head + 1;
  const end = b.length - tail;
  if (end < start) return { start, end: start, inserted: false };
  return { start, end, inserted: true };
}

// Net delimiter balance over real code — strings, comments and regex literals
// are masked, so a brace inside "}" does not read as structure.
function delimiterBalance(text) {
  const source = String(text ?? "");
  const code = codePositions(source);
  const counts = { "{": 0, "(": 0, "[": 0 };
  const opener = { "}": "{", ")": "(", "]": "[" };
  for (let i = 0; i < source.length; i += 1) {
    if (!code[i]) continue;
    const char = source[i];
    if (char === "{" || char === "(" || char === "[") counts[char] += 1;
    else if (opener[char]) counts[opener[char]] -= 1;
  }
  return counts;
}

function describeImbalance(counts) {
  const pairs = [["{", "}"], ["(", ")"], ["[", "]"]];
  const parts = [];
  for (const [open, close] of pairs) {
    const net = counts[open];
    if (net > 0) parts.push(`${net} unclosed \`${open}\``);
    else if (net < 0) parts.push(`${-net} unmatched \`${close}\``);
  }
  return parts;
}

// The edited region of the staged file, numbered, so the model can read its own
// text in place. Bounded: a long insertion shows its head and tail, which is
// where an unclosed delimiter lives, and never the whole file.
const STAGED_EXCERPT_MAX_LINES = 24;

const STAGED_EXCERPT_CONTEXT = 3;

function stagedExcerpt(lines, span) {
  if (!span || !span.inserted) return "";
  const start = Math.max(1, span.start);
  const end = Math.min(lines.length, span.end);
  if (end < start) return "";
  // Context on both sides: an unbalanced delimiter is legible where the new
  // text MEETS the existing code, not inside the new text alone.
  const from = Math.max(1, start - STAGED_EXCERPT_CONTEXT);
  const to = Math.min(lines.length, end + STAGED_EXCERPT_CONTEXT);
  const number = (index) => {
    const lineNo = index + 1;
    const mark = lineNo >= start && lineNo <= end ? ">" : " ";
    return `${mark} ${lineNo}\t${String(lines[index] ?? "").slice(0, 200)}`;
  };

  const total = to - from + 1;
  const body = [];
  if (total <= STAGED_EXCERPT_MAX_LINES) {
    for (let i = from - 1; i <= to - 1; i += 1) body.push(number(i));
  } else {
    const half = Math.floor(STAGED_EXCERPT_MAX_LINES / 2);
    for (let i = from - 1; i < from - 1 + half; i += 1) body.push(number(i));
    body.push(`… ${total - (half * 2)} lines omitted …`);
    for (let i = to - half; i <= to - 1; i += 1) body.push(number(i));
  }
  return `\nThe staged result around your edit (\`>\` marks the lines you changed):\n${body.join("\n")}`;
}

// What the edit landed INSIDE, read from the file as it was before the edit.
//
// tb6 (2026-08-16, .bantam/runs/2026-08-16T17-22-16-517Z.json) turn 28: the
// model inserted an `if` statement at line 696, between `files:` and `buildMs:`
// — properties of an object literal. acorn reported "Unexpected token" at
// 704:12, thirty lines away from anything that reads as the cause, and the
// model re-sent the identical edit. The staged excerpt shows the object
// properties above the insertion, but only to a reader who already suspects
// the shape. Naming the container states it.
//
// Containers where a statement is illegal. A BlockStatement or Program is where
// statements belong, so saying "you are inside a block" is noise.
const STATEMENT_HOSTILE_NODES = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "CallExpression",
  "NewExpression",
  "TemplateLiteral",
  "ObjectPattern",
  "ArrayPattern",
  "ClassBody",
]);

function enclosingContainer(before, filePath, runtimePath, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  // parseJavaScript's return shape is asserted verbatim by its own tests, so it
  // stays a yes/no. Re-parse here for the tree; this path runs only when an
  // edit has already been refused, which is rare.
  const parsed = parseJavaScript(before, filePath, { runtimePath });
  if (!parsed.ok) return null;
  let program;
  try {
    program = acorn.parse(String(before ?? ""), {
      ecmaVersion: "latest",
      sourceType: parsed.sourceType,
      allowHashBang: true,
      locations: true,
    });
  } catch { return null; }

  let found = null;
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (!(node.start <= offset && offset <= node.end)) return;
    if (STATEMENT_HOSTILE_NODES.has(node.type)) found = node;   // innermost wins
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) { for (const child of value) visit(child); }
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  try { visit(program); } catch { return null; }
  return found;
}

const CONTAINER_ENGLISH = {
  ObjectExpression: "an object literal",
  ArrayExpression: "an array literal",
  CallExpression: "a call's argument list",
  NewExpression: "a call's argument list",
  TemplateLiteral: "a template literal",
  ObjectPattern: "a destructuring pattern",
  ArrayPattern: "a destructuring pattern",
  ClassBody: "a class body",
};

function offsetOfLine(text, line) {
  if (!Number.isInteger(line) || line < 1) return -1;
  const rows = String(text ?? "").split("\n");
  if (line > rows.length) return -1;
  let offset = 0;
  for (let i = 0; i < line - 1; i += 1) offset += rows[i].length + 1;
  return offset;
}

function syntaxRefusal(filePath, error, source, { isNew, before = null, runtimePath = null }) {
  const line = Number(error?.loc?.line ?? 0);
  const column = Number(error?.loc?.column ?? 0) + 1;
  const where = line > 0 ? `${filePath}:${line}:${column}` : filePath;
  const detail = String(error?.message ?? "JavaScript parse failed").replace(/\s*\(\d+:\d+\)\s*$/, "");
  const lines = String(source ?? "").split(/\r?\n/);
  const sourceLine = line > 0 ? lines[line - 1]?.trim() : "";
  const excerpt = sourceLine ? `\nParser stopped at: ${sourceLine.slice(0, 240)}` : "";
  const transition = isNew
    ? "new JavaScript files must parse before they are created"
    : "valid JavaScript would become invalid";

  // A parse error reports where the grammar gave up, which for an unbalanced
  // insertion is far below the mistake — the tb2 run (2026-08-16) read
  // "unexpected export" at top level and re-sent the same broken edit four
  // times looking for a defect at the wrong end of the file. Locate the edit
  // itself, say whether the stop is inside it, and name the imbalance.
  const span = changedSpan(before, source);
  const notes = [];
  if (span && span.inserted) {
    const region = span.start === span.end ? `line ${span.start}` : `lines ${span.start}-${span.end}`;
    notes.push(`Your edit changed ${filePath} ${region}.`);
    if (line > 0 && (line < span.start || line > span.end)) {
      notes.push(
        `The parser stopped at line ${line}, OUTSIDE that region — the defect is`
        + ` almost always an unbalanced delimiter inside your edited text, not at line ${line}.`,
      );
    }
    const imbalance = describeImbalance(delimiterBalance(lines.slice(span.start - 1, span.end).join("\n")));
    if (imbalance.length) {
      notes.push(`The text you inserted leaves ${imbalance.join(" and ")}.`);
    }
    // Where the edit landed, in the pre-edit file. A statement dropped among
    // object properties parses as garbage far below itself, and the parse error
    // never says "you are inside an object literal".
    const container = enclosingContainer(before, filePath, runtimePath, offsetOfLine(before, span.start));
    const english = container ? CONTAINER_ENGLISH[container.type] : null;
    if (english) {
      const openedAt = container.loc?.start?.line;
      notes.push(
        `Your edit begins inside ${english}${openedAt ? ` that opens at line ${openedAt}` : ""}`
        + ` — a statement cannot appear there.`,
      );
    }
  }
  const diagnosis = notes.length ? `\n${notes.join(" ")}` : "";
  // Naming the imbalance is not the same as showing it. The model authored its
  // replacement blind — it never sees how that text sits against the lines
  // around it, which is exactly where a stray brace is legible. Ticket B rerun
  // (2026-08-16) received "leaves 1 unclosed `{`", tried once more, and stopped.
  const staged = stagedExcerpt(lines, span);

  return `ERROR: refused — ${transition}. The complete staged result for ${where} failed to parse: ${detail}.`
    + `${excerpt}${diagnosis}${staged}`
    + `\nNo files were changed. Fix the proposed edit, then submit the complete action again.`;
}

// Duplicate-definition detector (advisory, not a syntax gate).
//
// A `replace`/`edit_lines` can paste a second copy of a `def`/`class` into the
// same scope: valid Python, but the earlier definition is now dead code and the
// model usually cannot see it happened (swb3-bulkcreate, 2026-07-18: a replace
// duplicated `def bulk_create`, and ~40 turns of blind edits went into repairing
// the corruption the "replaced 1 occurrence" observation never named). This
// reports only definitions whose same-scope count the edit *increased*, so
// pre-existing legitimate redefinitions (conditional import fallbacks, and —
// via the decorator skip below — @property setters / @overload / dispatch
// registrations) never trip it.
const PY_PATH = /\.py$/i;

/** Map "scopeId::name" -> [1-based line numbers] of undecorated def/class headers. */
function pythonDefinitionSites(source) {
  const lines = String(source ?? "").split("\n");
  const sites = new Map();
  const stack = []; // { indent, id }
  let seq = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "        ").length;
    const name = m[3];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : "<module>";
    stack.push({ indent, id: `${parentId}>${name}#${seq += 1}` });
    // Skip decorated definitions: @property/@x.setter/@overload/@singledispatch
    // register legitimate same-name redefinitions we must not flag.
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j -= 1;
    let decorated = false;
    while (j >= 0 && lines[j].trim().startsWith("@")) { decorated = true; j -= 1; }
    if (decorated) continue;
    const key = `${parentId}::${name}`;
    if (!sites.has(key)) sites.set(key, []);
    sites.get(key).push(i + 1);
  }
  return sites;
}

/**
 * Detect same-scope duplicate definitions an edit INTRODUCED (count went up and
 * is now >= 2). Returns the most relevant one as { name, kind, lines } or null.
 * Python only for now; returns null for other languages.
 */
export function introducedDuplicateDefinition({ path: filePath, before, after }) {
  if (!PY_PATH.test(String(filePath ?? ""))) return null;
  const b = pythonDefinitionSites(before);
  const a = pythonDefinitionSites(after);
  let best = null;
  for (const [key, linesAfter] of a) {
    if (linesAfter.length < 2) continue;
    const wasCount = (b.get(key) ?? []).length;
    if (linesAfter.length <= wasCount) continue; // pre-existing, edit did not worsen it
    const name = key.split("::").pop();
    // Prefer the shallowest / earliest to report deterministically.
    if (!best || linesAfter[0] < best.lines[0]) best = { name, lines: linesAfter };
  }
  return best;
}

/** Human-facing advisory string for a duplicate-definition finding, or "". */
export function duplicateDefinitionNote(finding, filePath) {
  if (!finding) return "";
  const at = finding.lines.join(" and ");
  return `\n[dup-def] This edit left ${filePath} with ${finding.lines.length} definitions of `
    + `\`${finding.name}\` in the same scope (lines ${at}). Python keeps only the last; the earlier `
    + `one is now dead. If that was not intended, remove the stray copy.`;
}
