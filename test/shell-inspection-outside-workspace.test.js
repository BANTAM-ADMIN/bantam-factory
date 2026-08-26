import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Executor } from "../src/executor.js";

// "Use read_file instead" is only advice while read_file can reach the file.
// Outside the workspace it cannot, and this guard plus the workspace-escape
// guard then close from both sides with nothing legal between them.
//
// TB2 mailman (2026-08-21), which has never scored above 0. It is a
// system-service task: configure /etc/mailman3/mailman.cfg, read
// /usr/lib/python3/dist-packages/mailman/. read_file refused those as escaping
// /app; cat and `sed -n` on the same paths were refused here and pointed back at
// read_file. Eleven such refusals across twelve recent streams.
//
// Driven through execute(), not the classifier — a unit test on the helper
// passes happily while the dispatcher never reaches it.
// await the body before the finally runs: returning the promise deletes the
// fixture while the test is still using it, and a search against a missing
// directory is "not refused" for entirely the wrong reason.
async function withWorkspace(fn) {
  const ws = fs.mkdtempSync("/tmp/shell-inspect-");
  try { return await fn(ws); } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

const blocked = (obs) => /shell file inspection is disabled/.test(String(obs ?? ""));

test("shell inspection of a path read_file CANNOT reach is allowed", async () => {
  await withWorkspace(async (ws) => {
    const ex = new Executor(ws, { shellSandbox: "host" });
    for (const cmd of [
      "cat /etc/mailman3/mailman.cfg",
      "sed -n '1,20p' /usr/lib/python3/dist-packages/mailman/app/subscriptions.py",
      "grep -n site_owner /etc/mailman3/mailman.cfg",
      "cat /tmp/pystan_run.log",
    ]) {
      const out = await ex.execute({ a: "shell", c: cmd });
      assert.equal(blocked(out?.observation), false, `must fall through to the shell: ${cmd}`);
    }
  });
});

test("inside the workspace the redirect still holds", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(`${ws}/inside.txt`, "hello\n");
    const ex = new Executor(ws, { shellSandbox: "host" });
    for (const cmd of ["cat inside.txt", `cat ${ws}/inside.txt`]) {
      const out = await ex.execute({ a: "shell", c: cmd });
      assert.equal(blocked(out?.observation), true, `read_file can serve this, so keep steering: ${cmd}`);
    }
  });
});

test("a command mixing inside and outside paths stays blocked", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(`${ws}/inside.txt`, "hello\n");
    const ex = new Executor(ws, { shellSandbox: "host" });
    const out = await ex.execute({ a: "shell", c: `cat ${ws}/inside.txt /etc/passwd` });
    assert.equal(blocked(out?.observation), true, "only a provably-unreachable read falls through");
  });
});
