import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { systemFonts, viewImageTool } from "../src/logic/vision.js";

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
  const tool = viewImageTool(root, "http://127.0.0.1:0", { describe: () => "a board" });
  const out = tool.answer("view_image board.png");
  assert.match(out, /DATA STRUCTURE/, "never retype findings into a string by hand");
  assert.match(out, /number of cells you found equals the number of items you emitted/);
});
