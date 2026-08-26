import assert from "node:assert/strict";
import test from "node:test";

import {
  DERIVED_CONTEXT_MARKER,
  DERIVED_COMPLETION_MARKER,
  deriveCompletionContext,
  deriveRepeatedFailureContext,
} from "../src/logic/derived-failure-context.js";

const refreshTask = "Implement a keyed cache. get always returns a Promise. Validate key and loader. Concurrent misses for the same key return the same Promise. Loader throws reject asynchronously. TTL begins when the loader resolves. invalidate fences an older in-flight stale completion.";

test("Datalog compiles a repeated keyed-cache failure into bounded lifecycle context", () => {
  const result = deriveRepeatedFailureContext({
    task: refreshTask,
    fingerprint: "not ok - evicts failed loads\nError: boom",
    occurrence: 2,
    stateAuditReason: "auto-keyed-promise-lifecycle",
  });

  assert.ok(result);
  assert.equal(result.marker, DERIVED_CONTEXT_MARKER);
  assert.deepEqual(result.remedies, [
    "async_callback_boundary",
    "promised_validation",
    "identity_fence",
    "ttl_from_resolution",
  ]);
  assert.match(result.message, /Promise\.resolve\(\)\.then/);
  assert.match(result.message, /entries\.get\(key\) === entry/);
  assert.match(result.message, /assertion-bearing probe/);
  assert.equal(result.proofs.length, 4);
  assert.ok(result.proofs.every((proof) => /task_signal/.test(JSON.stringify(proof))));
});

test("Datalog carries keyed freshness semantics across get and size at completion", () => {
  const result = deriveCompletionContext({
    task: refreshTask.replace("TTL begins", "size() returns only fresh settled entries. TTL zero is immediately stale. TTL begins"),
    stateAuditReason: "auto-keyed-promise-lifecycle",
  });

  assert.equal(result.marker, DERIVED_COMPLETION_MARKER);
  assert.ok(result.remedies.includes("shared_freshness_predicate"));
  assert.match(result.message, /Store each settled entry's own TTL/);
  assert.match(result.message, /assert `size\(\) === 0`/);
  assert.match(result.message, /get\(\).*size\(\).*freshness boundary/);
  assert.match(result.message, /both settlement orders/);
  assert.ok(result.proofs.some((proof) => /size_api/.test(JSON.stringify(proof))));
});

test("Datalog selects abort lifecycle context instead of keyed-cache advice", () => {
  const result = deriveRepeatedFailureContext({
    task: "Run an abortable batch with one result per input. Each worker may throw. Stop starting work when the AbortSignal aborts and remove the abort listener before resolving.",
    fingerprint: "not ok - removes listener",
    occurrence: 2,
    stateAuditReason: "auto-async-abort-lifecycle",
  });

  assert.deepEqual(result.remedies, [
    "abort_before_drain",
    "listener_identity",
    "worker_sync_throw",
  ]);
  assert.doesNotMatch(result.message, /entries\.get\(key\)/);
  assert.match(result.message, /abort before awaiting the batch/i);
});

test("Datalog completion context supplies non-recursive abort instrumentation", () => {
  const result = deriveCompletionContext({
    task: "Run an abortable batch with one result per input. Each worker may throw. Stop starting work when the AbortSignal aborts and remove the abort listener before resolving.",
    stateAuditReason: "auto-async-abort-lifecycle",
  });
  assert.match(result.message, /plain AbortSignal-like object/);
  assert.match(result.message, /do not monkey-patch a native AbortSignal/);
  assert.match(result.message, /invoke the stored listener before awaiting `pending`/);
  assert.match(result.message, /never `console\.assert`/);
  assert.match(result.message, /await Promise\.resolve\(\).*prefix has actually entered/s);
});

test("derived context stays silent before a repeated failure and for unrelated tasks", () => {
  assert.equal(deriveRepeatedFailureContext({
    task: refreshTask,
    fingerprint: "Error: boom",
    occurrence: 1,
  }), null);
  assert.equal(deriveRepeatedFailureContext({
    task: "Rename the heading in README.md",
    fingerprint: "not ok - heading",
    occurrence: 2,
  }), null);
});
