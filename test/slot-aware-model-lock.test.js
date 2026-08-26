// The multi-slot era contract: a server with N slots admits N concurrent
// runs, the N+1th waits, and a dead holder's slot is stolen. Capacity is
// injectable so tests never depend on what happens to be serving locally.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireModelLock, probeSlotCapacity } from "../src/model-lock.js";

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "slotlock-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("two slots admit two holders; the third waits until one releases", async (t) => {
  const lockDir = dir(t);
  const a = await acquireModelLock({ endpoint: "http://localhost:9099", lockDir, pollMs: 20, slots: 2 });
  const b = await acquireModelLock({ endpoint: "http://localhost:9099", lockDir, pollMs: 20, slots: 2 });
  assert.ok(a && b, "both acquired");
  assert.notEqual(a.path, b.path, "distinct slot files");
  let third = null;
  const thirdP = acquireModelLock({ endpoint: "http://localhost:9099", lockDir, pollMs: 20, slots: 2 }).then((l) => (third = l));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(third, null, "third holder waits at capacity");
  a.release();
  await thirdP;
  assert.ok(third, "third proceeds after a release");
  b.release(); third.release();
});

test("a dead holder's slot is stolen even at capacity 2", async (t) => {
  const lockDir = dir(t);
  const a = await acquireModelLock({ endpoint: "http://localhost:9099", lockDir, pollMs: 20, slots: 2 });
  // fake a dead second holder
  const corpse = a.path.replace(/\.lock$/, "") + ".slot1.lock";
  fs.writeFileSync(a.path.includes(".slot") ? a.path : corpse, JSON.stringify({ pid: 999999999, startedAt: "x" }));
  const b = await acquireModelLock({ endpoint: "http://localhost:9099", lockDir, pollMs: 20, slots: 2 });
  assert.ok(b, "corpse slot stolen");
  a.release(); b.release();
});

test("probeSlotCapacity: live count when the server answers, 1 when it cannot", async () => {
  assert.equal(await probeSlotCapacity("http://x", { fetchImpl: async () => ({ ok: true, json: async () => [{}, {}, {}, {}] }) }), 4);
  assert.equal(await probeSlotCapacity("http://x", { fetchImpl: async () => { throw new Error("down"); } }), 1);
  assert.equal(await probeSlotCapacity("http://x", { fetchImpl: async () => ({ ok: false }) }), 1);
});
