import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, loadPolicy, haltState, haltSpend, resumeSpend, governorVerdict, renderGovernorLine } from "../src/logic/governor.js";

const ok = (pct, mins) => ({ status: "OK", usedPercent: pct, windowMinutes: mins, resetsAt: "2026-08-21T00:00:00.000Z" });

test("verdict matrix: envelopes, warn margin, window classification", () => {
  assert.equal(governorVerdict({ reading: ok(33, 10080) }).level, "ok");
  assert.equal(governorVerdict({ reading: ok(78, 10080) }).level, "warn"); // within 10 of weekly 85
  assert.equal(governorVerdict({ reading: ok(86, 10080) }).allow, false); // weekly cap
  assert.equal(governorVerdict({ reading: ok(72, 300) }).allow, false);   // 5h cap 70
  assert.equal(governorVerdict({ reading: ok(72, 10080) }).level, "ok");  // same pct, weekly window
});

test("kill switch beats force; force beats thresholds", () => {
  const halted = governorVerdict({ halt: { halted: true, source: "x" }, force: true, reading: ok(1, 300) });
  assert.equal(halted.allow, false);
  assert.equal(halted.level, "halt");
  const forced = governorVerdict({ reading: ok(99, 10080), force: true });
  assert.equal(forced.allow, true);
  assert.equal(forced.level, "forced");
});

test("NO-READING follows two-inks: never invents a percentage, policy decides", () => {
  const warn = governorVerdict({ reading: { status: "NO-READING", reason: "no logs" } });
  assert.equal(warn.allow, true);
  assert.equal(warn.level, "unmetered");
  assert.match(renderGovernorLine(warn), /NO-READING/);
  const strict = { ...DEFAULT_POLICY, onNoReading: "refuse" };
  assert.equal(governorVerdict({ policy: strict, reading: null }).allow, false);
});

test("halt file lifecycle and env override", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gov-"));
  assert.equal(haltState(root, {}).halted, false);
  haltSpend(root, "operator lunch break");
  const h = haltState(root, {});
  assert.equal(h.halted, true);
  assert.match(h.note, /lunch break/);
  assert.equal(resumeSpend(root), true);
  assert.equal(haltState(root, {}).halted, false);
  assert.equal(haltState(root, { BANTAM_NO_SPEND: "1" }).halted, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy file merges over defaults without clobbering the codex block", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gov-"));
  fs.mkdirSync(path.join(root, ".bantam"));
  fs.writeFileSync(path.join(root, ".bantam", "governor.json"), JSON.stringify({ codex: { weeklyStopPct: 50 } }));
  const p = loadPolicy(root);
  assert.equal(p.codex.weeklyStopPct, 50);
  assert.equal(p.codex.fiveHourStopPct, DEFAULT_POLICY.codex.fiveHourStopPct);
  assert.equal(p.onNoReading, "warn");
  fs.rmSync(root, { recursive: true, force: true });
});
