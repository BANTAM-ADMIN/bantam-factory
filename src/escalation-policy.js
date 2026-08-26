// Evidence-based escalation decisions for BANTAM runs.
//
// The model's self-reported confidence is deliberately absent. Every trigger is
// derived from a persisted outcome: verifier/contract status, turn exhaustion,
// gate intervention, repeated failure fingerprints, or evaluator integrity.

export const DEFAULT_ESCALATION_POLICY = Object.freeze({
  localRepairsBeforeDiagnostic: 1,
  diagnosticsBeforeDelegation: 1,
});

export function deriveEscalationDecision({ attempts, policy = DEFAULT_ESCALATION_POLICY } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new Error("escalation decision requires at least one attempt");
  }
  const rows = attempts.map(normalizeAttempt);
  const latest = rows.at(-1);
  const triggers = observableTriggers(rows);

  if (latest.status === "pass") {
    return decision("complete", 0, ["verified-pass"], rows);
  }
  if (latest.scopeViolations > 0 || latest.status === "cheated") {
    return decision("human-review", null, ["integrity-violation", ...triggers], rows);
  }
  if (isInfrastructureFailure(latest.status)) {
    return decision("retry-infrastructure", 0, ["infrastructure-failure", ...triggers], rows);
  }

  const diagnostics = rows.filter((row) => row.stage === "diagnostic").length;
  const taskDelegations = rows.filter((row) => row.stage === "delegate").length;
  const localFailures = rows.filter((row) => row.stage === "local" && row.status !== "pass").length;
  const hardTrigger = triggers.some((trigger) => [
    "repeated-failure",
    "turn-limit",
    "progress-terminated",
    "lifecycle-gate-loop",
    "state-audit-loop",
  ].includes(trigger));

  if (taskDelegations > 0) {
    return decision("human-review", null, ["delegate-failed", ...triggers], rows);
  }
  if (diagnostics >= policy.diagnosticsBeforeDelegation) {
    return decision("delegate-task", 3, triggers, rows);
  }
  if (hardTrigger || localFailures > policy.localRepairsBeforeDiagnostic) {
    return decision("diagnose-with-teacher", 2, triggers, rows);
  }
  return decision("repair-context", 1, triggers.length ? triggers : ["unverified-failure"], rows);
}

export function failureFingerprint(attempt = {}) {
  return [
    attempt.status ?? "unknown",
    attempt.contractStatus ?? "none",
    attempt.publicStatus ?? "none",
    Number(attempt.scopeViolations ?? 0),
  ].join(":");
}

function observableTriggers(rows) {
  const latest = rows.at(-1);
  const triggers = [];
  if (String(latest.status).startsWith("contract-")) triggers.push("hidden-contract-failure");
  if (latest.publicStatus === "fail") triggers.push("public-verifier-failure");
  if (latest.turnLimit > 0 && latest.turns >= latest.turnLimit) triggers.push("turn-limit");
  if (latest.progressGateTerminations > 0) triggers.push("progress-terminated");
  if (latest.lifecycleContractDoneRejections >= 2) triggers.push("lifecycle-gate-loop");
  if (latest.stateAuditDeferrals >= 2) triggers.push("state-audit-loop");
  if (rows.length >= 2 && rows.at(-2).fingerprint === latest.fingerprint) triggers.push("repeated-failure");
  return [...new Set(triggers)];
}

function normalizeAttempt(row) {
  const stage = ["local", "diagnostic", "delegate"].includes(row?.stage) ? row.stage : "local";
  const normalized = {
    stage,
    status: String(row?.status ?? "unknown"),
    publicStatus: String(row?.publicStatus ?? "unknown"),
    contractStatus: row?.contractStatus == null ? null : String(row.contractStatus),
    turns: finite(row?.turns),
    turnLimit: finite(row?.turnLimit),
    scopeViolations: finite(row?.scopeViolations),
    progressGateTerminations: finite(row?.progressGateTerminations),
    lifecycleContractDoneRejections: finite(row?.lifecycleContractDoneRejections),
    stateAuditDeferrals: finite(row?.stateAuditDeferrals),
  };
  normalized.fingerprint = row?.failureFingerprint || failureFingerprint(normalized);
  return normalized;
}

function decision(action, tier, triggers, rows) {
  const unique = [...new Set(triggers)];
  return {
    schema: 1,
    action,
    tier,
    triggers: unique,
    attemptsObserved: rows.length,
    basedOnSelfReportedConfidence: false,
    facts: unique.map((trigger) => `escalation_trigger(current_task, ${datalogAtom(trigger)}).`),
  };
}

function isInfrastructureFailure(status) {
  return ["error", "model-error", "quota-exhausted", "timeout", "interrupted", "output-limit", "native-sandbox-error"].includes(status);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function datalogAtom(value) {
  return String(value).replace(/[^a-z0-9_]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "unknown";
}
