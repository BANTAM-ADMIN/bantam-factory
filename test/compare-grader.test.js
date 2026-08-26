import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTap, gradeArm } from "../src/logic/compare-grader.js";

// `bantam compare` reported the VISIBLE verify result as its "contract":
// `{ passed: publicResult.pass ? 1 : 0, tests: 1 }`. Two arms that both make the
// visible suite green are then indistinguishable however differently they solved
// the problem -- the weak-oracle failure this codebase keeps rediscovering. A
// head-to-head is only worth rendering if it is graded on something the
// competitors could not optimise against.

describe("reading a grader's TAP", () => {
  it("prefers the authoritative summary lines", () => {
    const r = parseTap("ok 1 - a\nnot ok 2 - b\n# pass 1\n# fail 1\n");
    assert.equal(r.passed, 1);
    assert.equal(r.tests, 2);
    assert.deepEqual(r.failures, ["b"]);
  });

  it("falls back to counting when no summary is present", () => {
    const r = parseTap("ok 1 - a\nok 2 - b\nnot ok 3 - c\n");
    assert.equal(r.passed, 2);
    assert.equal(r.tests, 3);
    assert.deepEqual(r.failures, ["c"]);
  });

  it("survives empty output without inventing passes", () => {
    assert.deepEqual(parseTap(""), { passed: 0, tests: 0, failures: [] });
  });
});

describe("grading an arm against a hidden contract", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmp-grade-"));

  it("runs the grader against the arm workspace via CANDIDATE_ROOT", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "a.js"), "export const answer = 42;\n");

    const graderDir = tmp();
    fs.writeFileSync(path.join(graderDir, "contract.test.mjs"), `
      import test from "node:test";
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      test("answer is 42", async () => {
        const m = await import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/a.js")).href);
        assert.equal(m.answer, 42);
      });
    `);

    const result = gradeArm(ws, graderDir);
    assert.equal(result.available, true);
    assert.equal(result.tests, 1);
    assert.equal(result.passed, 1);
  });

  it("reports failures rather than throwing when the arm is wrong", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "a.js"), "export const answer = 7;\n");

    const graderDir = tmp();
    fs.writeFileSync(path.join(graderDir, "contract.test.mjs"), `
      import test from "node:test";
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      test("answer is 42", async () => {
        const m = await import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/a.js")).href);
        assert.equal(m.answer, 42);
      });
    `);

    const result = gradeArm(ws, graderDir);
    assert.equal(result.available, true);
    assert.equal(result.passed, 0);
    assert.equal(result.tests, 1);
    assert.deepEqual(result.failures, ["answer is 42"]);
  });

  // Absent is not zero: a missing grader reporting 0/0 would read as a clean
  // sheet for every arm, which is how a comparison silently becomes meaningless.
  it("says it is unavailable rather than scoring 0/0", () => {
    const r = gradeArm(tmp(), path.join(os.tmpdir(), "definitely-not-here"));
    assert.equal(r.available, false);
    assert.equal(r.tests, 0);
  });
});
