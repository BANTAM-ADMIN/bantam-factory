import assert from "node:assert/strict";
import test from "node:test";

import { ReadLedger } from "../src/read-ledger.js";

// Measured 2026-08-15 (ticket A parity runs): eight identical whole-file reads
// of src/gate-policy.js in one 30-turn run. Whole-file reads were exempt from
// ledger coverage ("extent unknown without reading"), and the duplicate-action
// guard was gated on panel completeness — which truncation had disabled. Both
// defences were off at once.

test("a whole file read once is provably covered until it changes", () => {
  const ledger = new ReadLedger();
  assert.equal(ledger.fullyRead("src/x.js"), false, "unknown file is not covered");

  ledger.note("src/x.js", 1, 178, 178);          // observation: "(178 lines, showing 1-178)"
  assert.equal(ledger.fullyRead("src/x.js"), true, "the whole file is on record");

  ledger.invalidate("src/x.js");                  // an edit landed
  assert.equal(ledger.fullyRead("src/x.js"), false, "an edit clears the record");
});

test("a partial read does not claim whole-file coverage", () => {
  const ledger = new ReadLedger();
  ledger.note("src/x.js", 1, 60, 178);
  assert.equal(ledger.fullyRead("src/x.js"), false);
  ledger.note("src/x.js", 61, 178, 178);          // the rest, in a second read
  assert.equal(ledger.fullyRead("src/x.js"), true, "unioned ranges cover the file");
});

test("totals are only trusted from a real observation header", () => {
  const ledger = new ReadLedger();
  ledger.note("src/x.js", 1, 10);                 // no total stated
  assert.equal(ledger.fullyRead("src/x.js"), false);
});

test("a repeated RANGED read is covered the same way an inspect sub-op is", () => {
  const ledger = new ReadLedger();
  ledger.note("src/x.js", 1, 100, 178);
  // The exact range again — the stall observed on the fifth parity run.
  assert.equal(ledger.covers("src/x.js", 1, 100), true);
  // A genuinely new range is not covered and must execute.
  assert.equal(ledger.covers("src/x.js", 101, 178), false);
  ledger.invalidate("src/x.js");
  assert.equal(ledger.covers("src/x.js", 1, 100), false, "an edit reopens everything");
});
