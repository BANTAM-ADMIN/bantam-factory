import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";
import { ContextAuditSentinel } from "../src/logic/context-audit.js";

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-typed-outcomes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initial = "export function alpha() {}\nexport function beta() {}\nconst value = 1;\n";
  fs.writeFileSync(path.join(root, "m.js"), initial);
  fs.writeFileSync(path.join(root, "values.txt"), "one one\ntwo\n");
  return { root, initial, executor: new Executor(root, { shellSandbox: "host", ...options }) };
}

test("named-deletion confirmation is not counted as a failed anchor; the exact retry applies", async (t) => {
  const { root, initial, executor } = setup(t);
  const sentinel = new ContextAuditSentinel();
  const first = { a: "replace", p: "m.js", old: "export function alpha() {}", new: "// removed alpha" };
  const second = { a: "replace", p: "m.js", old: "export function beta() {}", new: "// removed beta" };
  for (const action of [first, second]) {
    const result = await executor.execute(action);
    assert.deepEqual(result.editOutcome, { applied: false, reason: "confirmation_required", paths: ["m.js"] });
    assert.equal(sentinel.note({ action, ...result }), null);
  }
  assert.equal(fs.readFileSync(path.join(root, "m.js"), "utf8"), initial);
  const result = await executor.execute(first);
  assert.deepEqual(result.editOutcome, { applied: true, reason: "applied", paths: ["m.js"] });
  assert.equal(sentinel.note({ action: first, ...result }), null);
  assert.match(fs.readFileSync(path.join(root, "m.js"), "utf8"), /removed alpha/);
});

test("exact edit failures retain their reason at the executor boundary", async (t) => {
  const { executor } = setup(t);
  const cases = [
    [{ a: "replace", p: "values.txt", old: "missing", new: "fixed" }, "anchor_missing"],
    [{ a: "replace", p: "values.txt", old: "one", new: "fixed" }, "ambiguous"],
    [{ a: "replace", p: "values.txt", old: "two", new: "two" }, "unchanged"],
    [{ a: "replace", p: "values.txt", old: "two", new: "fixed", line: 1 }, "anchor_missing"],
    [{ a: "replace", p: "values.txt", old: "one", new: "fixed", line: 1 }, "ambiguous"],
    [{ a: "edit_lines", p: "values.txt", start: 99, end: 99, new: "fixed" }, "anchor_missing"],
    [{ a: "edit_lines", p: "values.txt", start: 0, end: 1, new: "fixed" }, "other"],
    [{ a: "write_file", p: "m.js", content: "export const = ;" }, "syntax_invalid"],
    [{ a: "replace", p: "m.js", old: "const value = 1;", new: "const value = ;" }, "syntax_invalid"],
    [{ a: "replace", p: "absent.txt", old: "one", new: "fixed" }, "other"],
  ];
  for (const [action, reason] of cases) {
    const result = await executor.execute(action);
    assert.equal(typeof result.observation, "string");
    assert.deepEqual(result.editOutcome, { applied: false, reason, paths: [action.p] });
  }
});

test("atomic patches identify the failed file without reporting any applied edit", async (t) => {
  const { root, executor } = setup(t);
  for (const [old, reason] of [["missing", "anchor_missing"], ["one", "ambiguous"]]) {
    const result = await executor.execute({ a: "patch", edits: [
      { p: "m.js", old: "const value = 1;", new: "const value = 2;" },
      { p: "values.txt", old, new: "fixed" },
    ] });
    assert.deepEqual(result.editOutcome, { applied: false, reason, paths: ["values.txt"] });
    assert.match(fs.readFileSync(path.join(root, "m.js"), "utf8"), /const value = 1/);
  }
  const result = await executor.execute({ a: "write_batch", files: [
    { p: "created.txt", content: "valid" }, { p: "broken.js", content: "const = ;" },
  ] });
  assert.deepEqual(result.editOutcome, { applied: false, reason: "syntax_invalid", paths: ["broken.js"] });
  assert.equal(fs.existsSync(path.join(root, "created.txt")), false);
});

test("typed mutation paths cover line edits, patches, writes, batches, moves and deletion", async (t) => {
  const { executor } = setup(t);
  const cases = [
    [{ a: "edit_lines", p: "values.txt", start: 2, end: 2, new: "three" }, ["values.txt"]],
    [{ a: "patch", edits: [{ p: "values.txt", old: "three", new: "four" }] }, ["values.txt"]],
    [{ a: "write_file", p: "new.txt", content: "created" }, ["new.txt"]],
    [{ a: "write_batch", files: [{ p: "new.txt", content: "created" }, { p: "other.txt", content: "changed" }] }, ["other.txt"]],
    [{ a: "move_file", from: "new.txt", to: "moved.txt" }, ["new.txt", "moved.txt"]],
    [{ a: "delete_file", p: "moved.txt" }, ["moved.txt"]],
  ];
  for (const [action, paths] of cases) {
    assert.deepEqual((await executor.execute(action)).editOutcome, { applied: true, reason: "applied", paths });
  }
});

test("byte-identical writes remain typed unchanged when the legacy no-op guard is disabled", async (t) => {
  const { executor, initial } = setup(t, { noopEditGuard: false });
  const result = await executor.execute({ a: "write_file", p: "m.js", content: initial });
  assert.match(result.observation, /^wrote/);
  assert.deepEqual(result.editOutcome, { applied: false, reason: "unchanged", paths: ["m.js"] });
  assert.equal(typeof executor.replace({ p: "values.txt", old: "two", new: "three" }), "string", "direct method API is preserved");
});

test("typed reasons override misleading prose and target patch files for bounded context checks", () => {
  const sentinel = new ContextAuditSentinel();
  const action = { a: "patch", edits: [{ p: "m.js", old: "missing", new: "fixed" }] };
  const note = (reason, observation = "rewritten display text") => sentinel.note({
    action, observation, editOutcome: { applied: false, reason, paths: ["m.js"] },
  });
  for (const reason of ["confirmation_required", "confirmation_required", "syntax_invalid", "syntax_invalid", "other", "other"]) {
    assert.equal(note(reason, 'ERROR: "old" text not found in m.js.'), null);
  }
  assert.equal(note("anchor_missing"), null);
  assert.match(note("ambiguous"), /2 consecutive edits to m\.js.*target was not unique/);
  assert.equal(note("unchanged"), null, "one note per episode");
  sentinel.note({ action, editOutcome: { applied: true, reason: "applied", paths: ["m.js"] } });
  assert.equal(note("unchanged"), null);
  assert.match(note("unchanged"), /requested bytes were already present/);
});

test("raw shell evidence preserves process status and unrendered output", async (t) => {
  const stdout = "noise\n".repeat(6000) + "# pass 2\n# fail 0\n";
  const { executor, root } = setup(t, {
    processRunner: async () => ({ code: 17, stdout, stderr: "late process failure", timedOut: false, aborted: false }),
  });
  const result = await executor.execute({ a: "shell", c: "npm test" });
  assert.equal(result.shellExecution, executor.lastShellExecution);
  assert.equal(result.shellExecution.exitCode, 17);
  assert.equal(result.shellExecution.stdout, stdout);
  assert.equal(result.shellExecution.stderr, "late process failure");
  assert.equal(result.shellExecution.cwd, fs.realpathSync(root));
  assert.equal(result.shellExecution.command, "npm test");
  assert.equal(result.shellExecution.blocked, false);
  const refusal = await executor.execute({ a: "shell", c: "curl https://example.invalid/reference" });
  assert.ok(refusal.blocked);
  assert.equal(refusal.shellExecution, null, "a refused command cannot inherit the previous process result");
  await executor.execute({ a: "read_file", p: "m.js" });
  assert.equal(executor.lastShellExecution, null);
});

test("timeout, output cap, signal and interruption survive shell rendering", async (t) => {
  const { executor } = setup(t, {
    processRunner: async () => ({ code: null, stdout: "partial", stderr: "", timedOut: true, aborted: true, bufferExceeded: true, signal: "SIGTERM" }),
  });
  const result = await executor.execute({ a: "shell", c: "npm test" });
  assert.equal(result.shellExecution.exitCode, null);
  assert.equal(result.shellExecution.timedOut, true);
  assert.equal(result.shellExecution.interrupted, true);
  assert.equal(result.shellExecution.bufferExceeded, true);
  assert.equal(result.shellExecution.signal, "SIGTERM");
});
