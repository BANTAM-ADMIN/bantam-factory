const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = process.env.CANDIDATE_ROOT;
const load = (name) => import(
  `${pathToFileURL(path.join(root, "src", "adapters", `${name}.js`)).href}?t=${Date.now()}-${Math.random()}`
);
const rejectsTypeError = (fn) => assert.throws(fn, TypeError);

test("normalizes identifiers, counts, and booleans strictly", async () => {
  const { normalizeId } = await load("id");
  assert.equal(normalizeId("  alpha  "), "alpha");
  for (const value of ["", "   ", null, 3]) rejectsTypeError(() => normalizeId(value));

  const { parseCount } = await load("count");
  for (const [input, expected] of [[0, 0], [12, 12], [" 007 ", 7]]) {
    assert.equal(parseCount(input), expected);
  }
  for (const value of [-1, 1.5, "-1", "+1", "1.0", "1x", "", null]) {
    rejectsTypeError(() => parseCount(value));
  }

  const { parseEnabled } = await load("enabled");
  for (const [input, expected] of [[true, true], [false, false], [" TRUE ", true], ["false", false]]) {
    assert.equal(parseEnabled(input), expected);
  }
  for (const value of [1, 0, "yes", "", null]) rejectsTypeError(() => parseEnabled(value));
});

test("normalizes collections without mutation or prototype hazards", async () => {
  const { normalizeTags } = await load("tags");
  const tags = [" a ", "", "b", "a", " b ", "c"];
  const copy = [...tags];
  assert.deepEqual(normalizeTags(tags), ["a", "b", "c"]);
  assert.deepEqual(tags, copy);
  for (const value of [null, "a", ["ok", 2]]) rejectsTypeError(() => normalizeTags(value));

  const { normalizeHeaders } = await load("headers");
  const headers = JSON.parse('{" X-Trace ":" yes ","constructor":"bad","prototype":"bad","__proto__":"bad"}');
  assert.deepEqual(normalizeHeaders(headers), { "x-trace": "yes" });
  rejectsTypeError(() => normalizeHeaders([]));
  rejectsTypeError(() => normalizeHeaders({ ok: 2 }));
  assert.equal({}.bad, undefined);
});

test("normalizes dates, email addresses, levels, and methods", async () => {
  const { normalizeDate } = await load("date");
  const date = new Date("2026-03-04T05:06:07.000Z");
  assert.equal(normalizeDate(date), "2026-03-04T05:06:07.000Z");
  assert.equal(date.toISOString(), "2026-03-04T05:06:07.000Z");
  assert.equal(normalizeDate("2026-03-04T05:06:07Z"), "2026-03-04T05:06:07.000Z");
  for (const value of ["nope", new Date(NaN), 0, null]) rejectsTypeError(() => normalizeDate(value));

  const { normalizeEmail } = await load("email");
  assert.equal(normalizeEmail(" User@Example.COM "), "user@example.com");
  for (const value of ["a", "@host", "a@", "a@b@c", "", null]) rejectsTypeError(() => normalizeEmail(value));

  const { normalizeLevel } = await load("level");
  assert.equal(normalizeLevel(" WARN "), "warn");
  for (const value of ["trace", "", null]) rejectsTypeError(() => normalizeLevel(value));

  const { normalizeMethod } = await load("method");
  assert.equal(normalizeMethod(" patch "), "PATCH");
  assert.equal(normalizeMethod("head"), "HEAD");
  for (const value of ["CONNECT", "", null]) rejectsTypeError(() => normalizeMethod(value));
});

test("normalizes pagination, coordinates, and retry policy without mutation", async () => {
  const { normalizePage } = await load("page");
  assert.deepEqual(normalizePage(), { offset: 0, limit: 50 });
  const page = { offset: 0, limit: 100 };
  assert.deepEqual(normalizePage(page), page);
  assert.notEqual(normalizePage(page), page);
  for (const value of [[], { offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: 1.5 }]) {
    rejectsTypeError(() => normalizePage(value));
  }

  const { normalizeCoordinates } = await load("coordinates");
  const coordinates = { latitude: 90, longitude: -180 };
  assert.deepEqual(normalizeCoordinates(coordinates), coordinates);
  assert.notEqual(normalizeCoordinates(coordinates), coordinates);
  for (const value of [
    null, [], { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 },
    { latitude: "1", longitude: 2 }, { latitude: NaN, longitude: 2 },
  ]) rejectsTypeError(() => normalizeCoordinates(value));

  const { normalizeRetry } = await load("retry");
  assert.deepEqual(normalizeRetry(), { attempts: 3, delayMs: 0 });
  const retry = { attempts: 1, delayMs: 0 };
  assert.deepEqual(normalizeRetry(retry), retry);
  assert.notEqual(normalizeRetry(retry), retry);
  for (const value of [[], { attempts: 0 }, { attempts: 1.5 }, { delayMs: -1 }, { delayMs: 1.5 }]) {
    rejectsTypeError(() => normalizeRetry(value));
  }
});
