import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseQuotaNotice, humanizeWait, formatQuotaNotice } from "../src/logic/quota-notice.js";

// Observed verbatim on 2026-08-01, after which every run reported
// "evidence-invalid, modelFailure: null" -- which reads as a broken fixture. The
// real answer was already in the provider's own text.
const REAL = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
  + "to purchase more credits or try again at Aug 4th, 2026 10:09 PM.";

describe("reading a quota message", () => {
  it("recognises exhaustion and extracts the reset time", () => {
    const n = parseQuotaNotice(REAL, new Date("2026-08-01T02:09:00Z"));
    assert.equal(n.exhausted, true);
    assert.ok(n.resetAt instanceof Date);
    assert.equal(n.resetAt.getFullYear(), 2026);
    assert.equal(n.resetAt.getMonth(), 7, "August");
    assert.equal(n.resetAt.getDate(), 4);
  });

  // The ordinal suffix is not something Date.parse accepts, and dropping the reset
  // time loses the half of the message that decides what the operator does next.
  it("survives the ordinal suffix that Date.parse rejects", () => {
    for (const d of ["Aug 1st, 2026", "Aug 2nd, 2026", "Aug 3rd, 2026", "Aug 4th, 2026"]) {
      const n = parseQuotaNotice(`usage limit reached, try again at ${d} 10:00 PM`);
      assert.ok(n.resetAt instanceof Date, `failed to parse ${d}`);
    }
  });

  it("still reports exhaustion when no reset time is given", () => {
    const n = parseQuotaNotice("insufficient_quota");
    assert.equal(n.exhausted, true);
    assert.equal(n.resetAt, null);
    assert.match(formatQuotaNotice(n), /did not say when it resets/);
  });

  it("ignores messages that are not about quota", () => {
    assert.equal(parseQuotaNotice("Selected model is at capacity"), null);
    assert.equal(parseQuotaNotice("ECONNRESET"), null);
    assert.equal(parseQuotaNotice(undefined), null);
  });

  // Never read the clock implicitly: a wait computed against an unstated "now" is
  // not reproducible in an artifact.
  it("computes the wait only against a supplied clock", () => {
    assert.equal(parseQuotaNotice(REAL).waitMs, null);
    const n = parseQuotaNotice(REAL, new Date("2026-08-04T00:00:00"));
    assert.ok(typeof n.waitMs === "number" && n.waitMs >= 0);
  });
});

describe("stating the wait in the unit the operator decides on", () => {
  it("uses minutes, hours and days by magnitude", () => {
    assert.equal(humanizeWait(20 * 60_000), "20 minutes");
    assert.equal(humanizeWait(6 * 3_600_000), "6 hours");
    assert.equal(humanizeWait(3 * 86_400_000), "3 days");
    assert.equal(humanizeWait(60_000), "1 minute");
  });

  it("says nothing rather than something wrong for a bad input", () => {
    assert.equal(humanizeWait(0), null);
    assert.equal(humanizeWait(-5), null);
    assert.equal(humanizeWait(undefined), null);
  });
});

describe("the operator-facing notice", () => {
  it("leads with the fact that no run was graded", () => {
    const text = formatQuotaNotice(parseQuotaNotice(REAL, new Date("2026-08-01T02:09:00Z")));
    assert.match(text, /CODEX QUOTA EXHAUSTED/);
    assert.match(text, /Available again/);
    assert.match(text, /not a fixture or harness failure/);
    assert.match(text, /local model/, "the usable alternative must be offered");
  });

  it("renders nothing when there is no exhaustion", () => {
    assert.equal(formatQuotaNotice(null), "");
    assert.equal(formatQuotaNotice({ exhausted: false }), "");
  });
});
