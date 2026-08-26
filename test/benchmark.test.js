import assert from "node:assert/strict";
import test from "node:test";

import { BenchmarkSuite } from "../src/benchmark.js";

test("a new benchmark suite has independent empty state", () => {
  const first = new BenchmarkSuite();
  const second = new BenchmarkSuite();

  assert.deepEqual(first.summary(), {
    total: 0,
    passed: 0,
    rate: 0,
    results: [],
  });
  assert.notStrictEqual(first.benchmarks, second.benchmarks);
  assert.notStrictEqual(first.results, second.results);
});

test("add validates definitions before mutating the suite", () => {
  const suite = new BenchmarkSuite();

  for (const name of [undefined, null, "", "   ", 42]) {
    assert.throws(
      () => suite.add(name, "task", "expected"),
      /benchmark name must be a non-empty string/i,
    );
  }
  for (const validator of ["yes", {}, 1]) {
    assert.throws(
      () => suite.add("valid", "task", "expected", validator),
      /validator must be a function/i,
    );
  }
  assert.throws(
    () => suite.add("uncloneable", () => {}, "expected"),
    /benchmark task could not be cloned/i,
  );

  assert.deepEqual(suite.benchmarks, []);
});

test("add snapshots mutable task and expected values", () => {
  const suite = new BenchmarkSuite();
  const task = { files: ["src/a.js"], options: { strict: true } };
  const expected = { ok: true, values: [1, 2] };

  suite.add("structured", task, expected);
  task.files.push("src/b.js");
  task.options.strict = false;
  expected.ok = false;
  expected.values.push(3);

  assert.deepEqual(suite.benchmarks[0].task, {
    files: ["src/a.js"],
    options: { strict: true },
  });
  assert.deepEqual(suite.benchmarks[0].expected, {
    ok: true,
    values: [1, 2],
  });
});

test("run compares structured output by value without exposing its stored task", async () => {
  const suite = new BenchmarkSuite();
  suite.add(
    "structured",
    { files: ["src/a.js"], options: { strict: true } },
    { ok: true, values: [1, 2] },
  );

  const entry = await suite.run(suite.benchmarks[0], async (task) => {
    task.files.push("executor-side-mutation.js");
    task.options.strict = false;
    return { ok: true, values: [1, 2] };
  });

  assert.equal(entry.passed, true);
  assert.deepEqual(suite.benchmarks[0].task, {
    files: ["src/a.js"],
    options: { strict: true },
  });
});

test("run awaits async validators and requires a boolean verdict", async () => {
  const suite = new BenchmarkSuite();
  suite.add("async false", "task", null, async () => {
    await Promise.resolve();
    return false;
  });

  const failed = await suite.run(suite.benchmarks[0], async () => "result");
  assert.equal(failed.passed, false);
  assert.equal(typeof failed.passed, "boolean");

  suite.add("bad verdict", "task", null, async () => "yes");
  await assert.rejects(
    suite.run(suite.benchmarks[1], async () => "result"),
    /validator must resolve to a boolean/i,
  );
  assert.equal(suite.results.length, 1);
});

test("executor and validator errors propagate without recording partial results", async () => {
  const suite = new BenchmarkSuite();
  suite.add("executor error", "task", "result");
  suite.add("validator error", "task", null, async () => {
    throw new Error("validator failed");
  });

  await assert.rejects(
    suite.run(suite.benchmarks[0], async () => {
      throw new Error("executor failed");
    }),
    /executor failed/,
  );
  await assert.rejects(
    suite.run(suite.benchmarks[1], async () => "result"),
    /validator failed/,
  );
  assert.deepEqual(suite.results, []);
});

test("run validates inputs without invoking the executor", async () => {
  const suite = new BenchmarkSuite();
  let calls = 0;
  const executor = async () => {
    calls++;
    return "result";
  };

  for (const benchmark of [null, [], {}, { name: "", task: "task" }]) {
    await assert.rejects(
      suite.run(benchmark, executor),
      /benchmark must be an object|benchmark name must be a non-empty string/i,
    );
  }
  await assert.rejects(
    suite.run({ name: "valid", task: "task", expected: "result" }, null),
    /executor must be a function/i,
  );

  assert.equal(calls, 0);
  assert.deepEqual(suite.results, []);
});

test("returned entries and summaries cannot mutate recorded results", async () => {
  const suite = new BenchmarkSuite();
  suite.add("pass", "task", "result");
  const entry = await suite.run(suite.benchmarks[0], async () => "result");

  entry.passed = false;
  entry.name = "changed";
  const firstSummary = suite.summary();
  firstSummary.results[0].passed = false;
  firstSummary.results.push({
    name: "injected",
    passed: true,
    duration: 0,
    ts: 0,
  });

  assert.deepEqual(suite.summary(), {
    total: 1,
    passed: 1,
    rate: 100,
    results: [{
      name: "pass",
      passed: true,
      duration: suite.results[0].duration,
      ts: suite.results[0].ts,
    }],
  });
});

test("summary computes a one-decimal pass rate across mixed outcomes", async () => {
  const suite = new BenchmarkSuite();
  for (let index = 0; index < 3; index++) {
    suite.add(`case ${index}`, index, index);
  }

  await suite.run(suite.benchmarks[0], async () => 0);
  await suite.run(suite.benchmarks[1], async () => -1);
  await suite.run(suite.benchmarks[2], async () => -1);

  const summary = suite.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.rate, 33.3);
});
