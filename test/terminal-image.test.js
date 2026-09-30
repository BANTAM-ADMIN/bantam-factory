import test from "node:test";
import assert from "node:assert/strict";
import { kittyCellDimensions, renderAnsiImage, sixelImage, terminalImageProtocol } from "../src/logic/terminal-image.js";

test("ANSI terminal preview uses two pixels per terminal cell", () => {
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const output = renderAnsiImage({ width: 2, height: 2, pixels }, { columns: 16, maxRows: 1 });
  assert.match(output, /\x1b\[38;2;255;0;0m/);
  assert.match(output, /\x1b\[48;2;0;0;255m/);
  assert.match(output, /▀/);
  assert.match(output, /\x1b\[0m$/);
});

test("ANSI preview reduces width when its row limit would distort the aspect ratio", () => {
  const pixels = Buffer.alloc(1024 * 1024 * 4, 255);
  const output = renderAnsiImage({ width: 1024, height: 1024, pixels }, { columns: 100, maxRows: 22 });
  const lines = output.split("\n");
  assert.equal(lines.length, 22);
  // 44 half-block columns at a 2:1 terminal-cell aspect render as a square.
  assert.equal((lines[0].match(/▀/g) ?? []).length, 44);
});

test("terminal protocol is detected and can be forced", () => {
  assert.equal(terminalImageProtocol({ TERM: "xterm-256color" }), "ansi");
  assert.equal(terminalImageProtocol({ KITTY_WINDOW_ID: "7" }), "kitty");
  assert.equal(terminalImageProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm");
  assert.equal(terminalImageProtocol({ TERM: "xterm-ghostty" }), "kitty");
  assert.equal(terminalImageProtocol({ BANTAM_IMAGE_PREVIEW_PROTOCOL: "ansi", KITTY_WINDOW_ID: "7" }), "ansi");
  assert.equal(terminalImageProtocol({ BANTAM_IMAGE_PREVIEW_PROTOCOL: "sixel" }), "sixel");
});

test("Sixel preview emits a complete native raster sequence", () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const output = sixelImage({ width: 2, height: 2, pixels }, { columns: 20 });
  assert.match(output, /^\x1bPq/);
  assert.match(output, /#180;2;100;0;0/);
  assert.match(output, /\x1b\\\n$/);
});

test("Kitty placement supplies rows and columns that preserve source aspect", () => {
  assert.deepEqual(kittyCellDimensions({ width: 1024, height: 1024 }, 100), { columns: 48, rows: 24 });
  assert.deepEqual(kittyCellDimensions({ width: 720, height: 1280 }, 100), { columns: 27, rows: 24 });
  assert.deepEqual(kittyCellDimensions({ width: 1280, height: 720 }, 100), { columns: 72, rows: 21 });
});
