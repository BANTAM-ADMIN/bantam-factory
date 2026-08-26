import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnExternalAgent, detectBlockedAgent } from "../src/logic/external-agent.js";

// `bantam compare` spawned competitor CLIs with an stdin pipe it never wrote to
// or closed. `codex exec` reads stdin, so the arm blocked forever: measured
// 2026-07-31, a bare-Codex arm sat for FIFTY MINUTES on 0.0 seconds of CPU while
// the BANTAM arm finished the same task in 101 seconds.
//
// That is worse than a crash. It reads as "the competitor is slow", and a
// head-to-head rendered from it would have claimed a ~30x advantage that was
// purely our own spawn options. A benchmark that flatters the subject through a
// plumbing bug is not evidence.

describe("running a competitor CLI", () => {
  it("does not hang when the child reads stdin", async () => {
    // `cat` with no arguments reads stdin until EOF. With an unclosed pipe this
    // never returns -- which is exactly the observed failure.
    const result = await spawnExternalAgent("cat", [], { timeoutMs: 5_000 });
    assert.equal(result.timedOut, false, "closing stdin should let the child exit");
    assert.equal(result.code, 0);
  });

  it("captures stdout", async () => {
    const result = await spawnExternalAgent("echo", ["hello"], { timeoutMs: 5_000 });
    assert.match(result.stdout, /hello/);
    assert.equal(result.code, 0);
  });

  it("bounds a run that will never finish, and says so", async () => {
    const result = await spawnExternalAgent("sleep", ["30"], { timeoutMs: 400 });
    assert.equal(result.timedOut, true, "a wedged competitor must be bounded");
    assert.ok(result.durationMs < 10_000, `killed promptly, took ${result.durationMs}ms`);
  });

  // A timeout is a missing observation, not a loss -- the same rule as a run
  // killed by the wall clock. The caller has to be able to tell them apart.
  it("distinguishes a timeout from an ordinary non-zero exit", async () => {
    const failed = await spawnExternalAgent("false", [], { timeoutMs: 5_000 });
    assert.equal(failed.timedOut, false);
    assert.notEqual(failed.code, 0);
  });

  it("rejects when the command does not exist rather than reporting a false pass", async () => {
    await assert.rejects(
      spawnExternalAgent("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5_000 }),
    );
  });
});

// An arm that never got to ATTEMPT the task is a missing observation, not a loss.
// Measured 2026-07-31: bare Codex returned "I'm blocked by the workspace's
// read-only sandbox ... No files, tests, or package configuration were modified"
// and was scored 0/4 against a BANTAM arm's 4/4, with every file it "produced"
// being the untouched original. The harness had that sentence in captured stdout
// and never read it. Scoring a blocked competitor manufactures a win for the
// subject -- the one failure mode that discredits every honest number beside it.
describe("noticing a competitor that never started", () => {
  it("detects the read-only sandbox refusal verbatim", () => {
    const r = detectBlockedAgent({
      stdout: "I'm blocked by the workspace's read-only sandbox. Both patching and a write probe failed.",
    });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /read-only sandbox/i);
  });

  it("detects a sandbox that could not start", () => {
    const r = detectBlockedAgent({
      stdout: "every write operation failed at sandbox startup with:\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
    });
    assert.equal(r.blocked, true);
  });

  it("detects an explicit report that nothing was modified", () => {
    assert.equal(detectBlockedAgent({
      stdout: "No source, test, or package files were changed.",
    }).blocked, true);
  });

  // A genuine attempt that failed is a real result and must still count.
  it("does not flag an arm that tried and got it wrong", () => {
    assert.equal(detectBlockedAgent({
      stdout: "Updated 12 modules. 3 tests are still failing, see below.",
    }).blocked, false);
  });

  it("does not flag ordinary silence", () => {
    assert.equal(detectBlockedAgent({}).blocked, false);
  });
});

// The detection landed in the result JSON but not in the REPORT: a head-to-head
// where bare Codex was blocked by an unavailable OS sandbox still printed
// "codex (reference): FAIL" and "Winner: bantam-codex". A win over an arm that
// never ran is not a win, and printing one is the single failure mode that would
// discredit every honest number beside it.
describe("reporting a blocked arm", () => {
  it("refuses to crown a winner when every reference arm was blocked", async () => {
    const { formatSummary } = await import("../src/logic/compare-plan.js");
    const text = formatSummary({
      task: "t",
      editable: [],
      winner: "bantam-codex",
      arms: [
        { id: "bantam-codex", role: "subject", pass: true, blocked: false, public: true, contract: { passed: 4, tests: 4 }, scope: { violations: 0 } },
        { id: "codex", role: "reference", pass: false, blocked: true, blockedReason: "read-only sandbox", public: true, contract: { passed: 0, tests: 4 }, scope: { violations: 0 } },
      ],
    });
    assert.match(text, /BLOCKED — never attempted the task/);
    assert.match(text, /NO COMPARISON/);
    assert.ok(!/🏆 Winner/.test(text), "no winner may be declared over a blocked-only field");
  });
});
