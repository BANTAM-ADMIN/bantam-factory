import assert from "node:assert/strict";
import test from "node:test";

import { completePanelEntries, panelEntryPaths } from "../src/agent.js";
import { renderedOpenPaths } from "../src/open-files.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The residency guard (readReplayIsContextSafe) refuses a re-read when the file
// is already resident in the prompt. It was fed renderedOpenPaths(), which
// answers a different question: which CANDIDATES exist and are readable. That
// list is computed before compileContextPacket picks the panel's byte budget,
// so a file the packet then dropped was still reported resident, and reads of
// it were refused as already-present.
//
// tb21 (2026-08-17, .bantam/runs/2026-08-17T06-25-11-075Z.json) deadlocked on
// it: 22 of 60 turns were read refusals, and in 9 the requested file was in
// neither the panel nor history. src/fixture-runner.js was refused six times
// while its only read had been stubbed away — the bytes were nowhere in the
// prompt and the harness would not fetch them. The run reached its test suite
// twice in 60 turns and hit the cap.
//
// The packet text is the one description of the prompt that cannot drift from
// what the model was sent.

const PACKET = [
  "# Live repository map (automatic brief, refreshed from the current tree)",
  "src/ — the agent",
  "",
  "# src/agent.js (current, 5797 lines)",
  "1\tconst a = 1;",
  "… (5796 more lines omitted — use read_file to page the rest)",
  "",
  "# src/scope-guard.js (current, 341 lines)",
  "1\texport const guard = 1;",
  "",
  "The code at the failure the last observation named — you do not need to read these files:",
  "",
  "# src/gate-policy.js:145 (the failure is on the >> line)",
  "   144\t/** doc */",
  ">> 145\texport function deliveryFor(gate, {",
].join("\n");

test("only panel entries count as resident", () => {
  assert.deepEqual(panelEntryPaths(PACKET), ["src/agent.js", "src/scope-guard.js"]);
});

test("a failure-context block is not an entry", () => {
  // It shares the "# path" shape but carries a line anchor and only an excerpt;
  // treating it as residency would refuse reads of a file shown three lines deep.
  assert.ok(!panelEntryPaths(PACKET).includes("src/gate-policy.js"));
});

test("the repository map heading is not an entry", () => {
  assert.ok(!panelEntryPaths(PACKET).some((p) => p.includes("Live")));
});

test("an empty or absent packet yields nothing resident", () => {
  assert.deepEqual(panelEntryPaths(""), []);
  assert.deepEqual(panelEntryPaths(null), []);
});

test("the candidate list can exceed what a packet emits", (t) => {
  // The gap this fix closes, shown directly: renderedOpenPaths reports files
  // that exist, and says nothing about whether the packet had room for them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-resident-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(dir, "src", name), `${"// filler\n".repeat(400)}export const x = 1;\n`);
  }
  const openList = ["src/a.js", "src/b.js", "src/c.js"];
  const candidates = renderedOpenPaths(dir, openList, {});
  assert.deepEqual(candidates, openList, "all three exist, so all three are candidates");

  // A packet that only had room for one of them makes the other two non-resident.
  const emitted = panelEntryPaths("# src/a.js (current, 401 lines)\n1\t// filler");
  assert.deepEqual(emitted, ["src/a.js"]);
  assert.ok(
    candidates.length > emitted.length,
    "residency must follow the packet, not the candidate list",
  );
});

// completeOpenFiles decides two things: whether a read observation may be
// stubbed out of history as "the panel has it", and whether a re-read is
// refused as already-present. It came from fullyRenderedPaths(), which re-runs
// the planner WITHOUT the byte budget compileContextPacket settles on, so it
// could call a file complete that the packet clipped or dropped. tb21 lost
// src/fixture-runner.js through exactly that pair.
const whole = ["# src/small.js (current, 3 lines)", "1\ta", "2\tb", "3\tc"].join("\n");

test("an entry rendering every line is complete", () => {
  assert.deepEqual([...completePanelEntries(whole)], [["src/small.js", 3]]);
});

test("a clipped entry is not complete", () => {
  const clipped = ["# src/big.js (current, 900 lines)", "1\ta", "… (899 more lines omitted — use read_file to page the rest)"].join("\n");
  assert.equal(completePanelEntries(clipped).size, 0);
});

test("a focus-ranged entry with a real gap is not complete", () => {
  const gapped = ["# src/mid.js (current, 9 lines)", "1\ta", "2\tb", "… (lines 3–7 omitted)", "8\th", "9\ti"].join("\n");
  assert.equal(completePanelEntries(gapped).size, 0);
});

test("a seam pointer does not make an entry incomplete", () => {
  // "shown above under …" names lines the panel DOES hold, three rows up. It is
  // the repaired panel's honest marker, not an omission.
  const seamed = [
    "# src/mid.js (current, 5 lines)",
    "## accepted mutation seams (current)",
    "3\tc",
    '… (lines 3–3 shown above under "accepted mutation seams")',
    "1\ta", "2\tb", "4\td", "5\te",
  ].join("\n");
  assert.deepEqual([...completePanelEntries(seamed)], [["src/mid.js", 5]]);
});

test("an entry short of its stated length is not complete", () => {
  const short = ["# src/x.js (current, 4 lines)", "1\ta", "2\tb"].join("\n");
  assert.equal(completePanelEntries(short).size, 0);
});
