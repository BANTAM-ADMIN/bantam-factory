import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderOpenFiles } from "../src/open-files.js";

// Measured 2026-08-16 (ticket B, final prompt): the panel spent 29.7KB of a
// ~40KB source allowance while BOTH files the ticket required editing sat
// clipped at the 6KB seam budget — the completion-priority allocator caps
// un-completable files there and then leaves the remainder unspent. Budget left
// on the table is budget the model reads a file twice to recover.

function ws(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-leftover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
  return dir;
}

const bigFile = (n) => Array.from({ length: n }, (_, i) => `// line ${i} of a file too large to render whole`).join("\n");

test("leftover budget goes to the files that could not be completed", (t) => {
  const dir = ws(t, {
    "huge-a.js": bigFile(4000),
    "huge-b.js": bigFile(4000),
    "small.js": "export const x = 1;\n",
  });
  const panel = renderOpenFiles(dir, ["huge-a.js", "huge-b.js", "small.js"], {});
  const entry = (name) => {
    const i = panel.indexOf(`# ${name}`);
    const j = panel.indexOf("\n# ", i + 5);
    return panel.slice(i, j < 0 ? panel.length : j);
  };
  // Both giants should receive well more than the 6KB seam floor, because the
  // small file leaves most of the allowance unspent.
  assert.ok(entry("huge-a.js").length > 9000, `huge-a got ${entry("huge-a.js").length}B`);
  assert.ok(entry("huge-b.js").length > 9000, `huge-b got ${entry("huge-b.js").length}B`);
  // And the whole panel still respects the ceiling.
  assert.ok(panel.length <= 48_000, `panel ${panel.length}B exceeds the budget`);
});

test("a completable file is still completed before leftovers are handed out", (t) => {
  const dir = ws(t, { "huge.js": bigFile(4000), "mid.js": bigFile(200) });
  const panel = renderOpenFiles(dir, ["huge.js", "mid.js"], {});
  const i = panel.indexOf("# mid.js");
  const seg = panel.slice(i);
  assert.ok(!/panel truncated|more lines omitted/.test(seg), "the completable file stays complete");
});
