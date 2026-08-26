// Tell the operator their Codex account is empty, and when it will not be.
//
// On 2026-08-01 the quota ran out mid-session and BANTAM reported:
//
//   EVIDE  keyed-task-pool-strong  (0 turns, ...)
//   status: evidence-invalid       modelFailure: null
//
// which reads as a broken fixture. The real answer -- "try again at Aug 4th, 2026
// 10:09 PM" -- was sitting one layer down in the CLI output, already in hand.
// Diagnosing it took a fixture inspection, a second fixture run, a commit review
// and a manual transport test.
//
// The reset time is the part that actually changes what the operator does next. A
// wait of twenty minutes means go and get coffee; a wait until Tuesday means switch
// to the local model or buy credits. Reporting "quota exhausted" without it leaves
// the most useful half of the message on the floor.

const QUOTA_HINT = /\b(?:usage limit|quota (?:exceeded|exhausted)|out of credits|purchase more credits|insufficient_quota)\b/i;

// "try again at Aug 4th, 2026 10:09 PM" — the ordinal suffix is not something
// Date.parse accepts, so it is stripped before parsing.
const RESET_AT = /try again (?:at|after)\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?)/i;

/**
 * @param {string} message  the provider's own error text
 * @param {Date} [now]      injected for tests; never read the clock implicitly
 */
export function parseQuotaNotice(message, now = null) {
  const text = String(message ?? "");
  if (!QUOTA_HINT.test(text)) return null;

  const match = text.match(RESET_AT);
  let resetAt = null;
  if (match) {
    const parsed = new Date(match[1].replace(/(\d)(?:st|nd|rd|th)/g, "$1"));
    if (!Number.isNaN(parsed.getTime())) resetAt = parsed;
  }

  let waitMs = null;
  if (resetAt && now instanceof Date && !Number.isNaN(now.getTime())) {
    waitMs = Math.max(0, resetAt.getTime() - now.getTime());
  }

  return { exhausted: true, resetAt, waitMs, raw: text.slice(0, 400) };
}

/** Round a wait into the unit an operator actually decides on. */
export function humanizeWait(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The operator-facing block. Leads with what to DO, because "quota exhausted" is
 * only actionable once you know whether the wait is coffee-length or days.
 */
export function formatQuotaNotice(notice) {
  if (!notice?.exhausted) return "";
  const lines = ["", "⛔ CODEX QUOTA EXHAUSTED — no model calls are possible on this account."];

  if (notice.resetAt) {
    const when = notice.resetAt.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const wait = humanizeWait(notice.waitMs);
    lines.push(`   Available again: ${when}${wait ? `  (about ${wait} from now)` : ""}`);
  } else {
    lines.push("   The provider did not say when it resets.");
  }

  lines.push("   Options: buy credits at https://chatgpt.com/codex/settings/usage,");
  lines.push("            or run against the local model (drop --codex).");
  lines.push("   This is not a fixture or harness failure; no run was graded.");
  return lines.join("\n");
}
