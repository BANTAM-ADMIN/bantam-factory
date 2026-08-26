// Fight Night as a product: the arena auto-emits a replayable card at the end
// of every fight, and any user can `bantam fight` their own task across the
// corners they choose. The renderer is a library both paths share.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { replayCardData, renderReplayHtml, writeFightReplay } from "../src/fight-replay.js";

const POST = { task: "Fix /home/user/secret/thing at http://10.0.0.5:8085/x", startedAt: "s", finishedAt: "e",
  corners: [{ arm: "bantam", wallMs: 20000, exitCode: 0, usage: { turns: 5, inputTokens: 1000, outputTokens: 50, cacheHitTokens: 800, prefixReuse: 0.8 } }],
  verdicts: { bantam: { outcome: "WIN" } } };

test("replayCardData scrubs paths and endpoints and keeps the ledger", () => {
  const d = replayCardData({ no: "card X", post: POST, events: [{ t: 1, arm: "bantam", kind: "line", text: "hello /home/user/secret/f.js" }] });
  assert.doesNotMatch(d.task, /\/home\/user/);
  assert.doesNotMatch(d.task, /10\.0\.0\.5/);
  assert.equal(d.corners[0].usage.cacheHitTokens, 800);
  assert.doesNotMatch(d.events[0].x, /\/home\/user/);
});

test("every card pins the harness build it was fought on", () => {
  // "build 82c96e5e tops the field" is defensible forever; "tops the field"
  // is not. The post carries the harness commit; the replay page shows it.
  const d = replayCardData({ no: "card X", post: { ...POST, build: "abc1234" }, events: [] });
  assert.equal(d.build, "abc1234");
  const html = renderReplayHtml({ cards: [d], initial: 0, title: "T", h1: "H", eyebrow: "E" });
  assert.match(html, /abc1234/);
});

test("writeFightReplay emits a self-contained page beside the card, truth optional", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replaylib-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "events.ndjson"), JSON.stringify({ t: 5, arm: "bantam", kind: "line", text: "working" }) + "\n");
  const out = writeFightReplay({ fightDir: dir, post: POST });
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /Fight Night: Live Card/);
  assert.match(html, /"sealed":null/);
  fs.writeFileSync(path.join(dir, "truth.json"), JSON.stringify({ truthCheck: { bantam: { verdict: "EXACT" } } }));
  assert.match(fs.readFileSync(writeFightReplay({ fightDir: dir, post: POST }), "utf8"), /"sealed":"EXACT"/);
});

test("bantam fight --dry-run resolves task, arms, and materials without ringing the bell", () => {
  const r = spawnSync("node", ["bin/bantam.js", "fight", "--task", "T-marker", "--arms", "bantam,codex-sol", "--dry-run"],
    { encoding: "utf8", timeout: 30000 });
  const line = (r.stdout + r.stderr).split("\n").find((l) => l.includes("T-marker"));
  assert.ok(line, `dry-run plan not printed: ${r.stdout} ${r.stderr}`);
  const plan = JSON.parse(line);
  assert.deepEqual(plan.arms, ["bantam", "codex-sol"]);
  assert.equal(plan.task, "T-marker");
});
