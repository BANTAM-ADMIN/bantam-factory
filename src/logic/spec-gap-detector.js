// Does THIS task under-specify its own type contract? Decided without a grader.
//
// spec-coverage.js answers the same question for a fixture, by diffing the task
// text against the hidden grader. That is the right tool for auditing a benchmark
// and useless at runtime, where there is no grader to read -- which is exactly when
// the answer would be worth having.
//
// The payoff is measured. On channel-filter, whose task states its rejection
// requirement zero times while its grader asserts TypeError four times,
// BANTAM_TYPE_CONTRACT_GATE turned a 0/3 hidden-contract failure into 3/3 (n=3 per
// arm, gpt-5.6-terra, exact permutation p = 0.05, gate firing once in every passing
// run and zero times in every failing one). But the gate costs roughly 2x turns and
// buys nothing on the seven fixtures whose tasks already state their contracts. So
// the value is entirely in knowing WHEN to switch it on.
//
// THE SIGNAL, and why the obvious version does not work.
//
// The obvious version -- "the task never mentions rejection" -- fires on 4 of 14
// fixtures and is right about 1. retry-consolidation and safe-config-merge mention
// no rejection either, and their graders assert none: nothing is missing. Without a
// grader, "the spec omits what is tested" and "nothing tests it" are the same
// sentence.
//
// What separates them is whether the task DECLARES AN ACCEPTED TYPE. "accepts an
// array of strings", "accepts a plain object whose values are booleans" -- a task
// that names the accepted type has raised the question of what happens outside it,
// and then answers it or does not. A behaviour-preserving refactor never raises it.
//
// Measured across all 14 fixtures: 2 fires, both on fixtures with real unstated
// rejection contracts. Zero false positives, including on the three the naive
// version got wrong. It misses keyed-task-pool's runPlan (recall 2/3) -- the
// conservative direction, since a miss costs nothing and a false fire costs turns.
//
// The strongest evidence is the paired fixtures: channel-filter and
// channel-filter-explicit share a repo and differ only in whether the task states
// the contract. adapter-migration and adapter-migration-explicit likewise. The
// detector fires on both bare variants and neither explicit one. That is a
// controlled test of the signal, not a coincidence of wording.

import { taskStatesRejection } from "./spec-coverage.js";

// "accepts an array of strings", "takes a plain object", "expects a non-negative
// integer". Anchored on the verb so prose about what a function RETURNS or DOES
// does not count -- only a declared input contract raises the question.
const DECLARES_TYPE = new RegExp(
  "\\b(?:accepts?|takes|expects?|receives?)\\s+"
  + "(?:an?|only|exactly)?\\s*(?:optional\\s+)?"
  + "(?:array|object|string|number|integer|boolean|plain|valid|non-negative|positive|trimmed)",
  "i",
);

const word = (name) => new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

/**
 * Does the task declare an accepted input type for `fn`?
 *
 * Same clause-scoping rule as taskStatesRejection: a sentence counts when it names
 * the function, or when it names none of the other candidates and there is only one
 * candidate to attribute it to.
 */
export function taskDeclaresType(task, fn, candidates = [fn]) {
  const others = [...new Set(candidates)].filter((c) => c !== fn);
  for (const clause of String(task ?? "").split(/(?<=\.)\s+/)) {
    if (!DECLARES_TYPE.test(clause)) continue;
    if (word(fn).test(clause)) return true;
    if (others.length === 0) return true;
  }
  return false;
}

/**
 * Functions whose accepted type the task declares but whose rejection behaviour it
 * never states.
 *
 * @param {string} task        the task text
 * @param {string[]} exported  functions the workspace exports
 * @returns {{underSpecified: boolean, functions: string[]}}
 */
export function detectSpecGap(task, exported) {
  const candidates = [...new Set((exported ?? []).filter(Boolean))];
  const functions = candidates.filter(
    (fn) => taskDeclaresType(task, fn, candidates) && !taskStatesRejection(task, fn, candidates),
  );
  return { underSpecified: functions.length > 0, functions };
}

/**
 * One line for the operator explaining why a gate switched itself on.
 *
 * A mechanism that enables itself silently is indistinguishable from a mechanism
 * that fires at random, and this codebase has already spent a day on the cost of
 * unattributable interventions.
 */
export function formatSpecGap(gap) {
  if (!gap?.underSpecified) return "";
  const names = gap.functions.join(", ");
  return `[spec-gap] The task declares accepted input types for ${names} but never says `
    + "what happens outside them. Enabling the type_contract gate: an unstated rejection "
    + "contract is the one case it is measured to convert (0/3 to 3/3 on channel-filter).";
}
