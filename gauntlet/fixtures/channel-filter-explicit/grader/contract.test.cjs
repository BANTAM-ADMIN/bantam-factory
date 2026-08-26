const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(process.cwd(), "src/channel-filter.js"));
const rejectsTypeError = (fn) => assert.throws(fn, TypeError);

test("normalizes channels strictly, without coercing or mutating", async () => {
  const { normalizeChannels } = await load();

  assert.deepEqual(normalizeChannels([" Email ", "SMS", "email"]), ["email", "sms"]);
  assert.deepEqual(normalizeChannels(["a", "", "  "]), ["a"]);

  const input = [" Email ", "sms"];
  const copy = input.slice();
  normalizeChannels(input);
  assert.deepEqual(input, copy, "must not mutate its input");

  // An accepted type is a contract, not a suggestion: anything outside it throws.
  for (const value of [null, undefined, "email", 7, {}, ["ok", 2], ["ok", null]]) {
    rejectsTypeError(() => normalizeChannels(value));
  }
});

test("normalizes delivery flags strictly, without coercing", async () => {
  const { normalizeDelivery } = await load();

  assert.deepEqual(normalizeDelivery({ " Push ": true, SMS: false }), { push: true, sms: false });

  const input = { push: true };
  const copy = { ...input };
  const result = normalizeDelivery(input);
  assert.deepEqual(input, copy, "must not mutate its input");
  assert.notEqual(result, input, "must return a new object");

  // A plain object of booleans. Arrays, null and truthy non-booleans are not that.
  for (const value of [null, undefined, [], "push", 3, { push: "yes" }, { push: 1 }]) {
    rejectsTypeError(() => normalizeDelivery(value));
  }
});
