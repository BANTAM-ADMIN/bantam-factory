import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import {
  CONTRACT_LOGIC_MARKER,
  formatLifecycleContractViolations,
  lifecycleContractViolations,
} from "../src/logic/lifecycle-contract-logic.js";

const task = "get always returns a Promise. Loader throws reject asynchronously. TTL zero is immediately stale and size() returns only fresh settled entries.";

test("Datalog joins task obligations to eager callback and split-freshness source patterns", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-logic-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
export function cache(loader) {
  const promise = Promise.resolve(loader());
  return { promise, size() { return entries.size; } };
}
`);

  const violations = lifecycleContractViolations({ task, workspace, paths: ["src/cache.js"] });
  assert.deepEqual(violations.map((entry) => entry.kind).sort(), ["eager_callback", "split_freshness"]);
  assert.ok(violations.every((entry) => entry.path === "src/cache.js" && entry.line > 0));
  assert.ok(violations.every((entry) => /task_obligation/.test(JSON.stringify(entry.proof))));
  const message = formatLifecycleContractViolations(violations);
  assert.ok(message.includes(CONTRACT_LOGIC_MARKER));
  assert.match(message, /Promise\.resolve\(\)\.then/);
  assert.match(message, /same freshness test/);
});

test("contract logic stays silent for compliant bytes and unrelated tasks", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-logic-clean-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
export function cache(loader) {
  const promise = Promise.resolve().then(() => loader());
  return { promise, size() { return entries.filter((entry) => fresh(entry.ttlMs)).length; } };
}
`);
  assert.deepEqual(lifecycleContractViolations({ task, workspace, paths: ["src/cache.js"] }), []);
  assert.deepEqual(lifecycleContractViolations({ task: "Rename a README heading", workspace, paths: ["src/cache.js"] }), []);
});

test("Datalog requires exact entry ownership before stale settlement writes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-identity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "const entries = new Map();\nfunction load(key, promise) { entries.set(key, promise); return promise.then((value) => { entries.set(key, value); }); }\n");
  const identityTask = "invalidate(key) fences an older in-flight stale completion so it cannot repopulate the cache.";
  const violations = lifecycleContractViolations({ task: identityTask, workspace, paths: ["src/cache.js"] });
  assert.deepEqual(violations.map((entry) => entry.kind), ["stale_completion_write"]);
  assert.match(violations[0].message, /entries\.get\(key\) === entry/);

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "const entries = new Map();\nfunction load(key, entry) { entries.set(key, entry); return entry.promise.then((value) => { if (entries.get(key) === entry) entries.set(key, value); }); }\n");
  assert.deepEqual(lifecycleContractViolations({ task: identityTask, workspace, paths: ["src/cache.js"] }), []);

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "const entries = new Map();\nfunction load(key, generation) { return work().then((value) => { if (entries.get(key)?.generation !== generation) return value; entries.set(key, value); }); }\n");
  assert.deepEqual(lifecycleContractViolations({ task: identityTask, workspace, paths: ["src/cache.js"] }), []);

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `const entries = new Map();
function load(key, generation) { return work().then((value) => {
  const current = entries.get(key);
  if (current && current.generation === generation) entries.set(key, value);
  entries.delete(key);
}); }
`);
  const unsafeCleanup = lifecycleContractViolations({ task: identityTask, workspace, paths: ["src/cache.js"] });
  assert.deepEqual(unsafeCleanup.map((entry) => entry.kind), ["stale_completion_write"]);
  assert.equal(unsafeCleanup[0].line, 5);
  assert.match(unsafeCleanup[0].message, /mismatch branch must return or throw without touching/);
});

test("Datalog catches direct callback invocation and synchronous promised validation", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-direct-call-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
function validateKey(key) { if (!key) throw new TypeError("key"); }
export function cache() {
  return { get(key, loader, { ttlMs }) { validateKey(key); const loaderResult = loader(); return Promise.resolve(loaderResult); } };
}
`);
  const violations = lifecycleContractViolations({
    task: "get always returns a Promise. Validate key and loader. Loader throws must reject asynchronously.",
    workspace,
    paths: ["src/cache.js"],
  });
  assert.deepEqual(violations.map((entry) => entry.kind).sort(), ["eager_callback", "synchronous_validation"]);
  assert.match(formatLifecycleContractViolations(violations), /move validation inside the Promise chain/);
});

test("contract logic recognizes deferred and caught Promise boundaries", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-boundary-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  const boundaryTask = "get always returns a Promise. Validate the key. Loader throws reject asynchronously.";

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
function validateKey(key) { if (!key) throw new TypeError("key"); }
export function cache() {
  return { get(key, loader, { ttlMs }) { return Promise.resolve().then(async () => { validateKey(key); const value = await loader(); return value; }); } };
}
`);
  assert.deepEqual(lifecycleContractViolations({ task: boundaryTask, workspace, paths: ["src/cache.js"] }), []);

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
function validateKey(key) { if (!key) throw new TypeError("key"); }
export function cache() {
  return { get(key, loader, { ttlMs }) { try { validateKey(key); const value = loader(); return Promise.resolve(value); } catch (error) { return Promise.reject(error); } } };
}
`);
  assert.deepEqual(lifecycleContractViolations({ task: boundaryTask, workspace, paths: ["src/cache.js"] }), []);

  fs.writeFileSync(path.join(workspace, "src", "cache.js"), `
export function cache() {
  return { get(key, loader) { return loader().then((value) => value); } };
}
`);
  assert.deepEqual(lifecycleContractViolations({ task: boundaryTask, workspace, paths: ["src/cache.js"] }).map((entry) => entry.kind), ["eager_callback"]);
});

test("Datalog rejects async entrypoints when coalescing requires exact Promise identity", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-async-identity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "export function cache() { return { async get(key) { return pending.get(key); } }; }\n");
  const violations = lifecycleContractViolations({
    task: "Concurrent misses for the same key must return the exact same Promise object.",
    workspace,
    paths: ["src/cache.js"],
  });
  assert.deepEqual(violations.map((entry) => entry.kind), ["wrapped_promise_identity"]);
  assert.match(violations[0].message, /Keep `get\(\)` non-async/);
});

test("runAgent places contract logic on the edit observation", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-agent-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "// TODO\n");
  const content = "export function cache(loader) { const p = Promise.resolve(loader()); return { p, size() { return entries.size; } }; }\n";
  const model = {
    assistantPrefill: "",
    async complete() {
      return { content: JSON.stringify({ a: "write_file", p: "src/cache.js", content }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };

  const result = await runAgent({
    task,
    workspace,
    model,
    maxTurns: 1,
    thinkMode: "off",
    useGrammar: false,
    preGate: false,
    grounding: false,
    completionAudit: false,
    progressAwareness: false,
    regressionGuard: false,
    autoVerifyBlindEdits: 0,
    autoVerifyProbes: 0,
    autoVerifyStaleTurns: 0,
  });

  assert.equal(result.metrics.lifecycleContractHints, 1);
  assert.ok(result.turns[0].observation.includes(CONTRACT_LOGIC_MARKER));
  assert.match(result.turns[0].observation, /current edited bytes/);
});

test("runAgent rejects done while edited bytes retain a lifecycle contradiction", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-done-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "// TODO\n");
  const responses = [
    { a: "write_file", p: "src/cache.js", content: "export function cache(loader) { return Promise.resolve(loader()); }\n" },
    { a: "done", summary: "implemented" },
  ];
  const prompts = [];
  const model = {
    assistantPrefill: "",
    async complete(prompt) {
      prompts.push(prompt);
      return { content: JSON.stringify(responses.shift()), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };

  const result = await runAgent({
    task: "Implement a Promise-returning loader API. Loader throws must reject asynchronously.",
    workspace,
    model,
    maxTurns: 2,
    thinkMode: "off",
    useGrammar: false,
    preGate: false,
    grounding: false,
    completionAudit: false,
    stateAudit: "off",
    progressAwareness: false,
    regressionGuard: false,
    autoVerifyBlindEdits: 0,
    autoVerifyProbes: 0,
    autoVerifyStaleTurns: 0,
  });

  assert.equal(result.reachedDone, false);
  assert.equal(result.metrics.lifecycleContractDoneRejections, 1);
  assert.match(result.turns[1].observation, /\[contract-logic-done\]/);
  assert.match(prompts[1], /LIFECYCLE CONTRACT BLOCKER/);
  assert.match(prompts[1], /next action must edit/);
});

test("detects keyed Promise publication after a member task can run", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-member-task-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "pool.js"), `export class Pool {
  run(key, task) {
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ key, task, resolve, reject });
      this._execute();
    });
    this.active.set(key, promise);
    return promise;
  }
  _execute(entry) {
    (async () => {
      try {
        const value = await entry.task();
        entry.resolve(value);
      } catch (error) {
        entry.reject(error);
      } finally {
        this._done(entry.key);
      }
    })();
  }
}\n`);

  const violations = lifecycleContractViolations({
    task: "run coalesces a keyed task by returning the exact same Promise; synchronous task throws reject through that Promise.",
    workspace,
    paths: ["src/pool.js"],
  });

  const violation = violations.find((entry) => entry.kind === "late_promise_publication");
  assert.ok(violation);
  assert.match(violation.message, /published after the dispatcher/);
  assert.match(violation.message, /Use exactly one Promise/);
  assert.match(violation.message, /let resolve, reject/);
  assert.match(violation.message, /do not create a second\/dummy Promise/);
  assert.match(violation.message, /temporal dead zone/);
});

test("accepts a direct caught task call after keyed Promise publication", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-published-task-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "pool.js"), `export class Pool {
  run(key, task) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.active.set(key, promise);
    this.queue.push({ key, task, resolve, reject });
    this._drain();
    return promise;
  }
  _drain() {
    const entry = this.queue.shift();
    try { const value = entry.task(); Promise.resolve(value).then(entry.resolve); }
    catch (error) { entry.reject(error); }
  }
}\n`);

  assert.deepEqual(lifecycleContractViolations({
    task: "run returns the exact same Promise for a keyed task; synchronous task throws reject through the returned Promise.",
    workspace,
    paths: ["src/pool.js"],
  }), []);
});

test("joins a visible immediate-start assertion to a deferred task invocation", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-sync-start-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "test", "pool.test.js"), `test("starts admission immediately", () => {
  const started = [];
  pool.run("busy", () => { started.push("busy"); return pending; });
  assert.deepStrictEqual(started, ["busy"]);
});\n`);
  fs.writeFileSync(path.join(workspace, "src", "pool.js"), `export class Pool {
  _drain(entry) {
    Promise.resolve().then(() => entry.task()).then(entry.resolve, entry.reject);
  }
}\n`);

  const violations = lifecycleContractViolations({
    task: "run coalesces a keyed task by returning the exact same Promise.",
    workspace,
    paths: ["src/pool.js"],
  });
  const violation = violations.find((entry) => entry.kind === "deferred_task_start");
  assert.ok(violation);
  assert.match(violation.message, /visible assertion/);
  assert.match(violation.message, /Promise\.resolve\(result\)\.then/);
  assert.match(violation.message, /only in those fulfillment\/rejection handlers/);
});
