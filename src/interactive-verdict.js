import { isDeliverableRun } from "./logic/deliverable-signals.js";
const RESOLVED_BY_PASS = new Set(["unverified_edit", "premature_done"]);

/** Classify one completed REPL request before terminal styling is applied. */
export function classifyInteractiveResult(result) {
  const res = result ?? {};
  const verification = res.verification ?? null;
  const externallyVerified = verification?.status === "pass";

  if (res.interrupted) return verdict("interrupted", res, { externallyVerified: false });
  if (res.blocked) return verdict("blocked", res, { externallyVerified: false });
  if (verification?.status === "fail") {
    return verdict("verification_failed", res, { externallyVerified: false });
  }
  if (verification?.status === "unverified") {
    return verdict("verification_unverified", res, { externallyVerified: false });
  }
  if (res.responded) return verdict("response", res, { externallyVerified });
  if (!res.reachedDone) return verdict("paused", res, { externallyVerified });

  const warnings = (res.warnings ?? []).filter((warning) => (
    !externallyVerified || !RESOLVED_BY_PASS.has(warning?.gate)
  ));
  if (warnings.length) return verdict("warning", res, { externallyVerified, warnings });
  return verdict("success", res, { externallyVerified, warnings });
}

/** Keep verifier output readable while retaining both setup and final failure lines. */
export function verificationDetailLines(detail, { maxLines = 8, maxWidth = 160 } = {}) {
  const lines = String(detail ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => clipLine(line, maxWidth));
  if (lines.length <= maxLines) return lines;

  const headCount = Math.max(1, Math.ceil((maxLines - 1) / 2));
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    clipLine(`... (${omitted} lines omitted)`, maxWidth),
    ...lines.slice(-tailCount),
  ];
}

function verdict(kind, res, { externallyVerified, warnings = res.warnings ?? [] }) {
  return {
    kind,
    summary: res.summary ?? null,
    warnings,
    verification: res.verification ?? null,
    blocked: res.blocked ?? null,
    externallyVerified,
  };
}

function clipLine(line, width) {
  if (line.length <= width) return line;
  if (width <= 3) return line.slice(0, Math.max(0, width));
  return line.slice(0, width - 3) + "...";
}

/**
 * The demonstration a finished run can show for itself: the last shell turn
 * that ran the deliverable (not a probe, not an installer), with a trimmed
 * tail of its real output.
 *
 * Mined motivation (benches/collab, 2026-08-17): across 21GB of the operator's
 * real sessions, praise follows demonstrations — "perfect. Ok, dial it in and
 * test it out. Show me it working." A summary makes a claim; the receipt shows
 * the thing running. Returns null when the run never ran its deliverable —
 * absence of a receipt is itself honest.
 */
/**
 * The distinct files a run actually edited, in first-touch order. A paused
 * run used to end as a bare "⏸ Paused at the 60-turn limit" — the typewriter
 * PWA replay had built a four-stage flow plus a service worker and the
 * receipt showed none of it (chat r1 @ 2026-08-17T23:24). The pause line now
 * carries this digest so the person sees what exists before deciding.
 */
export function editedPathsOf(res, { max = 6 } = {}) {
  const seen = [];
  for (const turn of res?.turns ?? []) {
    const action = turn?.parsedAction ?? turn?.action ?? {};
    if (!["write_file", "replace", "patch", "edit_lines"].includes(action.a)) continue;
    if (/^(ERROR|NO_CHANGE)/.test(String(turn?.observation ?? ""))) continue;
    const path = action.p ?? action.path;
    if (typeof path === "string" && !seen.includes(path)) seen.push(path);
  }
  return { paths: seen.slice(0, max), more: Math.max(0, seen.length - max) };
}

export function demonstrationOf(res, { maxLines = 3, maxCols = 100 } = {}) {
  const turns = res?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const action = turns[i]?.parsedAction ?? turns[i]?.action;
    if (action?.a !== "shell") continue;
    const command = String(action.c ?? "");
    if (!isDeliverableRun(command)) continue;
    const observation = String(turns[i].observation ?? "");
    if (/^ERROR\b/.test(observation)) continue;
    const body = observation
      .split("\n")
      .filter((l) => l.trim() && !/^(\$ |cwd:|sandbox:|exit )/.test(l) && !/^\[[a-z-]+\]/.test(l));
    if (!body.length) return null;
    return {
      command: command.replace(/\s+/g, " ").slice(0, maxCols),
      output: body.slice(-maxLines).map((l) => l.slice(0, maxCols)),
    };
  }
  return null;
}
