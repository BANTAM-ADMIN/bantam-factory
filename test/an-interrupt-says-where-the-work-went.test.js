import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Ctrl-C mid-run killed the process silently: no "interrupted" line, nothing at
// the --save-run path the user named, no mention that --resume-run exists. The
// checkpoint machinery WORKED — a partial:true artifact landed in .bantam/runs —
// but the user was told nothing, so the rescue might as well not exist.
//
// Observed live 2026-08-17: SIGINT to a pytool run left py2-artifact.json absent
// and the log ending mid-action. The partial artifact sat unannounced in a
// directory the user has never heard of.
//
// Third instance of the session's usability theme: strong machinery, mute at the
// moment of need (--no-edit / excludeActions, doctor / dead endpoint, now
// resume / interrupt).
//
// The child uses RunCheckpoint.arm() directly, so this tests the real handler.

test("SIGINT flushes the checkpoint and tells the user how to resume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-interrupt-"));
  const dest = path.join(dir, "run.json");
  const child = path.join(dir, "child.mjs");
  fs.writeFileSync(child, [
    `import { RunCheckpoint } from ${JSON.stringify(path.resolve("src/run-checkpoint.js"))};`,
    `const cp = new RunCheckpoint({ dest: ${JSON.stringify(dest)}, meta: { runId: "t" } });`,
    "cp.arm();",
    "cp.note({ type: 'action', action: { a: 'read_file', p: 'x' } });",
    "process.send?.('armed');",
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  let out = "";
  try {
    out = execFileSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let err = "";
      c.stderr.on("data", (d) => { err += d; });
      c.on("message", () => setTimeout(() => c.kill("SIGINT"), 50));
      c.on("exit", (code) => { console.log(JSON.stringify({ code, err })); });
    `], { encoding: "utf8", timeout: 15000 });
  } finally {
    const { code, err } = JSON.parse(out.trim().split("\n").pop());
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 130, "SIGINT convention");
    assert.match(err, /interrupted/i, `should say it was interrupted: ${err}`);
    assert.match(err, new RegExp("run\\.json"), `should name where the work went: ${err}`);
    assert.match(err, /--resume-run/, `should name the resume flag: ${err}`);
  }
});
