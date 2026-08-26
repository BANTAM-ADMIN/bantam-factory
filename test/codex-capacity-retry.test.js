import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyCodexUpstreamError } from "../src/codex-transport.js";
import { retryDelayMs, CAPACITY_RETRY_BUDGET } from "../src/model.js";

// Two Codex runs on 2026-07-31 were scored `model-error` with a hidden contract of
// 4/4 -- the implementation was already correct and the run was killed at the
// finish line. Cause: "Selected model is at capacity. Please try a different
// model.", three attempts spanning NINE SECONDS (500ms then 1s of backoff), then
// the whole run discarded.
//
// Capacity pressure is transient and relieves on a scale of tens of seconds, so a
// 9-second budget cannot outlast it. It is also the one error class where giving
// up is most expensive: everything the run has already spent is lost, and unlike a
// timeout there is no duplicated upstream work to worry about -- the request never
// ran.

describe("classifying Codex upstream errors", () => {
  for (const message of [
    "Selected model is at capacity. Please try a different model.",
    "Rate limit exceeded, please try again later",
    "429 Too Many Requests",
    "The service is temporarily overloaded",
  ]) {
    it(`treats "${message.slice(0, 34)}..." as retryable capacity pressure`, () => {
      const error = classifyCodexUpstreamError(message);
      assert.equal(error.code, "capacity");
      assert.equal(error.retryable, true);
    });
  }

  it("leaves an ordinary failure alone", () => {
    const error = classifyCodexUpstreamError("Codex turn failed: syntax error in tool call");
    assert.notEqual(error.code, "capacity");
    assert.notEqual(error.retryable, true);
  });

  it("survives a missing message without inventing a capacity error", () => {
    const error = classifyCodexUpstreamError(undefined);
    assert.ok(error instanceof Error);
    assert.notEqual(error.code, "capacity");
  });
});

describe("capacity backoff outlasts the pressure", () => {
  it("waits orders of magnitude longer than for a generic error", () => {
    const generic = retryDelayMs({ code: "server_error" }, 0);
    const capacity = retryDelayMs({ code: "capacity" }, 0);
    assert.ok(capacity >= generic * 5,
      `capacity backoff ${capacity}ms must dwarf the generic ${generic}ms`);
  });

  it("escalates so later attempts wait longer", () => {
    const first = retryDelayMs({ code: "capacity" }, 0);
    const third = retryDelayMs({ code: "capacity" }, 2);
    assert.ok(third > first, "capacity backoff must escalate");
  });

  // Unbounded escalation would strand a run behind a genuinely exhausted quota.
  it("caps the wait so a run cannot hang indefinitely", () => {
    const far = retryDelayMs({ code: "capacity" }, 12);
    assert.ok(far <= 60_000, `capacity backoff capped, got ${far}ms`);
  });

  // The budget has to be long enough to matter: the failure it exists to prevent
  // burned through its entire allowance in nine seconds.
  it("affords a total wait far beyond the nine seconds that failed", () => {
    let total = 0;
    for (let i = 0; i < CAPACITY_RETRY_BUDGET; i += 1) total += retryDelayMs({ code: "capacity" }, i);
    assert.ok(total >= 60_000,
      `capacity budget totals ${total}ms; the observed failure exhausted 9,000ms`);
  });
});

// Quota exhaustion is not capacity pressure. Observed 2026-08-01: "You've hit your
// usage limit ... try again at Aug 4th". BANTAM reported it as `evidence-invalid`
// with zero turns and modelFailure: null -- which reads as a broken fixture rather
// than an empty account, and sends someone debugging the harness instead of buying
// credits.
//
// It must also never be retried: the answer does not change for days, and the
// capacity budget would spend two minutes of backoff discovering that.
describe("quota exhaustion", () => {
  for (const message of [
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 4th, 2026 10:09 PM.",
    "quota exceeded for this organization",
    "insufficient_quota",
  ]) {
    it(`recognises "${message.slice(0, 30)}..." as terminal`, () => {
      const error = classifyCodexUpstreamError(message);
      assert.equal(error.code, "quota_exhausted");
      assert.equal(error.retryable, false, "retrying an empty account wastes the capacity budget");
    });
  }

  it("does not confuse it with retryable capacity pressure", () => {
    assert.equal(classifyCodexUpstreamError("Selected model is at capacity").code, "capacity");
    assert.notEqual(classifyCodexUpstreamError("You've hit your usage limit").code, "capacity");
  });
});
