// The 27B serves one request at a time. Two concurrent bantam runs do not fail —
// they do something worse: they alternate, and every swap evicts the other run's
// KV cache, so the server spends its time re-prefilling 30k-token prompts instead
// of generating (measured 2026-08-17: +29,700 prompt tokens vs +200 generated in
// one 15s window while a leftover probe fought the head-to-head replay).
//
// So runs on a local endpoint take a cross-process lock for their whole lifetime.
// A second run WAITS — visibly — instead of interleaving. Remote/API endpoints
// have real concurrency and are never serialized.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireModelLock, modelLockPath } from "../src/model-lock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lock-test-"));

test("the second run waits until the first releases", async () => {
  const dir = tmp();
  const first = await acquireModelLock({ endpoint: "http://localhost:8085", lockDir: dir, pollMs: 20, slots: 1 });
  assert.ok(first, "a local endpoint takes the lock");

  let secondHolds = false;
  const waits = [];
  const secondP = acquireModelLock({
    slots: 1,
    endpoint: "http://localhost:8085",
    lockDir: dir,
    pollMs: 20,
    onWait: (info) => waits.push(info),
  }).then((lock) => { secondHolds = true; return lock; });

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(secondHolds, false, "the second run must not proceed while the first holds the lock");
  assert.ok(waits.length >= 1, "the wait is surfaced, not silent");
  assert.equal(typeof waits[0].holderPid, "number", "the wait names the holder");

  first.release();
  const second = await secondP;
  assert.equal(secondHolds, true, "release hands the lock over");
  second.release();
});

test("a lock left by a dead process is stolen, not waited on", async () => {
  const dir = tmp();
  const file = modelLockPath({ endpoint: "http://localhost:8085", lockDir: dir });
  // 2^22 exceeds kernel.pid_max on this machine — guaranteed-dead pid.
  fs.writeFileSync(file, JSON.stringify({ pid: 4194304 + 1, startedAt: "2026-01-01T00:00:00Z" }));
  const lock = await acquireModelLock({ endpoint: "http://localhost:8085", lockDir: dir, pollMs: 20, slots: 1 });
  assert.ok(lock, "the stale lock did not block acquisition");
  const held = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(held.pid, process.pid, "the live process now holds the lock");
  lock.release();
  assert.equal(fs.existsSync(file), false, "release removes the lock file");
});

test("remote and disabled endpoints are never serialized", async () => {
  const dir = tmp();
  assert.equal(
    await acquireModelLock({ endpoint: "https://api.example.com/v1", lockDir: dir }),
    null,
    "a remote endpoint has real concurrency — no lock",
  );
  assert.equal(
    await acquireModelLock({ endpoint: "http://localhost:8085", lockDir: dir, enabled: false }),
    null,
    "BANTAM_MODEL_LOCK=0 opts out",
  );
  assert.equal(fs.readdirSync(dir).length, 0, "no lock files were left behind");
});

test("release only removes a lock this process still owns", async () => {
  const dir = tmp();
  const file = modelLockPath({ endpoint: "http://localhost:8085", lockDir: dir });
  const lock = await acquireModelLock({ endpoint: "http://localhost:8085", lockDir: dir, pollMs: 20, slots: 1 });
  // Simulate a steal (e.g. this process was judged dead during a long GC pause):
  fs.writeFileSync(file, JSON.stringify({ pid: 4194305, startedAt: "2026-01-01T00:00:00Z" }));
  lock.release();
  assert.equal(fs.existsSync(file), true, "someone else's lock survives our release");
  fs.rmSync(file);
});

test("two distinct endpoints lock independently", async () => {
  const dir = tmp();
  const a = await acquireModelLock({ endpoint: "http://localhost:8085", lockDir: dir, pollMs: 20, slots: 1 });
  const b = await acquireModelLock({ endpoint: "http://127.0.0.1:18086", lockDir: dir, pollMs: 20, slots: 1 });
  assert.ok(a && b, "different servers do not serialize against each other");
  a.release(); b.release();
});
