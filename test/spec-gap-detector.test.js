import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { detectSpecGap, taskDeclaresType, formatSpecGap } from "../src/logic/spec-gap-detector.js";
import { auditSpecCoverage } from "../src/logic/spec-coverage.js";

// The detector has to work WITHOUT a grader, because at runtime there isn't one.
//
// The measured payoff: BANTAM_TYPE_CONTRACT_GATE took channel-filter from 0/3 to
// 3/3 on the hidden contract (n=3 per arm, gpt-5.6-terra, p = 0.05), and costs ~2x
// turns on the seven fixtures that already state their contracts. All the value is
// in knowing when to switch it on.
//
// The naive signal -- "the task never mentions rejection" -- fires on 4 of 14
// fixtures and is right about 1, because without a grader "the spec omits what is
// tested" and "nothing tests it" read identically. Requiring the task to have
// DECLARED AN ACCEPTED TYPE is what separates them.

const FIXTURES = path.join(process.cwd(), "gauntlet", "fixtures");
const hasFixtures = fs.existsSync(FIXTURES);

const taskOf = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, name, "task.json"), "utf8")).task ?? "";
  } catch { return ""; }
};

function exportsOf(name) {
  const found = new Set();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "platform") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.[cm]?js$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) found.add(m[1]);
      for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g)) found.add(m[1]);
    }
  };
  walk(path.join(FIXTURES, name, "repo", "src"));
  return [...found];
}

const fires = (name) => detectSpecGap(taskOf(name), exportsOf(name)).underSpecified;

describe("detecting an unstated type contract", () => {
  it("fires on the task measured to fail without the gate", () => {
    const gap = detectSpecGap(taskOf("channel-filter"), exportsOf("channel-filter"));
    assert.equal(gap.underSpecified, true);
    assert.deepEqual(gap.functions.sort(), ["normalizeChannels", "normalizeDelivery"]);
  });

  it("does not fire on a behaviour-preserving refactor that names no input types", () => {
    // retry-consolidation mentions no rejection either, and its grader asserts none.
    // The naive "task never mentions rejection" signal got this wrong.
    assert.equal(fires("retry-consolidation"), false);
  });

  it("does not fire on a task with no declared type surface", () => {
    assert.equal(fires("safe-config-merge"), false);
  });
});

// The controlled test. Paired fixtures share a repo and differ only in whether the
// task states the contract, so a detector that reads the task must flip and one
// that is keying on the code cannot.
describe("paired explicit fixtures", () => {
  for (const base of ["channel-filter", "adapter-migration"]) {
    it(`fires on ${base} and not on ${base}-explicit`, (t) => {
      if (!hasFixtures || !fs.existsSync(path.join(FIXTURES, `${base}-explicit`))) {
        t.skip("paired fixture not present");
        return;
      }
      assert.equal(fires(base), true, `${base} states no rejection contract`);
      assert.equal(fires(`${base}-explicit`), false, `${base}-explicit states it`);
    });
  }
});

describe("precision across the whole fixture set", () => {
  it("never fires on a fixture whose grader asserts no unstated rejection", (t) => {
    if (!hasFixtures) { t.skip("no fixtures"); return; }
    const falsePositives = [];
    for (const name of fs.readdirSync(FIXTURES).sort()) {
      if (!fs.statSync(path.join(FIXTURES, name)).isDirectory()) continue;
      const exported = exportsOf(name);
      if (!exported.length) continue;
      // Ground truth needs the grader; the detector must reach it without one.
      if (detectSpecGap(taskOf(name), exported).underSpecified
        && auditSpecCoverage(path.join(FIXTURES, name)).gaps.length === 0) {
        falsePositives.push(name);
      }
    }
    assert.deepEqual(falsePositives, [],
      `fired where nothing was missing: ${falsePositives.join(", ")} — each costs ~2x turns`);
  });
});

describe("taskDeclaresType", () => {
  it("reads a declared input type", () => {
    assert.equal(taskDeclaresType("normalizeChannels accepts an array of strings.", "normalizeChannels"), true);
  });

  // Only a declared INPUT contract raises the question of what falls outside it.
  it("does not count prose about what a function returns", () => {
    assert.equal(taskDeclaresType("toSlug returns a string in kebab case.", "toSlug"), false);
  });

  it("does not credit one function's clause to another", () => {
    const task = "parseCount accepts a non-negative integer. formatCount renders it.";
    assert.equal(taskDeclaresType(task, "formatCount", ["parseCount", "formatCount"]), false);
  });
});

describe("formatSpecGap", () => {
  it("says which functions triggered it and why the gate turned on", () => {
    const text = formatSpecGap(detectSpecGap(taskOf("channel-filter"), exportsOf("channel-filter")));
    assert.match(text, /normalizeChannels/);
    assert.match(text, /type_contract/);
  });

  it("is silent when nothing is missing", () => {
    assert.equal(formatSpecGap({ underSpecified: false, functions: [] }), "");
  });
});
