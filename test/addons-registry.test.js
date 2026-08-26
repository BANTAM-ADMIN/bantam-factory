// Add-ons are the repo's boundary: the harness ships none of them, lists all
// of them honestly (sizes included), and the scaffolded start script delegates
// to the certified profile when a model+GPU are present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS, renderAddons } from "../src/addons.js";
import { buildStartScript } from "../src/doctor.js";
import { DEFAULT_REPO, EXTRAS } from "../src/provision.js";

test("the default model is the stock, ungated, Apache-2.0 repo", () => {
  assert.equal(DEFAULT_REPO, "ggml-org/Qwen3.8-27B-GGUF");
  assert.ok(!/uncensored|heretic|abliterat/i.test(DEFAULT_REPO), "no fine-tune taint in the default");
  assert.match(EXTRAS.vision.file, /^mmproj-/);
  assert.match(EXTRAS.mtp.file, /^mtp-/);
});

test("every add-on renders with a status and an install path", () => {
  const out = renderAddons();
  for (const a of ADDONS) assert.ok(out.includes(a.name), a.name);
  assert.match(out, /never in the repo/);
  assert.match(out, /GB/);
});

test("scaffold delegates to the certified profile when model+GPU exist", () => {
  const s = buildStartScript({ ggufs: ["/models/m.gguf"], gpu: { name: "RTX", memMB: 24000 }, llama: "/usr/bin/llama-server" });
  assert.match(s, /launch-profiles\/local-gguf\.sh/);
  assert.match(s, /export MODEL="\/models\/m\.gguf"/);
  assert.match(s, /certified launch profile/);
});

test("the TODO template survives for the no-model and CPU cases", () => {
  const none = buildStartScript({ ggufs: [], gpu: null });
  assert.match(none, /# TODO/);
  const cpu = buildStartScript({ ggufs: ["/models/m.gguf"], gpu: null });
  assert.match(cpu, /n-gpu-layers 0|CPU-only/);
});
