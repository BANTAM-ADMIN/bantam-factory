// Hidden contract for retry-consolidation.
//
// A DESIGN task: three clients duplicate retry logic that differs in ways easy to
// flatten by accident. Billing retries 503/429 four times with exponential backoff
// from 50ms; search retries 503/429/504 three times from 20ms; audit retries
// 503/429 five times with FLAT 10ms backoff because its writes are idempotent.
//
// Grading a design means grading two things at once. Behaviour must be preserved
// exactly -- a unification that quietly gives audit exponential backoff, or grants
// billing the 504 retry, has changed production semantics. And the duplication
// must actually be gone: a refactor that leaves three retry loops in place while
// adding a fourth shared one is worse than not refactoring.
//
// The structural check is deliberately narrow: client modules must not schedule
// their own waits. That is the load-bearing half of the duplicated logic, and it
// cannot be satisfied by renaming.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = process.env.CANDIDATE_ROOT;
const load = (rel) => import(
  `${pathToFileURL(path.join(root, rel)).href}?t=${Date.now()}-${Math.random()}`
);

function failing(status, times) {
  let n = 0;
  const calls = [];
  return {
    calls,
    transport: async (req) => {
      calls.push({ req, at: Date.now() });
      if (n++ < times) {
        const error = new Error(`status ${status}`);
        error.status = status;
        throw error;
      }
      return { ok: true };
    },
  };
}

const CLIENTS = [
  { rel: "src/clients/billing.js", fn: "chargeCard", attempts: 4 },
  { rel: "src/clients/search.js", fn: "query", attempts: 3 },
  { rel: "src/clients/audit.js", fn: "append", attempts: 5 },
];

test("each client keeps its own attempt budget", { timeout: 30000 }, async () => {
  for (const client of CLIENTS) {
    const mod = await load(client.rel);
    const t = failing(503, 99);
    await assert.rejects(mod[client.fn]({ x: 1 }, t.transport));
    assert.equal(t.calls.length, client.attempts,
      `${client.fn} must still make exactly ${client.attempts} attempts`);
  }
});

test("each client keeps its own retryable status set", { timeout: 30000 }, async () => {
  const billing = await load("src/clients/billing.js");
  const search = await load("src/clients/search.js");
  const audit = await load("src/clients/audit.js");

  // 504 is transient for search only.
  const s = failing(504, 1);
  assert.deepEqual(await search.query({ q: 1 }, s.transport), { ok: true });
  assert.equal(s.calls.length, 2);

  for (const [name, mod, fn] of [["billing", billing, "chargeCard"], ["audit", audit, "append"]]) {
    const t = failing(504, 99);
    await assert.rejects(mod[fn]({ x: 1 }, t.transport));
    assert.equal(t.calls.length, 1, `${name} must not treat 504 as transient`);
  }

  // Nothing retries a plain 500 or a 4xx that is not 429.
  for (const status of [500, 502, 400, 402]) {
    for (const [mod, fn] of [[billing, "chargeCard"], [search, "query"], [audit, "append"]]) {
      const t = failing(status, 99);
      await assert.rejects(mod[fn]({ x: 1 }, t.transport));
      assert.equal(t.calls.length, 1, `${fn} must not retry status ${status}`);
    }
  }
});

test("audit stays flat while billing stays exponential", { timeout: 30000 }, async () => {
  const audit = await load("src/clients/audit.js");
  const billing = await load("src/clients/billing.js");

  const a = failing(503, 99);
  const auditStart = Date.now();
  await assert.rejects(audit.append({ x: 1 }, a.transport));
  const auditMs = Date.now() - auditStart;

  const b = failing(503, 99);
  const billingStart = Date.now();
  await assert.rejects(billing.chargeCard({ x: 1 }, b.transport));
  const billingMs = Date.now() - billingStart;

  // Flat 10ms x4 is ~40ms; exponential from 10ms would already be ~150ms.
  assert.ok(auditMs < 120, `audit backoff must remain flat, took ${auditMs}ms`);
  // Exponential 50/100/200 is ~350ms and must not have been flattened away.
  assert.ok(billingMs > 250, `billing backoff must remain exponential, took ${billingMs}ms`);
  assert.ok(billingMs > auditMs * 2,
    `billing must back off far harder than audit (${billingMs}ms vs ${auditMs}ms)`);
});

test("the rejection that propagates is the last one seen", { timeout: 30000 }, async () => {
  const billing = await load("src/clients/billing.js");
  const seen = [];
  const transport = async () => {
    const error = new Error(`attempt ${seen.length}`);
    error.status = 503;
    seen.push(error);
    throw error;
  };
  await assert.rejects(billing.chargeCard({ x: 1 }, transport), (thrown) => {
    assert.strictEqual(thrown, seen[seen.length - 1],
      "the final error must propagate by identity, not the first");
    return true;
  });
});

// The design half. Duplication must be gone, not merely joined by a fourth copy.
test("the retry policy lives outside the clients", { timeout: 30000 }, async () => {
  const offenders = [];
  for (const client of CLIENTS) {
    const source = fs.readFileSync(path.join(root, client.rel), "utf8");
    if (/setTimeout/.test(source)) offenders.push(`${client.rel} still schedules its own backoff`);
  }
  assert.deepEqual(offenders, [],
    `retry waiting must be shared, not repeated per client:\n  ${offenders.join("\n  ")}`);

  const shared = fs.readdirSync(path.join(root, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => fs.readFileSync(path.join(root, "src", entry.name), "utf8"));
  assert.ok(shared.some((text) => /setTimeout/.test(text)),
    "a shared module under src/ must own the backoff");
});
