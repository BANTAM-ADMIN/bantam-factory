// A `done` whose summary is a stub is not a claim of completion. It is the model
// filling a required field and leaving.
//
// TB2 mailman (2026-08-21), on a clean build with the python fix in place and
// zero error signals in its stream. Ten actions in — it had read eval.py, listed
// /etc/mailman3, and written one config file — it emitted:
//
//     {"a":"done","summary":"placeholder"}
//
// and the run ended. Turn 10 of a 200-turn budget, reward 0.
//
// Nothing caught it. empty_done wants an untouched tree and the tree had been
// touched; premature_done needs a failing test verdict and no test had ever run,
// so it returned null and waved the done through. Every gate in the chain was
// looking at the WORK. None was looking at the SUMMARY, which in this case was
// the one field that announced the run was not finished.
//
// The check is cheap and unambiguous: no real run describes what it accomplished
// as "placeholder", "TODO", or "...". Treating that as a completion claim is the
// harness believing something the model did not say.

const PLACEHOLDER_WORDS = new Set([
  "placeholder", "todo", "tbd", "tba", "n/a", "na", "none", "null", "nil",
  "summary", "description", "text", "string", "value", "xxx", "yyy", "zzz",
  "foo", "bar", "baz", "test", "testing", "example", "sample", "stub",
  "wip", "pending", "unknown", "asdf", "lorem",
]);

// `<summary>`, `[summary]`, `{{summary}}`, `TODO:`, `...`, `--`, `N/A.`
const TEMPLATE_MARKER = /^[\s<>\[\]{}()"'`*_.,:;#-]*$|^(?:<|\[|\{\{)[^>\]}]{0,40}(?:>|\]|\}\})[\s.:-]*$/;

/** Strip decoration so "TODO:" and "[placeholder]" reduce to their word. */
function core(summary) {
  return String(summary ?? "")
    .trim()
    .replace(/^[\s<>\[\]{}()"'`*_#-]+|[\s<>\[\]{}()"'`*_#.!:;-]+$/g, "")
    .trim()
    .toLowerCase();
}

/** Is this summary a stub rather than a description of work? */
export function isPlaceholderSummary(summary) {
  const raw = String(summary ?? "");
  const c = core(raw);
  if (!c) return true;                                  // empty or pure punctuation
  if (TEMPLATE_MARKER.test(raw.trim())) return true;    // <summary>, ..., --
  if (PLACEHOLDER_WORDS.has(c)) return true;            // placeholder, todo, stub
  // "todo: finish this" / "placeholder for now" — a stub that grew a tail but
  // still leads with the marker and says nothing about what was done.
  const first = c.split(/[\s:,.-]+/)[0] ?? "";
  if (PLACEHOLDER_WORDS.has(first) && c.length <= 24) return true;
  return false;
}

/**
 * Refuse a done whose summary is a stub. Bounded like every other gate: after
 * `maxRejections` it stands, so this can never trap a run that genuinely has
 * nothing more to say.
 */
export function placeholderDoneObjection(turns, alreadyRejected = 0, opts = {}) {
  const { maxRejections = 2 } = opts;
  if (alreadyRejected >= maxRejections) return null;

  const all = turns || [];
  let summary = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const a = (all[i]?.action ?? all[i]?.parsedAction ?? {});
    if (a.a === "done") { summary = a.summary; break; }
  }
  if (summary === null) return null;
  if (!isPlaceholderSummary(summary)) return null;

  const shown = String(summary ?? "").trim().slice(0, 40);
  return (
    `You called done with the summary ${shown ? `\`${shown}\`` : "(empty)"}, which describes no work. `
    + `A stub summary is not a completion claim — it is the required field filled in so the action would parse. `
    + `If you are actually finished, say concretely what you built or changed, name the files you touched, and name the `
    + `command whose output proves it works. If you cannot write those three things, you are NOT finished: go back and `
    + `do the task. A run once ended on turn 10 of 200 with the summary "placeholder", having written one config file `
    + `and verified nothing, and scored zero.`
  );
}
