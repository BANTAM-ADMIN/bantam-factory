import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";
import { OBS_MAX } from "../src/clip.js";

// 2026-08-24 tour run: turn 4 batched four listings (src/logic, src/factory,
// bin, scripts — 5.4k chars) into one inspect. The bundle is clipped to OBS_MAX
// with a head+tail cut, so the model saw src/logic, the head of src/factory,
// "... [1407 chars clipped] ...", and the tail of scripts. `bin` never arrived
// and nothing said which ops were cut. It re-requested three of them on the
// next turn — a good guess, but a guess. Name the cut ops so the next move is
// the lit button, not an inference.

function workspace(t, dirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-inspect-clip-"));
  for (const [name, count] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, name, `module-${String(i).padStart(3, "0")}-with-a-long-name.js`), "");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a clipped inspect names the ops that did not arrive whole", (t) => {
  // ~1.8k chars per listing: four of them overflow OBS_MAX, one does not.
  const ws = workspace(t, { alpha: 45, beta: 45, gamma: 45, delta: 45 });
  const exec = new Executor(ws, { shellSandbox: "host" });
  const ops = ["alpha", "beta", "gamma", "delta"].map((p) => ({ a: "list_dir", p }));
  const out = exec.inspect({ ops });
  assert.match(out, /chars clipped/);
  assert.ok(out.length <= OBS_MAX, `bundle stays within OBS_MAX (${out.length})`);
  const note = /\[clipped ops: ([^\]]+)\]/.exec(out);
  assert.ok(note, "the observation must end with a note naming the cut ops");
  assert.doesNotMatch(note[1], /#1 list_dir alpha/, "alpha arrived whole and must not be named");
  assert.match(note[1], /#2 list_dir beta/);
  assert.match(note[1], /#3 list_dir gamma/);
  assert.match(note[1], /#4 list_dir delta/);
  assert.match(out, /re-request/);
});

test("an inspect that fits carries no note", (t) => {
  const ws = workspace(t, { alpha: 5, beta: 5 });
  const exec = new Executor(ws, { shellSandbox: "host" });
  const out = exec.inspect({ ops: [{ a: "list_dir", p: "alpha" }, { a: "list_dir", p: "beta" }] });
  assert.doesNotMatch(out, /clipped/);
});
