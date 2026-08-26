// `edit_image` — send an existing workspace image to Codex with an instruction.
//
// BANTAM could generate images and describe them, but not CHANGE one. The
// mechanism was already in the transport: describeImage attaches an image with
// inputItems: [{type:"localImage", path, detail}], and generateImage simply
// never passed references through. Editing is generation with the source image
// attached -- the same shape the operator's own imggen experiments use
// (codex_imagegen.py builds input_image parts alongside the prompt text).
//
// The tool is workspace-scoped like every other: a path outside the workspace is
// refused rather than silently read, because the image worker is deliberately
// forbidden from touching the workspace itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { parseEditRequest, codexImageEditTool } from "../src/logic/codex-image.js";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "img-edit-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "cover.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return root;
}

test("the request splits into a source path, an instruction, and variants", () => {
  const r = parseEditRequest("assets/cover.png make the sky stormy --variants=2");
  assert.equal(r.source, "assets/cover.png");
  assert.equal(r.instruction, "make the sky stormy");
  assert.equal(r.variants, 2);
});

test("a quoted path with spaces survives", () => {
  const r = parseEditRequest('"my art/cover 1.png" add a border');
  assert.equal(r.source, "my art/cover 1.png");
  assert.equal(r.instruction, "add a border");
});

test("variants are clamped to the concurrency the worker allows", () => {
  assert.equal(parseEditRequest("a.png x --variants=99").variants, 4);
  assert.equal(parseEditRequest("a.png x --variants=0").variants, 1);
  assert.equal(parseEditRequest("a.png x").variants, 1);
});

test("usage is returned when either half is missing", async () => {
  const tool = codexImageEditTool(workspace(), {});
  assert.match(await tool.answer("edit_image"), /usage: edit_image/);
  assert.match(await tool.answer("edit_image assets/cover.png"), /usage: edit_image/);
});

test("a path outside the workspace is refused, not read", async () => {
  const tool = codexImageEditTool(workspace(), {});
  const out = await tool.answer("edit_image ../../etc/passwd make it blue");
  assert.match(out, /outside workspace/i);
});

test("a missing source names the path instead of failing obscurely", async () => {
  const tool = codexImageEditTool(workspace(), {});
  assert.match(await tool.answer("edit_image assets/nope.png make it blue"), /no image at .*nope\.png/i);
});

test("the source image rides to Codex as a localImage reference", async () => {
  const ws = workspace();
  const seen = [];
  const tool = codexImageEditTool(ws, {
    runtimeFactory: () => ({
      close() {},
      async generateImage(prompt, opts) {
        seen.push({ prompt, references: opts.references });
        const out = path.join(ws, "out.png");
        fs.writeFileSync(out, "x");
        return { savedPath: out, status: "completed", usage: null };
      },
    }),
  });
  const out = await tool.answer("edit_image assets/cover.png make the sky stormy");
  assert.equal(seen.length, 1);
  assert.match(seen[0].prompt, /stormy/);
  assert.deepEqual(seen[0].references, [path.join(ws, "assets", "cover.png")],
    "the edit must carry the ORIGINAL image, or it is just a fresh generation");
  assert.match(out, /assets\/generated\//);
});
