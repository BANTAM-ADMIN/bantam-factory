import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// break-filter (TB2, 2026-08-20): a read of a file OUTSIDE the workspace is a
// legitimate move — you ran a tool that wrote /tmp/t.html and want to inspect
// the result — but the old error ("path escapes workspace: /tmp/t.html") was a
// dead end, so the model could not observe its own experiment and thrashed.
// The denied path must NAME the escape hatch: copy it in, read the copy.

test("a read that escapes the workspace names the copy-in escape hatch", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-escape-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const ex = new Executor(workspace);

  const { observation } = await ex.execute({ a: "read_file", p: "/tmp/t.html" });

  assert.match(observation, /^ERROR: path escapes workspace: \/tmp\/t\.html/);
  // The way OUT, spelled out as a runnable pair (this is the whole point):
  assert.match(observation, /cp \/tmp\/t\.html \.\/t\.html/);
  assert.match(observation, /read_file t\.html/);
  // And it must state the boundary so the model understands the rule, not just the fix.
  assert.ok(observation.includes(workspace), "message should name the workspace boundary");
});

test("a normal in-workspace read is unaffected by the hint", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-escape-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "ok.txt"), "hello\n");
  const ex = new Executor(workspace);

  const { observation } = await ex.execute({ a: "read_file", p: "ok.txt" });
  assert.doesNotMatch(observation, /escapes workspace/);
  assert.match(observation, /hello/);
});
