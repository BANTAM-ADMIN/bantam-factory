import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLoad, expectedLoadMs, renderExpectation, loadAnomaly } from "../src/logic/swap-ledger.js";

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "nested", "swap-ledger.json");
}

test("records accumulate, cap at 50, and yield a median expectation", (t) => {
  const file = rig(t);
  assert.equal(expectedLoadMs("crew", { file }), null, "no history yet");
  for (const ms of [8300, 8500, 7300, 15200]) recordLoad("crew", ms, { file });
  const e = expectedLoadMs("crew", { file });
  assert.equal(e.n, 4);
  assert.equal(e.medianMs, 8500);
  assert.match(renderExpectation("crew", { file }), /~8\.5s on this machine \(n=4\)/);
  for (let i = 0; i < 60; i++) recordLoad("crew", 8000, { file });
  assert.equal(expectedLoadMs("crew", { file }).n, 50, "history capped");
});

test("failed loads are recorded but never poison the expectation", (t) => {
  const file = rig(t);
  recordLoad("solo", 8000, { file });
  recordLoad("solo", 240000, { ok: false, file });
  assert.equal(expectedLoadMs("solo", { file }).medianMs, 8000);
});

test("anomaly fires only with history, only on a real spike", (t) => {
  const file = rig(t);
  recordLoad("crew", 8000, { file });
  recordLoad("crew", 8400, { file });
  assert.equal(loadAnomaly("crew", 60000, { file }), null, "n<3 stays silent");
  recordLoad("crew", 8200, { file });
  assert.equal(loadAnomaly("crew", 12000, { file }), null, "50% slower is unremarkable");
  assert.match(loadAnomaly("crew", 41000, { file }), /5\.0x this machine's usual/);
});

test("corrupt ledger reads as empty, never a crash", (t) => {
  const file = rig(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{broken");
  assert.equal(expectedLoadMs("crew", { file }), null);
  assert.equal(recordLoad("crew", 8000, { file }), true, "recovers by rewriting");
});
