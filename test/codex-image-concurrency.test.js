// Concurrency has to fall as resolution rises.
//
// BANTAM shipped a flat MAX_VARIANTS = 4 with no notion of size at all. The
// operator's own batch drivers say otherwise: hell_inc_run_covers.py,
// hell_inc_gavel_variants.py and hell_inc_photoreal_set.py all generate at
// `--size 1600x2560 --quality high` with ThreadPoolExecutor(max_workers=3) and
// a 4-second pause before a retry. Four concurrent high-res jobs is a
// configuration that was deliberately not used.
//
// Only ONE point is measured — 1600x2560 at high quality wants 3 — so the rule
// below is conservative around it rather than pretending to a curve, and an env
// override exists for when the real ceiling is learned.
import assert from "node:assert/strict";
import test from "node:test";

import { imageConcurrencyCap, validateImageSize } from "../src/logic/codex-image.js";

test("the measured configuration gets the concurrency it was measured with", () => {
  assert.equal(imageConcurrencyCap({ size: "1600x2560", quality: "high" }), 3);
});

test("big images drop to 3 even at default quality", () => {
  assert.equal(imageConcurrencyCap({ size: "1600x2560" }), 3);
  assert.equal(imageConcurrencyCap({ size: "2048x2048" }), 3);
});

test("high quality drops to 3 even at a modest size — their batches were all high", () => {
  assert.equal(imageConcurrencyCap({ size: "1024x1024", quality: "high" }), 3);
});

test("small or unspecified work keeps the full four", () => {
  assert.equal(imageConcurrencyCap({}), 4);
  assert.equal(imageConcurrencyCap({ size: "auto" }), 4);
  assert.equal(imageConcurrencyCap({ size: "1024x1024" }), 4);
});

test("an operator override wins, because the real ceiling is not fully known", () => {
  assert.equal(imageConcurrencyCap({ size: "1600x2560", env: { BANTAM_CODEX_IMAGE_CONCURRENCY: "1" } }), 1);
  assert.equal(imageConcurrencyCap({ env: { BANTAM_CODEX_IMAGE_CONCURRENCY: "2" } }), 2);
  // Never above the hard ceiling, whatever anyone types.
  assert.equal(imageConcurrencyCap({ env: { BANTAM_CODEX_IMAGE_CONCURRENCY: "99" } }), 4);
  assert.equal(imageConcurrencyCap({ env: { BANTAM_CODEX_IMAGE_CONCURRENCY: "junk" } }), 4);
});

test("size validation matches the backend's real constraints", () => {
  assert.equal(validateImageSize("auto").ok, true);
  assert.equal(validateImageSize("1600x2560").ok, true);
  // multiples of 16
  assert.match(validateImageSize("1000x1001").error, /multiple of 16/i);
  // pixel floor and ceiling
  assert.match(validateImageSize("128x128").error, /pixel/i);
  assert.match(validateImageSize("4096x4096").error, /pixel/i);
  // aspect ratio 1:3 .. 3:1
  assert.match(validateImageSize("512x2560").error, /aspect/i);
  assert.match(validateImageSize("nonsense").error, /auto or WIDTHxHEIGHT/i);
});

test("a 4-variant request at high resolution actually runs 3, and says so", async () => {
  const { codexImageEditTool } = await import("../src/logic/codex-image.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "img-cap-"));
  fs.mkdirSync(path.join(ws, "assets"), { recursive: true });
  fs.writeFileSync(path.join(ws, "assets", "a.png"), "x");
  let live = 0; let peak = 0;
  const tool = codexImageEditTool(ws, {
    runtimeFactory: () => ({
      close() {},
      async generateImage(prompt) {
        live += 1; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 20));
        live -= 1;
        const out = path.join(ws, `o${Math.random()}.png`);
        fs.writeFileSync(out, "x");
        assert.match(prompt, /1600x2560/, "the requested size must reach the worker");
        return { savedPath: out, status: "completed", usage: null };
      },
    }),
  });
  const out = await tool.answer("edit_image assets/a.png make it stormy --variants=4 --size 1600x2560 --quality high");
  assert.equal(peak, 3, "four concurrent high-res jobs is the configuration their drivers avoided");
  assert.match(out, /ran 3 at a time, not 4/);
  fs.rmSync(ws, { recursive: true, force: true });
});
