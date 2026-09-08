// The unsearched-choice gate: you cannot pick the best of N by thinking about it.
//
// TB2 constraints-scheduling (2026-08-21). The task lists nine hard constraints
// across three people, hands over three ICS calendars, and asks for the EARLIEST
// valid one-hour slot. The run read the calendars, reasoned it through in prose,
// and wrote Monday 09:00 — which violates Bob's "no meetings before 10 AM". It
// spent twelve turns and executed NOTHING: its only two shell calls were a `cat`
// to look at a file and a `cat >` heredoc to write the answer.
//
// The compute-dont-reason RULE was in that run's prompt bytes — "COMPUTE it" and
// "ENUMERATE" both verifiably present at 26,778 bytes — and it was waved past.
// That is the standing finding about advice: a rule advises, a gate enforces.
//
// What makes this checkable rather than a matter of taste: the task asks for a
// SUPERLATIVE or an EXHAUSTIVE set — earliest, best, all valid, every solution —
// over a candidate space the run was handed. That is a decidable question. An
// answer to a decidable question, produced without executing anything that could
// have decided it, is a guess wearing an argument's clothes.

// The task wants one distinguished element, or all of them, out of a space.
// Deliberately requires a SELECTION word: "write the config" is not a search.
const SELECTION_RE = /\b(?:earliest|latest|best|optimal|shortest|longest|cheapest|fastest|smallest|largest|maximum|minimum|most|fewest|all (?:valid|possible|such)|every (?:valid|possible)|that satisf(?:y|ies)|satisfying all)\b/i;

// A candidate space the run has to search, rather than a value it can look up.
const SPACE_RE = /\b(?:slot|schedule|combination|permutation|arrangement|assignment|route|path|move|solution|candidate|subset|ordering|placement|allocation)s?\b/i;

const act = (turn) => (turn && (turn.action || turn.parsedAction)) || null;

/**
 * Does the task pose a decidable SEARCH — pick the extreme, or enumerate every
 * one, out of a space of candidates?
 */
export function taskDemandsSearch(task) {
  const text = String(task ?? "");
  // An unrelated superlative in background prose and a later mention of an
  // array slot/path do not together constitute a search request.
  return text.split(/\n|(?<=[.!?])\s+/).some(clause => SELECTION_RE.test(clause) && SPACE_RE.test(clause));
}

/**
 * Did the run EXECUTE anything capable of deciding it? Viewing a file and
 * writing the answer are not searching; an interpreter, a compiled binary or a
 * solver is. Kept deliberately generous — the bar is "ran something", not "ran
 * something I recognise", because enumerating recognised tools is how three
 * other gates in this codebase learned to refuse valid work.
 */
export function ranASearch(turns, isCompute) {
  for (const turn of turns ?? []) {
    const a = act(turn);
    if (!a) continue;
    if (a.a === "shell" && isCompute(String(a.c ?? ""))) return true;
    // A script authored and then run counts; the source names the search even
    // when the shell line is just its filename.
    if (typeof a.content === "string" && /\b(?:for |while |itertools|range\(|sorted\(|min\(|max\(|solve|search|enumerate)\b/.test(a.content)) {
      return true;
    }
  }
  return false;
}

/**
 * Objection for a done that answers a search without having run one. One bounce.
 * @returns {string|null}
 */
export function unsearchedChoiceObjection(turns, count = 0, { task = "", isCompute = () => false } = {}) {
  if (count >= 1) return null;
  if (!taskDemandsSearch(task)) return null;
  if (ranASearch(turns, isCompute)) return null;

  return "You are answering a question that has a DECIDABLE answer — the task asks for the earliest, the best, or all of something "
    + "over a space of candidates you were handed — and this run has not executed anything capable of deciding it. Reading the inputs and "
    + "writing an answer are not searching; the choice was made by argument.\n"
    + "That is the exact shape that fails these graders: a scheduling run picked 09:00 by reasoning and missed a stated \"no meetings before 10 AM\", "
    + "producing a perfectly well-formed answer that was simply wrong, with nothing in the output to reveal it.\n"
    + "Before you finish: (1) ENUMERATE the candidate space in code — every slot, move, route, or combination, at the granularity the task states. "
    + "(2) Write each hard constraint as a separate predicate and FILTER, so a violated constraint is a failed test rather than something you have to remember. "
    + "(3) Sort by the task's stated tie-breakers and take the answer off the top of the list. "
    + "(4) Print the surviving candidates and the chosen one, so the choice is visible evidence rather than a claim.\n"
    + "If the enumeration returns nothing, a constraint is wrong — that is information, and it is information you cannot get by thinking harder.";
}
