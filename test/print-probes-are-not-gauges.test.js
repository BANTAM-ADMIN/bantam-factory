// Card 18 (slugline, 2026-08-25): bantam probed its fix with a node -e that
// PRINTED seven cases — the killer one included: "  --Hi--There--  " =>
// "hi-there-", trailing dash in plain sight — then checkmarked "no leading or
// trailing dashes ✓" from its own symbolic trace and called done. Sealed MISS
// 6/7. A printout cannot fail; an assertion can. The shell station now nudges
// print-only probes toward the form the runner can gauge.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freshExec() {
  const { Executor } = await import("../src/executor.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-printprobe-"));
  return new Executor(ws, {});
}

test("a green print-only node -e probe gets the assertion nudge", async () => {
  const exec = await freshExec();
  const r = await exec.execute({ a: "shell", c: `node -e 'for (const s of ["a b"]) console.log(s, "=>", s.replace(/ /, "-"))'` });
  assert.match(r.observation, /\[gauge\] This probe only prints/);
  assert.match(r.observation, /assert/);
});

test("a probe that already asserts is left alone", async () => {
  const exec = await freshExec();
  const r = await exec.execute({ a: "shell", c: `node -e 'const assert = require("node:assert"); assert.equal(1, 1); console.log("ok")'` });
  assert.doesNotMatch(r.observation, /\[gauge\] This probe only prints/);
});

test("a failing probe is already loud — no nudge", async () => {
  const exec = await freshExec();
  const r = await exec.execute({ a: "shell", c: `node -e 'console.log("x"); process.exit(1)'` });
  assert.doesNotMatch(r.observation, /\[gauge\] This probe only prints/);
});

test("ordinary shell commands never get the nudge", async () => {
  const exec = await freshExec();
  const r = await exec.execute({ a: "shell", c: "echo hello && ls" });
  assert.doesNotMatch(r.observation, /\[gauge\] This probe only prints/);
});

test("the nudge is capped at two per run", async () => {
  const exec = await freshExec();
  const probe = `node -e 'console.log("v", "=>", 1 + 1)'`;
  const first = await exec.execute({ a: "shell", c: probe });
  const second = await exec.execute({ a: "shell", c: probe + " # again" });
  const third = await exec.execute({ a: "shell", c: probe + " # third" });
  assert.match(first.observation, /\[gauge\] This probe only prints/);
  assert.match(second.observation, /\[gauge\] This probe only prints/);
  assert.doesNotMatch(third.observation, /\[gauge\] This probe only prints/);
});
