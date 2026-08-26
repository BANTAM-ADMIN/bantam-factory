// Failure locus: when the harness already KNOWS the line, don't make the model
// find it — hand it the code.
//
// A failing test, a stack trace, or a syntax error names an exact file:line.
// Today the model spends a turn reading that file (v12 t64: test-focus named
// the failing test, then the model read test/agent.test.js to see it). That
// read is a tax on information the harness is already holding. Render the
// region directly into the next prompt instead.
//
// This is the same law as the open-files panel and edit_lines, applied to
// diagnosis: never ask the model to reproduce or re-fetch what we have.

import fs from "node:fs";
import path from "node:path";

const CONTEXT_LINES = 10;   // above and below the named line
const MAX_LOCI = 2;         // bound the panel: the newest failures only

// node --test:  location: '/abs/path/test/x.test.js:368:1'
// stack traces: at Foo (/abs/path/src/a.js:12:5)   |   at /abs/path/src/a.js:12:5
// file:// URLs: file:///abs/path/src/a.js:12:5
// pytest:       path/to/test_x.py:42: AssertionError
// go test:      path/to/x_test.go:17:
// node crash banner: a bare "/abs/path/file.js:405" on its own line, printed
// above the caret and the SyntaxError/TypeError. No column — which is exactly
// why the first three patterns all missed it, and why v16 sat in a loop
// re-running a crashing command whose broken line we already knew.
const PATTERNS = [
  /^(\/[^\s():]+\.(?:js|mjs|cjs|ts|py|go|rs)):(\d+)$/gm,
  /location:\s*'([^']+?):(\d+):\d+'/g,
  /\(?(?:file:\/\/)?(\/[^\s():]+\.(?:js|mjs|cjs|ts|py|go|rs)):(\d+):\d+\)?/g,
  /(^|\s)([\w./-]+\.(?:py|go|rs|js|ts)):(\d+):/gm,
];

/** Every file:line the harness has been TOLD about, newest first, de-duplicated. */
export function extractLoci(observation, { workspace }) {
  const text = String(observation ?? "");
  const found = [];
  const seen = new Set();
  const push = (file, line) => {
    const n = Number(line);
    if (!file || !Number.isInteger(n) || n < 1) return;
    const rel = path.isAbsolute(file) ? path.relative(workspace, file) : file;
    if (rel.startsWith("..") || rel.includes("node_modules")) return;   // outside the workspace
    const key = `${rel}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: rel, line: n });
  };

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (pattern.source.startsWith("location")) push(m[1], m[2]);
      else if (m.length === 4) push(m[2], m[3]);
      else push(m[1], m[2]);
    }
  }
  return found.slice(0, MAX_LOCI);
}

// An unbalanced delimiter does not fail where the bug is — it fails where the
// parser runs out of input. v18 dropped a brace at line 317 and node reported
// "Unexpected end of input" at line 1370, one PAST the end of a 1369-line file.
// renderLoci correctly skipped it (there is no line 1370), so the model got no
// panel at all: at the exact moment it most needed help, we showed it nothing.
//
// For this class of error the informative locus is not where the parser gave
// up. It is where the model last edited — which the harness knows exactly.
//
// CRITICAL: only genuine END-OF-INPUT errors qualify. `Unexpected token '}'`
// names a REAL, usable line (v28: node said bin/bantam.js:396, the exact stray
// brace) — for that, renderLoci pointing AT line 396 beats the edit-region every
// time. An earlier version of this regex also matched `Unexpected token '}'`,
// which hijacked the token case into the edit-region branch and showed the model
// line 315 (its edit) instead of line 396 (the bug). It re-read its edit site
// for five turns while node pointed 80 lines away. Two of this session's own
// fixes were fighting; the wrong one won. EOF only.
const UNBALANCED_RE = /Unexpected end of input|unexpected EOF|was never closed/i;

export function isUnbalanced(observation) {
  return UNBALANCED_RE.test(String(observation ?? ""));
}

/**
 * The region the model just rewrote, for when the parser's own locus is EOF.
 * `edit` is {path, start, lines} — where it wrote, and how many lines it wrote.
 */
export function renderEditRegion(edit, { workspace, pad = 6 } = {}) {
  if (!edit?.path || !Number.isInteger(edit.start)) return "";
  let content;
  try { content = fs.readFileSync(path.join(workspace, edit.path), "utf8"); }
  catch { return ""; }
  const lines = content.split("\n");
  const from = Math.max(1, edit.start - pad);
  const to = Math.min(lines.length, edit.start + (edit.lines ?? 1) + pad);
  if (from > lines.length) return "";
  const body = lines.slice(from - 1, to)
    .map((text, i) => `${from + i}\t${text}`)
    .join("\n");
  return `The syntax error is a delimiter that was opened and never closed, so the parser reports the END of the `
    + `file, not the bug. The bug is in the code YOU JUST WROTE. This is ${edit.path}:${from}-${to}, the region of `
    + `your last edit — count the braces here:\n\n${body}`;
}

/** The code at those lines, line-numbered, ready to drop into the prompt. */
export function renderLoci(loci, { workspace, contextLines = CONTEXT_LINES } = {}) {
  if (!loci?.length) return "";
  const blocks = [];
  for (const { path: rel, line } of loci) {
    let content;
    try { content = fs.readFileSync(path.join(workspace, rel), "utf8"); }
    catch { continue; }
    const lines = content.split("\n");
    if (line > lines.length) continue;
    const from = Math.max(1, line - contextLines);
    const to = Math.min(lines.length, line + contextLines);
    const body = lines.slice(from - 1, to)
      .map((text, i) => {
        const n = from + i;
        return `${n === line ? ">>" : "  "} ${n}\t${text}`;
      })
      .join("\n");
    blocks.push(`# ${rel}:${line} (the failure is on the >> line)\n${body}`);
  }
  if (!blocks.length) return "";
  return `The code at the failure the last observation named — you do not need to read these files:\n\n${blocks.join("\n\n")}`;
}
