// Bootstrap #2's gate scold, generalized: the run inherited failing tests
// (environmental + pre-existing), triaged them correctly, and the
// unfinished-tests gate objected anyway — it only knows "last verdict red".
// The operator's insight: a red baseline is polluted context; the model
// SHOULD chase reds, so undeclared reds should never be handed to it. The
// fix is a declared baseline: .bantam/known-failures.json names the
// inherited reds (ideally generated in the same environment the model tests
// in), the gate excuses exactly those names, and any NEW name still blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { prematureDoneObjection } from "../src/done-guard.js";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "bantam-reds-"));
const declare = (dir, names) => {
  fs.mkdirSync(path.join(dir, ".bantam"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".bantam", "known-failures.json"),
    JSON.stringify({ recorded: "2026-08-18", failures: names }));
};
const edit = { parsedAction: { a: "replace", p: "src/x.js", old: "a", new: "b" }, observation: "ok" };
const suite = (notOk) => ({
  parsedAction: { a: "shell", c: "npm test" },
  observation: notOk.map((n, i) => `not ok ${i + 1} - ${n}`).join("\n")
    + `\n# tests 100\n# pass ${100 - notOk.length}\n# fail ${notOk.length}\n`,
});

test("failures matching the declared baseline do not block done", () => {
  const dir = ws();
  declare(dir, ["genre voice check", "factory claims command"]);
  const turns = [suite(["genre voice check", "factory claims command"]), edit,
                 suite(["genre voice check", "factory claims command"])];
  assert.equal(prematureDoneObjection(turns, 0, { workspace: dir }), null,
    "every red is declared — the run added nothing");
});

test("a NEW failure blocks even when declared reds are also present", () => {
  const dir = ws();
  declare(dir, ["genre voice check"]);
  const turns = [edit, suite(["genre voice check", "shiny new regression"])];
  const o = prematureDoneObjection(turns, 0, { workspace: dir });
  assert.match(o, /failing tests/);
});

test("no manifest means the strict rule stands unchanged", () => {
  const dir = ws();
  const turns = [edit, suite(["anything at all"])];
  assert.match(prematureDoneObjection(turns, 0, { workspace: dir }), /failing tests/);
});

test("an unreadable manifest fails closed", () => {
  const dir = ws();
  fs.mkdirSync(path.join(dir, ".bantam"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".bantam", "known-failures.json"), "{corrupt");
  const turns = [edit, suite(["anything"])];
  assert.match(prematureDoneObjection(turns, 0, { workspace: dir }), /failing tests/);
});
