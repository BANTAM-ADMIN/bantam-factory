import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { BOOLEAN_FLAGS, parseArgs } from "../src/cli-args.js";

describe("CLI argument parsing", () => {
  it("readonly verification is a value-less opt-in and does not consume a positional task", () => {
    assert.deepEqual(parseArgs(["run", "--verify-workspace-read-only", "task words"]),
      { _: ["run", "task words"], "verify-workspace-read-only": true });
    assert.throws(() => parseArgs(["run", "--verify-workspace-read-only=false"]), /takes no value/);
  });
  it("keeps commands and task text positional while value options consume one token", () => {
    assert.deepEqual(
      parseArgs(["run", "--workspace", "project dir", "--task", "fix the parser"]),
      {
        _: ["run"],
        workspace: "project dir",
        task: "fix the parser",
      },
    );
  });

  it("supports inline values without consuming the following positional", () => {
    assert.deepEqual(
      parseArgs(["exec", "--endpoint=http://127.0.0.1:8080", "quoted task"]),
      {
        _: ["exec", "quoted task"],
        endpoint: "http://127.0.0.1:8080",
      },
    );
    assert.deepEqual(parseArgs(["run", "--title="]), { _: ["run"], title: "" });
  });

  it("never lets a default boolean flag consume the next token", () => {
    for (const name of BOOLEAN_FLAGS) {
      assert.deepEqual(
        parseArgs([`--${name}`, "task"]),
        { _: ["task"], [name]: true },
        `--${name}`,
      );
    }
  });

  it("honors a caller-supplied boolean set without mutating it", () => {
    const booleans = new Set(["custom"]);
    const argv = Object.freeze(["run", "--custom", "task", "--value", "chosen"]);

    assert.deepEqual(parseArgs(argv, booleans), {
      _: ["run", "task"],
      custom: true,
      value: "chosen",
    });
    assert.deepEqual([...booleans], ["custom"]);
    assert.deepEqual(argv, ["run", "--custom", "task", "--value", "chosen"]);
  });

  it("uses the final occurrence when an option is repeated", () => {
    assert.deepEqual(
      parseArgs(["run", "--endpoint", "first", "--endpoint=second", "--json", "--json"]),
      { _: ["run"], endpoint: "second", json: true },
    );
  });

  it("treats every token after the delimiter as positional data", () => {
    assert.deepEqual(
      parseArgs(["run", "--workspace", "before", "--", "--workspace", "after", "--json"]),
      {
        _: ["run", "--workspace", "after", "--json"],
        workspace: "before",
      },
    );
  });

  it("keeps single-dash and negative-number tokens positional", () => {
    assert.deepEqual(
      parseArgs(["run", "-x", "-1", "--temperature", "-0.5"]),
      {
        _: ["run", "-x", "-1"],
        temperature: "-0.5",
      },
    );
  });

  it("represents an omitted optional value as true", () => {
    assert.deepEqual(
      parseArgs(["run", "--save-run", "--json"]),
      { _: ["run"], "save-run": true, json: true },
    );
    assert.deepEqual(parseArgs(["run", "--save-run"]), { _: ["run"], "save-run": true });
  });

  it("rejects values attached to flags declared boolean", () => {
    assert.throws(
      () => parseArgs(["run", "--json=false"]),
      /--json takes no value/,
    );
  });

  it("rejects malformed input with stable errors instead of corrupting parser state", () => {
    assert.throws(() => parseArgs(null), /argv must be an array/i);
    assert.throws(() => parseArgs(["run", 3]), /argv\[1\] must be a string/i);
    assert.throws(() => parseArgs(["run", "---bad"]), /invalid option name/i);
    assert.throws(() => parseArgs(["run", "--_"]), /reserved option name/i);
    assert.throws(() => parseArgs(["run", "--__proto__", "value"]), /reserved option name/i);
    assert.throws(() => parseArgs(["run"], []), /booleanFlags must provide has/i);
  });

  it("accepts a trailing delimiter as an empty positional suffix", () => {
    assert.deepEqual(parseArgs(["run", "--"]), { _: ["run"] });
  });
});

// A value-less flag missing from BOOLEAN_FLAGS silently eats the next argument.
// That is the bug in this file's header comment, and on 2026-07-31 it was live
// again: `bantam eval --save-run gauntlet/fixtures/keyed-task-pool-strong` parsed
// the fixture path as the flag's VALUE, leaving no fixtures. Twenty runs launched
// and all twenty died instantly with "no fixtures found".
//
// The set is a closed enumeration that has to stay in step with how bin/bantam.js
// actually reads its flags, and nothing kept the two in step. Deriving the second
// list from source and comparing is what makes the drift impossible rather than
// merely fixed once.
it("declares every flag bin/bantam.js reads as a boolean", () => {
  const source = readFileSync(new URL("../bin/bantam.js", import.meta.url), "utf8");
  // `args["x"] === true` is ambiguous: it reads a boolean flag, OR it guards a
  // VALUE-taking flag that was given without its value (`--state-home` with no
  // directory). The guard form always fails fast, so drop those lines first --
  // without this the check flags state-home, review-file and resume-run, which
  // are value-taking and correctly absent from the set.
  const scanned = source
    .split("\n")
    .filter((line) => !/===\s*true\)\s*fail\(/.test(line))
    .join("\n");

  const used = new Set();
  for (const m of scanned.matchAll(/Boolean\(args\["([a-z0-9-]+)"\]\)/g)) used.add(m[1]);
  for (const m of scanned.matchAll(/args\["([a-z0-9-]+)"\]\s*===\s*true/g)) used.add(m[1]);

  const missing = [...used].filter((f) => !BOOLEAN_FLAGS.has(f)).sort();
  assert.deepEqual(missing, [], `these flags consume the next argument: ${missing.join(", ")}`);
});
