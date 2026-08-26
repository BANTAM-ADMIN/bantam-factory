// Spec-example check.
//
// A task spec usually states concrete examples — `render('{{#if on}}Y{{/if}}',
// {on:false}) -> ''`. Those are ground truth from the task author, not the model.
// When a model reasons itself into a false belief (the template-engine run
// "verified" that `if([])` is falsy in JS, which it is not) its own thin tests
// can miss the regression. This runs the spec's own examples against the model's
// exported functions and reports any mismatch — an un-arguable, oracle-backed
// obligation the model cannot reason around. It is NOT a self-authored test: the
// oracle is the spec, so strengthening the spec strengthens the check.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Evaluate a source fragment as a plain JS literal (numbers, strings, arrays,
// objects, booleans, null). Returns { ok, value }. Anything that is not a clean
// literal (prose, a variable, a call) fails to parse and is simply skipped.
function literal(src) {
  try {
    const value = Function(`"use strict";return (${src});`)();
    const t = typeof value;
    if (value === null || t === "number" || t === "string" || t === "boolean" || t === "object") {
      return { ok: true, value };
    }
  } catch { /* not a literal */ }
  return { ok: false };
}

/**
 * Parse `fn(args) -> expected` (or `=> expected`) examples out of spec prose.
 * Only examples whose argument list AND expected value both parse as literals
 * are kept, which filters ordinary prose that merely looks call-shaped.
 */
export function parseExamples(spec) {
  const s = String(spec ?? "");
  const out = [];
  const head = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = head.exec(s))) {
    const fn = m[1];
    let i = m.index + m[0].length - 1; // at '('
    let depth = 0, inStr = null, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === inStr && s[j - 1] !== "\\") inStr = null; continue; }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const argsSrc = s.slice(i + 1, j);
    let k = j + 1;
    while (k < s.length && /\s/.test(s[k])) k++;
    const arrow = s.slice(k, k + 2);
    if (arrow !== "->" && arrow !== "=>") continue;
    k += 2;
    while (k < s.length && s[k] === " ") k++;
    let end = s.indexOf("\n", k);
    if (end === -1) end = s.length;
    const expectedSrc = s.slice(k, end).trim().replace(/[.;,]+$/, "");
    const args = literal(`[${argsSrc}]`);
    const expected = literal(expectedSrc);
    if (args.ok && expected.ok) out.push({ fn, args: args.value, expected: expected.value });
  }
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// Map each exported function name in the workspace to its implementation, so an
// example naming `render` finds whichever module exports it.
async function exportIndex(workspace) {
  const index = new Map();
  let entries;
  try { entries = readdirSync(workspace, { recursive: true }); } catch { return index; }
  for (const rel of entries) {
    const f = String(rel);
    if (!f.endsWith(".js") || f.endsWith(".test.js") || f.includes("node_modules")) continue;
    const full = path.join(workspace, f);
    // Skip CLI-shaped modules: importing a file that runs argv parsing / exits at
    // top level would kill this process. Library exports we example-test don't.
    try { if (/process\.(argv|exit)\b/.test(readFileSync(full, "utf8"))) continue; } catch { continue; }
    try {
      const mod = await import(pathToFileURL(full).href);
      for (const [k, v] of Object.entries(mod)) if (typeof v === "function" && !index.has(k)) index.set(k, v);
    } catch { /* unimportable — skip */ }
  }
  return index;
}

const render = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** Run the spec's examples against the workspace; return the mismatches. */
export async function checkSpecExamples(workspace, spec) {
  const examples = parseExamples(spec);
  if (!examples.length) return [];
  const index = await exportIndex(workspace);
  const findings = [];
  for (const ex of examples) {
    const fn = index.get(ex.fn);
    if (!fn) continue; // the spec named something this repo doesn't export — not our business
    let got, threw = null;
    try { got = fn(...ex.args); } catch (e) { threw = String((e && e.message) || e); }
    if (threw !== null || !deepEqual(got, ex.expected)) {
      findings.push({ fn: ex.fn, args: ex.args, expected: ex.expected, got: threw !== null ? `threw: ${threw}` : got });
    }
  }
  return findings;
}

/** Format findings as a done-gate observation, or "" if there are none. */
export function formatSpecExamples(findings) {
  if (!findings.length) return "";
  const lines = findings.slice(0, 6).map(
    (f) => `  ${f.fn}(${f.args.map(render).join(", ")})  →  got ${render(f.got)}  ·  spec says ${render(f.expected)}`,
  );
  return "[spec-example] your code disagrees with example(s) stated in the task spec:\n"
    + lines.join("\n")
    + "\nThe spec is the oracle — make these produce the stated result before finishing.";
}

// CLI: `node spec-examples.js <workspace> <specfile>` prints findings as JSON.
// The done-gate runs this as a subprocess so candidate code executes out of the
// harness process, with a timeout to survive an out-of-spec infinite loop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [workspace, specfile] = process.argv.slice(2);
  let spec = "";
  try { spec = readFileSync(specfile, "utf8"); } catch { /* no spec */ }
  checkSpecExamples(workspace || ".", spec)
    .then((f) => process.stdout.write(JSON.stringify(f)))
    .catch(() => process.stdout.write("[]"));
}
