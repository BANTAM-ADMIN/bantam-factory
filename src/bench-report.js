const ADDITIVE_FIELDS = [
  "invalid",
  "protocol",
  "turns",
  "durationMs",
  "preGateFails",
  "shellCwdGuards",
  "shellReadGuards",
  "testPipeGuards",
  "testDigestHits",
  "repeatedFailureHints",
  "outcomeCycleEvents",
  "outcomeCycleHints",
  "capabilityHints",
  "duplicateActionRejections",
  "repeatEscapeMasks",
  "doneRejections",
  "ledgerRejections",
  "secretAuditRejections",
  "queryBudgetBlocks",
  "progressNudges",
  "progressGateRejections",
  "progressGateTerminations",
  "artifactVerificationNudges",
  "artifactVerificationGateRejections",
  "artifactVerificationGateTerminations",
  "replaceFailures",
  "replaceOldNotFound",
  "replaceAmbiguous",
  "replaceLineStale",
  "replaceOther",
  "patchActions",
  "patchFailures",
  "deleteFileActions",
  "moveFileActions",
  "fileOperationFailures",
];

const COUNT_FIELDS = ADDITIVE_FIELDS.filter((field) => field !== "durationMs");
const TOTAL_FIELDS = ["pass", ...ADDITIVE_FIELDS, "maxProgresslessTurns"];

export function emptyBenchTotals() {
  return {
    pass: 0,
    invalid: 0,
    protocol: 0,
    turns: 0,
    durationMs: 0,
    preGateFails: 0,
    shellCwdGuards: 0,
    shellReadGuards: 0,
    testPipeGuards: 0,
    testDigestHits: 0,
    repeatedFailureHints: 0,
    outcomeCycleEvents: 0,
    outcomeCycleHints: 0,
    capabilityHints: 0,
    duplicateActionRejections: 0,
    repeatEscapeMasks: 0,
    doneRejections: 0,
    ledgerRejections: 0,
    secretAuditRejections: 0,
    queryBudgetBlocks: 0,
    progressNudges: 0,
    progressGateRejections: 0,
    progressGateTerminations: 0,
    artifactVerificationNudges: 0,
    artifactVerificationGateRejections: 0,
    artifactVerificationGateTerminations: 0,
    maxProgresslessTurns: 0,
    replaceFailures: 0,
    replaceOldNotFound: 0,
    replaceAmbiguous: 0,
    replaceLineStale: 0,
    replaceOther: 0,
    patchActions: 0,
    patchFailures: 0,
    deleteFileActions: 0,
    moveFileActions: 0,
    fileOperationFailures: 0,
  };
}

export function addBenchRun(totals, run) {
  validateTotals(totals);
  requireRecord(run, "benchmark run");
  if (typeof run.pass !== "boolean") {
    throw new TypeError("benchmark run pass must be a boolean");
  }

  // Validate and calculate the complete next state before touching the caller's
  // accumulator. A malformed late metric must not leave a half-added run.
  const increments = Object.create(null);
  for (const field of COUNT_FIELDS) {
    increments[field] = optionalCount(run[field], field);
  }
  increments.durationMs = optionalDuration(run.durationMs, "durationMs");
  const maxProgresslessTurns = optionalCount(
    run.maxProgresslessTurns,
    "maxProgresslessTurns",
  );

  const next = Object.create(null);
  next.pass = checkedCount(totals.pass + (run.pass ? 1 : 0), "aggregated pass");
  for (const field of COUNT_FIELDS) {
    next[field] = checkedCount(totals[field] + increments[field], `aggregated ${field}`);
  }
  next.durationMs = checkedDuration(
    totals.durationMs + increments.durationMs,
    "aggregated durationMs",
  );
  next.maxProgresslessTurns = Math.max(
    totals.maxProgresslessTurns,
    maxProgresslessTurns,
  );

  totals.pass = next.pass;
  for (const field of ADDITIVE_FIELDS) totals[field] = next[field];
  totals.maxProgresslessTurns = next.maxProgresslessTurns;
  return totals;
}

export function formatBenchRow(name, label, totals, repeat) {
  if (typeof name !== "string") {
    throw new TypeError("benchmark name must be a string");
  }
  if (typeof label !== "string") {
    throw new TypeError("benchmark label must be a string");
  }
  validateTotals(totals);
  checkedCount(repeat, "repeat");
  if (totals.pass > repeat) {
    throw new RangeError("benchmark total pass cannot exceed repeat");
  }

  const avgTurns = repeat ? (totals.turns / repeat).toFixed(1) : "0.0";
  const avgMs = repeat ? Math.round(totals.durationMs / repeat) : 0;
  return `${name.padEnd(26)} ${label}  pass ${totals.pass}/${repeat}`
    + `  invalidOutputs ${totals.invalid}`
    + `  protocolViolations ${totals.protocol}`
    + `  preGateFails ${totals.preGateFails}`
    + `  replaceFailures ${totals.replaceFailures}`
    + ` (${totals.replaceOldNotFound} old, ${totals.replaceAmbiguous} ambiguous, ${totals.replaceLineStale} stale-line, ${totals.replaceOther} other)`
    + `  patchActions ${totals.patchActions}`
    + `  patchFailures ${totals.patchFailures}`
    + `  deleteFileActions ${totals.deleteFileActions}`
    + `  moveFileActions ${totals.moveFileActions}`
    + `  fileOperationFailures ${totals.fileOperationFailures}`
    + `  shellCwdGuards ${totals.shellCwdGuards}`
    + `  shellReadGuards ${totals.shellReadGuards}`
    + `  testPipeGuards ${totals.testPipeGuards}`
    + `  testDigestHits ${totals.testDigestHits}`
    + `  repeatedFailureHints ${totals.repeatedFailureHints}`
    + `  outcomeCycleEvents ${totals.outcomeCycleEvents}`
    + `  outcomeCycleHints ${totals.outcomeCycleHints}`
    + `  capabilityHints ${totals.capabilityHints}`
    + `  duplicateActionRejections ${totals.duplicateActionRejections}`
    + `  repeatEscapeMasks ${totals.repeatEscapeMasks}`
    + `  doneRejections ${totals.doneRejections}`
    + `  ledgerRejections ${totals.ledgerRejections}`
    + `  secretAuditRejections ${totals.secretAuditRejections}`
    + `  queryBudgetBlocks ${totals.queryBudgetBlocks}`
    + `  progressNudges ${totals.progressNudges}`
    + `  progressGateRejections ${totals.progressGateRejections}`
    + `  progressGateTerminations ${totals.progressGateTerminations}`
    + `  artifactVerificationNudges ${totals.artifactVerificationNudges}`
    + `  artifactVerificationGateRejections ${totals.artifactVerificationGateRejections}`
    + `  artifactVerificationGateTerminations ${totals.artifactVerificationGateTerminations}`
    + `  maxProgresslessTurns ${totals.maxProgresslessTurns}`
    + `  avgTurns ${avgTurns}`
    + `  avgMs ${avgMs}`;
}

function validateTotals(totals) {
  requireRecord(totals, "benchmark totals");
  for (const field of TOTAL_FIELDS) {
    if (!Object.hasOwn(totals, field)) {
      throw new TypeError(`benchmark totals is missing field: ${field}`);
    }
  }
  checkedCount(totals.pass, "totals pass");
  for (const field of COUNT_FIELDS) {
    checkedCount(totals[field], `totals ${field}`);
  }
  checkedDuration(totals.durationMs, "totals durationMs");
  checkedCount(
    totals.maxProgresslessTurns,
    "totals maxProgresslessTurns",
  );
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function optionalCount(value, field) {
  return value === undefined || value === null
    ? 0
    : checkedCount(value, field);
}

function optionalDuration(value, field) {
  return value === undefined || value === null
    ? 0
    : checkedDuration(value, field);
}

function checkedCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function checkedDuration(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}
