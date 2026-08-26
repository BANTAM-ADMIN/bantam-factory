// The canary kit's contract, verified without a model: the pristine kit is
// red by design (one comparison flipped), the holdout agrees with the FIXED
// behavior, and the task text points at the right motion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const KIT = path.resolve("bench/canary");
function suite(ws) {
  let out = "";
  try { out = execSync("npm test --silent 2>&1", { cwd: ws, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined } }); }
  catch (e) { out = String(e.stdout ?? ""); }
  return { pass: /# pass (\d+)/.exec(out)?.[1], fail: /# fail (\d+)/.exec(out)?.[1] };
}

test("pristine kit is red by design", () => {
  const r = suite(path.join(KIT, "materials"));
  assert.equal(r.fail, "1");
  assert.equal(r.pass, "1");
});

test("the intended one-line fix goes green, holdout included", (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "canary-kit-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.cpSync(path.join(KIT, "materials"), ws, { recursive: true });
  const p = path.join(ws, "src", "window.js");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("if (sum < best) best = sum;", "if (sum > best) best = sum;"));
  fs.copyFileSync(path.join(KIT, "holdout", "holdout.test.mjs"), path.join(ws, "test", ".holdout.test.mjs"));
  const r = suite(ws);
  assert.equal(r.fail, "0");
  assert.ok(Number(r.pass) >= 3, "visible + holdout all green");
});

test("task text demands the loop the canary exists to exercise", () => {
  const task = fs.readFileSync(path.join(KIT, "task.txt"), "utf8");
  assert.match(task, /red/i);
  assert.match(task, /npm test|pytest|suite/i);
});
