// A card log inside its own cwd turns the belt's tee into "foreign edits"
// for any agent running workspace-coherence (2026-08-19: nineteen swallowed
// dones). The belt warns loudly at intake; it does not refuse, because
// non-coherence commands use the pattern legitimately.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function run(backlog) {
  return execFileSync("bash", ["-c", `node tools/kanban.cjs --backlog '${backlog}' --cmd true --drain-once 2>&1`], { encoding: "utf8" });
}

test("a log inside cwd draws a loud warning naming the pathology", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-guard-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const ws = path.join(d, "ws"); fs.mkdirSync(ws);
  const backlog = path.join(d, "cards.jsonl");
  fs.writeFileSync(backlog, JSON.stringify({ id: "bad", cwd: ws, stdin: "/dev/null", log: path.join(ws, "run.log") }) + "\n");
  const out = run(backlog);
  assert.match(out, /WARNING.*inside cwd/i);
  assert.match(out, /done|drained/i, "warned but still ran");
});

test("a log outside cwd runs clean with no warning", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-guard2-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const ws = path.join(d, "ws"); fs.mkdirSync(ws);
  const backlog = path.join(d, "cards.jsonl");
  fs.writeFileSync(backlog, JSON.stringify({ id: "ok", cwd: ws, stdin: "/dev/null", log: path.join(d, "run.log") }) + "\n");
  const out = run(backlog);
  assert.doesNotMatch(out, /WARNING.*inside cwd/i);
  assert.match(out, /done|drained/i);
});
