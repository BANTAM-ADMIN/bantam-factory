// EAVT run-history — record an agent run as append-only datoms [entity, attribute, value, time],
// and query it "as of" any turn. This is the temporal event model applied to an agent run:
// immutable facts, time as a first-class key, so you can ask "what was true at turn T?" without
// snapshots. It's the substrate for time-travel ("recreate turn T with its context"), provenance
// ("which turn asserted this?"), and — the point of this file — turning the agent's hand-written
// control HEURISTICS into declarative QUERIES over run-state.
//
//   const log = recordTurns(turns);
//   log.asof("run", "verdict", 12);          // -> { t, v: "fail" } | null   (latest at/before 12)
//   prematureDoneByQuery(log, turns.length); // -> "failing" | "unverified-edit" | null

import { verificationVerdict } from "../done-guard.js";
import { EDIT_ACTIONS, editPaths, turnEditApplied } from "../edit-actions.js";
import { clipText } from "../clip.js";
import { CRASH_RE, RUNNER_FAIL_RE, isDeliverableRun, nonZeroExit } from "./deliverable-signals.js";

// A working note is a continuity capsule, not a second transcript. Keep enough
// of the latest private reasoning to retain the decision/checklist across an
// as-of lookup while placing a hard ceiling on the fact copied into state.
export const WORKING_NOTE_MAX_CHARS = 1200;

const REPOSITORY_QUERY_VERBS = new Set([
  "brief", "arch", "flow", "callers", "impact", "reach", "explain",
]);

const QUERY_NOT_EXECUTED_RE = /^\[(?:query-budget|progress-awareness|artifact verification|investigation budget reached|repetition)\b/i;

export function queryWasExecuted(turn) {
  const action = turn?.action || turn?.parsedAction || {};
  if (action.a !== "query") return false;
  if (typeof turn?.queryExecuted === "boolean") return turn.queryExecuted;
  // Legacy artifacts predate explicit provenance. Preserve their useful map
  // queries, but never resurrect a query whose observation says a control gate
  // refused it before execution.
  return !QUERY_NOT_EXECUTED_RE.test(String(turn?.observation ?? ""));
}

export function repositoryQueryTool(turn) {
  const action = turn?.action || turn?.parsedAction || {};
  if (action.a !== "query" || !queryWasExecuted(turn)) return null;
  if (turn?.queryTool === "map") return "map";
  if (Object.prototype.hasOwnProperty.call(turn ?? {}, "queryTool")) return null;
  const query = String(action.q ?? "").trim();
  const head = query.split(/\s+/, 1)[0].replace(/:$/, "").toLowerCase();
  if (head === "map") return "map";
  return REPOSITORY_QUERY_VERBS.has(head) ? "map" : null;
}

export class RunLog {
  constructor() {
    this.datoms = [];          // full [{e,a,v,t}] log, append-only
    this.tl = new Map();       // (e\0a) -> sorted-by-t [{t, v}]  (the as-of index)
  }
  add(e, a, v, t) {
    this.datoms.push({ e, a, v, t });
    const k = `${e}\0${a}`;
    let xs = this.tl.get(k);
    if (!xs) { xs = []; this.tl.set(k, xs); }
    let i = xs.length;                        // keep ascending by t (bisect-insert)
    while (i > 0 && xs[i - 1].t > t) i--;
    xs.splice(i, 0, { t, v });
    return this;
  }
  /** Latest {t, v} for (e,a) at or before time t — the distance-free as-of join. Null if unknown. */
  asof(e, a, t) {
    const xs = this.tl.get(`${e}\0${a}`);
    if (!xs) return null;
    let r = null;
    for (const x of xs) { if (x.t <= t) r = x; else break; }
    return r;
  }
  all(e, a) { return (this.tl.get(`${e}\0${a}`) || []).slice(); }
  count() { return this.datoms.length; }
}

/** Outcome of a deliverable run from its observation: "fail" | "pass" | null (not a deliverable run). */
export function deliverableRunOutcome(action, observation) {
  if (action?.a !== "shell" || !isDeliverableRun(action.c)) return null;
  const o = String(observation ?? "");
  if (CRASH_RE.test(o) || RUNNER_FAIL_RE.test(o) || nonZeroExit(o) !== null) return "fail";
  return "pass";
}

/** Record a trajectory (turns of {action|parsedAction, observation}) as EAVT datoms. */
export function recordTurns(turns) {
  const log = new RunLog();
  (turns || []).forEach((tn, i) => {
    const a = tn.action || tn.parsedAction || {};
    const reasoning = typeof tn.reasoning === "string" ? tn.reasoning.trim() : "";
    if (reasoning) {
      log.add("run", "working-note", clipText(reasoning, WORKING_NOTE_MAX_CHARS), i);
    }
    if (a.a) {
      log.add(`turn:${i}`, "action", a.a, i);
      if (a.a === "query") {
        const query = String(a.q ?? "").trim();
        const executed = queryWasExecuted(tn);
        const tool = repositoryQueryTool(tn) || (executed ? (tn.queryTool || "unknown") : "not-executed");
        log.add(`turn:${i}`, "query", query, i);
        log.add(`turn:${i}`, "query-tool", tool, i);
        log.add(`turn:${i}`, "query-executed", executed, i);
        // Store the requested structural view, not a copied textual answer.
        // A rewind can re-run this query against the restored tree and get
        // current line numbers instead of pinning stale prose forever.
        if (executed && tool === "map") log.add("run", "repository-query", query, i);
      }
      if (turnEditApplied(tn)) {
        for (const target of editPaths(a)) {
          log.add(`turn:${i}`, "target", target, i);
          log.add(`file:${target}`, "edited", i, i);
          log.add("run", "edit", target, i);        // run-level "an edit happened at t"
        }
      }
      if (a.p && !EDIT_ACTIONS.has(a.a)) {
        log.add(`turn:${i}`, "target", a.p, i);
      }
    }
    // A shell command that rewrote source is a run-level edit at t (no single named path) — keeps the
    // query re-expression in agreement with turnEditedSource/prematureDoneObjection.
    if (tn.sourceEditedByShell) log.add("run", "edit", "(shell)", i);
    const verdict = verificationVerdict(tn);
    if (verdict) log.add("run", "verdict", verdict, i);
    // A deliverable run's crash/exit is a SEPARATE verdict channel — the oracle-blindness signal
    // that formal-runner detection misses (a SIGSEGV on a binary the model built).
    const dv = deliverableRunOutcome(a, tn.observation);
    if (dv) log.add("run", "deliverable", dv, i);
    // A harness-run verification (auto-verify / scoped-verify) stamps `scopedVerify` on the EDIT turn
    // that triggered it. That is a TRUSTED deliverable outcome (the harness itself ran the tests), so
    // credit it in the deliverable channel too — otherwise a passing harness re-run after the model's
    // own failed run leaves the failure "unresolved" and the evidence-guard falsely tells the model
    // "your last check failed" right after the harness confirmed the fix (risking a regress-good-code
    // re-edit). The turn's action is the edit, so deliverableRunOutcome (which needs a shell run) missed it.
    const stamped = tn.scopedVerify?.verdict;
    if (!dv && (stamped === "pass" || stamped === "fail")) log.add("run", "deliverable", stamped, i);
  });
  return log;
}

/**
 * Oracle-blindness, RE-EXPRESSED as a query over run datoms (the substrate form of the JS
 * evidence-guard): as of time t, the latest deliverable-run verdict is a failure, with no clean
 * deliverable run after it. "Failing" means the model's own last check of the deliverable failed and
 * it declared done anyway. Precise where prematureDoneByQuery is loose: it reads ONLY the deliverable
 * channel, and a clean deliverable run after the failure clears it (the model recovered).
 */
export function unresolvedDeliverableFailure(log, t) {
  const xs = log.all("run", "deliverable").filter((x) => x.t <= t);
  if (!xs.length) return null;
  const last = xs[xs.length - 1];
  return last.v === "fail" ? { at: last.t } : null;   // { at } (never a falsy turn-0) or null
}

/**
 * The premature-done guard, RE-EXPRESSED as a query over run datoms (not imperative JS). `done` is
 * premature if, as of time t: the latest verdict is a failure with no edit after it, OR an edit
 * happened after the last verdict (so the change is unverified). Returns the reason, or null.
 *
 * This is the proof of the thesis: a control heuristic becomes three as-of lookups over the
 * append-only run history — declarative, inspectable, and identical in verdict to the hand-written
 * guard (see runlog.test.js, which asserts agreement with prematureDoneObjection).
 */
export function prematureDoneByQuery(log, t) {
  const verdict = log.asof("run", "verdict", t);
  if (!verdict) return null;                         // never tested here -> allow (un-testable task)
  const lastEdit = log.asof("run", "edit", t);
  const editT = lastEdit ? lastEdit.t : -1;
  if (verdict.v === "fail" && verdict.t >= editT) return "failing";
  if (editT > verdict.t) return "unverified-edit";
  return null;
}

/** Time-travel: reconstruct a compact snapshot of the run as of turn t (files touched, last verdict). */
export function stateAsOf(log, t) {
  const filesEdited = [];
  for (const { e, a, t: dt } of log.datoms) {
    if (a === "edited" && dt <= t && e.startsWith("file:")) filesEdited.push(e.slice(5));
  }
  const verdict = log.asof("run", "verdict", t);
  const repositoryQuery = log.asof("run", "repository-query", t);
  const workingNote = log.asof("run", "working-note", t);
  const lastEdit = log.asof("run", "edit", t);
  const editsSinceWorkingNote = workingNote
    ? new Set(log.all("run", "edit")
      .filter((entry) => entry.t >= workingNote.t && entry.t <= t)
      .map((entry) => entry.t)).size
    : 0;
  return {
    asOf: t,
    filesEdited: [...new Set(filesEdited)].sort(),
    lastVerdict: verdict ? { turn: verdict.t, result: verdict.v } : null,
    repositoryQuery: repositoryQuery ? { turn: repositoryQuery.t, query: repositoryQuery.v } : null,
    workingNote: workingNote ? { turn: workingNote.t, text: workingNote.v } : null,
    editsSinceWorkingNote,
    lastEdit: lastEdit ? { turn: lastEdit.t, target: lastEdit.v } : null,
  };
}
