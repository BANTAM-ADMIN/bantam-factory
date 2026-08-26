import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// The [tool-missing] steer tells the model "python is NOT installed — use C
// instead." It must fire ONLY when the interpreter itself is missing, never
// when some OTHER command merely prints "not found" while the command line
// happens to contain an interpreter's name. chess-best-move (2026-08-20):
// `pip install python-chess` failed with our broken pip symlink ("exec:
// /usr/local/bin/python3.11: not found"); the old broad clause matched "python"
// inside "python-chess" and falsely steered the model off python (which was
// installed) toward C.

function mkExec(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-toolmiss-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return new Executor(ws);
}

test("does NOT steer when pip fails but the interpreter is present", async (t) => {
  const ex = mkExec(t);
  // command mentions python (python-chess); output has 'not found' but the
  // interpreter itself was never the missing thing.
  const { observation } = await ex.execute({
    a: "shell",
    c: "echo 'installing python-chess'; echo '/usr/local/bin/pip: 2: exec: /usr/local/bin/python3.11: not found'",
  });
  assert.doesNotMatch(observation, /\[tool-missing\]/, "must not falsely declare python missing");
});

test("STILL steers when the interpreter itself is not found (real case)", async (t) => {
  const ex = mkExec(t);
  for (const line of [
    "sh: 1: python3: not found",
    "bash: python3: command not found",
  ]) {
    const { observation } = await ex.execute({ a: "shell", c: `echo '${line}'` });
    assert.match(observation, /\[tool-missing\]/, `should steer on: ${line}`);
    assert.match(observation, /python3/, "names the missing interpreter");
  }
});
