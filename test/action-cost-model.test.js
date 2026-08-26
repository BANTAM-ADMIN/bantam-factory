import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  SessionCostTracker,
  estimateCost,
  optimizeActions,
} from "../src/action-cost-model.js";
import { ALL_ACTION_VERBS } from "../src/action-protocol.js";

const MODULE_PATH = fileURLToPath(new URL("../src/action-cost-model.js", import.meta.url));

test("estimateCost covers every protocol action family with finite non-negative costs", () => {
  const expectedBase = new Map([
    ["read_file", { latency: 5, io: 1, cpu: 1 }],
    ["list_dir", { latency: 2, io: 1, cpu: 0.5 }],
    ["search", { latency: 10, io: 2, cpu: 2 }],
    ["inspect", { latency: 8, io: 3, cpu: 2 }],
    ["replace", { latency: 3, io: 2, cpu: 1 }],
    ["edit_lines", { latency: 3, io: 2, cpu: 1 }],
    ["patch", { latency: 5, io: 2, cpu: 1.5 }],
    ["write_file", { latency: 4, io: 2, cpu: 1 }],
    ["write_batch", { latency: 6, io: 4, cpu: 2 }],
    ["delete_file", { latency: 3, io: 2, cpu: 1 }],
    ["move_file", { latency: 3, io: 2, cpu: 1 }],
    ["shell", { latency: 50, io: 1, cpu: 3 }],
    ["done", { latency: 1, io: 0, cpu: 0.1 }],
    ["respond", { latency: 1, io: 0, cpu: 0.1 }],
    ["query", { latency: 2, io: 0, cpu: 0.5 }],
  ]);

  assert.deepEqual([...expectedBase.keys()], ALL_ACTION_VERBS);
  for (const [type, expected] of expectedBase) {
    const action = type === "search" ? { a: type, p: "src" } : { a: type };
    const cost = estimateCost(action);
    assert.deepEqual(
      { latency: cost.latency, io: cost.io, cpu: cost.cpu },
      expected,
      type,
    );
    assert.equal(cost.type, type);
    assert.ok(Number.isFinite(cost.total) && cost.total >= 0, type);
  }
});

test("estimateCost supports the legacy type key and a bounded unknown-action fallback", () => {
  assert.deepEqual(estimateCost({ type: "query" }), {
    type: "query",
    latency: 2,
    io: 0,
    cpu: 0.5,
    total: 2.5,
  });
  for (const type of ["future_action", "__proto__", "constructor", "toString"]) {
    assert.deepEqual(estimateCost({ a: type }), {
      type,
      latency: 10,
      io: 1,
      cpu: 1,
      total: 10,
    });
  }
});

test("estimateCost rejects malformed actions and invalid file-stat stores", () => {
  for (const action of [null, undefined, [], {}, { a: "" }, { a: 3 }]) {
    assert.throws(() => estimateCost(action), /action.*object|action type/i);
  }
  assert.throws(
    () => estimateCost({ a: "read_file", p: "a.js" }, {}),
    /fileStats.*Map/i,
  );
});

test("read costs grow at page boundaries and reject corrupt size data", () => {
  const fileStats = new Map([
    ["empty.js", 0],
    ["fifty.js", 50],
    ["fifty-one.js", 51],
  ]);
  const empty = estimateCost({ a: "read_file", p: "empty.js" }, fileStats);
  const fifty = estimateCost({ a: "read_file", p: "fifty.js" }, fileStats);
  const fiftyOne = estimateCost({ a: "read_file", p: "fifty-one.js" }, fileStats);

  assert.ok(fifty.latency > empty.latency);
  assert.ok(fiftyOne.latency > fifty.latency);
  assert.ok(fiftyOne.total > fifty.total);

  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assert.throws(
      () => estimateCost(
        { a: "read_file", p: "bad.js" },
        new Map([["bad.js", invalid]]),
      ),
      /file size.*finite non-negative number/i,
    );
  }
});

test("each shell control operator contributes once to complexity", () => {
  const base = estimateCost({ a: "shell", c: "first" });
  for (const command of [
    "first | second",
    "first && second",
    "first || second",
    "first; second",
    "first\nsecond",
  ]) {
    const cost = estimateCost({ a: "shell", c: command });
    assert.equal(cost.latency, base.latency + 15, command);
    assert.equal(cost.cpu, base.cpu + 0.5, command);
  }
  for (const quoted of [
    "echo 'first | second'",
    'echo "first && second"',
    String.raw`echo first\|second`,
  ]) {
    assert.deepEqual(estimateCost({ a: "shell", c: quoted }), base, quoted);
  }
  for (const command of [42, 0, false, null, {}]) {
    assert.throws(
      () => estimateCost({ a: "shell", c: command }),
      /shell command must be a string/i,
    );
  }
});

test("workspace-wide search costs more than a path-scoped search", () => {
  const workspace = estimateCost({ a: "search", q: "needle" });
  const explicitlyEmpty = estimateCost({ a: "search", q: "needle", p: "" });
  const explicitRoot = estimateCost({ a: "search", q: "needle", p: "." });
  const scoped = estimateCost({ a: "search", q: "needle", p: "src" });

  assert.deepEqual(workspace, explicitlyEmpty);
  assert.deepEqual(workspace, explicitRoot);
  assert.ok(workspace.latency > scoped.latency);
  assert.ok(workspace.io > scoped.io);
});

test("tracker honors measured overrides and snapshots accounting history", () => {
  const tracker = new SessionCostTracker();
  const action = { a: "shell", c: "true", metadata: { source: "estimated" } };
  const cost = tracker.track(action, { latency: 7, io: 0, cpu: 0 });

  assert.deepEqual(cost, {
    type: "shell",
    latency: 7,
    io: 0,
    cpu: 0,
    total: 3.5,
  });

  action.a = "query";
  action.metadata.source = "mutated";
  cost.total = 999;

  assert.deepEqual(tracker.summary(), {
    totalLatency: 7,
    totalIo: 0,
    totalCpu: 0,
    totalActions: 1,
    avgLatency: 7,
    byType: {
      shell: { count: 1, totalCost: 3.5 },
    },
  });
  assert.equal(tracker.mostExpensive(1)[0].action.a, "shell");
  assert.equal(tracker.mostExpensive(1)[0].action.metadata.source, "estimated");
  assert.equal(tracker.mostExpensive(1)[0].cost.total, 3.5);
  assert.equal(Object.isFrozen(tracker.mostExpensive(1)[0].action.metadata), true);
});

test("tracker validates overrides, budget bounds, and result count", () => {
  const tracker = new SessionCostTracker();
  for (const overrides of [
    null,
    { latency: -1 },
    { io: Number.NaN },
    { cpu: Number.POSITIVE_INFINITY },
    { latncy: 2 },
  ]) {
    assert.throws(
      () => tracker.track({ a: "query" }, overrides),
      /overrides.*object|override|latency|io|cpu/i,
    );
  }
  assert.throws(
    () => tracker.track({ a: "query", callback() {} }),
    /could not be cloned/i,
  );
  assert.deepEqual(tracker.summary(), {
    totalLatency: 0,
    totalIo: 0,
    totalCpu: 0,
    totalActions: 0,
    avgLatency: 0,
    byType: {},
  });

  tracker.track({ a: "query" });
  assert.equal(tracker.withinBudget(2), true);
  assert.equal(tracker.withinBudget(1), false);
  assert.equal(tracker.mostExpensive(0).length, 0);
  assert.throws(() => tracker.mostExpensive(-1), /non-negative integer/i);
  assert.throws(() => tracker.withinBudget(Number.NaN), /finite non-negative number/i);
});

test("tracker groups prototype-named actions without mutating global prototypes", () => {
  const tracker = new SessionCostTracker();
  tracker.track({ a: "__proto__" });
  tracker.track({ a: "constructor" });

  const byType = tracker.summary().byType;
  assert.equal(Object.hasOwn(byType, "__proto__"), true);
  assert.equal(Object.hasOwn(byType, "constructor"), true);
  assert.deepEqual(byType.__proto__, { count: 1, totalCost: 10 });
  assert.deepEqual(byType.constructor, { count: 1, totalCost: 10 });
  assert.equal(Object.hasOwn(Object.prototype, "count"), false);
  assert.equal(Object.hasOwn(Object.prototype, "totalCost"), false);
});

test("optimizeActions sorts cheapest-first without changing the input order", () => {
  const actions = [
    { a: "shell", c: "first | second" },
    { a: "read_file", p: "a.js" },
    { a: "query", q: "symbol" },
  ];
  const original = [...actions];
  const ranked = optimizeActions(actions);

  assert.deepEqual(actions, original);
  assert.deepEqual(ranked.map(({ action }) => action.a), [
    "query",
    "read_file",
    "shell",
  ]);
  assert.ok(ranked.every(({ cost }) => Number.isFinite(cost.total)));
  assert.throws(() => optimizeActions(null), /actions must be an array/i);
});

test("direct execution runs the built-in smoke checks exactly once", () => {
  const result = spawnSync(process.execPath, [MODULE_PATH], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.match(/=== Action Cost Model ===/g)?.length,
    1,
    result.stdout,
  );
});
