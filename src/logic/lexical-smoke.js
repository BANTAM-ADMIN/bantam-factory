// Lexical-language smoke check.
//
// Sibling of edge-smoke.js. Where edge-smoke probes DEGENERATE inputs the visible
// tests skipped, this probes the accepted-string language the TASK ITSELF named:
// "trimmed", "case-insensitive". The model narrows those to a canonical spelling
// (`t === "true"` instead of `t.toLowerCase() === "true"`), the visible suite stays
// green because it only ever passes the canonical form, and only the hidden grader
// knows.
//
// The recorded specimen (adapter-migration, local 27B, 2026-07-30): the advisory
// `[lexical-contract-audit]` reminder fired at turn 6, named case-insensitivity
// explicitly, and was ignored for four turns before a confident done. Same fact,
// wrong voice — advisory text persuades, a done-gate binds (docs/PRINCIPLES.md #5).
//
// The invariant that keeps this mechanical rather than advisory, and false
// positives near zero: a finding requires the accepted spelling to WORK and only
// the named variant to THROW. A function that rejects the base literal is simply
// not the function that parses it, and is skipped.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".bantam", "coverage", "dist"]);

/** Which accepted-string languages the assignment explicitly names. */
export function namedLanguages(task) {
  const s = String(task ?? "");
  return {
    caseInsensitive: /\bcase[\s-]*insensitive\b/i.test(s),
    trimmed: /\btrim(?:med|s|ming)?\b/i.test(s),
  };
}

/** Quoted spellings the task names as accepted, e.g. "true"/"false". */
export function taskAcceptedLiterals(task) {
  const out = new Set();
  for (const m of String(task ?? "").matchAll(/"([^"\n]{1,32})"|'([^'\n]{1,32})'/g)) {
    const v = m[1] ?? m[2];
    if (v && /\S/.test(v)) out.add(v);
  }
  return [...out];
}

/**
 * Associate each named language with the function its own clause names.
 *
 * A multi-contract assignment names case-insensitivity for one function while
 * every other export legitimately preserves case. Applying a language globally
 * false-bounces correct code, so each contract is scoped to its own sentence --
 * the same "independently gated by its corresponding contract language" rule the
 * advisory audit already follows.
 *
 * @returns {Map<string,{languages:{caseInsensitive:boolean,trimmed:boolean},literals:string[]}>}
 */
export function contractsByFunction(task) {
  const map = new Map();
  // Specs list one contract per sentence; `;` also separates them in practice.
  for (const clause of String(task ?? "").split(/(?<=[.;])\s+/)) {
    const languages = namedLanguages(clause);
    if (!languages.caseInsensitive && !languages.trimmed) continue;
    const literals = taskAcceptedLiterals(clause);
    if (!literals.length) continue;
    // camelCase identifiers are how these specs name the functions they govern.
    for (const fn of new Set(clause.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) || [])) {
      const entry = map.get(fn) ?? { languages: { caseInsensitive: false, trimmed: false }, literals: new Set() };
      entry.languages.caseInsensitive ||= languages.caseInsensitive;
      entry.languages.trimmed ||= languages.trimmed;
      for (const l of literals) entry.literals.add(l);
      map.set(fn, entry);
    }
  }
  return new Map([...map].map(([k, v]) => [k, { languages: v.languages, literals: [...v.literals] }]));
}

/** Variants of an accepted spelling that the named languages require to stay valid. */
export function variantsFor(literal, languages) {
  const out = [];
  if (languages.caseInsensitive) {
    const upper = literal.toUpperCase();
    if (upper !== literal) out.push({ value: upper, language: "case-insensitive" });
  }
  if (languages.trimmed) out.push({ value: ` ${literal} `, language: "trimmed" });
  return out;
}

const render = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

function sameResult(a, b) {
  if (Object.is(a, b)) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function* moduleFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* moduleFiles(p, depth + 1);
    else if (e.isFile() && /\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) yield p;
  }
}

/**
 * Probe every exported function in the workspace with the task's named spellings.
 * Recursive, unlike edgeSmokeWorkspace: real repos keep modules under src/ and
 * tests elsewhere, and the recorded specimen lived in src/adapters/.
 *
 * @returns {Promise<Array<{fn:string,file:string,language:string,accepted:string,variant:string,error:string}>>}
 */
export async function lexicalSmokeWorkspace(workspace, task) {
  const contracts = contractsByFunction(task);
  if (!contracts.size) return [];

  const findings = [];
  const seen = new Set();
  for (const file of moduleFiles(workspace)) {
    let mod;
    try { mod = await import(pathToFileURL(file).href); } catch { continue; }
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      // Only probe a function whose own clause named an accepted-string language.
      const contract = contracts.get(name);
      if (!contract) continue;
      const { languages, literals } = contract;
      for (const accepted of literals) {
        // The accepted spelling must work, or this is not the parser for it.
        let base;
        try { base = fn(accepted); } catch { continue; }
        for (const v of variantsFor(accepted, languages)) {
          let got, threw = null;
          try { got = fn(v.value); } catch (e) { threw = e; }
          // A named language is an oracle: the variant is the SAME value spelled
          // differently, so it must neither throw nor produce a different result.
          let error = null;
          if (threw) error = String((threw && threw.message) || threw);
          else if (!sameResult(base, got)) {
            error = `returned ${render(got)}, expected ${render(base)} — the same result as the accepted spelling`;
          }
          if (!error) continue;
          const key = `${name}:${v.language}:${accepted}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            fn: name,
            file: path.relative(workspace, file),
            language: v.language,
            accepted,
            variant: v.value,
            error,
          });
        }
      }
    }
  }
  return findings;
}

/** Format findings as a done-gate bounce, or "" if there are none. */
export function formatLexicalSmoke(findings) {
  if (!findings.length) return "";
  const lines = findings.slice(0, 6).map(
    (f) => `  ${f.fn}(${JSON.stringify(f.variant)})  threw:  ${f.error}\n`
      + `     ${f.fn}(${JSON.stringify(f.accepted)}) is accepted, and the task names a ${f.language} language — so this spelling must be accepted too.`,
  );
  return "[lexical-smoke] the task names accepted string languages, but your code rejects valid spellings of them:\n"
    + lines.join("\n")
    + "\nWiden the accepting comparison (not the error message) so these spellings parse, then rerun verification.";
}

// CLI: `node lexical-smoke.js <workspace> <taskFile>` prints findings as JSON.
// The done-gate runs this as a subprocess so candidate modules execute OUT of
// the harness process — a crash, hang, or hostile top-level statement cannot
// reach the agent loop. The task arrives as a FILE (like spec-example's CLI):
// a multi-contract assignment is far too long to pass safely through argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let task = "";
  try { task = readFileSync(process.argv[3], "utf8"); } catch { /* no task, no gate */ }
  lexicalSmokeWorkspace(process.argv[2] || ".", task)
    .then((f) => process.stdout.write(JSON.stringify(f)))
    .catch(() => process.stdout.write("[]"));
}
