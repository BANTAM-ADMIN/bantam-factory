// kanban.cjs — the pull-system sibling of runqueue.cjs. The backlog file is
// the priority order; the belt pulls one card at a time (WIP=1), continuation
// cards jump the queue, and ANDON stops the line on a receiptless death.
// Stub-driven: the --cmd is a node one-liner that appends a marker line to a
// shared order file and exits with a per-card code, so the test can assert the
// exact pull order and what the belt did with each outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const KANBAN = path.join(here, "..", "tools", "kanban.cjs");

function writeBacklog(dir, cards) {
  const backlog = path.join(dir, "backlog.jsonl");
  fs.writeFileSync(backlog, cards.map((c) => JSON.stringify(c)).join("\n") + "\n");
  return backlog;
}

function card(dir, id, { kind, exit = 0, receipt = null } = {}) {
  const stdin = path.join(dir, id + ".in");
  fs.writeFileSync(stdin, "");
  const log = path.join(dir, id + ".log");
  if (receipt != null) fs.writeFileSync(log, receipt + "\n");
  const c = { id, cwd: dir, stdin, log };
  if (kind) c.kind = kind;
  return c;
}

// The stub's exit code comes from argv[2]; bake the per-card code into the
// command via an env var the stub reads instead — simpler: one cmd per run
// that reads a code-map file.
function makeWorldWithCodes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-"));
  const orderFile = path.join(dir, "order.txt");
  const codeMap = path.join(dir, "codes.json");
  fs.writeFileSync(codeMap, "{}");
  const stub = path.join(dir, "stub.js");
  fs.writeFileSync(stub, [
    "const fs = require('fs');",
    `const orderFile = ${JSON.stringify(orderFile)};`,
    `const codeMap = ${JSON.stringify(codeMap)};`,
    "const id = process.argv[2];",
    "fs.appendFileSync(orderFile, id + '\\n');",
    "const m = JSON.parse(fs.readFileSync(codeMap, 'utf8'));",
    "process.exit(m[id] || 0);",
  ].join("\n"));
  const cmd = `node ${JSON.stringify(stub)} {id}`;
  return { dir, orderFile, codeMap, cmd };
}

function setCodes(world, map) {
  fs.writeFileSync(world.codeMap, JSON.stringify(map));
}

function runKanban(args) {
  return spawnSync(process.execPath, [KANBAN, ...args], { encoding: "utf8", timeout: 30000 });
}

function orderOf(world) {
  try { return fs.readFileSync(world.orderFile, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
}

function statusOf(backlog) {
  return JSON.parse(fs.readFileSync(backlog + "-status.json", "utf8"));
}

test("file order is priority order, WIP one, continuation jumps the queue", () => {
  const w = makeWorldWithCodes();
  const cards = [
    card(w.dir, "first"),
    card(w.dir, "second"),
    card(w.dir, "finish-me", { kind: "continuation" }),
    card(w.dir, "third"),
  ];
  const backlog = writeBacklog(w.dir, cards);
  const r = runKanban(["--backlog", backlog, "--cmd", w.cmd]);
  assert.equal(r.status, 0, r.stderr);
  // The continuation is the top pull regardless of position: it is pulled
  // first, then the rest drains in file order.
  assert.deepEqual(orderOf(w), ["finish-me", "first", "second", "third"],
    "continuation card jumps the queue ahead of every other kind");
  const st = statusOf(backlog);
  assert.equal(st.jobs.length, 4);
  assert.ok(st.jobs.every((j) => j.status === "done"));
});

test("a continuation at the bottom still jumps a pending card above it", () => {
  const w = makeWorldWithCodes();
  const cards = [
    card(w.dir, "a"),
    card(w.dir, "b"),
    card(w.dir, "c"),
    card(w.dir, "late-continuation", { kind: "continuation" }),
  ];
  const backlog = writeBacklog(w.dir, cards);
  const r = runKanban(["--backlog", backlog, "--cmd", w.cmd, "--drain-once"]);
  assert.equal(r.status, 0, r.stderr);
  // drain-once pulls the FIRST card by priority: a continuation exists, so it
  // is pulled first even though it is last in the file.
  assert.deepEqual(orderOf(w), ["late-continuation"],
    "the continuation is the top pull regardless of position");
});

test("andon: a receiptless nonzero death halts the belt", () => {
  const w = makeWorldWithCodes();
  const cards = [
    card(w.dir, "ok"),
    card(w.dir, "boom"),
    card(w.dir, "never"),
  ];
  setCodes(w, { boom: 3 });
  const backlog = writeBacklog(w.dir, cards);
  const r = runKanban(["--backlog", backlog, "--cmd", w.cmd]);
  assert.notEqual(r.status, 0, "a halted belt must not exit 0");
  assert.match(r.stderr, /ANDON/, "the halt is loud");
  assert.match(r.stderr, /boom/, "the halt names the job");
  assert.match(r.stderr, /never\.log|boom\.log/, "the halt names a log path");
  assert.deepEqual(orderOf(w), ["ok", "boom"], "the card after the death never runs");
  const st = statusOf(backlog);
  const boom = st.jobs.find((j) => j.id === "boom");
  const never = st.jobs.find((j) => j.id === "never");
  assert.equal(boom.status, "failed");
  assert.equal(never.status, "pending", "the halted card stays pending for a later resume");
});

test("a receipted nonzero failure is recorded and the belt continues", () => {
  const w = makeWorldWithCodes();
  const cards = [
    card(w.dir, "ok"),
    card(w.dir, "expected-fail", { receipt: "⚠ expected: input missing" }),
    card(w.dir, "after"),
  ];
  setCodes(w, { "expected-fail": 2 });
  const backlog = writeBacklog(w.dir, cards);
  const r = runKanban(["--backlog", backlog, "--cmd", w.cmd]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(orderOf(w), ["ok", "expected-fail", "after"],
    "the belt flows past a receipted failure");
  const st = statusOf(backlog);
  assert.equal(st.jobs.find((j) => j.id === "expected-fail").status, "failed");
  assert.equal(st.jobs.find((j) => j.id === "after").status, "done");
});

test("resume after partial drain: done cards skipped, running card retried", () => {
  const w = makeWorldWithCodes();
  const cards = [
    card(w.dir, "one"),
    card(w.dir, "two"),
    card(w.dir, "three"),
  ];
  const backlog = writeBacklog(w.dir, cards);
  // First run: drain-once pulls "one".
  let r = runKanban(["--backlog", backlog, "--cmd", w.cmd, "--drain-once"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(orderOf(w), ["one"]);
  // Simulate a crash mid-card: mark "two" running in the status file.
  const st = statusOf(backlog);
  const two = st.jobs.find((j) => j.id === "two");
  two.status = "running";
  two.startedAt = new Date().toISOString();
  fs.writeFileSync(backlog + "-status.json", JSON.stringify(st, null, 2) + "\n");
  // Second run: "one" is skipped (done), "two" is retried (was running), then "three".
  r = runKanban(["--backlog", backlog, "--cmd", w.cmd]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(orderOf(w), ["one", "two", "three"],
    "done card not re-run; crashed card retried; then the rest drains");
  const st2 = statusOf(backlog);
  assert.ok(st2.jobs.every((j) => j.status === "done"));
});

test("--drain-once runs exactly one card then exits", () => {
  const w = makeWorldWithCodes();
  const cards = [card(w.dir, "a"), card(w.dir, "b"), card(w.dir, "c")];
  const backlog = writeBacklog(w.dir, cards);
  const r = runKanban(["--backlog", backlog, "--cmd", w.cmd, "--drain-once"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(orderOf(w), ["a"], "exactly one card");
  const st = statusOf(backlog);
  assert.equal(st.jobs.find((j) => j.id === "a").status, "done");
  assert.equal(st.jobs.find((j) => j.id === "b").status, "pending");
  assert.equal(st.jobs.find((j) => j.id === "c").status, "pending");
});
