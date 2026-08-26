// Proof-backed search-strategy repetition station.
//
// Search commands often look different while exercising the same underlying
// search domain: a longer timeout, another fork count, or narrower length
// bounds do not make a second `john --incremental=alpha` attempt a new idea.
// Normalize that stable semantic axis, retain executed failure evidence from
// prior turns, and let Datalog prove when two failures already cover the next
// proposal. The station starts deliberately narrow: only explicit John the
// Ripper incremental modes are classified, so unrelated shell work cannot be
// stopped by a fuzzy command similarity heuristic.

import path from "node:path";

import { Datalog } from "./datalog.js";

export const SEARCH_STRATEGY_MARKER = "BANTAM_SEARCH_STRATEGY_V1";
export const SEARCH_STRATEGY_FAILURE_THRESHOLD = 2;

const SHELL_BOUNDARIES = new Set([";", "&&", "||", "|", "&", "(", ")", "\n"]);
const WRAPPER_COMMANDS = new Set(["command", "env", "nice", "nohup", "stdbuf", "sudo", "time", "timeout"]);
const SAFE_DOMAIN_RE = /^[a-z0-9][a-z0-9_.+-]{0,63}$/;
const NON_EXECUTION_RE = /^\s*(?:ERROR:|\[(?:artifact verification|budget|investigation budget reached|progress-awareness|query-budget|repetition|search-strategy|source-provenance)\b)/i;
const TIMEOUT_RE = /\b(?:timed\s*out|timeout\s+(?:after|expired|reached)|deadline exceeded)\b/i;
const INVALID_CONFIGURATION_RE = /\bunknown incremental mode\b|\binvalid (?:option|incremental mode|(?:--)?fork(?: range| value)?)\b|\b(?:fork|--fork)\b[^\n]{0,80}\b(?:invalid|out of range|must be|requires?)\b/i;
const SESSION_ABORTED_RE = /\bsession aborted\b/i;
const NO_CANDIDATE_RES = Object.freeze([
  /(?:^|\s)0g(?:\s|$)/m,
  /\b0\s+password hashes?\s+(?:cracked|recovered)\b/i,
  /\bloaded\s+0\s+password hashes?\b/i,
  /\bno\s+(?:password(?: hashes?)?|candidates?|hashes?)\s+(?:were\s+)?(?:cracked|recovered|found|loaded)\b/i,
  /\bno password hashes left to crack\b/i,
]);

/**
 * Classify one shell action by its stable search axis.
 *
 * For John incremental searches the domain is the mode name before any
 * optional length suffix. Timeout wrappers, `--fork`, and min/max length flags
 * are intentionally absent from the result. Ambiguous commands that launch
 * more than one explicit domain are left unclassified rather than guessed.
 */
export function classifySearchStrategyAction(action) {
  if (action?.a !== "shell" || typeof action.c !== "string" || !action.c.trim()) return null;

  const invocations = johnInvocations(action.c);
  if (invocations.length === 0) return null;

  const domains = new Set();
  let sawIncremental = false;
  let sawShow = false;
  for (const invocation of invocations) {
    const parsed = incrementalDomain(invocation.args);
    if (parsed.present) {
      sawIncremental = true;
      if (!parsed.domain) return null;
      domains.add(parsed.domain);
    }
    if (invocation.args.some((arg) => /^--show(?:=.*)?$/i.test(cleanToken(arg)))) sawShow = true;
  }

  if (sawIncremental) {
    if (domains.size !== 1) return null;
    const [domain] = domains;
    return Object.freeze({
      family: "john-incremental",
      domain,
      operation: "search",
      normalized: `john:incremental:${domain}`,
    });
  }

  if (sawShow) {
    return Object.freeze({
      family: "john",
      domain: "show",
      operation: "inspect",
      normalized: "john:show",
    });
  }

  return null;
}

/**
 * Evaluate a proposed action against prior executed turns.
 *
 * Returns an integration-ready decision object. Callers that only need the
 * execution gate can use `searchStrategyGateRejection` below; observability
 * surfaces can retain `proof` and `failures` to explain the decision.
 */
export function evaluateSearchStrategyProposal(action, { turns = [] } = {}) {
  const strategy = classifySearchStrategyAction(action);
  if (!strategy) return decision({ applicable: false });

  if (strategy.operation === "inspect") {
    const db = new Datalog({ provenance: true });
    db.fact("inspection_proposal", strategy.family, strategy.domain, compactCommand(action.c));
    db.rule("allowed_strategy(F, D) :- inspection_proposal(F, D, C)");
    db.run();
    return decision({
      applicable: true,
      strategy,
      proof: db.explain("allowed_strategy", strategy.family, strategy.domain),
    });
  }

  const failedAttempts = collectFailedAttempts(turns);
  const sameDomainFailures = failedAttempts.filter((attempt) => (
    attempt.strategy.family === strategy.family && attempt.strategy.domain === strategy.domain
  ));
  const db = buildSearchStrategyDb(strategy, action.c, failedAttempts);
  const rejected = db.has("reject_strategy", strategy.family, strategy.domain);

  if (!rejected) {
    return decision({ applicable: true, strategy, failures: sameDomainFailures });
  }

  const evidence = sameDomainFailures
    .slice(0, 4)
    .map((attempt) => `${attempt.turnId} (${attempt.reason})`)
    .join(", ");
  const rejection = `[search-strategy] ${SEARCH_STRATEGY_MARKER} Datalog rejected this action before execution: John incremental domain \`${strategy.domain}\` already has at least ${SEARCH_STRATEGY_FAILURE_THRESHOLD} failed executed attempts (${evidence}). Changing timeout, \`--fork\`, or length bounds does not change that normalized search domain. Run \`john --show\` to inspect candidates already recovered, enumerate configured incremental modes with \`john --list=inc-modes\`, or change a real search axis (a different mode/domain, wordlist, rules, or mask) before another expensive attempt.`;
  return decision({
    applicable: true,
    rejected: true,
    rejection,
    strategy,
    failures: sameDomainFailures,
    proof: db.explain("reject_strategy", strategy.family, strategy.domain),
  });
}

/** Simple adapter for agent execution gates. */
export function searchStrategyGateRejection(action, options = {}) {
  return evaluateSearchStrategyProposal(action, options).rejection;
}

function buildSearchStrategyDb(strategy, command, failedAttempts) {
  const db = new Datalog({ provenance: true });
  db.fact("proposed_strategy", strategy.family, strategy.domain, compactCommand(command));
  for (const attempt of failedAttempts) {
    db.fact(
      "strategy_attempt",
      attempt.turnId,
      attempt.strategy.family,
      attempt.strategy.domain,
      compactCommand(attempt.command),
    );
    db.fact("failed_outcome", attempt.turnId, attempt.reason);
  }
  for (let i = 0; i < failedAttempts.length; i++) {
    for (let j = i + 1; j < failedAttempts.length; j++) {
      db.fact("earlier_attempt", failedAttempts[i].turnId, failedAttempts[j].turnId);
    }
  }
  db.rule("failed_strategy(T, F, D) :- strategy_attempt(T, F, D, C), failed_outcome(T, O)");
  db.rule("exhausted_strategy(F, D) :- proposed_strategy(F, D, C), failed_strategy(A, F, D), failed_strategy(B, F, D), earlier_attempt(A, B)");
  db.rule("reject_strategy(F, D) :- exhausted_strategy(F, D)");
  db.run();
  return db;
}

function collectFailedAttempts(turns) {
  const failed = [];
  for (const [index, turn] of Array.from(turns ?? []).entries()) {
    const action = turn?.action ?? turn?.parsedAction;
    const strategy = classifySearchStrategyAction(action);
    if (!strategy || strategy.operation !== "search") continue;
    const reason = failedOutcome(turn);
    if (!reason) continue;
    failed.push(Object.freeze({
      turn: index + 1,
      turnId: `turn:${index + 1}`,
      reason,
      command: action.c,
      strategy,
    }));
  }
  return failed;
}

function failedOutcome(turn) {
  if (turn?.executed === false || turn?.shellExecuted === false) return null;
  const delivered = String(turn?.observation ?? "");
  if (!delivered.trim() || NON_EXECUTION_RE.test(delivered)) return null;
  const observation = String(turn?.rawObservation ?? delivered);
  const action = turn?.action ?? turn?.parsedAction;

  const exitMatches = [...observation.matchAll(/(?:^|\n)exit\s+(-?\d+)\s*(?=\n|$)/g)];
  const nonZeroExit = exitMatches.map((match) => Number(match[1])).find((code) => code !== 0);
  if (nonZeroExit === 124 || TIMEOUT_RE.test(observation)) return "timeout";
  if (nonZeroExit !== undefined) return `nonzero-exit:${nonZeroExit}`;
  // `... 2>&1 | tail` reports tail's zero even when John rejected its mode or
  // fork configuration. The semantic diagnostic is the outcome in that case.
  if (INVALID_CONFIGURATION_RE.test(observation)) return "invalid-configuration";
  // John prints this when an externally timed search is interrupted, while a
  // trailing pipeline can again hide the timeout status. It is a failed search
  // either way; retain the more useful timeout reason when the command says so.
  if (SESSION_ABORTED_RE.test(observation)) {
    return commandUsesTimeoutWrapper(action?.c) ? "timeout" : "aborted";
  }
  if (NO_CANDIDATE_RES.some((pattern) => pattern.test(observation))) return "no-candidate";
  if (/(?:^|\n)\s*(?:error|fatal):|\b(?:segmentation fault|traceback)\b/i.test(observation)) return "failed";
  return null;
}

function commandUsesTimeoutWrapper(command) {
  return shellSegments(command).some((segment) => segment.some((token) => executableName(token) === "timeout"));
}

function incrementalDomain(args) {
  const found = [];
  for (const arg of args) {
    const token = cleanToken(arg);
    const match = /^--incremental(?:=(.*))?$/i.exec(token) ?? /^-i(?:=(.*))?$/i.exec(token);
    if (!match) continue;
    const raw = match[1] === undefined || match[1] === "" ? "default" : match[1];
    const domain = raw.split(":", 1)[0].trim().toLowerCase();
    if (!SAFE_DOMAIN_RE.test(domain)) return { present: true, domain: null };
    found.push(domain);
  }
  if (found.length === 0) return { present: false, domain: null };
  const unique = [...new Set(found)];
  return { present: true, domain: unique.length === 1 ? unique[0] : null };
}

function johnInvocations(command) {
  const invocations = [];
  for (const segment of shellSegments(command)) {
    for (let index = 0; index < segment.length; index++) {
      if (executableName(segment[index]) !== "john") continue;
      if (!validInvocationPrefix(segment.slice(0, index))) continue;
      invocations.push({ args: segment.slice(index + 1) });
      break;
    }
  }
  return invocations;
}

function shellSegments(command) {
  const tokens = String(command).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||[;|&()\n]|[^\s;&|()]+/g) ?? [];
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (SHELL_BOUNDARIES.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function validInvocationPrefix(tokens) {
  if (tokens.length === 0) return true;
  return tokens.every((raw) => {
    const token = cleanToken(raw);
    const executable = executableName(token);
    return WRAPPER_COMMANDS.has(executable)
      || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
      || token === "--"
      || token.startsWith("-")
      || /^\d+(?:\.\d+)?(?:ms|[smhd])?$/i.test(token)
      || /^(?:HUP|INT|QUIT|KILL|TERM|USR[12]|STOP|CONT)$/i.test(token);
  });
}

function executableName(token) {
  const cleaned = cleanToken(token).replace(/\\/g, "/");
  return path.posix.basename(cleaned).toLowerCase();
}

function cleanToken(token) {
  const value = String(token ?? "");
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function compactCommand(command) {
  const text = String(command ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

function decision({
  applicable,
  rejected = false,
  rejection = null,
  strategy = null,
  failures = [],
  proof = null,
}) {
  return Object.freeze({
    marker: SEARCH_STRATEGY_MARKER,
    applicable: Boolean(applicable),
    rejected: Boolean(rejected),
    rejection,
    strategy,
    failures: Object.freeze([...failures]),
    proof,
  });
}
