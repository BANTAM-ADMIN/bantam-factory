// A public-contract jig, not a candidate-code smoke test.
//
// type-contract-smoke invokes a named export with one argument. That is not a
// sound way to construct arbitrary nested records or multi-argument APIs. This
// sibling instead supplies a tiny trusted-runtime witness for a specifically
// named language boundary before the worker chooses its implementation. It
// imports no candidate code, invents no API inputs, and grants no verification.
import { createHash } from "node:crypto";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const JS_LANGUAGE = /^(?:javascript|ecmascript|js|node|nodejs|node\.js)$/i;
const TASK_NAMES_JS = /\b(?:JavaScript|ECMAScript|Node\.js|NodeJS)\b|\bnode\s+[\w./-]+\.(?:mjs|cjs|js)\b/i;
const SAFE_INTEGER_TERM = /\bsafe[\s-]{1,8}integers?\b/gi;

function publicTerms(task) {
  const terms = [];
  for (const match of task.matchAll(SAFE_INTEGER_TERM)) {
    // Conservative local exclusions, not a natural-language contract parser.
    // Missing a paraphrase costs only a hint; adding a new requirement is worse.
    const before = task.slice(Math.max(0, match.index - 100), match.index);
    const after = task.slice(match.index + match[0].length, match.index + match[0].length + 80);
    if (/\b(?:no|not|never|without)\s+(?:(?:need|require|requires|requiring|enforce|enforcing|a|an|any|only)\s+){0,4}$/i.test(before)
        || /^\s+(?:validation\s+)?(?:(?:is|are)\s+)?(?:not\s+(?:required|needed)|unnecessary)\b/i.test(after)) continue;
    terms.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    if (terms.length === 3) break;
  }
  return terms;
}

/**
 * A task-bound observation of JavaScript Number semantics, or null.
 *
 * `language` may be supplied from a known workspace stack when the public task
 * does not name its language. Do not infer it from the worker model/profile.
 * This is intentionally independent of spec-gap auto-enablement: an explicit
 * safe-integer requirement still benefits from grounding its implementation.
 */
export function numericContractWitness(task, { language } = {}) {
  if (typeof task !== "string" || !task) return null;
  const explicitLanguage = language !== undefined && language !== null;
  if (explicitLanguage ? !JS_LANGUAGE.test(String(language)) : !TASK_NAMES_JS.test(task)) return null;
  const terms = publicTerms(task);
  if (!terms.length) return null;

  const max = Number.MAX_SAFE_INTEGER;
  const samples = [
    ["0", 0],
    ["1.5", 1.5],
    ["Number.MAX_SAFE_INTEGER", max],
    ["Number.MAX_SAFE_INTEGER + 1", max + 1],
    ["Number.MAX_SAFE_INTEGER + 2", max + 2],
    ["-Number.MAX_SAFE_INTEGER", -max],
    ["-(Number.MAX_SAFE_INTEGER + 1)", -(max + 1)],
  ];
  const body = {
    schema: "bantam.numeric-contract-witness.v1",
    kind: "javascript-safe-integer",
    scope: "language-semantics-only",
    candidateVerified: false,
    source: { kind: "public-task", sha256: sha256(task), terms },
    language: { name: "javascript", establishedBy: explicitLanguage ? "supplied-stack" : "public-task" },
    runtime: { node: process.version, v8: process.versions.v8 },
    observations: samples.map(([expression, value]) => ({
      expression,
      value,
      isInteger: Number.isInteger(value),
      isSafeInteger: Number.isSafeInteger(value),
      isNonnegativeSafeInteger: Number.isSafeInteger(value) && value >= 0,
    })),
    adjacentUnsafeValuesCollide: max + 1 === max + 2,
  };
  return { ...body, id: `sha256:${sha256(JSON.stringify(body))}` };
}

/** Bounded initial-context fact; never a done-gate verdict or claimed API test. */
export function formatNumericContractWitness(witness) {
  if (!witness) return "";
  const rows = witness.observations;
  const safe = rows.find((row) => row.expression === "Number.MAX_SAFE_INTEGER");
  const unsafe = rows.find((row) => row.expression === "Number.MAX_SAFE_INTEGER + 1");
  return "[public-numeric-contract]\n"
    + `Public task names ${JSON.stringify(witness.source.terms[0].text)}; task sha256:${witness.source.sha256}.\n`
    + `Observed JavaScript runtime fact (${witness.runtime.node}; NOT candidate verification):\n`
    + `Number.MAX_SAFE_INTEGER = ${safe.value}; Number.isSafeInteger(${safe.value}) = ${safe.isSafeInteger}.\n`
    + `Number.isInteger(${unsafe.value}) = ${unsafe.isInteger}, but Number.isSafeInteger(${unsafe.value}) = ${unsafe.isSafeInteger}.\n`
    + `(Number.MAX_SAFE_INTEGER + 1) === (Number.MAX_SAFE_INTEGER + 2) is ${witness.adjacentUnsafeValuesCollide}: the latter expression rounds to the same Number.\n`
    + "For a JavaScript Number safe-integer contract, Number.isInteger alone is insufficient; use Number.isSafeInteger. "
    + "Require value >= 0 as well only where the public contract says nonnegative. "
    + "This establishes language semantics, not whether your API accepts or rejects any input. "
    + "Exercise the applicable boundary through the actual API and run project verification.";
}
