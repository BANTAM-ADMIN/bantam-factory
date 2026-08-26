import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLoadout, listLoadouts, findLoadout, captureLiveLoadout, loadoutHash, renderLoadout } from "../src/logic/loadouts.js";

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadouts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "loadouts.json");
}

const ARGS = ["/bin/llama-server", "-m", "model.gguf", "--ctx-size", "112000", "--parallel", "1"];

test("repeat sightings dedup by argv hash; probes fill in without erasing", (t) => {
  const file = rig(t);
  recordLoadout({ args: ARGS, ctx: 112064 }, { file, at: "2026-08-19T01:00:00Z" });
  recordLoadout({ args: ARGS, vramMb: 22930 }, { file, at: "2026-08-19T02:00:00Z" });
  const all = listLoadouts({ file });
  assert.equal(all.length, 1);
  assert.equal(all[0].count, 2);
  assert.equal(all[0].ctx, 112064, "earlier probe survives");
  assert.equal(all[0].vramMb, 22930, "later probe fills in");
  assert.equal(all[0].firstSeen, "2026-08-19T01:00:00Z");
});

test("selection by index, full hash, and hash prefix", (t) => {
  const file = rig(t);
  recordLoadout({ args: ARGS }, { file, at: "2026-08-19T01:00:00Z" });
  recordLoadout({ args: [...ARGS, "--kv-unified"] }, { file, at: "2026-08-19T02:00:00Z" });
  const all = listLoadouts({ file });
  assert.equal(all[0].lastSeen > all[1].lastSeen, true, "newest first");
  assert.equal(findLoadout("2", { file }).hash, all[1].hash);
  assert.equal(findLoadout(all[0].hash.slice(0, 4), { file }).hash, all[0].hash);
  assert.equal(findLoadout("zzzz", { file }), null);
});

test("live capture reads the process argv, probes, and records", (t) => {
  const file = rig(t);
  const exec = (cmd, args) => {
    if (cmd === "fuser") return " 4242 ";
    if (cmd === "ps") return "/usr/bin/llama-server -m big.gguf --ctx-size 140000";
    if (cmd === "nvidia-smi") return "4242, 22884";
    throw new Error(`unexpected ${cmd}`);
  };
  const got = captureLiveLoadout({ exec, probeSlots: () => ({ slots: 4, ctx: 140032 }), file });
  assert.equal(got.vramMb, 22884);
  const rec = listLoadouts({ file })[0];
  assert.equal(rec.slots, 4);
  assert.match(renderLoadout(rec), /big\.gguf · ctx 140032 · 4 slots · 22\.3 GB · seen 1x/);
});

test("no server on the port means null, never a crash", (t) => {
  const file = rig(t);
  const got = captureLiveLoadout({ exec: () => { throw new Error("nothing there"); }, file });
  assert.equal(got, null);
  assert.equal(listLoadouts({ file }).length, 0);
});
