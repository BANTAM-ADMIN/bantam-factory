import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSample, estimateMs, renderCard, bucketFor, setActiveProfile, activeProfile } from "../src/logic/model-cards.js";

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cards.json");
}

test("samples land in context buckets and EWMA toward recent behavior", (t) => {
  const file = rig(t);
  assert.equal(bucketFor(500), "0-8k");
  assert.equal(bucketFor(40000), "32-64k");
  recordSample("duo", { promptN: 500, promptMs: 200, genN: 300, genMs: 2800 }, { file });
  recordSample("duo", { promptN: 700, promptMs: 300, genN: 300, genMs: 2700 }, { file });
  const est = estimateMs("duo", { promptTokens: 600, genTokens: 100 }, { file });
  assert.ok(est.ms > 0 && est.ms < 5000, `sane estimate, got ${est.ms}`);
  assert.match(est.basis, /2 request/);
});

test("estimates fall back to the nearest learned band; unlearned profiles say null", (t) => {
  const file = rig(t);
  assert.equal(estimateMs("ghost", { promptTokens: 100 }, { file }), null);
  recordSample("duo", { promptN: 500, promptMs: 200, genN: 300, genMs: 3000 }, { file });
  const est = estimateMs("duo", { promptTokens: 50000, genTokens: 100 }, { file });
  assert.ok(est, "falls back to the 0-8k band rather than refusing");
});

test("cards render capabilities plus learned speeds, or admit ignorance", (t) => {
  const file = rig(t);
  const reg = { name: "duo", slots: 2, vision: true, vramMb: 22800, notes: "hybrid daily driver" };
  assert.match(renderCard(reg, { file }), /no runtime samples yet/);
  recordSample("duo", { promptN: 500, promptMs: 250, genN: 300, genMs: 2800 }, { file });
  const card = renderCard(reg, { file });
  assert.match(card, /2 slots · vision · ~22\.3 GB VRAM/);
  assert.match(card, /@0-8k: .*tok\/s.*ttft/);
});

test("active-profile marker round-trips", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cards-ap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "active.json");
  assert.equal(activeProfile(file), null);
  setActiveProfile("duo", file);
  assert.equal(activeProfile(file), "duo");
});
