import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// tb4 (.bantam/runs/2026-08-16T16-16-10-688Z.json) rewrote src/fixture-runner.js
// and added test/unsatisfiable-scope.test.js. Its artifact recorded
// `workspaceChanged: true` and named neither file, and `finalDiff` was null —
// correctly, because `bantam run` works on the operator's real workspace and
// capturing a git diff means committing a baseline into it (the codex/claude
// delegates can, since they run in isolated candidate workspaces).
//
// So the artifact could say THAT the run changed something and never WHAT.
// The loop already tracks the set for the landing note; this surfaces it.

function scriptedModel(actions) {
  const queue = [...actions];
  return {
    assistantPrefill: "",
    profileName: "qwen",
    beginAgentRun() { return null; },
    endAgentRun() {},
    async complete() {
      const next = queue.shift() ?? { a: "done", summary: "finished" };
      return { content: JSON.stringify(next), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

describe("run artifact names the paths it changed", () => {
  it("records every edited path, in first-touch order", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-edited-paths-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src/a.js"), "export const a = 1;\n");

    const result = await runAgent({
      task: "Edit a.js and add b.js.",
      workspace,
      model: scriptedModel([
        { a: "replace", p: "src/a.js", old: "export const a = 1;", new: "export const a = 2;" },
        { a: "write_file", p: "src/b.js", content: "export const b = 1;\n" },
        { a: "replace", p: "src/a.js", old: "export const a = 2;", new: "export const a = 3;" },
        { a: "done", summary: "done" },
      ]),
      maxTurns: 6,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    assert.deepEqual(result.metrics.editedPaths, ["src/a.js", "src/b.js"],
      "each changed path once, in the order first touched");
    assert.equal(result.metrics.workspaceChanged, true);
  });

  it("stays empty when the run changes nothing", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-edited-none-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, "a.js"), "export const a = 1;\n");

    const result = await runAgent({
      task: "Read a.js and report.",
      workspace,
      model: scriptedModel([
        { a: "read_file", p: "a.js" },
        { a: "done", summary: "read it" },
      ]),
      maxTurns: 4,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    assert.deepEqual(result.metrics.editedPaths, []);
    assert.equal(result.metrics.workspaceChanged, false);
  });
});
