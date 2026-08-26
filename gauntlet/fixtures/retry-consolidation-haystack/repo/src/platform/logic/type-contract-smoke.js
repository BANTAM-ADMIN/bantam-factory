// Accepted-type contract smoke check.
//
// Third sibling of edge-smoke.js and lexical-smoke.js. Where lexical-smoke asks
// "does the code REJECT a spelling the task said is valid?", this asks the mirror
// question: "does the code ACCEPT a value the task's stated type excludes?"
//
// The recorded specimen (adapter-migration, local 27B, 2026-07-30): across the
// six lexical-smoke-gate-ab runs -- all of which wrote a correct parseEnabled --
// the hidden contract still failed 6/6 on "normalizes collections without
// mutation or prototype hazards". Probing the reconstructed trees:
//
//   normalizeTags("a")        -> ["a"]        (a bare string is not an array)
//   normalizeTags(["ok", 2])  -> ["ok","2"]   (coerced a number to a string)
//   normalizeHeaders([])      -> {}           (an array is not a plain object)
//
// One shape: the model COERCES where the contract requires a throw. Being
// helpful is the wrong instinct against a strict contract, and the visible suite
// only ever passes well-formed input, so nothing contradicts it.
//
// Deliberately narrow. Only two accepted-type phrases are recognised, both of
// which name a closed, unambiguous set. Phrases like "a non-negative integer or a
// trimmed unsigned decimal-integer string" are NOT handled: deriving negatives
// from them needs judgement, and a false bounce is expensive.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".bantam", "coverage", "dist"]);

// Each accepted type carries the probes its own wording excludes, and nothing more.
const ACCEPTED_TYPES = {
  "array-of-strings": {
    // "accepts an array of strings" excludes a non-array, and an array whose
    // entries are not strings.
    match: /\ban\s+array\s+of\s+strings\b/i,
    describe: "an array of strings",
    probes: [
      { value: "a", why: "a bare string is not an array" },
      { value: ["ok", 2], why: "a non-string entry is not a string" },
    ],
  },
  "plain-object": {
    // "accepts a plain object" excludes an array (typeof [] === "object", which
    // is exactly the check a permissive implementation forgets). "an optional
    // plain object" is the same accepted type: "optional" governs whether the
    // argument may be OMITTED, not which types are valid when one is supplied,
    // and the probe below never passes undefined. adapter-migration phrases
    // normalizePage and normalizeRetry that way, and both still fail the hidden
    // grader on normalizePage([]) / normalizeRetry([]).
    match: /\ban?\s+(?:optional\s+)?plain\s+object\b/i,
    describe: "a plain object",
    probes: [
      { value: [], why: "an array is not a plain object" },
    ],
  },
};

/**
 * Map each function to the accepted types its OWN clause names.
 *
 * Clause-scoped for the same reason lexical-smoke is: a multi-contract assignment
 * states one type per function, and applying them globally would false-bounce
 * correct code.
 *
 * @returns {Map<string,string[]>}
 */
export function acceptedTypesByFunction(task) {
  const map = new Map();
  for (const clause of String(task ?? "").split(/(?<=[.;])\s+/)) {
    const kinds = Object.entries(ACCEPTED_TYPES)
      .filter(([, spec]) => spec.match.test(clause))
      .map(([kind]) => kind);
    if (!kinds.length) continue;
    for (const fn of new Set(clause.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) || [])) {
      const prev = map.get(fn) ?? [];
      for (const k of kinds) if (!prev.includes(k)) prev.push(k);
      map.set(fn, prev);
    }
  }
  return map;
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

const render = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

/**
 * Probe every exported function against the values its stated accepted type
 * excludes. A finding is a RETURN where the contract requires a throw.
 *
 * @returns {Promise<Array<{fn:string,file:string,accepts:string,probe:any,returned:string,why:string}>>}
 */
export async function typeContractSmokeWorkspace(workspace, task) {
  const contracts = acceptedTypesByFunction(task);
  if (!contracts.size) return [];

  const findings = [];
  const seen = new Set();
  for (const file of moduleFiles(workspace)) {
    let mod;
    try { mod = await import(pathToFileURL(file).href); } catch { continue; }
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      const kinds = contracts.get(name);
      if (!kinds) continue;
      for (const kind of kinds) {
        const spec = ACCEPTED_TYPES[kind];
        for (const probe of spec.probes) {
          let returned;
          try {
            returned = fn(probe.value);
          } catch {
            continue; // rejected as required
          }
          const key = `${name}:${kind}:${render(probe.value)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            fn: name,
            file: path.relative(workspace, file),
            accepts: kind,
            probe: probe.value,
            returned: render(returned),
            why: probe.why,
          });
        }
      }
    }
  }
  return findings;
}

/** Format findings as a done-gate bounce, or "" if there are none. */
export function formatTypeContractSmoke(findings) {
  if (!findings.length) return "";
  const lines = findings.slice(0, 6).map((f) => {
    const spec = ACCEPTED_TYPES[f.accepts];
    return `  ${f.fn}(${render(f.probe)})  returned  ${f.returned}\n`
      + `     the task says ${f.fn} accepts ${spec ? spec.describe : f.accepts}, and ${f.why} — so this must throw instead.`;
  });
  return "[type-contract-smoke] your code accepts values the task's stated type excludes:\n"
    + lines.join("\n")
    + "\nReject these with a TypeError rather than coercing them, then rerun verification.";
}

// CLI: `node type-contract-smoke.js <workspace> <taskFile>` -> findings as JSON.
// Run as a subprocess by the done-gate so candidate code executes out of the
// harness process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let task = "";
  try { task = readFileSync(process.argv[3], "utf8"); } catch { /* no task, no gate */ }
  typeContractSmokeWorkspace(process.argv[2] || ".", task)
    .then((f) => process.stdout.write(JSON.stringify(f)))
    .catch(() => process.stdout.write("[]"));
}
