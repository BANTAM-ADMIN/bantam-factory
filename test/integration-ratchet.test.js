import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditIntegration } from "../src/logic/integration-audit.js";

// BANTAM's self-improvement loop proposes an improvement, builds it, and then does
// not connect it. Measured 2026-07-31: 13 modules, 2,384 lines, imported only by
// their own tests. Nothing in the build noticed, because nothing was watching.
//
// That is not merely waste. turn-parallelism.js sat shelved for weeks reporting
// that 46.5% of Codex turns were removable -- enough to justify building parallel
// dispatch. The real figure was 4.4%; it was counting `done` actions as savings
// and pooling reads across a whole run as if a trajectory were a bag of actions.
// Shelved code is not inert, it is UNVERIFIED code that still gets read and acted
// upon.
//
// This is a ratchet, not a cliff. The existing 2,384 lines are grandfathered; what
// it forbids is ADDING more. Build something and wire it, or build something and
// delete it, but do not quietly grow the pile.
//
// To lower the baseline: wire a module or remove it, then drop this number. It
// should only ever go down.
// Lowered 2384 -> 1587 on 2026-07-31 by removing six stub modules whose proposals
// had stale premises. Ratchets are only honest if you tighten them after gaining
// ground.
const SHELVED_LINE_BASELINE = 1587;

describe("self-improvement output reaches the product", () => {
  it("does not grow the pile of built-but-unwired modules", () => {
    const audit = auditIntegration(".");
    assert.ok(
      audit.totals.shelvedLines <= SHELVED_LINE_BASELINE,
      `shelved code grew to ${audit.totals.shelvedLines} lines (baseline ${SHELVED_LINE_BASELINE}).\n`
      + `Wire the new module or delete it -- do not add to the pile.\n`
      + `test-only: ${audit.testOnly.map((m) => m.file).join(", ")}\n`
      + `unreferenced: ${audit.unreferenced.map((m) => m.file).join(", ") || "(none)"}`,
    );
  });

  // A module nothing imports at all is worse than a test-only one: it has no
  // exercise whatsoever, so it can rot silently and still be believed when read.
  it("keeps every proposal module at least under test", () => {
    const audit = auditIntegration(".");
    assert.deepEqual(
      audit.unreferenced.map((m) => m.file),
      [],
      "a module nothing imports has no exercise at all; wire it, test it, or delete it",
    );
  });

  // Deliberately NOT asserting that every named module exists. The registry's
  // `missingMechanisms` list is a BACKLOG, gated on the file being absent -- its
  // own comment records that making those proposals unconditional caused completed
  // work to resurface forever. A missing file there is the mechanism working.
  //
  // Asserting otherwise would have flagged 15 healthy backlog entries as defects,
  // which is the same mistake this whole file exists to catch: an instrument
  // reporting a confident problem where the honest answer is "that is fine".
  it("counts the backlog without mistaking it for a defect", () => {
    const audit = auditIntegration(".");
    assert.ok(Array.isArray(audit.missing),
      "the audit should still report unbuilt proposals, as information rather than failure");
  });

  // The baseline must stay honest: if it drifts far above reality, it stops
  // ratcheting. Anyone who lowers the pile should lower this number too.
  it("keeps the baseline close to the truth", () => {
    const audit = auditIntegration(".");
    assert.ok(
      SHELVED_LINE_BASELINE - audit.totals.shelvedLines <= 400,
      `the pile has shrunk to ${audit.totals.shelvedLines} lines; lower SHELVED_LINE_BASELINE `
      + `to lock the improvement in, or the ratchet stops holding`,
    );
  });
});

// integration-audit only sees files named in the self-improve proposal registry.
// Everything outside that list was invisible, so the ratchet above guarded 1,587
// lines while 5,787 sat unwatched -- a guard that only watches where you already
// looked. This second ratchet covers every module under src/.
//
// Three categories, because the honest answer differs:
//   test-only         exercised, but nothing in production runs it
//   possibly-spawned  named in a string; may be an execFileSync entry point
//   unreferenced      imported by nothing at all, not even a test
//
// Only the last is unambiguously dead. To lower a baseline: wire the module,
// delete it, or give it a test -- then drop the number.
describe("repo-wide orphan ratchet", () => {
  it("does not grow the set of modules nothing imports", async () => {
    const { auditOrphans } = await import("../src/logic/orphan-audit.js");
    const audit = auditOrphans(".");
    // Lowered 843 -> 0 by removing showcase-model.js (render target
    // comparison/viewer/ no longer exists; gauntlet-showcase.js is the live
    // renderer) and smart-file-integration.js (a wiring module nothing ever wired).
    assert.ok(audit.totals.unreferencedLines <= 0,
      `imported-by-nothing grew to ${audit.totals.unreferencedLines} lines (baseline 0): `
      + audit.orphans.filter((o) => o.kind === "unreferenced").map((o) => o.file).join(", "));
  });

  // Ratchets on MODULE COUNT, not lines. The line-based version fired on a
  // one-line bug fix inside an already-orphaned module -- correct by its own rule
  // and wrong about the problem, which is how many things are unwired, not how big
  // they are. Punishing repairs to shelved code is the opposite of the intent:
  // cross-file-patterns.js is shelved and found a real defect tonight.
  it("does not grow the number of modules nothing imports", async () => {
    const { auditOrphans } = await import("../src/logic/orphan-audit.js");
    const audit = auditOrphans(".");
    const shelved = audit.orphans.filter((o) => o.kind !== "cli-entry");
    assert.ok(shelved.length <= 20,
      `orphaned modules grew to ${shelved.length} (baseline 20). `
      + "Wire the new module or delete it — do not add to the pile.\n"
      + shelved.map((o) => `${o.kind} ${o.file}`).join("\n"));
  });

  // Lines are still reported, as information rather than a gate: a single
  // 5,000-line orphan and fifty small ones are different problems.
  it("reports the orphan line total without gating on it", async () => {
    const { auditOrphans } = await import("../src/logic/orphan-audit.js");
    const audit = auditOrphans(".");
    assert.ok(Number.isInteger(audit.totals.orphanLines));
    assert.ok(Number.isInteger(audit.totals.unreferencedLines));
  });
});

// D14. The citation-based ratchet above cannot see through a barrel: one
// import of src/factory.js certified all 57 factory modules, so "unwired by
// design" and "unwired by drift" were indistinguishable and the pile could
// grow invisibly. This is the reachability ratchet: demanded-use walk from
// bin/, CLI entries, and examples/ (production tier), then scripts/ (lab
// tier), and every module reachable from NOTHING must be individually named
// here with a reason. Adding an unreachable module without naming it fails;
// naming one that no longer needs it also fails (stale exemptions are drift).
import { auditReachability } from "../src/logic/orphan-audit.js";

const REACHABILITY_EXEMPTIONS = [
  // Spawned by path (execFileSync/child_process), invisible to an import walk.
  { file: "src/logic/preview-runner.mjs", reason: "spawned by path from preview flow" },
  { file: "src/lock-recovery-child.js", reason: "spawned by path for lock recovery" },
  // The shelved self-improvement pile, grandfathered 2026-08-02 (D14 landing).
  // Wire it or delete it; do not add to it. Lower this list, never grow it.
  { file: "src/self-healing.js", reason: "shelved self-improvement output" },
  { file: "src/turn-parallelism.js", reason: "shelved self-improvement output (its 46.5% claim was measured false)" },
  { file: "src/playground.js", reason: "shelved developer tool" },
  { file: "src/smart-file-priority.js", reason: "shelved self-improvement output" },
  { file: "src/codebase-index.js", reason: "shelved self-improvement output" },
  { file: "src/cross-file-patterns.js", reason: "shelved self-improvement output" },
  { file: "src/context-budget.js", reason: "shelved self-improvement output" },
  { file: "src/failure-pattern-learner.js", reason: "shelved self-improvement output" },
  { file: "src/self-benchmark.js", reason: "shelved benchmark harness" },
  { file: "src/benchmark.js", reason: "shelved benchmark harness" },
  { file: "src/logic/effort-policy.js", reason: "shelved self-improvement output" },
  { file: "src/test-coverage.js", reason: "shelved self-improvement output" },
  { file: "src/logic/prompt-optimization.js", reason: "shelved self-improvement output" },
  { file: "src/action-efficiency.js", reason: "shelved self-improvement output" },
  { file: "src/shared.js", reason: "shelved helper, candidates for deletion" },
  { file: "src/action-decision-tree.js", reason: "shelved self-improvement output" },
  { file: "src/error-handling.js", reason: "shelved helper, candidate for deletion" },
  // Built in the factory experiment as observe-only arithmetic. It has no
  // accepted scheduler/CLI consumer yet; this exemption becomes stale and fails
  // automatically when one is wired.
  { file: "src/factory/changeover-planner.js", reason: "lab-tier campaign proposal; pending accepted scheduler integration" },
];

describe("reachability ratchet (D14)", () => {
  it("leaves no module unreachable without a named reason", () => {
    const audit = auditReachability(".", { exemptions: REACHABILITY_EXEMPTIONS });
    const drift = audit.modules.filter((m) => m.tier === "unreachable");
    assert.deepEqual(
      drift.map((m) => m.file),
      [],
      "these modules are reachable from no entry point, script, or named exemption —\n"
      + "wire them, delete them, or name them here with a reason:\n"
      + drift.map((m) => `  ${m.lines}  ${m.file}`).join("\n"),
    );
  });

  it("keeps the factory's lab surface visible as its own tier, not laundered into production", () => {
    const audit = auditReachability(".");
    assert.ok(audit.totals.scriptLines > 0, "scripts/ reach modules production does not; that tier must stay visible");
    assert.ok(audit.totals.productionLines > 0);
  });
});
