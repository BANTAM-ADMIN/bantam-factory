import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderOpenFiles } from "../src/open-files.js";

// tc1 (2026-08-17, .bantam/runs/2026-08-17T05-15-34-675Z.json) turn 4. The panel
// rendered src/logic/test-focus.js as:
//
//     ## accepted mutation seams (current)
//     81..89                            <- the lines the model had just edited
//     … (lines 1–55 omitted)
//     56..80
//     … (lines 81–89 omitted)           <- three rows below where they were shown
//     90..161
//
// Mutation-seam lines are filtered out of the body so they are not printed
// twice; the marker loop then read that hole as an omission. Lines 84-85 were
// the model's own new signature and `effectiveMax` binding, so it re-read
// 84-133 — and the repetition guard refused, telling it the read could "reveal
// nothing new". Two further turns went to searching for a change already on
// screen. A panel that denies its own contents is worse than one that clips:
// the model cannot tell which half to believe.
function panelLines(text) {
  const rendered = new Set();
  const claimedOmitted = new Set();
  const pointedAt = new Set();
  for (const row of text.split("\n")) {
    const numbered = /^(\d+)\t/.exec(row);
    if (numbered) { rendered.add(Number(numbered[1])); continue; }
    const range = /^… \(lines (\d+)–(\d+)([^)]*)\)/.exec(row.trim());
    if (!range) continue;
    // Anything that is not the word "omitted" is a pointer at content the panel
    // does hold — above in the seam block, or below in the body.
    const target = /\bomitted\b/.test(range[3]) ? claimedOmitted : pointedAt;
    for (let n = Number(range[1]); n <= Number(range[2]); n += 1) target.add(n);
  }
  return { rendered, claimedOmitted, pointedAt };
}

function giantWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-omission-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/agent.js"),
    `${Array.from({ length: 5667 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n")}\n`,
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const render = (dir, ranges) => renderOpenFiles(dir, ["src/agent.js"], {
  mutationFocusByPath: new Map([["src/agent.js", ranges]]),
});

test("no line is called omitted while the panel renders it", (t) => {
  const dir = giantWorkspace(t);
  const { rendered, claimedOmitted } = panelLines(render(dir, [{ start: 100, end: 100 }]));
  const contradiction = [...claimedOmitted].filter((n) => rendered.has(n));
  assert.deepEqual(contradiction, [], "these lines are both printed and declared missing");
});

test("the seam lines are pointed at, not silently skipped", (t) => {
  const dir = giantWorkspace(t);
  const text = render(dir, [{ start: 100, end: 100 }]);
  const { rendered, pointedAt } = panelLines(text);
  assert.ok(pointedAt.size > 0, "the body must say where the seam lines went");
  for (const n of pointedAt) {
    assert.ok(rendered.has(n), `line ${n} is pointed at but never rendered`);
  }
  assert.match(text, /shown above under "accepted mutation seams"/);
});

test("the invariant holds across seam layouts", (t) => {
  const dir = giantWorkspace(t);
  const layouts = [
    [{ start: 1, end: 2 }],                              // seam at the very top
    [{ start: 100, end: 100 }],                          // mid-window, the tc1 shape
    [{ start: 100, end: 101 }, { start: 140, end: 141 }], // two seams inside one window
    [{ start: 100, end: 101 }, { start: 4000, end: 4001 }], // one seam past the clip
    [{ start: 5666, end: 5667 }],                        // seam at the end of file
  ];
  for (const ranges of layouts) {
    const label = JSON.stringify(ranges);
    const { rendered, claimedOmitted } = panelLines(render(dir, ranges));
    const contradiction = [...claimedOmitted].filter((n) => rendered.has(n));
    assert.deepEqual(contradiction, [], `${label}: printed and declared missing`);
  }
});

test("genuinely absent lines are still reported omitted", (t) => {
  // The marker must not be softened into uselessness: a line the panel really
  // does lack has to keep saying so, or clipping becomes invisible.
  const dir = giantWorkspace(t);
  const { rendered, claimedOmitted } = panelLines(render(dir, [
    { start: 100, end: 101 },
    { start: 4000, end: 4001 },
  ]));
  assert.ok(claimedOmitted.size > 0, "the span between two distant seams is genuinely absent");
  for (const n of claimedOmitted) {
    assert.ok(!rendered.has(n), `line ${n} is reported omitted but rendered`);
  }
  // And a file too large to render whole must still say so somewhere.
  assert.match(render(dir, [{ start: 100, end: 100 }]), /more lines omitted/);
});
