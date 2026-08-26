// Task-agnostic execution-state observer.
//
// Inputs are controller-owned facts about the trajectory, never words that
// identify a benchmark or implementation shape. The result is telemetry only:
// it must not alter prompts, grammars, actions, verification, or completion.

import { Datalog } from "./datalog.js";

const PRIORITY = Object.freeze(["repair", "verify", "land", "implement", "investigate"]);

export function deriveExecutionStateShadow({
  residentSourceCount = 0,
  namedSourceCount = 0,
  residentNamedSourceCount = 0,
  lastEditTurn = null,
  lastVerdictTurn = null,
  lastVerdict = null,
  pendingBlockerCount = 0,
} = {}) {
  const db = new Datalog({ provenance: true });
  db.fact("state_fact", "run", "observed");
  if (residentSourceCount > 0) db.fact("state_fact", "run", "source_resident");
  if (namedSourceCount > 0) db.fact("state_fact", "run", "named_source_known");
  if (namedSourceCount > 0 && residentNamedSourceCount >= namedSourceCount) {
    db.fact("state_fact", "run", "all_named_source_resident");
  }
  if (Number.isInteger(lastEditTurn)) db.fact("state_fact", "run", "edited");
  else db.fact("state_fact", "run", "pre_edit");
  if (lastVerdict === "pass") db.fact("state_fact", "run", "verdict_pass");
  if (lastVerdict === "fail") db.fact("state_fact", "run", "verdict_fail");
  if (pendingBlockerCount > 0) db.fact("state_fact", "run", "blocker_pending");

  const verdictIsCurrent = Number.isInteger(lastVerdictTurn)
    && (!Number.isInteger(lastEditTurn) || lastVerdictTurn >= lastEditTurn);
  if (verdictIsCurrent) db.fact("state_fact", "run", "verdict_current");
  else if (Number.isInteger(lastEditTurn)) db.fact("state_fact", "run", "verification_stale");

  db.rule("phase(R, repair) :- state_fact(R, blocker_pending)");
  db.rule("phase(R, repair) :- state_fact(R, verdict_fail), state_fact(R, verdict_current)");
  db.rule("phase(R, verify) :- state_fact(R, edited), state_fact(R, verification_stale)");
  db.rule("phase(R, land) :- state_fact(R, verdict_pass), state_fact(R, verdict_current)");
  db.rule("phase(R, implement) :- state_fact(R, source_resident)");
  db.rule("phase(R, investigate) :- state_fact(R, observed)");
  db.rule("boundary(R, source_grounded_pre_edit) :- state_fact(R, named_source_known), state_fact(R, all_named_source_resident), state_fact(R, pre_edit)");
  db.run();

  const candidates = new Set(db.query("phase", "run", "?").map((row) => row[1]));
  const phase = PRIORITY.find((candidate) => candidates.has(candidate)) ?? "investigate";
  const boundaries = db.query("boundary", "run", "?").map((row) => row[1]);
  return Object.freeze({
    mode: "shadow",
    authority: "observe-only",
    phase,
    boundaries: Object.freeze(boundaries),
    facts: Object.freeze({
      residentSourceCount: Math.max(0, Number(residentSourceCount) || 0),
      namedSourceCount: Math.max(0, Number(namedSourceCount) || 0),
      residentNamedSourceCount: Math.max(0, Number(residentNamedSourceCount) || 0),
      lastEditTurn: Number.isInteger(lastEditTurn) ? lastEditTurn : null,
      lastVerdictTurn: Number.isInteger(lastVerdictTurn) ? lastVerdictTurn : null,
      lastVerdict: lastVerdict === "pass" || lastVerdict === "fail" ? lastVerdict : null,
      pendingBlockerCount: Math.max(0, Number(pendingBlockerCount) || 0),
    }),
    proof: db.explain("phase", "run", phase),
    boundaryProofs: Object.freeze(Object.fromEntries(
      boundaries.map((boundary) => [boundary, db.explain("boundary", "run", boundary)]),
    )),
  });
}
