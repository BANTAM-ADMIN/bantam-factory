import { verificationVerdict } from "./done-guard.js";
import { isInlineEvalProbe, isTestCommand } from "./logic/deliverable-signals.js";
import { formatStateAuditRisks } from "./state-audit-risk.js";
import { deriveCompletionContext } from "./logic/derived-failure-context.js";

import { requirementChecklistSuffix } from "./requirement-checklist.js";

export const COMPLETION_AUDIT_MARKER = "[completion-audit]";
export const VISUAL_ALT_AUDIT_MARKER = "[visual-alt-audit]";
export const LEXICAL_CONTRACT_AUDIT_MARKER = "[lexical-contract-audit]";
export const STATE_AUDIT_MARKER = "[state-audit]";
export const PLAN_AUDIT_MARKER = "[plan-audit]";
export const MAX_MISSING_ENV_CHECKS = 1;
const DENIED_ENV_CHECKS = new Set([
  "NODE_TEST_CONTEXT",
  "PATH",
  "HOME",
  "TMPDIR",
  "PWD",
  "SHELL",
  "NODE_OPTIONS",
  "NODE_PATH",
]);
const KEYED_STATE_AUDIT_DEFERRAL = `${STATE_AUDIT_MARKER} Reading the source or rerunning the unchanged visible suite does not resolve the keyed Promise audit. Run one assertion-bearing, task-local probe with no temporary files: synchronous throw then same-key reuse, synchronous same-key reentrancy, and resubmission immediately after observed fulfillment or rejection. Publish the key-to-Promise association before user code can run and retire that exact association before settlement is observable. A thrown task rejects its Promise: use \`await assert.rejects(first, expectedReason)\`; never compare \`await first\` to a value, because awaiting a rejection throws. Printed values or an exit-zero script without assertions are not proof. If the probe exposes a defect, edit it and rerun the relevant verification; otherwise finish.`;
const ABORT_STATE_AUDIT_DEFERRAL = `${STATE_AUDIT_MARKER} Reading the source or rerunning the unchanged visible suite does not resolve the abort lifecycle audit. Run one assertion-bearing, task-local probe with no temporary files: start a batch with blocked workers, abort before awaiting the batch, assert that no later item starts, let started workers settle, and assert the exact listener function is removed before resolution. Also assert that a synchronously throwing worker becomes that item's rejected result. Printed values or an exit-zero script without assertions are not proof. If the probe exposes a defect, edit it and rerun the relevant verification; otherwise finish.`;
const GENERAL_STATE_AUDIT_DEFERRAL = `${STATE_AUDIT_MARKER} Reading the source or rerunning the unchanged visible suite does not resolve the async state audit. Run one assertion-bearing, task-local probe with no temporary files that exercises the task's most dangerous reset, stale-settlement, or cleanup ordering. Printed values or an exit-zero script without assertions are not proof. If the probe exposes a defect, edit it and rerun the relevant verification; otherwise finish.`;

// Backward-compatible keyed constant for callers/tests that explicitly exercise
// the original keyed lifecycle. Live code should select by audit reason.
export const STATE_AUDIT_DEFERRAL = KEYED_STATE_AUDIT_DEFERRAL;

export function stateAuditDeferral(reason, task = "") {
  const derived = deriveCompletionContext({
    task,
    stateAuditReason: reason,
    verified: "The previous probe did not cover every derived obligation.",
  });
  if (derived) return derived.message.trimStart();
  if (reason === "auto-keyed-promise-lifecycle") return KEYED_STATE_AUDIT_DEFERRAL;
  if (reason === "auto-async-abort-lifecycle") return ABORT_STATE_AUDIT_DEFERRAL;
  return GENERAL_STATE_AUDIT_DEFERRAL;
}

const AUDIT_MESSAGE = `\n\n${COMPLETION_AUDIT_MARKER} Tests are green. Before done, compare the current implementation with every explicit task requirement. Trace each requirement to behavior in executed code; names, comments, declared helpers or constants, intent, and covered tests are not proof. Trace every explicitly named input class or edge case through every public or CLI entrypoint that can receive it; duplicated classifiers must agree on accept/reject behavior. Validate function-wide parameters before entering element loops so empty collections cannot bypass their preconditions, and make sure sparse collection slots are validated rather than silently skipped. When work is deduplicated but the contract requires one result per input, preserve any required value/reason identity while constructing an independent result record for each input; one shared wrapper object is not multiple results. Do not invent unnamed inputs or broaden the task. Fix any mismatch and re-run the tests.`;
const CONFIGURED_VERIFICATION_AUDIT_MESSAGE = AUDIT_MESSAGE.replace(
  "Tests are green.",
  "The trusted configured verification is green.",
);
const visualAuditMessage = (verified) => `\n\n${COMPLETION_AUDIT_MARKER} ${VISUAL_ALT_AUDIT_MARKER} ${verified} Do not finish yet. This task uses supplied image evidence. Compare every authored image alt description with the earlier \`view_image\` observation, not merely with visible tests. Check that each alt concisely captures the supplied image's distinctive foreground subject and distinctive sky or background elements rather than only its generic setting. If a prominent visible element is omitted or invented, correct the alt and rerun the relevant test before done. Then check the remaining explicit assignment requirements against the current files and preview evidence; do not invent unnamed requirements.`;
const PLAN_AUDIT_MESSAGE = `\n\n${PLAN_AUDIT_MARKER} The deliverable is a repository-grounded document, so audit it against the exact assignment and inspected code, not just the shape check. Four checks, in order. 1 Consumers: name each relevant file, symbol, consumer, or deliberately unaffected path supported by repository evidence; do not substitute an unnamed "API", "CLI", "service", or "downstream consumer" for paths already found. 2 Behavior diffs: trace every explicit requirement and requested observable change to a concrete section of the draft. 3 Guarantees: for each must/never/always, compatibility, migration, rollout, risk, or test requirement that the assignment actually names, trace the relevant worst case and recovery. 4 Decisions: make unresolved choices explicit with a one-line reason and tie focused tests to the affected surfaces. Revise only omissions established by the assignment or repository evidence; do not invent mechanisms that a different task might need. Reread the revision, re-run the requested check, then finish.`;
const STATE_AUDIT_MESSAGE = `\n\n${STATE_AUDIT_MARKER} Visible tests are not evidence for the required concurrent orderings. Use one or two concrete counterexamples, prioritizing reset/invalidate followed by stale settlement. Read the current source and audit these boundaries separately: success data write, success pending cleanup, rejection/finally pending cleanup, invalidate/clear identity change, and shared-result fan-out. Immediately before every write or cleanup, the stored operation identity must still equal the settling operation. Identity must remain unique across reset; clearing a sequence map can reuse values. If any path can mutate newer state or share mutable results, it is a defect even when untested or unlikely. Prefer an existing focused test or a minimal inline probe; do not create a broad temporary test script, rewrite unrelated tests, or rerun the entire suite unless the focused check requires it.`;
const KEYED_PROMISE_AUDIT_MESSAGE = `\n\n${STATE_AUDIT_MARKER} Visible tests do not prove the keyed Promise lifecycle. Trace the exact timeline: publish key → Promise before invoking user task code; user code may throw or synchronously reenter with the same key; settle the task; retire the exact key → Promise association before fulfillment or rejection becomes observable; then let a caller submit that key again. A map update performed after calling user code loses synchronous reentrancy. Cleanup attached after the returned Promise settles leaves an immediate post-await resubmission coalesced to an already-settled Promise. Run one compact focused probe. Use valid calls on every path: capture a synchronously thrown task's returned Promise and use \`await assert.rejects(first, expectedReason)\`; never use \`assert.equal(await first, value)\`, because awaiting a rejection throws. Then submit the key again. For reentrancy, have the running task assign \`nested = subject.run(key, () => "must not run")\`, then assert \`nested === first\` after the outer \`run\` returns; repeat reuse immediately after an observed fulfillment and an observed rejection. Do not omit the later task argument or await a rejection before installing the rejection assertion. If any check fails, fix the ownership timeline and rerun the relevant verification; do not substitute another run of the unchanged broad suite for these orderings.`;
const ABORT_LIFECYCLE_AUDIT_MESSAGE = `\n\n${STATE_AUDIT_MARKER} Visible tests do not prove the abort lifecycle. Trace one concrete timeline: install and retain the exact listener function; start only the concurrency-limited prefix; abort while those workers are still blocked; start no later item; let already-started workers settle into ordinary fulfilled/rejected results; remove that exact listener before resolving the batch. Invoke workers through a Promise boundary so synchronous throws become per-item rejected results. Run one compact assertion-bearing probe: call abort before awaiting the batch, instrument worker starts and add/remove listener identity, and assert each outcome. Printed arrays, booleans, or an exit-zero script without assertions are not proof.`;

/**
 * Is the completion audit worth running for this model?
 *
 * MEASURED per model, 2026-07-31. On gpt-5.6-terra, keyed-task-pool-strong, n=3
 * per arm with complete separation (exact permutation p = 0.05):
 *
 *              mean turns   mean cache miss   hidden contract
 *   audit ON      9.7           51,253        4/4, 4/4, 4/4
 *   audit off     6.3           30,758        4/4, 4/4, 4/4
 *
 * Every ON run cost more than every OFF run: +54% turns and +67% cache misses for
 * an identical contract result. The audit also emits the `guidance` block that
 * appears for one turn and vanishes, rewriting the prompt after it -- so it costs
 * cache twice, once in extra turns and once in churn.
 *
 * It stays ON for local models, where premature `done` is a real and frequent
 * failure mode. The audit asks "are you sure?"; a frontier model on a
 * well-specified task already was, and re-checking is pure cost. An explicit
 * BANTAM_COMPLETION_AUDIT still wins over both defaults.
 */
export function completionAuditEnabled(
  value = process.env.BANTAM_COMPLETION_AUDIT,
  { codex = false } = {},
) {
  // Only an UNSET variable falls through to the per-model default. An empty string
  // stays off, as it always has: `BANTAM_COMPLETION_AUDIT=` is someone explicitly
  // disabling the audit, and quietly re-enabling it for local models would be a
  // behaviour change hiding inside a default change.
  if (value !== undefined) return /^(1|true|yes|on)$/i.test(String(value));
  return !codex;
}

export function visualCompletionAuditEnabled(
  value = process.env.BANTAM_VISUAL_COMPLETION_AUDIT,
) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

export function lexicalContractAuditEnabled(
  value = process.env.BANTAM_LEXICAL_CONTRACT_AUDIT,
) {
  if (value === undefined) return true;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/**
 * Build a narrow post-green reminder from lexical languages the assignment
 * explicitly names. This is deliberately not a generic edge-case generator:
 * tasks without these phrases receive no extra prompt, and each clause is
 * independently gated by its corresponding contract language.
 */
export function lexicalContractAuditMessage(task) {
  const source = String(task ?? "");
  const clauses = [];
  if (/\btrim(?:med|s|ming)?\b/i.test(source)) {
    clauses.push(`"trimmed" means surrounding whitespace remains valid`);
  }
  if (/\bcase[\s-]*insensitive\b/i.test(source)) {
    clauses.push(`"case-insensitive" means mixed case remains valid`);
  }
  const unsignedDecimalString = /\bunsigned\s+decimal(?:-integer)?\s+string\b/i.test(source)
    || /\bunsigned\s+decimal-integer\s+string\b/i.test(source);
  const canonicalRequired = /\b(?:canonical|normalized)\s+(?:decimal(?:-integer)?\s+)?(?:form|string|representation)\b/i.test(source);
  if (unsignedDecimalString && !canonicalRequired) {
    clauses.push(`an "unsigned decimal-integer string" includes leading-zero forms such as "007" unless canonical form is explicitly required`);
  }
  if (!clauses.length) return "";

  const language = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
  return `\n\n${LEXICAL_CONTRACT_AUDIT_MARKER} The task names accepted string languages. Treat them as languages, not canonical serializers: ${language}. Compare the current accepting regexes and parsers against those named valid spellings now; correct any narrowed boundary, then rerun verification.`;
}

/**
 * Documentation paths explicitly delegated as authoritative by the task.
 * This intentionally excludes source/config files: the presence verifier is
 * grounded only in the assignment and in task-named prose specifications.
 */
export function taskExplicitSpecDocumentPaths(task) {
  const paths = [];
  const seen = new Set();
  const pattern = /(?:^|[\s("'`])((?:\.{0,2}\/)?(?:[\w.-]+\/)*(?:README(?:\.[\w.-]+)?|[\w.-]+\.(?:md|mdx|rst|adoc|txt)))(?=$|[\s)"'`,.:;])/gi;
  for (const match of String(task ?? "").matchAll(pattern)) {
    const value = normalizeDocumentPath(match[1]);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    paths.push(value);
  }
  return paths;
}

/**
 * Extract task-grounded environment variables whose *absence* is explicitly
 * required. Documents are considered only when the task names their path and
 * the caller marks the current file authoritative and unedited.
 */
export function extractMissingEnvironmentVariables({
  task = "",
  documents = [],
} = {}, {
  max = MAX_MISSING_ENV_CHECKS,
} = {}) {
  const limit = Math.max(0, Math.min(MAX_MISSING_ENV_CHECKS, Number(max) || 0));
  if (limit === 0) return [];

  const sources = [String(task ?? "")];
  const taskNames = new Set(uppercaseNames(task));
  const explicit = new Set(taskExplicitSpecDocumentPaths(task).map((value) => value.toLowerCase()));
  for (const document of Array.isArray(documents) ? documents : []) {
    const key = normalizeDocumentPath(document?.path).toLowerCase();
    const authoritative = document?.authoritative === true || document?.successfulRead === true;
    if (!key || !explicit.has(key) || !authoritative || document?.edited === true) continue;
    sources.push(String(document?.text ?? ""));
  }

  const found = [];
  const seen = new Set();
  for (const source of sources) {
    for (const name of missingEnvironmentVariablesInText(source)) {
      if (!taskNames.has(name) || DENIED_ENV_CHECKS.has(name) || name.startsWith("BANTAM_")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push(name);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

function uppercaseNames(text) {
  return [...String(text ?? "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g)]
    .map((match) => match[0]);
}

function missingEnvironmentVariablesInText(text) {
  const found = [];
  const source = String(text ?? "");
  const candidate = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g;
  for (const match of source.matchAll(candidate)) {
    const name = match[0];
    if (name.length < 2 || name.length > 64) continue;
    const start = Math.max(
      source.lastIndexOf("\n", match.index) + 1,
      source.lastIndexOf(".", match.index) + 1,
      match.index - 120,
    );
    const newline = source.indexOf("\n", match.index + name.length);
    const period = source.indexOf(".", match.index + name.length);
    const ends = [newline, period, match.index + name.length + 120].filter((value) => value >= 0);
    const end = Math.min(source.length, ...ends);
    const clause = source.slice(start, end);
    const escaped = escapeRegExp(name);
    const quoted = "[`'\"]?";
    const absenceBefore = new RegExp(
      `\\b(?:missing|unset|absent|without|omitted)\\b(?:\\s+the)?(?:\\s+(?:environment(?:al)?\\s+(?:variable|var)|env(?:ironment)?\\s+var))?\\s+${quoted}\\b${escaped}\\b${quoted}`,
      "i",
    );
    const absenceAfter = new RegExp(
      `\\b${escaped}\\b${quoted}(?:\\s+(?:environment(?:al)?\\s+(?:variable|var)|env(?:ironment)?\\s+var))?\\s+(?:(?:is|must\\s+be|should\\s+be)\\s+)?(?:not\\s+(?:set|defined|provided)|unset|missing|absent|undefined|omitted)\\b`,
      "i",
    );
    if (!absenceBefore.test(clause) && !absenceAfter.test(clause)) continue;

    // A one-word uppercase acronym is too ambiguous unless the clause binds
    // that exact name to "environment variable"/"env var". Underscored names
    // already have the conventional environment-variable shape.
    if (!name.includes("_")) {
      const explicitEnvironmentName = new RegExp(
        `(?:\\b${escaped}\\b${quoted}\\s+(?:environment(?:al)?\\s+(?:variable|var)|env(?:ironment)?\\s+var)|(?:environment(?:al)?\\s+(?:variable|var)|env(?:ironment)?\\s+var)\\s+${quoted}\\b${escaped}\\b${quoted})`,
        "i",
      );
      if (!explicitEnvironmentName.test(clause)) continue;
    }
    found.push(name);
  }
  return found;
}

function normalizeDocumentPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim()
    .replace(/[.,:;]+$/, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function completionAuditHint({
  enabled,
  workspaceChanged,
  emitted,
  turn,
  task = "",
  visualAudit = false,
  lexicalAudit = false,
  stateAudit = false,
  stateAuditReason = null,
  stateRisks = [],
  planAudit = false,
  requirementChecklist = false,
} = {}) {
  if (!enabled || !workspaceChanged || emitted) return null;
  if (verificationVerdict(turn) !== "pass") return null;
  const scopedVerify = turn?.scopedVerify;
  const action = turn?.action ?? turn?.parsedAction ?? {};
  const directTestPass = action.a === "shell" && isTestCommand(action.c);
  const trustedConfiguredPass = scopedVerify?.verdict === "pass";
  if (!directTestPass && !trustedConfiguredPass) return null;

  // `verificationVerdict` intentionally credits any successful deliverable invocation for the
  // done/evidence guards. A CLI smoke command is useful evidence there, but it cannot truthfully
  // introduce a post-*test* audit as "Tests are green." Harness-run verification is separately
  // trusted through the unspoofable scopedVerify stamp and gets evidence-accurate wording when its
  // configured command is not itself a recognized test runner.
  const configuredNonTest = trustedConfiguredPass && !isTestCommand(scopedVerify.command);
  const verified = configuredNonTest
    ? "The trusted configured verification is green."
    : "Tests are green.";
  const auditMessage = visualAudit && taskRequiresVisualAltAudit(task)
    ? visualAuditMessage(verified)
    : configuredNonTest ? CONFIGURED_VERIFICATION_AUDIT_MESSAGE : AUDIT_MESSAGE;
  const lexicalMessage = lexicalAudit ? lexicalContractAuditMessage(task) : "";
  // Task-specific requirement quotes (opt-in): the generic audit was measured
  // fired-and-bypassed on 5/7 polyglot holdout failures whose failing clauses
  // the task text named verbatim. Prereg:
  // docs/superpowers/reports/2026-08-15-requirement-checklist-preregistration.md
  const checklistMessage = requirementChecklist ? requirementChecklistSuffix(task) : "";
  if (planAudit) return `${auditMessage}${lexicalMessage}${checklistMessage}${PLAN_AUDIT_MESSAGE}`;
  const derivedStateContext = stateAudit
    ? deriveCompletionContext({ task, stateAuditReason, verified })
    : null;
  if (derivedStateContext) {
    return `${derivedStateContext.message}${lexicalMessage}${checklistMessage}${formatStateAuditRisks(stateRisks)}`;
  }
  const stateMessage = stateAuditReason === "auto-keyed-promise-lifecycle"
    ? KEYED_PROMISE_AUDIT_MESSAGE
    : stateAuditReason === "auto-async-abort-lifecycle"
      ? ABORT_LIFECYCLE_AUDIT_MESSAGE
      : STATE_AUDIT_MESSAGE;
  return stateAudit
    ? `${auditMessage}${lexicalMessage}${checklistMessage}${stateMessage}${formatStateAuditRisks(stateRisks)}`
    : `${auditMessage}${lexicalMessage}${checklistMessage}`;
}

export function taskRequiresVisualAltAudit(task) {
  const source = String(task ?? "");
  return /\bview_image\b/i.test(source)
    && /\balt(?:\s+(?:text|description))?\b/i.test(source)
    && /\b(?:image|artwork|photo|illustration|graphic)\b/i.test(source);
}

/** Re-anchor the existing audit without duplicating the assignment or promising a panel. */
export function completionAuditReanchor(task, observation) {
  if (!String(observation ?? "").includes(COMPLETION_AUDIT_MARKER)) return "";
  const assignment = String(task ?? "");
  if (!assignment.trim()) return "";
  return "[completion-audit] POST-GREEN COMPLETION AUDIT: compare every explicit requirement in the original assignment with the current implementation and the verification actually performed. A passing supplied suite does not establish untested requirements. Use current source already visible; if the needed bytes are absent or stale, read_file the exact path and range. Resolve concrete gaps before done; do not infer correctness merely because a branch or comment names the requirement.";
}

/** Did the model substantively engage with the specialized audit after it fired? */
export function stateAuditEngagement(action, {
  duplicate = false,
  directEditSucceeded = false,
  observation = "",
} = {}) {
  if (!action || duplicate) return false;
  if (directEditSucceeded) return true;
  if (action.a === "read_file" || action.a === "search") return true;
  if (action.a === "inspect") {
    return Array.isArray(action.ops) && action.ops.some((op) => op?.a === "read_file" || op?.a === "search");
  }
  if (action.a === "shell") {
    // Models commonly pair a focused inline counterexample with the broad
    // verification command in one shell action. The passing suite verdict
    // must not hide the probe from the state audit; stateAuditProbePassed
    // independently rejects failed, duplicate, and unchanged broad commands.
    if (isInlineEvalProbe(action.c)) return true;
    return verificationVerdict({ action, observation }) === null;
  }
  return false;
}

/**
 * Did a shell action produce task-local state-machine evidence?
 *
 * This is deliberately stricter than `stateAuditEngagement`: reading source
 * is useful engagement, but only a successful inline counterexample or a
 * distinct focused test can discharge the audit. Ordinary shell commands and
 * another run of the command that triggered the audit are not proof.
 */
export function stateAuditProbePassed(action, {
  duplicate = false,
  blocked = null,
  observation = "",
  configuredVerification = null,
  triggerCommand = null,
  task = "",
} = {}) {
  if (action?.a !== "shell" || duplicate || blocked) return false;
  const command = normalizeCommand(action.c);
  if (!command) return false;
  if (sameCommand(command, configuredVerification) || sameCommand(command, triggerCommand)) {
    return false;
  }

  const output = String(observation ?? "");
  if (/^(?:ERROR:|\[blocked\])|timed out|output limit exceeded|\(interrupted\)/im.test(output)) {
    return false;
  }
  const exitMatches = [...output.matchAll(/^\s*exit\s+(-?\d+)\s*$/gim)];
  const exitedCleanly = exitMatches.length > 0
    && exitMatches.every((match) => Number(match[1]) === 0);
  if (!exitedCleanly) return false;

  if (isInlineEvalProbe(command)) {
    return hasSemanticAssertion(command) && probeCoversTaskObligations(command, task);
  }
  if (!isTestCommand(command)) return false;

  // A different broad suite is still broad evidence. Require a concrete test
  // file, test selector, or runner filter so this path represents the focused
  // lifecycle check requested by the audit.
  if (!isFocusedTestCommand(command)) return false;
  return verificationVerdict({ action, observation: output }) === "pass";
}

function hasSemanticAssertion(command) {
  const source = String(command ?? "");
  return /\bassert\s*(?:\.|\()/.test(source)
    || /(?:from|require\s*\()\s*["'](?:node:)?assert(?:\/strict)?["']/.test(source)
    || /\bif\s*\([^)]*\)\s*(?:\{[^}]*\bthrow\b|\bthrow\b)/s.test(source)
    || /process\.exit\s*\([^)]*\?\s*[01]\s*:\s*[01]/.test(source);
}

function probeCoversTaskObligations(command, task) {
  const assignment = String(task ?? "");
  const source = String(command ?? "");
  const requiresInvalidation = /\b(?:invalidate|clear|reset)\b/i.test(assignment)
    && /\b(?:older|old|stale|in[- ]flight|completion|fence)\b/i.test(assignment);
  if (requiresInvalidation && !/\binvalidate\s*\(/i.test(source)) return false;

  const requiresFreshSize = /\b(?:ttl|immediately stale|freshness)\b/i.test(assignment)
    && /\bsize\s*\(\s*\)/i.test(assignment);
  if (requiresFreshSize && (!/\bsize\s*\(/i.test(source) || !/ttlMs\s*:\s*0\b/i.test(source))) return false;

  const requiresAbort = /\b(?:AbortSignal|abort(?:ed|ing)?|signal\.reason)\b/i.test(assignment);
  const triggersNativeAbort = /\.abort\s*\(/i.test(source);
  const triggersRecordedSignal = /(?:\.aborted|\baborted)\s*=\s*true\b/i.test(source)
    && /addEventListener/i.test(source)
    && /removeEventListener/i.test(source);
  if (requiresAbort && !triggersNativeAbort && !triggersRecordedSignal) return false;
  if (requiresAbort && /remove (?:the )?abort listener/i.test(assignment)
      && !/removeEventListener/i.test(source)) return false;

  const requiresSyncWorkerThrow = /\bworker\b/i.test(assignment)
    && /\b(?:throw|synchronous)/i.test(assignment);
  if (requiresSyncWorkerThrow && !/\bthrow\b/.test(source)) return false;
  return true;
}

/**
 * Explain failures caused by the audit probe itself so the model does not
 * mutate correct production code to satisfy an invalid counterexample.
 */
export function stateAuditProbeDiagnostic(action, observation) {
  if (action?.a !== "shell" || !isInlineEvalProbe(action.c)) return "";
  const command = String(action.c ?? "");
  const output = String(observation ?? "");
  const tdz = /ReferenceError:\s*Cannot access ['"]([A-Za-z_$][\w$]*)['"] before initialization/i.exec(output);
  if (tdz && /\.run\s*\(/.test(command)) {
    const binding = tdz[1];
    return `\n[state-audit probe-invalid] This failure is in the probe, not evidence of a production defect: the task callback runs synchronously before the outer \`const ${binding} = subject.run(...)\` assignment completes, so reading \`${binding}\` inside that callback hits its temporal dead zone. Declare \`let nested\` outside; inside the callback only assign \`nested = subject.run(key, () => "must not run")\`; after the outer run returns, compare \`nested\` with \`${binding}\`. Do not edit production code to make an invalid probe pass.`;
  }
  const rejectedBindings = [...command.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[\s\S]{0,180}?\.run\s*\([\s\S]{0,240}?\bthrow\b/g)]
    .map((match) => match[1]);
  const awaitedAsValue = rejectedBindings.find((binding) => {
    const escaped = escapeRegExp(binding);
    return new RegExp(`\\bassert(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?\\s*\\(\\s*await\\s+${escaped}\\b`).test(command);
  });
  if (awaitedAsValue && /(?:^|\n)(?:Error|[A-Za-z_$][\w$]*(?:Error|Exception)):\s|\bERR_UNHANDLED_REJECTION\b/m.test(output)) {
    return `\n[state-audit probe-invalid] This failure is in the probe, not evidence that production must turn a rejection into a fulfillment: \`${awaitedAsValue}\` comes from a task that explicitly throws, so \`await ${awaitedAsValue}\` throws before the value assertion can run. Preserve rejection identity. Use \`await assert.rejects(${awaitedAsValue}, expectedReason)\` (or catch and compare the exact reason), then submit the key again and assert reuse behavior. Do not edit production code to make a rejected Promise fulfill.`;
  }
  if (/\bassert(?:\s*\.\s*|\[['"])(?:throws)(?:['"]\])?\s*\(/.test(command)
      && /AssertionError(?:\s*\[ERR_ASSERTION\])?:\s*Missing expected exception/i.test(output)) {
    return "\n[state-audit probe-invalid] `assert.throws` only observes exceptions thrown synchronously by the call expression. An `async` function converts a throw—even one before its first `await`—into a rejected Promise. Preserve the task's async API and rerun this check with `await assert.rejects(() => call(...), ExpectedError)`; do not remove `async` or edit production code solely to satisfy this invalid probe.";
  }
  if (/ReferenceError:\s*assert is not defined/i.test(output)) {
    return "\n[state-audit probe-invalid] This probe never reached the lifecycle assertion because `assert` is undefined. Import `node:assert/strict` in a module-mode inline probe, then rerun the same focused check; do not edit production code for this harness error.";
  }
  if (/SyntaxError:\s*Cannot use import statement outside a module/i.test(output)) {
    return "\n[state-audit probe-invalid] This probe never reached the lifecycle assertion because Node parsed the inline script as CommonJS. Run it with `node --input-type=module -e ...`; do not edit production code for this harness error.";
  }
  return "";
}

function normalizeCommand(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function sameCommand(command, candidate) {
  const other = normalizeCommand(candidate);
  return Boolean(other) && command === other;
}

function isFocusedTestCommand(command) {
  return /(?:^|\s)(?:\.{0,2}\/)?(?:test|tests|spec|specs|src)\/[^\s"'*?[\]]+\.(?:[cm]?[jt]sx?|py|rb|go|rs)\b/i.test(command)
    || /(?:^|\s)(?:-t|--test-name-pattern|--grep|-k|::)\b/i.test(command);
}
