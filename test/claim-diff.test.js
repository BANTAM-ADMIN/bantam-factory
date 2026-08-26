// The poisoned-shelf countermeasure: the harness diffs fact atoms between
// the cold and shelved answers, because the model declared "matches my
// recollection; no conflict" over a direct contradiction (2026-08-19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { factAtoms, diffClaims, renderClaimDiff } from "../src/logic/claim-diff.js";

const COLD = "TaskGroup was introduced in Python 3.11 and uses ExceptionGroup. GGML_TYPE_Q5_K = 13.";
const POISONED = "TaskGroup was added in Python 3.9 [S]. Also GGML_TYPE_Q5_K = 14 per the notes.";

test("the exact falsifier case is caught mechanically", () => {
  const c = diffClaims(COLD, POISONED);
  const version = c.find((x) => x.cls === "version" && x.anchor === "python");
  assert.ok(version, "python version conflict detected");
  assert.equal(version.coldValue, "3.11");
  assert.equal(version.shelvedValue, "3.9");
  const constant = c.find((x) => x.cls === "constant" && x.anchor === "ggml_type_q5_k");
  assert.ok(constant, "constant reassignment detected");
});

test("agreement produces no conflicts", () => {
  assert.deepEqual(diffClaims(COLD, COLD), []);
  assert.deepEqual(diffClaims("added in Python 3.11", "introduced in Python 3.11 [S]"), []);
});

test("the warning quotes both raw forms and names the harness as holder", () => {
  const out = renderClaimDiff(diffClaims(COLD, POISONED));
  assert.match(out, /previous answer said/);
  assert.match(out, /harness holds both/);
});

test("atoms extract the spec-numeric class", () => {
  const a = factAtoms("the scheme obfuscates the first 1040 bytes");
  assert.ok(a.some((x) => x.cls === "spec-numeric" && x.value === "1040"));
});

test("markdown emphasis does not hide atoms (live-validation regression)", () => {
  const cold = "`asyncio.TaskGroup` was introduced in **Python 3.11** (it depends on ExceptionGroup).";
  const poisoned = "[S] The note claims TaskGroup was added in **Python 3.9**.";
  const c = diffClaims(cold, poisoned);
  assert.ok(c.some((x) => x.cls === "version" && x.coldValue === "3.11" && x.shelvedValue === "3.9"));
});

test("natural declaratives carry atoms: version-first and copula phrasings", () => {
  const a = factAtoms("Python 3.11 introduced asyncio.TaskGroup.");
  assert.ok(a.some((x) => x.cls === "version" && x.anchor === "python" && x.value === "3.11"));
  const b = factAtoms("The numeric value of the GGML_TYPE_Q5_K enum is 14.");
  assert.ok(b.some((x) => x.cls === "constant" && x.anchor === "ggml_type_q5_k" && x.value === "14"));
});

test("config-default atoms: the q11 wild fixture (200M cold vs 1.6 billion shelved)", () => {
  const cold = "approaching `autovacuum_freeze_max_age` (default **200,000,000**; multixact 400,000,000).";
  const shelved = "the safety net (default `autovacuum_freeze_max_age` = 1.6 billion XIDs).";
  const c = diffClaims(cold, shelved);
  assert.ok(c.some((x) => x.cls === "config-default" && x.anchor === "autovacuum_freeze_max_age"
    && x.coldValue === "200000000" && x.shelvedValue === "1600000000"),
    JSON.stringify(c));
});
