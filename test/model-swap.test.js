// The swap verb's contract: aliases resolve through the registry, stop
// precedes start, wall time is measured, unknown names refuse with guidance.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { swapModel, resolveModelTarget, MODEL_ALIASES } from "../src/model-launcher.js";

function withRegistry(t, models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swapreg-"));
  process.env.BANTAM_SWAP_LEDGER = path.join(dir, "ledger.json"); // isolate from the machine's real ledger
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BANTAM_MODELS; delete process.env.BANTAM_SWAP_LEDGER; });
  const file = path.join(dir, "models.json");
  // listModels filters on script existence — point scripts at real files.
  for (const m of models) { m.script = path.join(dir, `${m.name}.sh`); fs.writeFileSync(m.script, "#!/bin/bash\n"); }
  fs.writeFileSync(file, JSON.stringify(models));
  process.env.BANTAM_MODELS = file;
}

test("aliases resolve to registry entries; unknown names return null", (t) => {
  withRegistry(t, [{ name: "bantam-q4", endpoint: "http://x:1" }, { name: "bantam-q4-crew", endpoint: "http://x:2" }]);
  assert.equal(resolveModelTarget("solo").name, MODEL_ALIASES.solo);
  assert.equal(resolveModelTarget("crew").name, "bantam-q4-crew");
  assert.equal(resolveModelTarget("bantam-q4").name, "bantam-q4");
  assert.equal(resolveModelTarget("nonsense"), null);
});

test("swap stops the endpoint, starts the target, and measures wall time", async (t) => {
  withRegistry(t, [{ name: "bantam-q4-crew", endpoint: "http://x:2" }]);
  const calls = [];
  let clock = 1000;
  const r = await swapModel("crew", {
    out: () => {},
    stop: async (ep) => calls.push(["stop", ep]),
    start: async (target) => { calls.push(["start", target.name]); clock += 7300; return target.endpoint; },
    now: () => clock,
  });
  assert.deepEqual(calls, [["stop", "http://x:2"], ["start", "bantam-q4-crew"]]);
  assert.equal(r.ok, true);
  assert.equal(r.ms, 7300);
});

test("an unknown target refuses with the alias menu, touching nothing", async (t) => {
  withRegistry(t, [{ name: "bantam-q4", endpoint: "http://x:1" }]);
  const r = await swapModel("bogus", { stop: async () => { throw new Error("must not stop"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /solo, crew/);
});
