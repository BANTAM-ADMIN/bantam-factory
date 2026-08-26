// Probe-demand done gate (opt-in, BANTAM_PROBE_DEMAND=1).
//
// Lineage, both measured: the requirement-checklist HINT quoted a task's own
// named bounds post-green and changed nothing — the VLQ run read
// "[32-bit unsigned integer]" and declared done with the overflow bug intact
// (2026-08-15-requirement-checklist-results.md). But a done-BOUNCE that
// delivers the missing fact gets repaired 7/7 under the rebuild trajectory
// (2026-08-12-strictness-routing-results.md). Same fact, different delivery.
// This gate moves the checklist into the bounce and demands executed
// evidence: one inline probe of a named bound before done is accepted.
// Bounded to one rejection — a wrong demand costs one turn, never a loop.
// Preregistration: docs/superpowers/reports/2026-08-15-probe-demand-gate-preregistration.md
import { extractRequirements } from "../requirement-checklist.js";

// A probe is INLINE executed evidence, not a suite rerun: the suite is the
// thing whose green the model already over-trusts.
const PROBE_RE = /\bnode\s+(?:-e\b|--eval\b|--input-type\b|--test\s+\S)/;

export function isQualifyingProbe(command) {
  return PROBE_RE.test(String(command ?? ""));
}

export function probeDemandObjection(task, turns, priorRejections, {
  enabled = false,
  auditEmitted = false,
} = {}) {
  if (!enabled || !auditEmitted || priorRejections >= 1) return null;
  const named = extractRequirements(task);
  if (!named.length) return null;
  const probed = (turns ?? []).some((t) => {
    const action = t?.action ?? t?.parsedAction ?? {};
    return action.a === "shell" && isQualifyingProbe(action.c);
  });
  if (probed) return null;
  const listed = named.slice(0, 5).map((x) => `[${x}]`).join(" · ");
  return `The task explicitly names requirements the visible tests may not cover: ${listed}. `
    + `Green tests are not evidence for named bounds they never exercise. Before done: run ONE `
    + `focused inline probe (node -e / node --input-type=module) that exercises a named bound or `
    + `rejection at its exact limit against the CURRENT code, read its verdict, fix any miss, then `
    + `finish. Do not rerun the unchanged suite in place of the probe.`;
}
