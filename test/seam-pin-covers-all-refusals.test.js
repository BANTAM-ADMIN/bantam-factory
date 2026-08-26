import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// The seam pin hung off failedEditPath, which answers a narrower question: did
// the edit's "old" text fail to match? Its pattern covers exactly three errors
// — "old" text not found, appears more than once, out of range — so a SYNTAX
// refusal or a COLLATERAL refusal pinned nothing at all.
//
// tb15 (2026-08-16, .bantam/runs/2026-08-16T21-48-38-604Z.json) refused eight
// edits that way. On every recovery turn the panel showed src/agent.js lines
// 256-391 while the failed edits targeted the import block and line ~5300 — the
// model retrying against a window that could not contain its seam.
//
// Any refused edit leaves the model in the same position, so any refused edit
// now pins.

function giantWorkspace(t, { targetLine = 4200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-seam-pin-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const lines = Array.from({ length: 5000 }, (_, i) => `const g${i} = ${i};`);
  lines[targetLine] = "export function target() {";
  lines[targetLine + 1] = "  return 1;";
  lines[targetLine + 2] = "}";
  fs.writeFileSync(path.join(dir, "src/agent.js"), `${lines.join("\n")}\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedModel(actions) {
  const queue = [...actions];
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      const next = queue.shift() ?? { a: "done", summary: "out of script" };
      return { content: JSON.stringify(next), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

async function seamsPinnedBy(t, editAction) {
  const workspace = giantWorkspace(t);
  const pinned = [];
  await runAgent({
    task: "Adjust the giant.",
    workspace,
    model: scriptedModel([
      { a: "read_file", p: "src/agent.js", start: 1, limit: 60 },
      editAction,
      { a: "read_file", p: "src/agent.js", start: 1, limit: 20 },
      { a: "done", summary: "done" },
    ]),
    maxTurns: 6,
    interactive: true,
    useGrammar: false,
    grounding: false,
    shellSandbox: "host",
    onEvent: (event) => { if (event.type === "edit_recovery_seam") pinned.push(event); },
  });
  return pinned;
}

describe("seam pinning covers every refused edit", () => {
  it("pins the seam of a syntax-refused replace", async (t) => {
    const pinned = await seamsPinnedBy(t, {
      a: "replace",
      p: "src/agent.js",
      old: "export function target() {\n  return 1;\n}",
      new: "export function target() {\n  if (x) {\n  return 1;\n}",   // unbalanced
    });
    assert.equal(pinned.length, 1, "a syntax refusal must pin its seam");
    const [range] = pinned[0].ranges;
    assert.ok(range.start < 4201 && range.end > 4201,
      `the window must straddle the failed edit, got ${JSON.stringify(range)}`);
  });

  it("pins the seam of a collateral-refused replace", async (t) => {
    const pinned = await seamsPinnedBy(t, {
      a: "replace",
      p: "src/agent.js",
      old: "export function target() {\n  return 1;\n}",
      new: "// removed",                                              // deletes a named symbol
    });
    assert.equal(pinned.length, 1, "a collateral refusal must pin its seam too");
  });

  it("pins nothing when the edit succeeds", async (t) => {
    const pinned = await seamsPinnedBy(t, {
      a: "replace",
      p: "src/agent.js",
      old: "export function target() {\n  return 1;\n}",
      new: "export function target() {\n  return 2;\n}",
    });
    assert.equal(pinned.length, 0, "there is no failed seam to look at");
  });
});
