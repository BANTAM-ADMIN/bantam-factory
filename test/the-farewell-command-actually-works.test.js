import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

// The Ctrl-C farewell prints:
//
//   resume with: bantam run --resume-run <artifact>
//
// and that exact command failed with "run requires --task" — the fail-fast ran
// before the artifact (which CARRIES the task) was ever opened. Advertising a
// rescue command that errors is worse than no farewell at all.
//
// The checkpoint now also records its workspace, so the command works from any
// directory, not only the one the run happened to start in.
//
// Dead endpoint on purpose: the probe must get PAST argument validation; the
// connection failure that follows is expected and fast.

const BANTAM = path.resolve("bin/bantam.js");

function checkpoint(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-farewell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, "run.json");
  fs.writeFileSync(artifact, JSON.stringify({
    schema: 2, kind: "bantam-run-checkpoint", runId: "t", stamp: "s",
    partial: true, truncatedBy: "sigint",
    task: "Add a doubled() export to alpha.js.",
    turns: [], turnCount: 0, rejectedOutputs: [], modelCalls: [], events: [],
    ...extra,
  }));
  return { dir, artifact };
}

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [BANTAM, ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("resume without --task gets past argument validation", (t) => {
  const { dir, artifact } = checkpoint(t);
  const r = run(["run", "--resume-run", artifact, "--endpoint", "http://127.0.0.1:9"], dir);
  assert.ok(!/run requires --task/.test(r.out),
    `the artifact carries the task; got: ${r.out.slice(0, 300)}`);
});

test("a checkpoint without a task still fails with a useful message", (t) => {
  const { dir, artifact } = checkpoint(t, { task: undefined });
  const r = run(["run", "--resume-run", artifact, "--endpoint", "http://127.0.0.1:9"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /task/i, `should say what is missing: ${r.out.slice(0, 300)}`);
});

// The workspace half is validated live rather than here: the loader rejects a
// checkpoint with zero recorded turns before workspace resolution is reached,
// and a synthetic checkpoint with real turns needs a live model to resume into.
// The interrupt-and-resume probe in the session log covers it end to end.
