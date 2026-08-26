// Timegrid audit (2026-08-25): compactHistory's per-build dedup maps let a
// LATER duplicate rewrite an EARLIER turn's rendered bytes — 550 chars moved
// 15k chars into a 128k prompt, and the checkpoint-or-nothing slot re-prefilled
// 43k tokens twice. Under the extension invariant, a rendered turn is frozen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt } from "../src/prompt.js";

const T = (i, action, observation) => ({ i, action, observation });

test("a frozen turn's bytes survive retroactive mutation of its source turn", () => {
  const turns = [
    T(0, { a: "write_file", p: "a.js", content: "const MARKER_ONE = 1;\n" }, "wrote a.js"),
    T(1, { a: "shell", c: "npm test" }, "# pass 1\n# fail 0"),
    T(2, { a: "read_file", p: "a.js" }, "const MARKER_ONE = 1;\n"),
  ];
  const cache = new Map();
  const opts = { task: "t", turns, renderCache: cache, extensionTrajectory: true };
  const p1 = buildPrompt(opts);
  assert.ok(cache.size >= 2, "earlier turns froze");
  // simulate ANY retroactive recompute: mutate turn 0 in place
  turns[0] = T(0, { a: "write_file", p: "a.js", content: "const MUTATED = 9;\n" }, "wrote a.js");
  const p2 = buildPrompt({ ...opts, turns });
  assert.ok(p2.includes("MARKER_ONE"), "frozen render replayed verbatim");
  assert.ok(!p2.includes("MUTATED"), "the retroactive rewrite never reaches the prompt");
  assert.equal(p1, p2, "identical build inputs render byte-identical prompts");
});

test("without a cache the mutation leaks (documents the defect the freeze fixes)", () => {
  const turns = [
    T(0, { a: "write_file", p: "a.js", content: "const MARKER_ONE = 1;\n" }, "wrote a.js"),
    T(1, { a: "shell", c: "npm test" }, "# pass 1\n# fail 0"),
    T(2, { a: "read_file", p: "a.js" }, "body"),
  ];
  buildPrompt({ task: "t", turns, extensionTrajectory: true });
  turns[0] = T(0, { a: "write_file", p: "a.js", content: "const MUTATED = 9;\n" }, "wrote a.js");
  const p2 = buildPrompt({ task: "t", turns, extensionTrajectory: true });
  assert.ok(p2.includes("MUTATED"), "uncached render follows the mutation");
});

test("the newest turn is never frozen — guidance folds still land", () => {
  const turns = [
    T(0, { a: "write_file", p: "a.js", content: "x" }, "wrote a.js"),
    T(1, { a: "shell", c: "npm test" }, "# fail 1"),
  ];
  const cache = new Map();
  buildPrompt({ task: "t", turns, renderCache: cache, extensionTrajectory: true });
  turns[1].observation = "# fail 1\n\n[guidance]\nfold landed";
  const p2 = buildPrompt({ task: "t", turns, renderCache: cache, extensionTrajectory: true });
  assert.ok(p2.includes("fold landed"), "newest turn re-renders with the fold");
});

test("wired: an early write body persists byte-verbatim through later same-file edits", async (t) => {
  process.env.BANTAM_PROMPT_TRAJECTORY = "extension";
  t.after(() => { delete process.env.BANTAM_PROMPT_TRAJECTORY; });
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-freeze-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const BODY = "// FROZEN_SENTINEL_9271\nexport const v = 1;\n";
  const outputs = [
    JSON.stringify({ a: "write_file", p: "f.js", content: BODY }),
    JSON.stringify({ a: "replace", p: "f.js", old: "v = 1", new: "v = 2" }),
    JSON.stringify({ a: "replace", p: "f.js", old: "v = 2", new: "v = 3" }),
    JSON.stringify({ a: "write_file", p: "f.js", content: "// rewritten wholesale\nexport const v = 4;\n" }),
    JSON.stringify({ a: "done", summary: "edited f.js repeatedly." }),
  ];
  const prompts = [];
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) { prompts.push(String(prompt)); return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: "Edit f.js as instructed.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const withHistory = prompts.filter((p) => p.includes("FROZEN_SENTINEL_9271"));
  assert.ok(withHistory.length >= 3, "the original body appears in later prompts");
  for (const p of withHistory) {
    assert.ok(p.includes(JSON.stringify(BODY).slice(1, -1)), "original write body byte-verbatim in every prompt that carries it");
  }
});
