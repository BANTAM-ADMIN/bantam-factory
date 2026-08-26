// A provenanced, append-only fact log in front of the Datalog engine — the durable half
// of the reasoning substrate.
//
// The engine (datalog.js) is deliberately monotone and in-memory: within one evaluation,
// facts only accumulate, which is what makes fixpoint recursion sound. But an agent's
// knowledge is not monotone across time — files change, beliefs get corrected, runs end.
// This layer resolves that tension the classic way: MUTATION LIVES IN THE LOG, NOT THE
// ENGINE. Every assertion and retraction is an immutable log entry stamped with a monotone
// sequence number and provenance (source, kind). The engine only ever sees a replayed
// CURRENT VIEW — facts whose latest operation at some sequence point is an assert.
//
// What that buys, cheaply, because BANTAM is one process with one governed writer:
//   - as-of reads:        view({ asOf: seq })  — "what did the harness know at seq N?"
//   - named snapshots:    snapshot("pre-fix"); viewAt("pre-fix")   — durable causal marks
//   - retraction without lying: tombstones hide a fact from the view; history keeps it
//   - fact provenance:    provenance(rel, ...args) — every op that ever touched the tuple
//   - durability:         one JSONL file, appended per op, tolerant replay on open
//   - multi-source joins: seed a scratch view, assert transient candidates into it, query;
//                         the log never learns about them (proposal is not truth)
//
// Relationship to runlog.js: RunLog is the per-run, turn-keyed EAVT index that powers
// control heuristics inside one run. FactLog is the cross-run, provenanced store that
// feeds rule-based reasoning. They deliberately share the same temporal philosophy.
//
//   const log = FactLog.open(".bantam/facts.jsonl");
//   log.assert("depends", ["main.js", "util.js"], { src: "codefacts", kind: "observation" });
//   const mark = log.snapshot("before-refactor");
//   log.retract("depends", ["main.js", "util.js"], { src: "codefacts" });
//   log.view().has("depends", "main.js", "util.js")            // false — current view
//   log.viewAt("before-refactor").has("depends", ...)          // true  — as-of view
//   log.provenance("depends", "main.js", "util.js")            // full op history

import fs from "node:fs";
import path from "node:path";
import { Datalog } from "./datalog.js";

// NUL separator: args are arbitrary strings ("a b" + "c" must not collide with "a" + "b c").
const SEP = "\u0000";
const keyOf = (rel, args) => rel + SEP + args.join(SEP);

export class FactLog {
  constructor({ path: filePath = null } = {}) {
    this.path = filePath;
    this.entries = [];          // full ordered log: {seq, op, rel, args, src, kind, t} | {seq, op:"snapshot", name, t}
    this.seq = 0;               // last issued sequence number (monotone; single writer)
    this.marks = new Map();     // snapshot name -> seq
  }

  /** Open (or create) a durable log. Tolerant replay: a torn/corrupt trailing line is skipped. */
  static open(filePath) {
    const log = new FactLog({ path: filePath });
    let raw = "";
    try { raw = fs.readFileSync(filePath, "utf8"); } catch { return log; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e.seq !== "number" || !e.op) continue;
      log.entries.push(e);
      log.seq = Math.max(log.seq, e.seq);
      if (e.op === "snapshot" && e.name) log.marks.set(e.name, e.seq);
    }
    return log;
  }

  _append(entry) {
    this.entries.push(entry);
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
    }
    return entry;
  }

  /**
   * Assert a fact with provenance. `kind` is a free convention; suggested values:
   * "observation" (a source reported it), "accepted" (the governed reducer promoted it),
   * "derived" (materialized rule output), "config" (operator-supplied).
   * Re-asserting a retracted tuple makes it current again (last op wins in the view).
   */
  assert(rel, args, { src = "unknown", kind = "observation" } = {}) {
    return this._append({
      seq: ++this.seq, op: "assert", rel, args: args.map(String), src, kind, t: Date.now(),
    });
  }

  /** Tombstone a fact. The current view drops it; every earlier view and the history keep it. */
  retract(rel, args, { src = "unknown" } = {}) {
    return this._append({
      seq: ++this.seq, op: "retract", rel, args: args.map(String), src, t: Date.now(),
    });
  }

  /** Record a named, durable causal mark at the current sequence point. Returns the seq. */
  snapshot(name) {
    const e = this._append({ seq: ++this.seq, op: "snapshot", name: String(name), t: Date.now() });
    this.marks.set(e.name, e.seq);
    return e.seq;
  }

  /** Every operation that ever touched this exact tuple, in order — fact-level provenance. */
  provenance(rel, ...args) {
    const k = keyOf(rel, args.map(String));
    return this.entries.filter((e) => e.op !== "snapshot" && keyOf(e.rel, e.args) === k);
  }

  /**
   * Seed a Datalog instance with the facts visible at `asOf` (default: now).
   * Last-op-wins per tuple: present iff the latest op at or before `asOf` is an assert.
   * The caller owns rules and run(); transient facts asserted into the returned view
   * never touch the log — that is the multi-source seam.
   */
  seed(db, { asOf = Infinity } = {}) {
    const last = new Map();  // tuple key -> entry (latest op <= asOf)
    for (const e of this.entries) {
      if (e.seq > asOf) break;                 // entries are seq-ordered by construction
      if (e.op === "snapshot") continue;
      last.set(keyOf(e.rel, e.args), e);
    }
    for (const e of last.values()) {
      if (e.op === "assert") db.fact(e.rel, ...e.args);
    }
    return db;
  }

  /** A fresh current (or as-of) view. Options pass through to the Datalog constructor. */
  view({ asOf = Infinity, ...dbOptions } = {}) {
    return this.seed(new Datalog(dbOptions), { asOf });
  }

  /** As-of view at a named snapshot. Throws on an unknown name — a typo'd mark is not "empty". */
  viewAt(name, dbOptions = {}) {
    const seq = this.marks.get(String(name));
    if (seq === undefined) throw new Error(`unknown snapshot: ${name}`);
    return this.view({ asOf: seq, ...dbOptions });
  }

  count() { return this.entries.length; }
}
