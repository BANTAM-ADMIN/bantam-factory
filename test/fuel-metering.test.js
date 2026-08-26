// P0 fuel metering. Fixtures copy the REAL on-disk shapes (2026-08-18):
// codex rollouts stream vendor-reported rate_limits; claude local logs carry
// only raw per-message usage. Doctrine under test: absent is not zero, a
// mutated format is NO-READING (never a guess), and the two bases never
// blend into one number.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCodexRateLimitLine, latestCodexReading, claudeLocalUsage, renderFuelReport } from "../src/logic/fuel.js";

const SNAP = JSON.stringify({ timestamp: "2026-08-18T21:32:28.669Z", payload: { rate_limits: {
  limit_id: "codex", primary: { used_percent: 33.0, window_minutes: 10080, resets_at: 1787239771 },
  credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "pro" } } });

test("real codex snapshot parses with basis and reset", () => {
  const r = parseCodexRateLimitLine(SNAP);
  assert.equal(r.usedPercent, 33.0);
  assert.equal(r.plan, "pro");
  assert.match(r.basis, /vendor-reported/);
  assert.match(r.resetsAt, /^2026-08-2/);
});

test("a mutated snapshot format is NO-READING, never a guess", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-codex-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, "2026"));
  const rogue = SNAP.replace('used_percent','used_fraction'); // vendor moved the meter
  fs.writeFileSync(path.join(d, "2026", "rollout-x.jsonl"), rogue + "\n");
  const r = latestCodexReading({ sessionsDir: d, now: () => Date.parse("2026-08-18T22:00:00Z") });
  assert.equal(r.status, "NO-READING");
  assert.match(r.reason, /not understood/);
});

test("newest snapshot wins and age is computed from its own timestamp", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-codex2-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const old = SNAP.replace("33.0", "10.0").replace("21:32:28", "09:00:00");
  fs.writeFileSync(path.join(d, "rollout-a.jsonl"), old + "\n" + SNAP + "\n");
  const r = latestCodexReading({ sessionsDir: d, now: () => Date.parse("2026-08-18T21:42:28.669Z") });
  assert.equal(r.status, "OK");
  assert.equal(r.usedPercent, 33.0);
  assert.equal(r.ageSeconds, 600);
});

test("empty sessions dir is NO-READING (absent is not zero)", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-codex3-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const r = latestCodexReading({ sessionsDir: d });
  assert.equal(r.status, "NO-READING");
});

function claudeFixture(t, ts, out = 100) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-claude-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "-home-x-proj");
  fs.mkdirSync(proj);
  const line = JSON.stringify({ timestamp: ts, message: { model: "claude-fable-5", usage: {
    input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 900, output_tokens: out } } });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), line + "\n");
  return root;
}

test("claude usage sums components inside the window, separately", (t) => {
  const root = claudeFixture(t, "2026-08-18T21:00:00Z", 2483);
  const r = claudeLocalUsage({ projectsDir: root, now: () => Date.parse("2026-08-18T22:00:00Z") });
  assert.equal(r.status, "OK");
  assert.equal(r.outputTokens, 2483);
  assert.equal(r.cacheCreationTokens, 500);
  assert.equal(r.cacheReadTokens, 900);
  assert.equal(r.messages, 1);
  assert.match(r.regime, /other devices .* invisible/);
});

test("records outside the window do not count", (t) => {
  const root = claudeFixture(t, "2026-08-18T10:00:00Z");
  const r = claudeLocalUsage({ projectsDir: root, now: () => Date.parse("2026-08-18T22:00:00Z") });
  assert.equal(r.status, "NO-READING");
});

test("the rendered report carries both bases and never blends them", (t) => {
  const root = claudeFixture(t, "2026-08-18T21:00:00Z");
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-codex4-"));
  t.after(() => fs.rmSync(codexDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(codexDir, "rollout-a.jsonl"), SNAP + "\n");
  const now = () => Date.parse("2026-08-18T22:00:00Z");
  const text = renderFuelReport({
    codex: latestCodexReading({ sessionsDir: codexDir, now }),
    claude5h: claudeLocalUsage({ projectsDir: root, now }),
    claude7d: claudeLocalUsage({ projectsDir: root, now, windowMs: 7 * 24 * 3600 * 1000 }),
  });
  assert.match(text, /vendor-reported/);
  assert.match(text, /measured on this machine only/);
  assert.match(text, /33\.0% of 7d window/);
  assert.doesNotMatch(text, /claude.*%/, "claude must never get an invented percentage");
});
