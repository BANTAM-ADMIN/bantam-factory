import assert from "node:assert/strict";
import test from "node:test";
import { chargeCard } from "../src/clients/billing.js";
import { query } from "../src/clients/search.js";
import { append } from "../src/clients/audit.js";

const fails = (status, times) => {
  let n = 0;
  const calls = [];
  return {
    calls,
    transport: async (req) => {
      calls.push({ req, at: Date.now() });
      if (n++ < times) { const e = new Error("boom"); e.status = status; throw e; }
      return { ok: true };
    },
  };
};

test("billing retries a 503 and succeeds", async () => {
  const t = fails(503, 2);
  assert.deepEqual(await chargeCard({ id: 1 }, t.transport), { ok: true });
  assert.equal(t.calls.length, 3);
});

test("billing gives up after 4 attempts", async () => {
  const t = fails(503, 99);
  await assert.rejects(chargeCard({ id: 1 }, t.transport));
  assert.equal(t.calls.length, 4, "billing makes at most 4 attempts");
});

test("billing never retries a declined card", async () => {
  const t = fails(402, 99);
  await assert.rejects(chargeCard({ id: 1 }, t.transport));
  assert.equal(t.calls.length, 1, "a non-transient status must not be retried");
});

test("search gives up after 3 attempts", async () => {
  const t = fails(503, 99);
  await assert.rejects(query({ q: "x" }, t.transport));
  assert.equal(t.calls.length, 3);
});

test("search retries a 504 but billing does not", async () => {
  const s = fails(504, 1);
  assert.deepEqual(await query({ q: "x" }, s.transport), { ok: true });
  assert.equal(s.calls.length, 2, "search treats a gateway timeout as transient");

  const b = fails(504, 1);
  await assert.rejects(chargeCard({ id: 1 }, b.transport));
  assert.equal(b.calls.length, 1, "billing does not");
});

test("audit gives up after 5 attempts", async () => {
  const t = fails(503, 99);
  await assert.rejects(append({ line: "x" }, t.transport));
  assert.equal(t.calls.length, 5);
});

test("audit backs off flat, not exponentially", async () => {
  const t = fails(503, 99);
  const started = Date.now();
  await assert.rejects(append({ line: "x" }, t.transport));
  const elapsed = Date.now() - started;
  // Four flat 10ms waits is ~40ms. Exponential from 10ms would be 10+20+40+80=150ms.
  assert.ok(elapsed < 120, `audit backoff must stay flat, took ${elapsed}ms`);
});

test("a successful first call never waits", async () => {
  for (const fn of [chargeCard, query, append]) {
    const t = fails(503, 0);
    const started = Date.now();
    await fn({ x: 1 }, t.transport);
    assert.ok(Date.now() - started < 30, `${fn.name} must not sleep on success`);
    assert.equal(t.calls.length, 1);
  }
});
