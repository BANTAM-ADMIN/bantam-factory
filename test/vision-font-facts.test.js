import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexViewImageTool, systemFonts, viewImageTool } from "../src/logic/vision.js";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fonts-"));
}

test("systemFonts: finds fonts and respects the limit", () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  for (const n of ["one.ttf", "two.otf", "three.ttc", "notes.txt"]) {
    fs.writeFileSync(path.join(root, "a", "b", n), "x");
  }
  const found = systemFonts({ dirs: [root] });
  assert.equal(found.length, 3, "picks up ttf/otf/ttc and skips non-fonts");
  assert.equal(systemFonts({ dirs: [root], limit: 2 }).length, 2);
});

test("systemFonts: a missing directory is not an error", () => {
  assert.deepEqual(systemFonts({ dirs: ["/definitely/not/here"] }), []);
});

test("systemFonts: the bounded walk does not descend forever", () => {
  const root = scratch();
  const deep = path.join(root, "1", "2", "3", "4", "5", "6");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.ttf"), "x");
  assert.deepEqual(systemFonts({ dirs: [root], maxDepth: 2 }), [], "past maxDepth is not walked");
});

// The seam: a view_image observation must CARRY the font inventory, because a
// fact the model has to go looking for is a fact it does not use. TB2
// chess-best-move classified pieces by aspect ratio with /fonts/noto.ttf on disk.
test("SEAM: a view_image observation carries the font inventory and the technique", () => {
  const root = scratch();
  const image = path.join(root, "board.png");
  fs.writeFileSync(image, "not-a-real-png");
  const tool = viewImageTool(root, "http://127.0.0.1:0", {
    describe: () => "a chess board",
  });
  const out = tool.answer("view_image board.png");
  assert.match(out, /a chess board/);
  assert.match(out, /Fonts on this machine:/, "the inventory must reach the observation");
  assert.match(out, /ImageFont\.truetype/, "and name the instrument, not just the fact");
  assert.match(out, /bounding box/, "including the part that removes size\\/offset guesswork");
});

test("SEAM: a failed vision call still does not fabricate facts", () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, "board.png"), "x");
  const tool = viewImageTool(root, "http://127.0.0.1:0", { describe: () => null });
  const out = tool.answer("view_image board.png");
  assert.match(out, /returned no description/);
  assert.doesNotMatch(out, /Fonts on this machine/, "no reading -> no appended facts");
});

// rep2 (2026-08-20) decoded the g5 bishop correctly, listed it in prose, then
// hand-typed the FEN rank by rank and lost it in TRANSCRIPTION. The decode was
// never the defect. The hint must name emit-from-structure and the arithmetic
// that catches a dropped item.
test("the hint demands emitting from a structure, and count conservation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fonts-"));
  fs.writeFileSync(path.join(root, "board.png"), "x");
  const tool = viewImageTool(root, "http://127.0.0.1:0", { describe: () => "a chess board" });
  const out = tool.answer("view_image board.png");
  assert.match(out, /DATA STRUCTURE/, "never retype findings into a string by hand");
  assert.match(out, /number of cells you found equals the number of items you emitted/);
});

test("ordinary image inspection keeps pixel facts without a glyph reconstruction tutorial", t => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve("creative-suite/assets/dispatch-card.png"), path.join(root, "station.png"));
  const tool = viewImageTool(root, "http://unused.invalid", {
    describe: () => "A subway platform with bright fluorescent lights, posters and an ammo HUD.",
  });
  const out = tool.answer("view_image station.png");
  assert.match(out, /subway platform/);
  assert.match(out, /Deterministic image facts/);
  assert.doesNotMatch(out, /Fonts on this machine|ImageFont|DATA STRUCTURE/);
});

test("local visual questions reach the image model and scope the returned advisory facts", t => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve('creative-suite/assets/dispatch-card.png'), path.join(root, 'combat frame.png'));
  const calls = [];
  const tool = viewImageTool(root, 'http://local.invalid', {describe(endpoint, image, options) {
    calls.push({endpoint, image, options});
    return 'A chessboard with a brightly illuminated column; no enemy is visible.';
  }});
  const question = 'Is an enemy actually visible? Assess its silhouette and lighting. Under 80 words.';
  const result = tool.answer(`view_image combat frame.png | ${question}`);
  assert.match(result, /no enemy is visible/);
  assert.match(result, /Deterministic image facts/);
  assert.doesNotMatch(result, /Fonts on this machine|ImageFont/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'http://local.invalid');
  assert.equal(calls[0].image, path.join(root, 'combat frame.png'));
  assert.ok(calls[0].options.prompt.endsWith(`Specific question: ${question}`));
  assert.match(calls[0].options.prompt, /First establish whether the requested subject is visible/);
  assert.match(calls[0].options.prompt, /question is not evidence/);
  assert.doesNotMatch(calls[0].options.prompt, /every piece of visible text/,
    'a focused visual question must not spend its response budget on an unrelated inventory');
  assert.match(result, /Vision interpretation.*not verification proof/);
  assert.equal(tool.lastOutcome.status, 'pass');
  tool.answer('view_image combat frame.png');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].options.prompt, /Specific question/);
  assert.match(calls[1].options.prompt, /Describe this image/);
});

test("both image providers keep question paths and symlink targets inside the workspace", async t => {
  const root = scratch(), outside = scratch();
  t.after(() => {fs.rmSync(root, {recursive:true, force:true});fs.rmSync(outside, {recursive:true, force:true});});
  fs.writeFileSync(path.join(root, 'frame.png'), 'fixture');
  fs.writeFileSync(path.join(outside, 'private.png'), 'outside fixture');
  fs.symlinkSync(path.join(outside, 'private.png'), path.join(root, 'escape.png'));
  fs.symlinkSync(path.join(root, 'frame.png'), path.join(root, 'alias.png'));
  let calls = 0;
  const tools = [
    viewImageTool(root, 'http://local.invalid', {describe(){calls++;return 'A frame.';}}),
    codexViewImageTool(root, {runtimeFactory:()=>({async describeImage(){calls++;return {content:'A frame.'};},close(){}})}),
  ];
  for (const tool of tools) {
    const before = calls;
    assert.match(await tool.answer('view_image escape.png | Read its text.'), /outside workspace/);
    assert.match(await tool.answer(`view_image ${path.join(outside, 'private.png')} | Read its text.`), /outside workspace/);
    assert.match(await tool.answer('view_image missing.png | Read its text.'), /no image at missing.png/);
    assert.equal(calls, before, 'invalid paths must never reach either model');
    assert.match(await tool.answer('view_image alias.png | Describe its layout.'), /A frame/);
    assert.equal(calls, before + 1, 'an internal image alias remains usable');
  }
});

test("Codex image review scopes glyph guidance to the requested task", async t => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve("creative-suite/assets/dispatch-card.png"), path.join(root, "board.png"));
  let closed = 0;
  const tool = codexViewImageTool(root, {
    runtimeFactory: () => ({
      async describeImage() { return { content: "A chessboard with small white glyphs and warm overhead lights." }; },
      close() { closed++; },
    }),
  });
  for (const question of [
    "Score the lighting, shadows and restrained bloom.",
    "Review layout and material fidelity; identify concrete defects.",
  ]) {
    const out = await tool.answer(`view_image board.png | ${question}`);
    assert.match(out, /A chessboard/);
    assert.match(out, /Deterministic image facts/);
    assert.doesNotMatch(out, /Fonts on this machine|ImageFont/);
  }
  for (const question of ["Decode the pieces as FEN.", "Extract the text.", "Which font is this?", "What is the best move?"]) {
    const out = await tool.answer(`view_image board.png | ${question}`);
    assert.match(out, /Fonts on this machine/);
    assert.match(out, /ImageFont\.truetype/);
  }
  assert.match(await tool.answer("view_image board.png"), /Fonts on this machine/);
  assert.equal(closed, 7, "all image workers close regardless of advisory selection");
});
