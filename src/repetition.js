// Exact-duplicate action guard.
//
// Observed in unattended runs: a run issued the same directory inspection dozens of times, and
// another repeated the same search through consecutive progress-gate rejections. The
// progress gate refuses such an action but returns no new information, so the model has no
// reason to choose differently and re-issues it verbatim.
//
// This guard makes the repeat impossible instead of merely discouraged: a read-only action that
// has already run, with no workspace change since, is not executed again. The duplicate notice
// points to the original turn instead of copying a potentially huge observation into context again.

import { isDeliverableRun } from "./logic/deliverable-signals.js";
import { deliverableRunOutcome } from "./logic/runlog.js";
import { shellFailureSignature } from "./logic/deliverable-signals.js";
import { createHash } from "node:crypto";

const READ_ONLY_ACTIONS = new Set(["read_file", "list_dir", "search", "inspect"]);

const REPETITION_TAG = "[repetition]";

// A read-only action with no workspace change is deterministic, so one repeat is provably redundant.
// A failed test/deliverable run is NOT deterministic: flaky tests and external state make a retry
// legitimate. Let a failure re-execute until the SAME result has been confirmed this many times.
// A verified pass over unchanged source is already sufficient evidence, so an exact repeat is
// suppressed immediately. Editing the workspace invalidates that fact through noteWorkspaceChanged.
const CONFIRM_RUNS = 3;

// No-progress rerun loop: the model reruns the SAME code-executing command that
// never passes, editing a scratch/test file between runs but getting the same
// result each time. break-filter-js (2026-08-20) ran `python xtest.py` 47 times
// — 45 with the byte-identical all-fail result — rewriting only the candidate
// LABELS between runs. It evaded both existing tracks: the failure track (the
// command exits 0, so shellFailureSignature is null) and exact-dedup (each
// intervening write calls noteWorkspaceChanged, clearing _seen). This track
// keys on the identical deliverable-run command that has never passed, and
// deliberately SURVIVES workspace changes — an edit that does not change the
// outcome is exactly the signal, not an excuse to reset the count.
const NOPROGRESS_RERUNS = 6;

/** Stable stringify: key order must not affect identity. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function editHash(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

export function actionKey(action) {
  return canonical(action);
}

export function isReadOnlyAction(action) {
  const a = action?.a;
  if (!READ_ONLY_ACTIONS.has(a)) return false;
  if (a === "inspect") return (action.ops ?? []).every((op) => READ_ONLY_ACTIONS.has(op?.a));
  return true;
}

/** The read-only ops an action performs: an inspect's ops, or the action itself. */
function readOnlyOps(action) {
  if (action?.a === "inspect") return (action.ops ?? []).filter((op) => op && READ_ONLY_ACTIONS.has(op.a) && op.a !== "inspect");
  return action && READ_ONLY_ACTIONS.has(action.a) ? [action] : [];
}

function readPaths(action) {
  if (action?.a === "read_file" && typeof action.p === "string") return [action.p];
  if (action?.a === "inspect") {
    return [...new Set((action.ops ?? [])
      .filter((op) => op?.a === "read_file" && typeof op.p === "string")
      .map((op) => op.p))];
  }
  return [];
}

// A turn number is only a usable address while that turn's observation is still
// in the prompt, and usually it is not. Across 34 runs, 697 of 1,183 "remains at
// turn N" claims named a turn whose observation had already been replaced by a
// stub; at the extreme (tb14 turn 74) the prompt did not contain the string
// "turn 38" anywhere — 15 of its 100 observations had survived — while the
// refusal sent the model there twice. 31% of all dedup refusals are the model
// immediately retrying the identical action, which is what an address pointing
// nowhere buys.
//
// Naming the panel instead is safe by construction: agent.js only consults this
// guard after readReplayIsContextSafe has established that <open_files> holds
// the file's current bytes. For a shell or query replay there is no such
// guarantee, so those claim no location at all rather than a false one.
function resultLocation(action) {
  const paths = readPaths(action);
  if (!paths.length) return "Its result is not repeated here.";
  return `Its result is not repeated here — the current contents of ${paths.join(", ")} are in <open_files> above.`;
}

export class RepetitionGuard {
  constructor({ enabled = true, dedupeShell = false, dedupeQuery = false, mapAvailable = false } = {}) {
    this.enabled = enabled;
    this.dedupeShell = dedupeShell;
    this.dedupeQuery = dedupeQuery;   // treat identical `query` actions as replayable (map/KB are deterministic)
    // The steer may name a `map` query only when the tool is registered. On the
    // 2026-08-24 tour run it was named in a checkout with no repomap extractor;
    // the model's next turn was spent on `[query] "map brief" didn't match a tool`.
    this.mapAvailable = Boolean(mapAvailable);
    this.duplicateActionRejections = 0;
    this.duplicateShellRejections = 0;
    this._seen = new Map(); // key -> { turn, sig, sameCount, passed }; observations stay in turn history
    this._attempts = new Map(); // key -> duplicate attempts
    // Per-op memory for read-only work. Exact-match keys let an `inspect` evade
    // the guard by reordering its ops or re-bundling ops that earlier inspects
    // already ran (2026-08-24 tour run: src/factory listed on turns 2, 3, 4, 5
    // and 6 before the exact key finally caught turn 7). opKey -> turn.
    this._seenOps = new Map();
    // Broken-record track: same FAILURE SIGNATURE across consecutive shell runs
    // with no intervening edit — even when the commands differ. Arm-B
    // (2026-08-18) varied output filenames to defeat exact-match dedup and
    // re-ran the same failing test seven times; the cleverness belonged on the
    // bug. Keyed by the failure's last line, not the command's bytes.
    this._failStreak = { sig: null, count: 0, steeredAt: 0 };
    this.brokenRecordSteers = 0;
    // No-progress rerun track (see NOPROGRESS_RERUNS): consecutive deliverable
    // runs whose RESULT is unchanged. Keyed on a normalized result signature,
    // not on pass/fail (a run can exit 0 every time yet never reach the goal —
    // break-filter's `python xtest.py` "passes" but never finds the bypass).
    // Not cleared by noteWorkspaceChanged — a result that stays identical across
    // edits is exactly the signal.
    this._resultStreak = { sig: null, count: 0, steeredAt: 0 };
    this.noProgressSteers = 0;
    // Inverse-edit oscillation track (maze films, backlog rank 3): the model
    // applies old->new, later new->old on the same file, then reaches for the
    // flip again — A/B forever, each landing "successfully". Keyed on hashed
    // (old,new) pairs per path. Deliberately NOT cleared by
    // noteWorkspaceChanged: the oscillation IS made of workspace changes.
    this._editPairs = new Map();   // path -> Set("hOld>hNew")
    this._inversions = new Map();  // path -> count of byte-inverse flips landed
    this.inverseEditStops = 0;
  }

  /** An edit invalidates prior reads: re-reading changed state is real work. */
  noteWorkspaceChanged() {
    this._seen.clear();
    this._seenOps.clear();
    this._attempts.clear();
    this._failStreak = { sig: null, count: 0, steeredAt: 0 };
  }

  record(action, observation, { turn = 0, shellWorkspaceUnchanged = false } = {}) {
    if (this.enabled && action?.a === "replace" && /^replaced /.test(String(observation ?? ""))) {
      const p = String(action.p ?? "");
      const pair = `${editHash(action.old)}>${editHash(action.new)}`;
      const inverse = `${editHash(action.new)}>${editHash(action.old)}`;
      const pairs = this._editPairs.get(p) ?? new Set();
      if (pairs.has(inverse)) this._inversions.set(p, (this._inversions.get(p) ?? 0) + 1);
      pairs.add(pair);
      this._editPairs.set(p, pairs);
    }
    if (this.enabled && action?.a === "shell") {
      const failSig = shellFailureSignature(observation);
      if (failSig) {
        this._failStreak = this._failStreak.sig === failSig
          ? { ...this._failStreak, count: this._failStreak.count + 1 }
          : { sig: failSig, count: 1, steeredAt: 0 };
      } else {
        this._failStreak = { sig: null, count: 0, steeredAt: 0 };
      }
      // No-progress rerun track: consecutive deliverable runs with the SAME
      // normalized result. A materially different result (real progress) resets
      // the streak. Intervening edits do NOT reset it — an edit that leaves the
      // result unchanged is the signal, not an excuse to forget.
      if (isDeliverableRun(action.c)) {
        const rsig = this._resultSig(observation);
        this._resultStreak = this._resultStreak.sig === rsig
          ? { ...this._resultStreak, count: this._resultStreak.count + 1 }
          : { sig: rsig, count: 1, steeredAt: 0 };
      }
    }
    if (!this.enabled || !this._isReplayable(action, { shellWorkspaceUnchanged })) return;
    const key = actionKey(action);
    const sig = this._sig(observation);
    const prior = this._seen.get(key);
    // Consecutive runs that produced the SAME result build confidence the command is deterministic;
    // a different result (a flaky flip) resets the count so the command is never frozen.
    const sameCount = prior && prior.sig === sig ? prior.sameCount + 1 : 1;
    // pass/fail is a property of a deliverable run only. Storing `false` for a
    // read made every deduplicated listing claim "its last real run FAILED".
    const passed = action?.a === "shell" && isDeliverableRun(action.c)
      ? deliverableRunOutcome(action, observation) === "pass"
      : null;
    this._seen.set(key, { turn, sig, sameCount, passed });
    for (const op of readOnlyOps(action)) this._seenOps.set(actionKey(op), turn);
  }

  /**
   * @returns {null | { observation: string, duplicateOfTurn: number }}
   *   null when the action should execute normally.
   */
  check(action) {
    if (this.enabled && action?.a === "replace") {
      const p = String(action.p ?? "");
      const inverse = `${editHash(action.new)}>${editHash(action.old)}`;
      const wouldInvert = (this._editPairs.get(p) ?? new Set()).has(inverse);
      if (wouldInvert && (this._inversions.get(p) ?? 0) >= 1) {
        this.inverseEditStops += 1;
        return {
          observation: `[inverse-edit] STOPPED: this replace on ${p} is the byte-exact inverse of an edit you`
            + ` already landed, and you have already flipped this same change back once. You are oscillating`
            + ` between two states you have each already tested — neither is right, and re-entering one cannot`
            + ` produce a new result. The defect is elsewhere (or the change must be DIFFERENT, not reversed):`
            + ` re-read the failing output, name what NEITHER version handles, and make a third, genuinely new`
            + ` edit.`,
          duplicateOfTurn: -1,
        };
      }
    }
    if (this.enabled && action?.a === "shell") {
      const st = this._failStreak;
      // Exact repeats stay with the confirmed-failure retry logic below —
      // deliberate re-runs of one command are how flaky failures get
      // confirmed. The broken-record steer exists for the VARIED-command
      // evasion: same failure signature, cosmetically different commands.
      const exactRepeat = this._seen.has(actionKey(action));
      if (!exactRepeat && st.count >= 3 && st.steeredAt < st.count) {
        st.steeredAt = st.count;
        this.brokenRecordSteers += 1;
        return {
          observation: `[broken-record] Your last ${st.count} shell runs all ended in the same failure`
            + ` (${st.sig.slice(0, 160)}) with no edit in between. Re-running cannot change the outcome.`
            + ` Change the CODE or your THEORY of the bug: re-read the exact line the error names,`
            + ` print the value that surprised you, then edit before testing again.`,
          duplicateOfTurn: -1,
        };
      }
      // No-progress rerun loop: a deliverable run whose result has now repeated
      // identically many times — editing between runs but never changing it.
      const rs = this._resultStreak;
      if (isDeliverableRun(action.c)
          && rs.count >= NOPROGRESS_RERUNS && rs.steeredAt < rs.count) {
        rs.steeredAt = rs.count;
        this.noProgressSteers += 1;
        const cmd = String(action.c ?? "");
        const shown = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
        return {
          observation: `[no-progress] You have run \`${shown}\` ${rs.count} times and it has never`
            + ` passed — editing between runs but getting the same result each time. Re-running the same`
            + ` command after small tweaks is not converging: the outcome the run keeps reporting is the`
            + ` clue. STOP tweaking details and change your APPROACH — pursue a fundamentally different`
            + ` strategy than the one that has now failed identically ${rs.count} times.`,
          duplicateOfTurn: -1,
        };
      }
    }
    if (!this.enabled || !this._isReplayable(action, { shellWorkspaceUnchanged: true })) return null;
    const key = actionKey(action);
    const prior = this._seen.get(key) ?? this._opCoveredPrior(action);
    if (!prior) return null;

    // Failed deliverable runs remain retryable until repeated evidence establishes a stable failure.
    // A passing exact command is reusable until an edit invalidates it.
    if (action?.a === "shell" && isDeliverableRun(action.c) && !prior.passed && prior.sameCount < CONFIRM_RUNS) return null;

    const attempts = (this._attempts.get(key) ?? 0) + 1;
    this._attempts.set(key, attempts);
    this.duplicateActionRejections += 1;
    if (action?.a === "shell") this.duplicateShellRejections += 1;

    return {
      observation: this._message(action, prior, attempts),
      duplicateOfTurn: prior.turn,
    };
  }

  /**
   * A read-only action whose every op already ran (in any bundling or order)
   * since the last workspace change is as redundant as an exact repeat. The
   * provenance is the newest covering turn. Returns null when any op is new.
   */
  _opCoveredPrior(action) {
    const ops = readOnlyOps(action);
    if (!ops.length) return null;
    let turn = -1;
    for (const op of ops) {
      const seenAt = this._seenOps.get(actionKey(op));
      if (seenAt === undefined) return null;
      turn = Math.max(turn, seenAt);
    }
    return { turn, sig: null, sameCount: 1, passed: null, everyOp: true };
  }

  /** Compact result signature that ignores volatile noise so "same result" is robust. */
  _sig(observation) {
    const normalized = String(observation ?? "")
      .replace(/\/tmp\/[^\s:'")]+/g, "<tmp>")
      .replace(/\bduration_ms:\s*[\d.]+/g, "duration_ms:<n>")
      .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, "<n>ms")
      .replace(/\b\d+(?:\.\d+)?s\b/g, "<n>s")
      .replace(/\s+/g, " ")
      .trim();
    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Aggressive result signature for the no-progress track: collapses the volatile
   * bits a spinning loop churns (candidate LABELS like `W1_img_srcdoc`, temp
   * paths, html entities, hex, durations) while KEEPING bare result numbers, so
   * genuine progress (`5 passed` -> `6 passed`) still changes the signature and
   * resets the streak. Deliberately coarser than `_sig`: only identifiers that
   * pair letters with a digit are erased; a plain count is not.
   */
  _resultSig(observation) {
    const normalized = String(observation ?? "")
      .replace(/\/tmp\/[^\s:'")]+/g, "<tmp>")
      .replace(/&#x?[0-9a-fA-F]+;?/g, "<e>")
      .replace(/0x[0-9a-fA-F]+/g, "<hex>")
      .replace(/[A-Za-z]+\d+\w*/g, "<id>")   // W1_img_srcdoc, nonexistent123, tmpXXXX…
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/gi, "<t>")
      .replace(/\s+/g, " ")
      .trim();
    return createHash("sha256").update(normalized).digest("hex");
  }

  _message(action, prior, attempts) {
    const shell = action?.a === "shell";
    const subject = shell ? "shell command" : "action";
    const state = shell ? "no workspace file has changed" : "the workspace has not changed";
    const what = prior.everyOp ? `every op in this ${subject}` : `this exact ${subject}`;
    const head = `${REPETITION_TAG} Deduplicated — not stale. You already ran ${what} on turn ${prior.turn} and ${state} `
      + `since, so it was not executed again.`
      + (prior.passed === false ? " Its last real run FAILED and the workspace is unchanged, so that failure still stands — FIX the code before re-testing or calling done." : "")
      + ` ${resultLocation(action)}`;
    if (attempts === 1) {
      const mapSteer = this.mapAvailable
        ? ", or — for a whole-repo overview you have not fetched yet — a `map` query (`brief`/`arch`)"
        : "";
      return `${head}\n\nReading it again cannot reveal anything new. If you already have enough to answer the `
        + `task, respond now with your answer (or mark it done). Otherwise do something different: request a `
        + `different file or line range, run a different search${mapSteer}.`;
    }
    if (attempts >= 3) {
      // Hard circuit-breaker (TB2 audit, 2026-08-20): on write-compressor the
      // model re-ran an identical test-command 13 times and burned its whole
      // turn budget mid-solve. The polite "do something different" steer was
      // ignored. This tier names the mechanism bluntly and forbids the loop.
      const verifyish = shell && isDeliverableRun(action.c);
      return `${REPETITION_TAG} LOOP DETECTED — you have run this identical ${subject} ${attempts} times and the workspace is byte-for-byte unchanged, so the result WILL be identical every time. This is a dead loop that is burning your turn budget.\n\n`
        + (verifyish
          ? `You are re-running a TEST without changing what it tests. Re-running an unchanged program cannot make it pass. You MUST either (a) EDIT the program/code to fix the actual defect, or (b) test a DIFFERENT property — if you keep checking size, check CORRECTNESS instead (pipe your output through the real checker and diff against the expected result). Do not run this exact command again.`
          : `STOP repeating it. Take a different action THIS turn: edit a file, inspect a different path, or if you truly have the answer, respond/done now.`);
    }
    return `${head}\n\nYou have now attempted this identical ${subject} ${attempts} times. Repeating it `
      + `cannot yield new information. Either respond now with what you already have, or do something different: `
      + `inspect a different path or range, or make an edit and verify it.`;
  }

  _isReplayable(action, { shellWorkspaceUnchanged = false } = {}) {
    if (isReadOnlyAction(action)) return true;
    if (this.dedupeQuery && action?.a === "query") return true;
    return this.dedupeShell && action?.a === "shell" && shellWorkspaceUnchanged;
  }
}
