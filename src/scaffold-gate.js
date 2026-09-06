// The wheelbarrow gate. Sibling to the build-gate: that one catches "editing
// without running"; this catches the deeper, more expensive antipattern —
// running the WHOLE deliverable over and over, guess-and-checking the end
// result, without ever building a cheap separate verifier to localize the bug.
//
// TB2 gpt2-codegolf (2026-08-20): the 27B compiled and ran the full GPT-2 dozens
// of times, each run producing one wrong token, then hand-searched all ~7 stages
// for the bug. It never wrote a small numpy oracle to diff against, so every
// wrong result left the whole pipeline a suspect. That search is exponential and
// it timed out inside it. The scaffold-first RULE teaches the fix; this gate
// ENFORCES it — a rule is advice, a gate makes skipping the wheelbarrow the
// unlit button. It fires once the model has run the full deliverable many times
// with NO separate verifier file in the workspace, and points it at building one.

import fs from "node:fs";
import path from "node:path";

export const SCAFFOLD_DEFAULTS = Object.freeze({
  // Full-deliverable runs allowed before the gate concludes the model is moving
  // the mountain with a shovel. A healthy decompose-first loop builds an oracle
  // well before this; only head-down guess-and-check reaches it with no verifier.
  runsBeforeNudge: 8,
  // Re-fire cadence: if still no wheelbarrow after another full interval, nudge
  // again (once), then go quiet — a gate that screams every turn gets ignored.
  refireEvery: 10,
});

export function createScaffoldState() {
  return { deliverableRuns: 0, lastFiredAt: -1, fires: 0 };
}

const COMPILE_RE = /\b(?:gcc|cc|clang|g\+\+|clang\+\+|rustc|go build|javac)\b/;
const BINARY_RE = /(?:^|\s|\/|&|;)(?:\.\/)?(?:a\.out|dbg)\b/;
const ORACLE_EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|c|cc|cpp|rs|go|rb|pl|sh|lua)$/i;

/** A bounded presence check, not a claim that a test/oracle is correct or ran. */
export function workspaceOracleExists(workspace, deliverables = []) {
  const bases = new Set(deliverables.map(d => String(d).split("/").pop()));
  let remaining = 1024;
  function scan(directory, depth, root = false) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (--remaining < 0) return false;
      if (entry.isFile() && ORACLE_EXT.test(entry.name) && !bases.has(entry.name)) return true;
      if (entry.isDirectory() && depth > 0
          && (root ? /^(?:tests?|specs?|__tests__)$/i.test(entry.name)
            : ![".git", ".bantam", "node_modules"].includes(entry.name))
          && scan(path.join(directory, entry.name), depth - 1)) return true;
    }
    return false;
  }
  return scan(workspace, 3, true);
}

/** Does this shell command build or run the DELIVERABLE (the whole artifact)? */
export function isFullDeliverableRun(command, deliverables = []) {
  if (typeof command !== "string" || !command) return false;
  // Running the compiled binary is always a full run.
  if (BINARY_RE.test(command)) return true;
  // Compiling a named deliverable is a full-artifact build.
  if (COMPILE_RE.test(command)) {
    for (const d of deliverables) {
      const base = d.split("/").pop();
      if (base && command.includes(base)) return true;
    }
    // A compile with no recognizable deliverable name still counts if it emits a
    // binary (covers `gcc x.c -o a.out`), already caught by BINARY_RE above; a
    // bare compile of an unknown file is not assumed to be the deliverable.
  }
  // Interpreted deliverables: `python3 solve.py`, `node app.js` where the file IS
  // a deliverable (NOT an ad-hoc `python3 -c` oracle, which is the wheelbarrow).
  const m = command.match(/\b(?:python3?|node|ruby|perl)\s+(\S+\.\w+)/);
  if (m) {
    const ran = m[1].split("/").pop();
    if (deliverables.some((d) => d.split("/").pop() === ran)) return true;
  }
  return false;
}

/**
 * Assess whether the model is guess-and-checking the whole deliverable without a
 * wheelbarrow. Call once per turn with the action + the current signals.
 *
 * @param action        the turn's action ({a, c, ...})
 * @param opts.deliverables  named deliverable paths (from namedDeliverables)
 * @param opts.oracleExists  () => boolean — is there a SEPARATE verifier/oracle
 *                           file in the workspace (a script that is not a
 *                           deliverable and not a task input)? If so, the model
 *                           built the wheelbarrow — never nudge.
 * @param state         createScaffoldState(), mutated in place
 * @returns {steer:boolean, message?:string}
 */
export function assessScaffold(action, { deliverables = [], oracleExists = () => false, execution, outcome = null } = {}, state, defaults = SCAFFOLD_DEFAULTS) {
  const quiet = { steer: false };
  if (!action || action.a !== "shell") return quiet;
  // Legacy callers count invocations. A modern caller supplies the actual
  // receipt (or explicit null), so blocked/deduplicated requests never count.
  if (execution !== undefined && (!execution || execution.blocked || execution.error
      || (execution.command !== action.c && execution.requestedCommand !== action.c))) return quiet;
  if (!deliverables.length) return quiet; // no named deliverable → nothing to gate
  if (!isFullDeliverableRun(action.c, deliverables)) return quiet;

  state.deliverableRuns += 1;

  // The wheelbarrow exists → the model already decomposed/verifies; stay silent.
  let hasOracle = false;
  try { hasOracle = Boolean(oracleExists()); } catch { hasOracle = false; }
  if (hasOracle) return quiet;

  const since = state.deliverableRuns - (state.lastFiredAt < 0 ? 0 : state.lastFiredAt);
  const due = state.lastFiredAt < 0
    ? state.deliverableRuns >= defaults.runsBeforeNudge
    : since >= defaults.refireEvery;
  if (!due) return quiet;
  if (state.fires >= 2) return quiet; // said it twice; nagging past that is noise

  state.lastFiredAt = state.deliverableRuns;
  state.fires += 1;
  const target = deliverables[0];
  return {
    steer: true,
    message:
      `[scaffold] You have built/run the whole program ${state.deliverableRuns} times; no separate verifier was found by the bounded workspace scan. `
      + (outcome === "fail" ? `The latest check failed; inspect its actual assertion or process error. `
        : outcome === "pass" ? `The latest recorded check passed. Repeated execution does not establish a defect or prove every requirement. `
          : `The latest outcome is unverified, not a demonstrated failure. `)
      + `If behavior remains uncertain, build the wheelbarrow: use a supplied reference ORACLE first, or add a small focused test `
      + `for the exact public requirement in question. Assert intermediate behavior of ${target} or the child's expected exit code, stdout and stderr. `
      + `A check's failure should identify a mismatch before you change code; if all requirements are already verified, finish.`,
  };
}
