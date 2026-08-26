// One judge for every card: instrument.json is the card's strongest
// instrument as DATA, and this runner is the only judge. Born from two
// hand-wired-judge faults in one night (missing data file; self-graded oracle).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const JUDGE = path.resolve("bin/judge-card.mjs");
function run(kit, ws) {
  try { return JSON.parse(execFileSync("node", [JUDGE, kit, ws], { encoding: "utf8" })); }
  catch (e) { return JSON.parse(String(e.stdout).trim().split("\n").pop()); }
}
function mk(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-judge-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body);
  }
  return d;
}

test("truth-file kind: byte match rules, trailing newline forgiven", (t) => {
  const kit = mk({ "instrument.json": JSON.stringify({ card: "x", checks: [{ kind: "truth-file", run: "node out.js", file: "truth.txt" }] }), "truth.txt": "a=1\nb=2\n" });
  const good = mk({ "out.js": 'console.log("a=1\\nb=2");' });
  const bad = mk({ "out.js": 'console.log("a=1\\nb=9");' });
  t.after(() => { for (const d of [kit, good, bad]) fs.rmSync(d, { recursive: true, force: true }); });
  assert.equal(run(kit, good).verdict, "EXACT");
  assert.equal(run(kit, bad).verdict, "MISS");
});

test("holdout kind: sealed test installs (with data), runs, and cleans up", (t) => {
  const kit = mk({
    "instrument.json": JSON.stringify({ card: "x", checks: [{ kind: "holdout", test: "holdout/h.test.mjs", data: "holdout/h.json" }] }),
    "holdout/h.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs";\nimport { v } from "../src/m.mjs";\ntest("sealed", () => { const d = JSON.parse(fs.readFileSync(new URL("./holdout.data.json", import.meta.url), "utf8")); assert.equal(v, d.expect); });',
    "holdout/h.json": JSON.stringify({ expect: 7 }),
  });
  const good = mk({ "package.json": '{"type":"module","scripts":{"test":"node --test test/"}}', "src/m.mjs": "export const v = 7;", "test/.keep": "" });
  const bad = mk({ "package.json": '{"type":"module","scripts":{"test":"node --test test/"}}', "src/m.mjs": "export const v = 8;", "test/.keep": "" });
  t.after(() => { for (const d of [kit, good, bad]) fs.rmSync(d, { recursive: true, force: true }); });
  assert.equal(run(kit, good).verdict, "EXACT");
  assert.equal(run(kit, bad).verdict, "MISS");
  assert.ok(!fs.existsSync(path.join(good, "test/.holdout.mjs")), "holdout cleaned up");
});

test("reference-bytes kind: any arg mismatch is a MISS naming the arg", (t) => {
  const kit = mk({
    "instrument.json": JSON.stringify({ card: "x", checks: [{ kind: "reference-bytes", run: "node r.js {arg}", reference: "node ref.js {arg}", args: ["1", "2"] }] }),
    "ref.js": "console.log('v'+process.argv[2]);",
  });
  const good = mk({ "r.js": "console.log('v'+process.argv[2]);" });
  const bad = mk({ "r.js": "console.log(process.argv[2]==='2'?'x':'v'+process.argv[2]);" });
  t.after(() => { for (const d of [kit, good, bad]) fs.rmSync(d, { recursive: true, force: true }); });
  assert.equal(run(kit, good).verdict, "EXACT");
  const r = run(kit, bad);
  assert.equal(r.verdict, "MISS");
  assert.deepEqual(r.legs.referenceMismatch, ["2"]);
});
