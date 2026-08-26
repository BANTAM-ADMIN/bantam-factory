// The contract-coverage done-gate (sweep films + A/B, 2026-08-26).
//
// The measured failure: on contract-handing tasks, fast draws implement an
// ENUMERATED list (operators, rule clauses) but their suites never test the
// unglamorous entries — rowquery shipped all six operators and a greedy-regex
// tokenizer that mis-parses `!=`/`<=`, invisible to a suite that tests
// neither. The advisory station (enumerate-the-contract v1/v2) fires
// correctly and compiles ~50%: v2's complied reps wrote 35-test suites and
// won; the non-complied wrote 11 and lost. Advice rolls dice; gates don't.
//
// Scope, deliberately narrow (v1): SYMBOL enumerations — a listed run of
// three or more operator-like tokens (`>= <= != > < =`) in the task text or
// in the head comment of a workspace source file. Each listed token must
// appear somewhere in the test files, or done bounces ONCE naming the
// untested tokens verbatim. Word-list contracts (slugline's "no leading or
// trailing dashes") are out of scope until a detector earns its keep.
import fs from "node:fs";
import path from "node:path";
import { CONTRACT_TASK_RE } from "./probe-discipline.js";

const SYMBOL_RUN_RE = /(?:^|[\s:])((?:[<>=!+\-*/%&|^~]{1,3}\s+){2,}[<>=!+\-*/%&|^~]{1,3})(?:\s|$)/gm;
const HEAD_LINES = 40;

export function extractSymbolEnumerations(text) {
  const found = [];
  for (const m of String(text ?? "").matchAll(SYMBOL_RUN_RE)) {
    // Comment punctuation is made of the same characters as operators; a
    // token that is ONLY slashes/asterisks is the comment, not the contract.
    const items = m[1].trim().split(/\s+/)
      .filter((t) => t.length <= 3 && !/^[/*]+$/.test(t));
    if (new Set(items).size >= 3) found.push([...new Set(items)]);
  }
  return found;
}

function headComments(fileText) {
  return String(fileText ?? "").split("\n").slice(0, HEAD_LINES)
    .filter((l) => /^\s*(\/\/|#|\*|\/\*)/.test(l)).join("\n");
}

/** Contract sources: the task itself + head comments of workspace source files. */
function gatherContractText(task, workspace) {
  const parts = [String(task ?? "")];
  const roots = ["", "src", "lib"];
  for (const rel of roots) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(workspace, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/\.(m?js|py|ts)$/.test(e.name)) continue;
      try { parts.push(headComments(fs.readFileSync(path.join(workspace, rel, e.name), "utf8"))); } catch { /* skip */ }
    }
  }
  return parts.join("\n");
}

function gatherTestText(workspace) {
  const parts = [];
  const dirs = ["test", "tests", ""];
  for (const rel of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(workspace, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/(^test_.*\.py|\.test\.[cm]?js|_test\.py)$/.test(e.name) && rel === "") continue;
      if (rel !== "" && !/\.(m?js|py|ts)$/.test(e.name)) continue;
      try { parts.push(fs.readFileSync(path.join(workspace, rel, e.name), "utf8")); } catch { /* skip */ }
    }
  }
  return parts.join("\n");
}

export function contractCoverageObjection({ task, workspace, count = 0 }) {
  if (count >= 1) return null;                               // one bounce, then the human's call
  if (!CONTRACT_TASK_RE.test(String(task ?? ""))) return null;
  const enums = extractSymbolEnumerations(gatherContractText(task, workspace));
  if (!enums.length) return null;
  const tests = gatherTestText(workspace);
  if (!tests.trim()) return null;                            // no suite at all: premature_done's beat
  const missing = [...new Set(enums.flat())].filter((tok) => !tests.includes(tok));
  if (!missing.length) return null;
  return `The contract for this task ENUMERATES symbol cases, and these listed items appear in NO test: `
    + `${missing.map((t) => `\`${t}\``).join(" ")}. An enumerated contract is covered item by item — an untested `
    + `operator is where a subtle parsing or semantics bug hides (measured: a green suite passed while \`!=\` `
    + `mis-parsed upstream). Add at least one test exercising EACH listed item through the public entry point, `
    + `run the suite, then finish.`;
}
