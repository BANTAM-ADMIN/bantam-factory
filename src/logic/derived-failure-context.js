// Compile a repeated verifier failure into a small, task-specific context card.
//
// The model does not need another copy of the entire trajectory. The harness
// already knows two high-value facts at this point: the task contract and that
// an edit failed to move a stable verifier fingerprint. Assert those signals
// into Datalog, derive only applicable lifecycle obligations, and inject the
// resulting card once at the decision point where the prior hypothesis failed.

import { Datalog } from "./datalog.js";

const DERIVED_CONTEXT_MARKER = "[derived-context]";
const DERIVED_COMPLETION_MARKER = "[derived-completion-context]";

const REMEDIES = Object.freeze({
  async_callback_boundary:
    "Invoke the user callback inside the Promise chain (for example `Promise.resolve().then(() => loader())`), so a synchronous throw becomes an asynchronous rejection.",
  promised_validation:
    "Keep validation on the promised API path: invalid input must produce a rejected Promise, not throw before `get()` returns.",
  identity_fence:
    "Represent each in-flight load with a unique entry object; settlement may write or delete only while `entries.get(key) === entry`, so invalidation fences stale completion.",
  ttl_from_resolution:
    "Record freshness time when the loader resolves, not when it starts; treat `ttlMs === 0` as immediately stale.",
  shared_freshness_predicate:
    "Store each settled entry's own TTL and use one freshness predicate in every public consumer of fresh state, including both `get()` and `size()`; `ttlMs === 0` must never be reused or counted.",
  abort_before_drain:
    "Exercise abort while workers are still pending: abort before awaiting the batch, then assert no new worker starts and every already-started worker settles normally.",
  listener_identity:
    "Store the exact abort-listener function and assert that the same function is removed before the returned Promise resolves.",
  worker_sync_throw:
    "Invoke each worker through a Promise boundary so a synchronous throw becomes that item's rejected result instead of rejecting the whole batch.",
});

/**
 * Return one proof-backed context card for a repeated failure, or null when the
 * task has no supported high-confidence lifecycle shape.
 */
export function deriveRepeatedFailureContext({
  task = "",
  fingerprint = "",
  occurrence = 0,
  stateAuditReason = null,
} = {}) {
  if (Number(occurrence) < 2 || !String(fingerprint).trim()) return null;

  const text = String(task);
  const db = new Datalog({ provenance: true });
  db.fact("repeated_failure", "run");
  signal(db, text, "promise_api", /\b(?:always returns? a Promise|returns? a Promise|Promise-returning|async(?:hronous)? API)\b/i);
  signal(db, text, "user_callback", /\b(?:loader|worker|callback|user (?:code|function)|task function)\b/i);
  signal(db, text, "validation", /\b(?:validat(?:e|ion)|requires? a|must be an?|invalid input)\b/i);
  signal(db, text, "keyed_cache", /\b(?:cache|same key|same-key|per-key|keyed|invalidate)\b/i);
  signal(db, text, "invalidation", /\b(?:invalidate|clear|reset|fence off|stale completion|older in-flight)\b/i);
  signal(db, text, "ttl", /\b(?:ttl|expir(?:e|y|ed)|freshness|fresh settled)\b/i);
  signal(db, text, "abort", /\b(?:AbortSignal|abort(?:ed|ing)?|signal\.reason|abort listener)\b/i);
  signal(db, text, "ordered_batch", /\b(?:one result per input|input order|batch)\b/i);
  if (stateAuditReason) db.fact("audit_reason", "run", String(stateAuditReason));

  db.rule("remedy(R, async_callback_boundary) :- repeated_failure(R), task_signal(R, promise_api), task_signal(R, user_callback)");
  db.rule("remedy(R, promised_validation) :- repeated_failure(R), task_signal(R, promise_api), task_signal(R, validation)");
  db.rule("remedy(R, identity_fence) :- repeated_failure(R), task_signal(R, keyed_cache), task_signal(R, invalidation)");
  db.rule("remedy(R, ttl_from_resolution) :- repeated_failure(R), task_signal(R, keyed_cache), task_signal(R, ttl)");
  db.rule("remedy(R, abort_before_drain) :- repeated_failure(R), task_signal(R, abort), task_signal(R, ordered_batch)");
  db.rule("remedy(R, listener_identity) :- repeated_failure(R), task_signal(R, abort), task_signal(R, ordered_batch)");
  db.rule("remedy(R, worker_sync_throw) :- repeated_failure(R), task_signal(R, user_callback), task_signal(R, ordered_batch)");
  db.run();

  const remedyIds = db.query("remedy", "run", "?").map((row) => row[1]);
  if (remedyIds.length === 0) return null;
  const selected = selectRemedies(remedyIds, stateAuditReason);
  const proofs = selected.map((id) => db.explain("remedy", "run", id));
  const lines = selected.map((id) => `- ${REMEDIES[id]}`);
  const message = [
    "",
    `${DERIVED_CONTEXT_MARKER} Datalog result: the same verifier outcome survived an edit, so the prior hypothesis is falsified. Apply these task-derived obligations before another edit:`,
    ...lines,
    "Run one assertion-bearing probe that distinguishes these obligations; printed values or an exit-zero script without assertions are not proof.",
  ].join("\n");
  return Object.freeze({
    marker: DERIVED_CONTEXT_MARKER,
    remedies: Object.freeze([...selected]),
    message,
    proofs: Object.freeze(proofs),
  });
}

/**
 * Compile task obligations at the first-green boundary. This catches semantic
 * propagation gaps that visible tests often miss (for example, `get()` and
 * `size()` disagreeing about what "fresh" means) before the model lands.
 */
export function deriveCompletionContext({ task = "", stateAuditReason = null, verified = "Tests are green." } = {}) {
  const text = String(task);
  const db = new Datalog({ provenance: true });
  db.fact("completion_boundary", "run");
  signal(db, text, "promise_api", /\b(?:always returns? a Promise|returns? a Promise|Promise-returning|async(?:hronous)? API)\b/i);
  signal(db, text, "user_callback", /\b(?:loader|worker|callback|user (?:code|function)|task function)\b/i);
  signal(db, text, "validation", /\b(?:validat(?:e|ion)|requires? a|must be an?|invalid input)\b/i);
  signal(db, text, "keyed_cache", /\b(?:cache|same key|same-key|per-key|keyed|invalidate)\b/i);
  signal(db, text, "invalidation", /\b(?:invalidate|clear|reset|fence off|stale completion|older in-flight)\b/i);
  signal(db, text, "ttl", /\b(?:ttl|expir(?:e|y|ed)|freshness|fresh settled)\b/i);
  signal(db, text, "size_api", /\bsize\s*\(\s*\)[\s\S]{0,100}\bfresh|\bfresh[\s\S]{0,100}\bsize\s*\(\s*\)/i);
  signal(db, text, "abort", /\b(?:AbortSignal|abort(?:ed|ing)?|signal\.reason|abort listener)\b/i);
  signal(db, text, "ordered_batch", /\b(?:one result per input|input order|batch)\b/i);
  if (stateAuditReason) db.fact("audit_reason", "run", String(stateAuditReason));

  db.rule("completion_remedy(R, async_callback_boundary) :- completion_boundary(R), task_signal(R, promise_api), task_signal(R, user_callback)");
  db.rule("completion_remedy(R, promised_validation) :- completion_boundary(R), task_signal(R, promise_api), task_signal(R, validation)");
  db.rule("completion_remedy(R, identity_fence) :- completion_boundary(R), task_signal(R, keyed_cache), task_signal(R, invalidation)");
  db.rule("completion_remedy(R, shared_freshness_predicate) :- completion_boundary(R), task_signal(R, keyed_cache), task_signal(R, ttl), task_signal(R, size_api)");
  db.rule("completion_remedy(R, abort_before_drain) :- completion_boundary(R), task_signal(R, abort), task_signal(R, ordered_batch)");
  db.rule("completion_remedy(R, listener_identity) :- completion_boundary(R), task_signal(R, abort), task_signal(R, ordered_batch)");
  db.rule("completion_remedy(R, worker_sync_throw) :- completion_boundary(R), task_signal(R, user_callback), task_signal(R, ordered_batch)");
  db.run();

  const ids = db.query("completion_remedy", "run", "?").map((row) => row[1]);
  if (ids.length === 0) return null;
  const selected = selectCompletionRemedies(ids, stateAuditReason);
  if (selected.length === 0) return null;
  const proofs = selected.map((id) => db.explain("completion_remedy", "run", id));
  const lines = selected.map((id) => `- ${REMEDIES[id]}`);
  const probes = [];
  if (selected.includes("shared_freshness_predicate")) {
    probes.push("use a fixed `now`, await `get(key, loader, { ttlMs: 0 })`, then assert `size() === 0`; advance time around a positive TTL and assert `get()` and `size()` cross the freshness boundary together");
  }
  if (selected.includes("identity_fence")) {
    probes.push("start deferred old and replacement loads around `invalidate(key)` and exercise both settlement orders: replacement-then-old and old-then-replacement; after each, assert a subsequent `get()` still returns the replacement without invoking another loader");
  }
  if (selected.includes("async_callback_boundary")) {
    probes.push("capture the Promise returned by a synchronously throwing callback, use `await assert.rejects(first, expectedReason)` (never compare `await first` to a value), then assert a later valid call succeeds");
  }
  if (selected.includes("abort_before_drain")) {
    probes.push("use `node --input-type=module -e` directly (no heredoc or temporary file); import `assert` from `node:assert/strict` and use throwing `assert.*` calls (never `console.assert`, which can log and still exit zero); use a plain AbortSignal-like object (do not monkey-patch a native AbortSignal): `addEventListener` stores the listener, `removeEventListener` records its argument; start the batch into `const pending` with every started worker blocked, `await Promise.resolve()` until the concurrency-limited prefix has actually entered the worker, then set `aborted` and `reason` and invoke the stored listener before awaiting `pending`; release started workers, await `pending`, and assert no later index started and the removed listener is the exact stored function");
  }
  const probe = probes.length
    ? `Required focused probe obligations:\n${probes.map((item) => `- ${item}`).join("\n")}.`
    : "Run one assertion-bearing focused probe over the derived ownership and settlement timeline.";
  return Object.freeze({
    marker: DERIVED_COMPLETION_MARKER,
    remedies: Object.freeze([...selected]),
    proofs: Object.freeze(proofs),
    message: [
      "",
      `[completion-audit] [state-audit] ${DERIVED_COMPLETION_MARKER} ${verified} Datalog derived the remaining cross-path obligations below. Audit only these task-grounded semantics:`,
      ...lines,
      probe,
      "Do not reread unchanged source or rerun the unchanged broad suite in place of this probe. Fix a failed assertion, rerun verification, then finish.",
    ].join("\n"),
  });
}

function signal(db, text, name, pattern) {
  if (pattern.test(text)) db.fact("task_signal", "run", name);
}

function selectRemedies(ids, reason) {
  const unique = [...new Set(ids)];
  if (reason === "auto-async-abort-lifecycle") {
    return unique.filter((id) => ["abort_before_drain", "listener_identity", "worker_sync_throw"].includes(id));
  }
  if (reason === "auto-keyed-promise-lifecycle") {
    return unique.filter((id) => ["async_callback_boundary", "promised_validation", "identity_fence", "ttl_from_resolution"].includes(id));
  }
  return unique.slice(0, 4);
}

function selectCompletionRemedies(ids, reason) {
  const unique = [...new Set(ids)];
  if (reason === "auto-async-abort-lifecycle") {
    return unique.filter((id) => ["abort_before_drain", "listener_identity", "worker_sync_throw"].includes(id));
  }
  if (reason === "auto-keyed-promise-lifecycle") {
    return unique.filter((id) => ["async_callback_boundary", "promised_validation", "identity_fence", "shared_freshness_predicate"].includes(id));
  }
  return unique.slice(0, 4);
}

export { DERIVED_COMPLETION_MARKER, DERIVED_CONTEXT_MARKER };
