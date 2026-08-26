// Maze films, backlog rank 3: A->B, B->A, A->B — each replace lands
// "successfully" and the run oscillates between two states it has already
// tested. The guard hard-stops the flip that would be the second inversion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepetitionGuard } from "../src/repetition.js";

const rep = (p, old, nw) => ({ a: "replace", p, old, new: nw });
const landed = "replaced 1 occurrence in f.js";

test("first inversion records; the flip that would be the second is stopped", () => {
  const g = new RepetitionGuard({ enabled: true });
  g.record(rep("f.js", "A", "B"), landed, { turn: 1 });
  assert.equal(g.check(rep("f.js", "B", "A")), null, "first reversal may execute (an undo is legitimate)");
  g.record(rep("f.js", "B", "A"), landed, { turn: 2 });     // inversion #1 landed
  const stop = g.check(rep("f.js", "A", "B"));
  assert.ok(stop, "the re-flip is refused");
  assert.match(stop.observation, /\[inverse-edit\] STOPPED/);
  assert.match(stop.observation, /third, genuinely new/);
  assert.equal(g.inverseEditStops, 1);
});

test("different paths and non-inverse edits never trip it", () => {
  const g = new RepetitionGuard({ enabled: true });
  g.record(rep("a.js", "A", "B"), landed, { turn: 1 });
  g.record(rep("b.js", "B", "A"), landed, { turn: 2 });     // inverse pair but a different file
  assert.equal(g.check(rep("a.js", "A", "B")), null);
  g.record(rep("a.js", "B", "C"), landed, { turn: 3 });
  assert.equal(g.check(rep("a.js", "C", "D")), null);
});

test("survives noteWorkspaceChanged — the oscillation IS workspace changes", () => {
  const g = new RepetitionGuard({ enabled: true });
  g.record(rep("f.js", "A", "B"), landed, { turn: 1 });
  g.noteWorkspaceChanged();
  g.record(rep("f.js", "B", "A"), landed, { turn: 2 });
  g.noteWorkspaceChanged();
  assert.ok(g.check(rep("f.js", "A", "B")), "memory outlives the invalidation that clears read dedup");
});

test("failed replaces (not landed) do not register pairs", () => {
  const g = new RepetitionGuard({ enabled: true });
  g.record(rep("f.js", "A", "B"), "ERROR: old text not found", { turn: 1 });
  g.record(rep("f.js", "B", "A"), "ERROR: old text not found", { turn: 2 });
  assert.equal(g.check(rep("f.js", "A", "B")), null);
});

test("wired: the oscillating run is stopped by the real dispatcher", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-osc-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "f.txt"), "alpha");
  const outputs = [];
  outputs.push(JSON.stringify(rep("f.txt", "alpha", "beta")));
  outputs.push(JSON.stringify(rep("f.txt", "beta", "alpha")));   // inversion #1
  outputs.push(JSON.stringify(rep("f.txt", "alpha", "beta")));   // would be #2 -> STOPPED
  outputs.push(JSON.stringify({ a: "done", summary: "Oscillation stopped; a third approach would follow." }));
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: "Settle f.txt.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const obs = result.turns.map((t2) => String(t2.observation ?? ""));
  assert.match(obs[2], /\[inverse-edit\] STOPPED/, "the second inversion is refused before executing");
  assert.equal(fs.readFileSync(path.join(ws, "f.txt"), "utf8"), "alpha", "the stopped flip never landed");
});
