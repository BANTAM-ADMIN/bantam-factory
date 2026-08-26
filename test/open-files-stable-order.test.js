import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderOpenFiles } from "../src/open-files.js";

// The open-files panel is a four-file window whose ORDER follows recency, so a
// new read pushes every other file down and the panel's bytes shift wholesale.
// It sits in the prompt's volatile tail, which means the prefix breaks at the
// panel's FIRST byte even when only one file changed.
//
// Measured on a gpt-5.6-terra adapter-migration run: quiet turns discarded
// 2,700-5,600 characters of cached prefix each, and the discarded region began at
// `<open_files> # <first file>` every time -- the panel start, not the file that
// changed.
//
// Selection stays recency-based; only the RENDER order is stabilised, so bytes for
// unchanged files remain byte-identical from turn to turn.

// Every temp workspace this file makes is removed when the file finishes. Three
// test files in this suite leaked one directory per run and never cleaned them
// up; over enough runs that contributed to a full disk, and a full disk makes the
// suite fail nondeterministically -- 103 failures in one run, 9 in the next, none
// of them real. A test suite that degrades its own environment is an unreliable
// instrument in exactly the way this codebase spent the day documenting.
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function workspaceWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-"));
  madeDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

describe("open-files panel byte stability", () => {
  const ws = workspaceWith({
    "src/alpha.js": "export const alpha = 1;\n",
    "src/beta.js": "export const beta = 2;\n",
    "src/gamma.js": "export const gamma = 3;\n",
  });

  it("renders the same bytes regardless of which file was read most recently", () => {
    const a = renderOpenFiles(ws, ["src/alpha.js", "src/beta.js"]);
    const b = renderOpenFiles(ws, ["src/beta.js", "src/alpha.js"]);
    assert.equal(a, b, "panel bytes changed when only the recency order changed");
  });

  // The point of stability: adding a file must EXTEND the panel rather than
  // rewrite the part already sent.
  it("keeps earlier files byte-identical when a new file joins the panel", () => {
    const before = renderOpenFiles(ws, ["src/beta.js", "src/gamma.js"]);
    const after = renderOpenFiles(ws, ["src/alpha.js", "src/beta.js", "src/gamma.js"]);
    const betaBlock = before.slice(before.indexOf("src/beta.js"));
    assert.ok(after.includes(betaBlock),
      "an existing file's rendered block changed when an unrelated file was added");
  });

  it("still renders every selected file", () => {
    const panel = renderOpenFiles(ws, ["src/gamma.js", "src/alpha.js"]);
    assert.match(panel, /src\/alpha\.js/);
    assert.match(panel, /src\/gamma\.js/);
  });
});
