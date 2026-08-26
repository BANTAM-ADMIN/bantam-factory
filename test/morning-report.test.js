// The morning report composes the $0 local ledger with the metered frontier
// block. Fixtures copy the REAL formats: llama-server's prometheus lines and
// bantam run artifacts. Doctrine: NO-READING when the server is down or the
// metrics format drifts; run counts name their scope (workspace roots, not a
// global census); no invented dollar figures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localServerReading, localRunsInWindow } from "../src/logic/fuel.js";

const METRICS = [
  "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.",
  "# TYPE llamacpp:prompt_tokens_total counter",
  "llamacpp:prompt_tokens_total 1.11759e+06",
  "llamacpp:tokens_predicted_total 28814",
].join("\n");

test("server counters parse from the real prometheus shape", async () => {
  const r = await localServerReading({ fetchText: async (u) => u.endsWith("/metrics") ? METRICS : JSON.stringify({ model_path: "/m/Qwen3.8-27B-BANTAM-Q4_K_P.gguf" }) });
  assert.equal(r.status, "OK");
  assert.equal(r.promptTokens, 1117590);
  assert.equal(r.genTokens, 28814);
  assert.equal(r.model, "Qwen3.8-27B-BANTAM-Q4_K_P.gguf");
  assert.match(r.basis, /restart resets/);
});

test("a down server is NO-READING, not zeros", async () => {
  const r = await localServerReading({ fetchText: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.status, "NO-READING");
  assert.match(r.reason, /no model server reachable/);
});

test("a drifted metrics format refuses rather than guessing", async () => {
  const r = await localServerReading({ fetchText: async (u) => u.endsWith("/metrics") ? "llamacpp:tokens_out_total 5" : "null" });
  assert.equal(r.status, "NO-READING");
  assert.match(r.reason, /not understood/);
});

function runsFixture(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morning-runs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".bantam", "runs");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body, ageMs] of entries) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(f, when, when);
  }
  return root;
}

test("run census counts the window, splits done, and names its scope", (t) => {
  const root = runsFixture(t, [
    ["a.json", JSON.stringify({ disposition: "done" }), 3600e3],
    ["b.json", JSON.stringify({ disposition: "stopped" }), 3600e3],
    ["old.json", JSON.stringify({ disposition: "done" }), 48 * 3600e3],
    ["corrupt.json", "{not json", 3600e3],
  ]);
  const r = localRunsInWindow({ roots: [root] });
  assert.equal(r.runs, 3, "corrupt artifacts still count as runs; old ones do not");
  assert.equal(r.done, 1);
  assert.match(r.basis, /not a global census/);
});

test("no runs dir means zero runs, stated scope intact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morning-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = localRunsInWindow({ roots: [root] });
  assert.equal(r.runs, 0);
});
