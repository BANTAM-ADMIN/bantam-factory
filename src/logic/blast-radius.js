// Which files import the one that was just edited?
//
// The expert failure mode is not ignorance, it is CONFIDENCE: changing a module
// without knowing what depends on it. Measured across 34 Codex runs and 383 turns,
// not one of BANTAM's sixteen defect gates ever fired -- Codex simply does not make
// the mistakes they were built from. What it can still do is edit a file whose
// dependents it never looked at.
//
// So this is CONTEXT, not a gate. It refuses nothing and blocks nothing; it states
// a fact the model would otherwise have to go and discover, at the moment the fact
// becomes relevant. That is the one lever measured to matter all day: completeness
// of what the model is told.
//
// Built on dependency-impact.js, which was shelved -- 379 lines, imported only by
// its own test -- while working correctly: 198 files indexed, and changing
// prompt.js correctly reports agent.js, fixture-runner.js and compare-plan.js
// among its dependents.

// MEASURED, by the same test that disabled the completion audit for Codex.
// gpt-5.6-terra, keyed-task-pool-strong, n=3 per arm, complete separation
// (exact permutation p = 0.05):
//
//                 mean turns   mean cache miss   hidden contract
//   blast ON         7.0          27,716         4/4, 4/4, 4/4
//   blast off        8.0          30,859         4/4, 4/4, 4/4
//
// -12.5% turns and -10% cache misses for +6% output. Naming the dependent appears
// to get it checked before the verify step rather than after it.
//
// The contrast with the completion audit is the useful part. Both are advisory and
// both fire on nearly every run, and they land in OPPOSITE directions:
//
//   completion audit   "re-check everything against the assignment"   +54% turns
//   blast radius       "run-plan.js imports the file you edited"      -12.5% turns
//
// A specific fact the model does not have is worth its tokens. A general
// instruction to be careful is not -- it asks a frontier model to redo reasoning it
// already did, and re-reading costs turns.
//
// PRE-REGISTERED AND FALSIFIED. The rule predicted that the state audit, being an
// "audit these boundaries" instruction, would cost turns like the completion audit.
// Measured n=3 per arm on keyed-task-pool-strong, it did the opposite:
//
//                    mean turns   mean cache miss
//   stateAudit ON        6.3         23,094
//   stateAudit off       7.3         37,816
//
// -14% turns and -39% cache misses, one of the strongest results measured.
//
// Read afterwards, the state audit is not an exhortation at all: it names the exact
// boundaries where concurrency bugs live and the exact invariant that must hold.
// It is a compressed expert briefing wearing an instruction's grammar, whereas the
// completion audit really does just say "check your work".
//
// So the rule may survive, but it could NOT be applied correctly in advance -- and a
// rule that only sorts cases after they are measured is not a predictor. Treat
// specific-vs-generic as a description of results, not a reason to skip measuring.

const MAX_LISTED = 6;

const isTestPath = (p) => /(?:^|\/)(?:tests?|__tests__)\//.test(p)
  || /\.(?:test|spec)\.[cm]?js$/.test(p);

/**
 * A one-line note naming the dependents of an edited file.
 *
 * @param {string} rel            path of the edited file, workspace-relative
 * @param {string[]} dependents   files that import it, transitively
 * @returns {string} "" when there is nothing worth saying
 */
export function blastRadiusNote(rel, dependents) {
  // Tests are excluded. "your test file imports the file you just edited" is not
  // news -- measured on a live Codex run, every note emitted said exactly that, and
  // a note costs prompt tokens on every remaining turn of the run. The note exists
  // to name dependents the model has NOT looked at; its own test suite is the one
  // dependent it is already thinking about.
  const list = [...new Set(
    (dependents ?? []).filter((d) => d && d !== rel && !isTestPath(d)),
  )].sort();
  // Silence when nothing imports it. A note saying "0 files affected" on every
  // leaf edit is noise, and noise in a prompt is not free -- it is re-sent every
  // turn for the rest of the run.
  if (!list.length) return "";
  const shown = list.slice(0, MAX_LISTED);
  const rest = list.length - shown.length;
  const tail = rest > 0 ? `, +${rest} more` : "";
  return `[impact] ${list.length} file(s) import ${rel}: ${shown.join(", ")}${tail}. `
    + "Check them if this change alters behaviour they rely on.";
}

/**
 * Dependents of `rel`, given a prebuilt dependency-impact graph.
 *
 * Separated from the note so the graph can be built once per run rather than per
 * edit: buildDependencyGraph walks and parses every file in the tree, which is
 * far too expensive to repeat on each write.
 *
 * @param {string} rel
 * @param {{graph: Map, reverseGraph: Map}} indexed
 * @param {(file: string, graph: Map, reverseGraph: Map) => string[]} findAffected
 */
export function dependentsOf(rel, indexed, findAffected) {
  if (!indexed?.graph || !indexed?.reverseGraph) return [];
  if (!indexed.graph.has(rel)) return [];
  try {
    return findAffected(rel, indexed.graph, indexed.reverseGraph) ?? [];
  } catch {
    // An impact graph is an optimisation. A failure to compute one must never
    // take down the edit that triggered it.
    return [];
  }
}
