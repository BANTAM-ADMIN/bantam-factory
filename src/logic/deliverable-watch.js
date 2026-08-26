// deliverable-watch.js — say it DURING the run, not only at done.
//
// missing-outputs.js already knows how to read the task's named outputs and
// check they exist. It is wired into done-gates, which means it only ever runs
// for a run that CALLS done. A run that times out is never checked at all.
//
// write-compressor (2026-08-22, local): 48 turns, 24 shell commands, 11 file
// writes, and the final workspace was data.txt / debug.py / decomp.c /
// encode.py. data.comp — the one file the task asks for — was never created.
// The run had spent 29 of its 30 minutes building an encoder whose output it
// only ever simulated. Nothing said "the thing you were asked to produce does
// not exist", because saying so was a done-gate and done was never reached.
//
// Deliberately quiet: it speaks only while the deliverable is genuinely absent,
// only after the run has had time to make one, and at most a few times. A
// reminder that fires every turn is noise, and noise is how a true signal gets
// tuned out.

const FIRST_TURN = 8;
const REPEAT_EVERY = 12;
const MAX_NOTICES = 3;

/**
 * Should the run be told its deliverable is missing on this turn?
 *
 * `missing` is the already-computed list of required-but-absent paths, so this
 * module stays pure and the filesystem check lives in one place.
 */
export function deliverableNotice({
  missing = [], turnsUsed = 0, noticesSoFar = 0,
  // Overridable so the WIRING can be exercised end-to-end without a 30-turn
  // run. A gauge that has never been seen to fire on the real path is not a
  // gauge, and the unit test covers only this function, not its call site.
  firstTurn = FIRST_TURN, repeatEvery = REPEAT_EVERY, maxNotices = MAX_NOTICES,
} = {}) {
  const absent = (Array.isArray(missing) ? missing : []).filter(Boolean);
  if (!absent.length) return null;
  if (noticesSoFar >= maxNotices) return null;
  if (turnsUsed < firstTurn) return null;
  // First notice at firstTurn, then spaced out.
  const due = firstTurn + noticesSoFar * repeatEvery;
  if (turnsUsed < due) return null;

  const names = absent.join(", ");
  const one = absent.length === 1;
  return {
    paths: absent,
    text: `[deliverable] ${names} ${one ? "does" : "do"} not exist yet.`
      + ` The task asks for ${one ? "this file" : "these files"} specifically, and the grader`
      + ` checks ${one ? "it" : "them"} first — work that only exists as a script, a plan, or a`
      + ` simulated result scores zero. Produce ${one ? "it" : "them"} on disk now, even in a rough`
      + ` form, then improve ${one ? "it" : "them"}. If a program is supposed to consume`
      + ` ${one ? "it" : "them"}, RUN that program on the real file and compare its real output`
      + ` — your own re-implementation of that program is not evidence about it.`,
  };
}

export const DELIVERABLE_WATCH_TUNING = { FIRST_TURN, REPEAT_EVERY, MAX_NOTICES };
