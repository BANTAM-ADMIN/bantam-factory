import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCalcResults, runCalcSetup } from "../src/factory.js";

const value = (run, name) => run.results.find((row) => row.name === name)?.value;

describe("factory calculator gauge", () => {
  it("computes arithmetic, percentages, separators and earlier names exactly", () => {
    const run = runCalcSetup([
      "threshold = 80% * 12,000",
      "net = $9,976.70 - 600",
      "after = net + 223.30",
      "capped = min(21400, 15000)",
      "big = 1,234,567.5 + 0",
      "tight = max(1,2)",
      "share = round(after / threshold, 4)",
    ].join("\n"));
    assert.equal(value(run, "threshold"), 9600);
    assert.ok(Math.abs(value(run, "net") - 9376.7) < 1e-9);
    assert.ok(Math.abs(value(run, "after") - 9600) < 1e-9);
    assert.equal(value(run, "capped"), 15000);
    assert.equal(value(run, "big"), 1234567.5);
    assert.equal(value(run, "tight"), 2);
    assert.equal(value(run, "share"), 1);
    assert.deepEqual(run.errors, []);
  });

  it("counts calendar days and elapsed hours across a daylight-saving change", () => {
    const run = runCalcSetup([
      'window = days("2026-03-15", "2026-05-02")',
      'leap = days("2028-02-28", "2028-03-01")',
      'rest = hours("2026-10-24T18:00+02:00", "2026-10-25T04:30+01:00")',
      'utc = hours("2026-03-28T09:00-04:00", "2026-03-29T01:00+01:00")',
    ].join("\n"));
    assert.equal(value(run, "window"), 48);
    assert.equal(value(run, "leap"), 2);
    assert.equal(value(run, "rest"), 11.5);
    assert.equal(value(run, "utc"), 11);
  });

  it("reports bad lines instead of guessing and ignores prose", () => {
    const run = runCalcSetup([
      "Here is my setup:",
      "* a = 10 / 0",
      "b = nope(3)",
      'c = days("2026-02-30", "2026-03-01")',
      "d = undefined_name + 1",
      "e = 2 * (3 + 4)",
      "x == y",
    ].join("\n"));
    assert.deepEqual(run.errors.map((row) => row.name), ["a", "b", "c", "d"]);
    assert.equal(value(run, "e"), 14);
    assert.equal(run.results.length, 1);
  });

  it("never evaluates code: only the arithmetic grammar is accepted", () => {
    const run = runCalcSetup("x = process.exit(1)\ny = 1; 2\nz = `1`");
    assert.equal(run.results.length, 0);
    assert.equal(run.errors.length, 3);
  });

  it("formats results for the material", () => {
    const text = formatCalcResults(runCalcSetup("t = 80% * 12000\nr = 1 / 3").results);
    assert.match(text, /t = 80% \* 12000 {2}→ {2}9600/);
    assert.match(text, /r = 1 \/ 3 {2}→ {2}0\.333333/);
  });
});
