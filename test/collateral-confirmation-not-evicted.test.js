import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// The collateral guard refuses a named deletion once and says "re-issue the
// identical edit only if deleting X is deliberate". That was tracked in ONE
// slot, so a second refusal evicted the first.
//
// tb15 (2026-08-16, .bantam/runs/2026-08-16T21-48-38-604Z.json) refused the same
// `impossibleEditableScope` export edit on turns 39 and 42. Turn 41 refused a
// DIFFERENT edit in between and took the slot, so turn 42 — the identical
// re-issue the refusal had asked for — was refused again. Five collateral
// refusals in that run and not one of them was ever confirmable.
//
// Clearing on a successful edit to the SAME file stays: that ground has moved.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-collateral-evict-"));
  fs.writeFileSync(
    path.join(dir, "m.js"),
    "export function alpha() {}\nexport function beta() {}\nconst v = 1;\n",
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ALPHA = { a: "replace", p: "m.js", old: "export function alpha() {}", new: "// a" };
const BETA = { a: "replace", p: "m.js", old: "export function beta() {}", new: "// b" };
const refused = (result) => /would DELETE 1 named thing/.test(String(result.observation));

test("a second refusal does not evict the first's pending confirmation", async (t) => {
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  assert.ok(refused(await executor.execute(ALPHA)), "first alpha attempt is refused");
  assert.ok(refused(await executor.execute(BETA)), "a different deletion is also refused");
  assert.ok(!refused(await executor.execute(ALPHA)),
    "the identical alpha re-issue is the confirmation the refusal asked for");
});

test("a successful edit to the same file still clears pending confirmations", async (t) => {
  // The existing contract: that file changed, so a pending deletion no longer
  // describes the tree the model confirmed against.
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  assert.ok(refused(await executor.execute(ALPHA)));
  const unrelated = await executor.execute({ a: "replace", p: "m.js", old: "const v = 1;", new: "const v = 2;" });
  assert.match(String(unrelated.observation), /replaced 1 occurrence/);
  assert.ok(refused(await executor.execute(ALPHA)), "the confirmation was correctly dropped");
});
