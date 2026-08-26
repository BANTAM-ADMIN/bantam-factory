// The simulate-to-target gate: when the task hands you the answer's END STATE,
// checking the rules it should satisfy is not the same as checking it.
//
// TB2 dna-insert (2026-08-21). The task supplies BOTH plasmids — the circular
// input and the desired output — and asks for primers that convert one into the
// other. The run spent 195 of 200 turns validating what it could compute
// directly: annealed lengths in [15,45], melting temperatures in [58,72], pair
// Tm within 5 degrees. All green. It said "product" 258 times and never once
// built the product and compared it to the desired plasmid — zero occurrences of
// a reverse-complement, a concatenation, or an equality against the target.
//
// The grader derives the annealed regions differently from the run: it locates
// the insert inside `rc(rev) + fwd` and takes what falls either side. By that
// derivation the forward anneal was 'ag' — two nucleotides against a floor of
// fifteen. A single simulation to the stated end state would have caught it in
// one turn; the constraint checks could not, because they were measuring a
// different thing than the grader was.
//
// This is the same shape as the round-trip in render-decode and the diff in
// write-compressor ("cat data.comp | decomp gives exactly data.txt"). When the
// target is stated, reproducing it IS the gauge; everything else is a proxy.

const act = (turn) => (turn && (turn.action || turn.parsedAction)) || null;

// The task states an end state the deliverable must reproduce. Requires an
// explicit equivalence, not merely the word "output" — plenty of tasks name an
// output file without supplying its expected contents.
const TARGET_RE = new RegExp(
  "\\b(?:gives?|produces?|yields?|results? in|converts? .{0,40}\\binto\\b|so that .{0,60}\\bmatches?\\b)\\s+(?:exactly\\s+)?\\S"
  + "|\\bdesired\\s+(?:output|result|state|plasmid|sequence|file)\\b"
  + "|\\bexpected\\s+(?:output|result|contents?)\\b"
  + "|\\bidentical to\\b|\\bexactly matches?\\b|\\bmust (?:equal|reproduce|round-?trip)\\b",
  "i",
);

// Evidence the run actually reproduced-and-compared, rather than only checking
// the rules. Kept broad on purpose: the bar is "compared its artifact against
// the target", not "compared it in a way I recognise".
const COMPARISON_RE = new RegExp(
  "\\b(?:diff|cmp|assertEqual|assert_equal|filecmp|sha256sum|md5sum)\\b"
  + "|==\\s*(?:open|expected|target|desired|golden|reference)"
  + "|(?:expected|target|desired|golden|reference)\\w*\\s*==",
  "i",
);

/** Every shell command plus the source of anything the run authored. */
function evidence(turns) {
  const parts = [];
  for (const turn of turns ?? []) {
    const a = act(turn);
    if (!a) continue;
    if (a.a === "shell" && typeof a.c === "string") parts.push(a.c);
    if (typeof a.content === "string") parts.push(a.content);
  }
  return parts.join("\n");
}

/** Does the task state an end state the deliverable must reproduce? */
export function taskStatesTarget(task) {
  return TARGET_RE.test(String(task ?? ""));
}

/** Did the run compare anything it produced against that target? */
export function comparedAgainstTarget(turns) {
  return COMPARISON_RE.test(evidence(turns));
}

/**
 * Objection for a done that satisfied the stated RULES without ever reproducing
 * the stated RESULT. One bounce.
 * @returns {string|null}
 */
export function unsimulatedTargetObjection(turns, count = 0, { task = "" } = {}) {
  if (count >= 1) return null;
  if (!taskStatesTarget(task)) return null;
  if (comparedAgainstTarget(turns)) return null;

  return "This task states the END STATE your answer has to produce, and nothing in this run has reproduced it. "
    + "You have checked the rules the answer should satisfy — lengths, temperatures, sizes, formats — which is a PROXY. "
    + "The target is the gauge.\n"
    + "Before you finish: apply your artifact to the input the way the task describes, build the actual result, and compare it to the "
    + "stated target byte-for-byte (`diff`, `cmp`, or an equality assertion). Print both the comparison and its verdict.\n"
    + "Why this matters more than another constraint check: a grader derives the quantities it checks its OWN way, and yours can be "
    + "measuring something different while every number looks right. A primer design once passed every stated rule — anneal length, "
    + "melting temperature, pair difference — and the grader, deriving the annealed region by locating the insert inside the joined "
    + "primers, measured that same region as two nucleotides against a floor of fifteen. Reproducing the target would have caught it "
    + "in one turn.\n"
    + "If reproducing the target is genuinely impossible here, say so explicitly and give the closest check you can actually run.";
}
