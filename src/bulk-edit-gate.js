// The bulk-edit gate: a hundred hand edits to one file is a script you did not write.
//
// TB2 overfull-hbox (2026-08-21). The task allows exactly one kind of change —
// replace a word in input.tex with a synonym listed in synonyms.txt — and asks
// for a document that compiles with no overfull hbox. The run made **102
// separate `replace` edits to input.tex**, one word at a time, and finished with
// a substitution the grader rejected: `test_input_file_matches` compares the two
// files token by token and requires every swap to be a true 1:1 exchange of a
// LISTED word with identical leading and trailing punctuation.
//
// Hand-editing cannot hold an invariant like that. Nothing in a sequence of 102
// point edits checks the whole-file property, so one bad swap out of a hundred
// sinks the task, and the run has no way to know which one. A script that
// applies the substitution set and then re-checks the invariant over the ENTIRE
// file catches it on the spot — and can be re-run for free after every change.
//
// Sibling to script-churn, which catches dbg1/dbg2/probe3 throwaway FILES. This
// catches the other shape: many point edits to a SINGLE file, where the answer
// is one loop rather than one turn per edit.

import { EDIT_ACTIONS as CANONICAL_EDIT_ACTIONS, editPaths } from "./edit-actions.js";

export const BULK_EDIT_DEFAULTS = Object.freeze({
  // Point edits to one file before the gate concludes a loop was wanted. A real
  // refactor touches a handful of sites; a search dressed as editing does not
  // stop. 12 is comfortably above ordinary work and far below 102.
  editsBeforeNudge: 12,
  refireEvery: 25,
  maxFires: 2,
});

export function createBulkEditState() {
  return { perPath: new Map(), lastFiredAt: new Map(), fires: 0, cycles: new Map(), sawShell: false };
}

// DERIVED from the protocol's canonical set, never re-listed by hand. This gate
// originally hand-copied ["replace","edit_lines","patch"] and omitted write_file,
// so winning-avg-corewars rewrote my_warrior.red 42 times — the search itself —
// and the gate watched in silence for 99 turns.
//
// That is a bug this codebase had already learned once: diagnose.js carries the
// note that `edit_lines` was "promoted to the protocol, never added here, scored
// as a malformed output by every diagnose A/B", and it fixed the shape by
// deriving PRODUCTIVE as ALL_ACTION_VERBS minus RECON rather than enumerating it.
// Subtract from the canonical set; do not restate it. A new edit verb added to
// the protocol is then inherited here for free.
const EDIT_VERBS = new Set(
  // delete_file/move_file touch a path without rewriting its CONTENT, so they are
  // not the hand-run edit loop this gate is looking for.
  [...CANONICAL_EDIT_ACTIONS].filter((v) => v !== "delete_file" && v !== "move_file"),
);
// A shell command between two edits to the same path means the cycle is
// edit -> measure -> edit: a search being turned by hand, one turn per crank.
const MEASURED_CYCLE_HINT = " You are running a SEARCH by hand: edit, measure, edit again, one turn per iteration."
  + " Script the whole loop instead — generate a candidate, run the measurement, record the score, keep the best, repeat —"
  + " so one command explores what is currently costing you one turn each. A run once rewrote a single file 42 times against"
  + " 91 benchmark invocations and never wrote that loop; it spent its budget cranking.";

/**
 * Count point edits per path and steer once a single file has absorbed enough of
 * them to mean the run is turning a crank a script should turn.
 *
 * @param action  the turn's action
 * @param opts.scriptedEdit  () => boolean — has the run authored/run a script
 *                           that performs the edits? If so, never nudge.
 * @param state   createBulkEditState(), mutated in place
 */
export function assessBulkEdit(action, { scriptedEdit = () => false } = {}, state, defaults = BULK_EDIT_DEFAULTS) {
  const quiet = { steer: false };
  if (action?.a === "shell") { state.sawShell = true; return quiet; }
  if (!action || !EDIT_VERBS.has(action.a)) return quiet;
  // editPaths, not action.p: `patch` carries edits[].p and `write_batch` carries
  // files[].p, so reading `p` directly would miss both — the same
  // enumerate-instead-of-derive mistake one level down.
  const paths = editPaths(action);
  if (!paths.length) return quiet;
  const path = paths[0];

  let n = 0;
  for (const target of paths) {
    const c = (state.perPath.get(target) ?? 0) + 1;
    state.perPath.set(target, c);
    if (target === path) n = c;
    if (state.sawShell) state.cycles.set(target, (state.cycles.get(target) ?? 0) + 1);
  }
  state.sawShell = false;

  try { if (scriptedEdit()) return quiet; } catch { /* treat as unscripted */ }
  if (state.fires >= defaults.maxFires) return quiet;

  const last = state.lastFiredAt.get(path) ?? 0;
  const due = last === 0 ? n >= defaults.editsBeforeNudge : n - last >= defaults.refireEvery;
  if (!due) return quiet;

  state.lastFiredAt.set(path, n);
  state.fires += 1;
  return {
    steer: true,
    path,
    count: n,
    message:
      `\n\n[bulk-edit] You have made ${n} separate point edits to ${path}. That is a loop you are running by hand, one turn per iteration, `
      + `and it has two costs. It burns the turn budget you will need for the actual problem, and — the expensive one — no single edit can check a `
      + `WHOLE-FILE property, so a rule that must hold across every change is never actually verified. A run once made 102 hand substitutions into one `
      + `file and finished with one illegal swap it could not locate; the grader compared the files token by token and rejected the lot.\n`
      + `Write the script instead: put the change set in a table (a dict, a list of pairs, a CSV), apply it to ${path} in one pass, and then RE-CHECK the `
      + `invariant the task states over the entire file — same token count, only listed substitutions, punctuation untouched, whatever the rule is. `
      + `Mirror the grader's own comparison as closely as the task describes it. Then each new attempt costs one command instead of one turn, and a `
      + `violation names itself instead of hiding among a hundred edits.`
      + ((state.cycles.get(path) ?? 0) >= Math.floor(defaults.editsBeforeNudge / 2) ? MEASURED_CYCLE_HINT : ""),
  };
}
