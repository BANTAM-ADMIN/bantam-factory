// Edge-input smoke check.
//
// The recurring "wheelhouse" failure of a small model is not a wrong algorithm —
// it is a solution that satisfies the visible examples and then CRASHES on an
// unhandled edge the examples never showed (an empty string, an empty array, 0).
// The visible tests are the model's whole notion of "correct", so it never sees
// the edge. This surfaces a subclass of that gap MECHANICALLY: run each exported
// function on degenerate inputs of the types the tests already exercise, and
// report any that throw. That is a true fact the harness can state — not advice.
//
// It only catches CRASHES (a thrown exception), never silent-wrong-answer edges:
// with no oracle we cannot know the right output, but we can know that throwing
// on a valid-shaped input is almost never intended.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Degenerate inputs per inferred argument type — the "boring" values examples skip.
//
// STRINGS ONLY, by design. An empty (or blank) string is a valid value for almost
// any string parameter, so a function that throws on it is almost always a real
// bug (the recorded titleCase("") crash). Numbers, arrays, and objects were tried
// too at first, but a measured false-positive audit over 58 correct reference
// solutions showed those degenerates violate DOMAIN constraints — base 0 for a
// 2..36 radix, step 0 for a range, [] for a transpose — where the throw is correct
// behavior, not a bug. Feeding them false-bounced ~5% of correct solutions, so the
// gate is deliberately narrowed to the case where "throws = bug" reliably holds.
const DEGENERATE = {
  string: ["", " "],
};

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "object";
  return typeof v;
}

// Pull the first example argument list for each exported function out of the
// visible test source (so we learn each parameter's shape without any spec).
function exampleCalls(testSrc, fnNames) {
  const calls = {};
  for (const fn of fnNames) {
    const re = new RegExp("\\b" + fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(", "g");
    let m;
    while ((m = re.exec(testSrc))) {
      let i = re.lastIndex - 1, depth = 0;
      const start = i;
      for (; i < testSrc.length; i++) {
        const c = testSrc[i];
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
      }
      try {
        // The test file is already trusted (it is the verify command); parsing
        // one literal arg list with Function is scoped to this workspace.
        const args = Function(`"use strict";return [${testSrc.slice(start + 1, i)}];`)();
        calls[fn] = args;
        break;
      } catch { /* not a literal call (e.g. a variable) — try the next site */ }
    }
  }
  return calls;
}

const render = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/**
 * @param {string} moduleFile absolute path to the candidate ES module
 * @param {string} testFile   absolute path to its visible test file
 * @returns {Promise<Array<{fn:string,args:any[],error:string}>>} crashes found
 */
export async function edgeSmoke(moduleFile, testFile) {
  let mod, testSrc;
  try {
    mod = await import(pathToFileURL(moduleFile).href);
    testSrc = readFileSync(testFile, "utf8");
  } catch {
    return []; // can't introspect — stay silent rather than say something false
  }
  const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === "function");
  const calls = exampleCalls(testSrc, fnNames);
  const findings = [];
  for (const fn of fnNames) {
    const example = calls[fn];
    if (!example) continue;
    for (let pos = 0; pos < example.length; pos++) {
      for (const deg of DEGENERATE[typeOf(example[pos])] || []) {
        const args = example.slice();
        args[pos] = deg;
        try {
          mod[fn](...args);
        } catch (e) {
          findings.push({ fn, args, error: String((e && e.message) || e) });
        }
      }
    }
  }
  return findings;
}

/**
 * Smoke every `<name>.js` in a workspace that has a sibling `<name>.test.js`,
 * aggregating the crashes. This is the shape the done-gate consumes: the module
 * under test and the visible tests that teach it its argument shapes sit together.
 */
export async function edgeSmokeWorkspace(workspace) {
  let entries;
  try { entries = readdirSync(workspace); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith(".test.js")) continue;
    const moduleFile = path.join(workspace, f.replace(/\.test\.js$/, ".js"));
    try { out.push(...await edgeSmoke(moduleFile, path.join(workspace, f))); } catch { /* skip */ }
  }
  return out;
}

/** Format findings as a done-gate observation, or "" if there are none. */
export function formatEdgeSmoke(findings) {
  if (!findings.length) return "";
  const lines = findings.slice(0, 6).map(
    (f) => `  ${f.fn}(${f.args.map(render).join(", ")})  threw:  ${f.error}`,
  );
  return "[edge-smoke] your code threw on valid-shaped edge inputs the visible tests didn't cover:\n"
    + lines.join("\n")
    + "\nHandle these (or confirm throwing is intended by the spec) before finishing.";
}

// CLI: `node edge-smoke.js <workspace>` prints the findings as JSON. The done-gate
// runs this as a subprocess so the candidate module executes OUT of the harness
// process (a crash, hang, or hostile top-level statement cannot reach the loop).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  edgeSmokeWorkspace(process.argv[2] || ".")
    .then((f) => process.stdout.write(JSON.stringify(f)))
    .catch(() => process.stdout.write("[]"));
}
