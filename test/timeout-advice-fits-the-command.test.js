import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// When a shell command hits OUR timeout, the observation used to offer exactly
// one recovery: background it and poll its log. Right for an install or build —
// and a trap for a program that never exits by design (a server, a watch-mode
// TUI, a REPL): backgrounded, it still never finishes, its "log" is a stream of
// escape codes, and the model waits on a file that will not conclude.
//
// The jl8 --watch run (2026-08-17) verified its TUI correctly only because the
// model already knew the bounded pattern (`timeout 3 … | cat -v`). Advice that
// only works when it is not needed is not advice; the observation now offers
// both patterns, labelled by what the command IS.

test("a timed-out command is offered the bounded pattern, not only background+poll", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-timeout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exec = new Executor(dir, { shellTimeoutMs: 500, shellSandbox: "host" });
  const r = await exec.execute({ a: "shell", c: "sleep 30" });
  const o = String(r.observation ?? "");
  assert.match(o, /\[timeout\]/, "the timeout note fires");
  assert.match(o, /nohup <command>/, "background+poll stays for installs/builds");
  assert.match(o, /timeout 3 <command>/, `the bounded pattern is offered too: ${o.slice(-300)}`);
  assert.match(o, /never exits by design|server, a watch mode|REPL/, "and says when to use which");
});
