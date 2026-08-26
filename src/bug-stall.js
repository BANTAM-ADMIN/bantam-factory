// Repeated-same-bug andon → a CONCRETE "isolate and unit-test that function" steer.
//
// TB2 gpt2-codegolf (2026-08-20): the model hit the SAME sanitizer bug —
// `heap-buffer-overflow /app/gpt2.c:13 in gemm` — for ~36 turns straight. ASAN
// handed it the exact file:line:function every time (context clean), and the
// sanitizer jig fired every time, yet it could not fix it: it kept re-running the
// WHOLE program, so the bug stayed entangled with everything else. The build/
// scaffold jigs failed here because they ask for an abstract pivot ("build an
// oracle"). This one lands because it names a SPECIFIC next action tied to the
// exact failing function ASAN just named: isolate gemm(), test it alone on tiny
// known inputs, and the overflow is obvious in one run. Concrete beats strategic.

export const BUG_STALL_DEFAULTS = Object.freeze({
  repeatToSteer: 3, // same bug signature this many times in a row → escalate
  refire: 4,        // if still stuck this many more repeats later, say it once more
});

export function createBugStallState() {
  return { sig: null, streak: 0, firedAtStreak: -1, fires: 0 };
}

/**
 * Extract a stable bug signature (type + file:line + function) from a sanitizer
 * or crash observation. Returns null when the observation shows no such bug.
 */
export function extractBugSignature(observation) {
  const text = String(observation ?? "");
  // ASAN SUMMARY is the most precise: "SUMMARY: AddressSanitizer: <type> <file>:<line> in <fn>"
  let m = text.match(/SUMMARY:\s*\w+Sanitizer:\s*([a-z0-9-]+)\s+(\S+):(\d+)\s+in\s+(\w+)/i);
  if (m) return { type: m[1], loc: `${m[2].split("/").pop()}:${m[3]}`, fn: m[4] };
  // ASAN header + first stack frame: "#0 0x.. in <fn> <file>:<line>"
  const err = text.match(/(?:ERROR:\s*\w+Sanitizer:\s*([a-z0-9-]+))/i);
  const frame = text.match(/#0\s+\S+\s+in\s+(\w+)\s+(\S+):(\d+)/);
  if (err && frame) return { type: err[1], loc: `${frame[2].split("/").pop()}:${frame[3]}`, fn: frame[1] };
  // UBSAN: "<file>:<line>:<col>: runtime error: <msg>"
  m = text.match(/(\S+):(\d+):\d+:\s*runtime error:/);
  if (m) return { type: "runtime-error", loc: `${m[1].split("/").pop()}:${m[2]}`, fn: null };
  return null;
}

/**
 * Call once per turn with the turn's observation. When the SAME bug signature has
 * recurred `repeatToSteer` times, return a concrete steer to isolate that exact
 * function and unit-test it. A different bug (or a clean run) resets the streak —
 * so it only fires on a genuine same-bug stall, never on normal iterative fixing.
 */
export function assessBugStall(observation, state, defaults = BUG_STALL_DEFAULTS) {
  const quiet = { steer: false };
  const sig = extractBugSignature(observation);
  if (!sig) { // no bug this turn (or a clean run) → progress; reset the streak
    if (state.streak) { state.streak = 0; state.sig = null; state.firedAtStreak = -1; }
    return quiet;
  }
  const key = `${sig.type}@${sig.loc}@${sig.fn ?? "?"}`;
  if (key === state.sig) state.streak += 1;
  else { state.sig = key; state.streak = 1; state.firedAtStreak = -1; }

  const due = state.firedAtStreak < 0
    ? state.streak >= defaults.repeatToSteer
    : state.streak - state.firedAtStreak >= defaults.refire;
  if (!due || state.fires >= 2) return quiet;

  state.firedAtStreak = state.streak;
  state.fires += 1;
  const where = sig.fn ? `\`${sig.fn}\` (${sig.loc})` : `the code at ${sig.loc}`;
  return {
    steer: true,
    signature: key,
    message:
      `\n\n[bug-stall] You have hit the SAME bug — ${sig.type} in ${where} — ${state.streak} times. `
      + `Running the whole program again will not localize it further; the sanitizer has already named the exact spot. `
      + `ISOLATE it: write a tiny standalone test that calls ${sig.fn ? `\`${sig.fn}\`` : "that code"} ALONE on small, `
      + `hand-checkable inputs (e.g. 2x3 and 3x2 matrices whose product you can compute by hand), print its output, and `
      + `compare to the value you worked out. In isolation the off-by-one bound or wrong dimension is obvious in one run. `
      + `Fix it there, prove the unit test passes, THEN put it back.`,
  };
}
