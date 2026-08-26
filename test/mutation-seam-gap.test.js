import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderOpenFiles } from "../src/open-files.js";

// tb9 turn 33 (2026-08-16, .bantam/runs/2026-08-16T18-34-07-754Z.json): the
// model issued edit_lines on src/agent.js lines 5283-5293 while the panel
// showed [[245,290],[5271,5282],[5294,5305]] — its two previous mutation seams,
// bracketing the very lines it was now editing. The recorder logged
// edit-target-partial on that turn and the two after it.
//
// Two causes, both here. Focus ranges a few lines apart were never coalesced,
// and the mutation-seam block capped at 24 lines, so even a merged region got
// head/tail split and reopened the hole. The ±3 expansion is what keeps a small
// mutation cheap; the cap only binds when seams are many or wide, and there a
// contiguous view of the working region is worth more than a punctured one.

function giantWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-seam-gap-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/agent.js"),
    `${Array.from({ length: 5667 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n")}\n`,
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seamBlockLines(text) {
  const at = text.indexOf("## accepted mutation seams (current)");
  if (at < 0) return { numbered: [], omissions: 0 };
  const rows = text.slice(at).split("\n").slice(1);
  const numbered = [];
  let omissions = 0;
  let last = -1;
  for (const row of rows) {
    const match = /^(\d+)\t/.exec(row);
    if (match) {
      const n = Number(match[1]);
      if (last >= 0 && n < last) break;      // the file body restarts numbering
      last = n;
      numbered.push(n);
      continue;
    }
    if (/^… \(lines/.test(row)) { omissions += 1; continue; }
    if (numbered.length) break;
  }
  return { numbered, omissions };
}

const render = (dir, ranges) => renderOpenFiles(dir, ["src/agent.js"], {
  mutationFocusByPath: new Map([["src/agent.js", ranges]]),
});

test("the gap between two nearby mutation seams is visible", (t) => {
  const dir = giantWorkspace(t);
  const text = render(dir, [{ start: 5271, end: 5282 }, { start: 5294, end: 5305 }]);
  for (const line of [5283, 5288, 5293]) {
    assert.match(text, new RegExp(`(^|\\n)${line}\\t`), `line ${line} — the edit target — must be visible`);
  }
});

test("the merged region renders contiguously, with no omission marker", (t) => {
  const dir = giantWorkspace(t);
  const { numbered, omissions } = seamBlockLines(render(dir, [
    { start: 5271, end: 5282 },
    { start: 5294, end: 5305 },
  ]));
  assert.equal(omissions, 0, "a hole in the working region is the defect");
  assert.equal(numbered.length, 41, "5268-5308: both seams plus their ±3 and the gap between");
});

test("a single one-line mutation still costs seven lines", (t) => {
  // The cap's original purpose. Raising it must not make a small edit expensive.
  const dir = giantWorkspace(t);
  const { numbered, omissions } = seamBlockLines(render(dir, [{ start: 100, end: 100 }]));
  assert.equal(numbered.length, 7, "±3 around the mutation, nothing more");
  assert.equal(omissions, 0);
});

test("distant seams stay separate rather than swallowing the span between", (t) => {
  const dir = giantWorkspace(t);
  const { numbered } = seamBlockLines(render(dir, [{ start: 100, end: 101 }, { start: 4000, end: 4001 }]));
  assert.ok(numbered.length <= 20, `two small distant seams must stay small, got ${numbered.length}`);
  assert.ok(!numbered.includes(2000), "the 3,900 lines between them are not the working region");
});
