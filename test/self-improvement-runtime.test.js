import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runAgent } from "../src/agent.js";
import {
  actionName,
  completedActionOutcome,
  createIntegratedPlanner,
  IntegratedDecider,
} from "../src/action-sequence-integration.js";
import { ObservationParser } from "../src/observation-parser.js";
import {
  ImprovementLog,
  ImprovementScheduler,
  scanWeaknesses,
} from "../src/self-improve.js";

const temporaryRoots = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-runtime-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("ImprovementLog runtime safety", () => {
  it("supports an in-memory log without creating files", () => {
    const root = temporaryRoot();
    const before = fs.readdirSync(root);
    const log = new ImprovementLog();

    log.record({ id: "probe", area: "reliability", passed: true });

    assert.deepStrictEqual(fs.readdirSync(root), before);
    assert.strictEqual(log.summary().passed, 1);
  });

  it("persists canonical passed outcomes atomically when explicitly enabled", () => {
    const root = temporaryRoot();
    const logPath = path.join(root, "evidence.json");
    const log = new ImprovementLog(logPath);

    log.record({ id: "old-shape", area: "quality", success: true });
    log.record({ id: "failure", area: "quality", passed: false });
    log.record({ id: "success", area: "reliability", passed: true });

    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.deepStrictEqual(
      persisted.map(({ passed }) => passed),
      [true, false, true],
    );
    assert.ok(persisted.every((entry) => !Object.hasOwn(entry, "success")));
    assert.deepStrictEqual(log.summary(), {
      total: 3,
      passed: 2,
      failed: 1,
      byArea: {
        quality: { total: 2, passed: 1 },
        reliability: { total: 1, passed: 1 },
      },
    });
    assert.deepStrictEqual(
      log.weakestAreas().map(({ area, rate }) => [area, rate]),
      [["quality", 0.5], ["reliability", 1]],
    );
    assert.deepStrictEqual(
      fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("snapshots records transactionally and keeps invalid evidence out of the ledger", () => {
    const root = temporaryRoot();
    const logPath = path.join(root, "evidence.json");
    const log = new ImprovementLog(logPath);
    const entry = {
      id: "snapshot",
      area: "reliability",
      passed: true,
      detail: { attempts: 1 },
    };

    log.record(entry);
    entry.detail.attempts = 99;
    assert.equal(log.entries[0].detail.attempts, 1);
    const before = fs.readFileSync(logPath, "utf8");
    const cyclic = { id: "cyclic", area: "reliability", passed: false };
    cyclic.self = cyclic;

    assert.throws(() => log.record(cyclic), /must be JSON-serializable/);
    assert.equal(log.entries.length, 1);
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
  });

  it("accounts for prototype-named areas without polluting global objects", () => {
    const log = new ImprovementLog();
    for (const area of ["__proto__", "constructor", "toString"]) {
      log.record({ id: area, area, passed: true });
    }

    const summary = log.summary();

    for (const area of ["__proto__", "constructor", "toString"]) {
      assert.equal(Object.hasOwn(summary.byArea, area), true);
      assert.deepEqual(summary.byArea[area], { total: 1, passed: 1 });
    }
    assert.equal(Object.hasOwn(Object.prototype, "total"), false);
    assert.equal(Object.hasOwn(Object.prototype, "passed"), false);
  });

  it("does not create a project log when the scheduler is only inspected", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "test"));

    new ImprovementScheduler(root);

    assert.strictEqual(fs.existsSync(path.join(root, ".bantam-improvements.json")), false);
  });
});

describe("missing-mechanism candidate suppression", () => {
  it("does not propose generated modules that already exist", () => {
    const root = temporaryRoot();
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.mkdirSync(path.join(root, "test"));
    const existing = new Map([
      // Examples only. completion-confidence / turn-efficiency / prompt-compression
      // were removed on 2026-07-31: each had been "built" as a stub nothing
      // imported, while the need it claimed was already met by real infrastructure.
      // The suppression mechanism is unchanged; only the illustrations moved.
      ["turn-parallelism.js", "turn-parallelism"],
      ["dependency-impact.js", "dependency-impact"],
      ["context-budget.js", "context-budgeting"],
      ["tool-feedback.js", "tool-feedback"],
      ["action-cost-model.js", "action-cost-model"],
    ]);
    for (const file of existing.keys()) {
      fs.writeFileSync(path.join(src, file), "export {};\n");
    }

    const ids = new Set(scanWeaknesses(root).map(({ id }) => id));
    for (const id of existing.values()) assert.ok(!ids.has(id), `${id} should be suppressed`);
    assert.ok(ids.has("self-test-gen"), "a genuinely absent mechanism should still be proposed");
  });

  it("proposes a mechanism again when all corresponding files are absent", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "test"));

    const candidates = scanWeaknesses(root);
    const ids = new Set(candidates.map(({ id }) => id));

    assert.ok(ids.has("dependency-impact"));
    assert.ok(ids.has("turn-parallelism"));
    assert.deepEqual(
      candidates.find(({ id }) => id === "dependency-impact").targets,
      ["dependency-impact.js"],
    );
    assert.deepEqual(
      candidates.find(({ id }) => id === "self-test-gen").targets,
      ["self-test-gen.js", "self-test-generator.js"],
    );
    assert.equal(
      candidates.find(({ id }) => id === "self-test-gen").promotionEligible,
      false,
    );
    assert.match(
      candidates.find(({ id }) => id === "self-test-gen").promotionBlocker,
      /production integration.*behavioral lift/i,
    );
  });
});

describe("observation and action outcome evidence", () => {
  it("emits one canonical data object with a compatibility alias", () => {
    const parsed = new ObservationParser().parse(
      { a: "shell", c: "node --test" },
      "VERDICT: all 12 tests passed.\nexit 0",
    );

    assert.strictEqual(parsed.data, parsed.extracted);
    assert.deepStrictEqual(parsed.data.tests, { passed: 12, failed: 0 });
  });

  it("normalizes action objects to protocol verb strings", () => {
    assert.strictEqual(actionName({ a: "read_file", p: "x.js" }), "read_file");
    assert.strictEqual(actionName("shell"), "shell");
    assert.strictEqual(actionName({}), null);
  });

  it("learns only from meaningful completed-action evidence", () => {
    assert.strictEqual(completedActionOutcome({
      action: "read_file",
      turn: { action: { a: "read_file" } },
      result: { observation: "file contents" },
      parsed: { data: {} },
    }), null);

    assert.deepStrictEqual(completedActionOutcome({
      action: "shell",
      result: {},
      parsed: { data: { tests: { passed: 4, failed: 0 } } },
    }), { success: true, evidence: "test_output" });

    assert.deepStrictEqual(completedActionOutcome({
      action: "replace",
      turn: { action: { a: "replace" }, editApplied: false },
      result: {},
      parsed: { data: {} },
    }), { success: false, evidence: "edit_rejected" });

    assert.deepStrictEqual(completedActionOutcome({
      action: "read_file",
      result: { blocked: { operation: "install" } },
      parsed: { data: {} },
    }), { success: false, evidence: "infrastructure_block" });
  });

  it("factory seeding is exactly one seed pass", () => {
    const manuallySeeded = new IntegratedDecider();
    manuallySeeded.seed();
    const factorySeeded = createIntegratedPlanner();

    assert.strictEqual(
      factorySeeded.planner.transitionModel.totalSequences,
      manuallySeeded.planner.transitionModel.totalSequences,
    );
  });
});

describe("agent live-runtime defaults", () => {
  it("does not create a log or inject decider hints by default", async () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "note.txt"), "hello\n");
    const model = scriptedModel([
      JSON.stringify({ a: "read_file", p: "note.txt" }),
      JSON.stringify({ a: "respond", text: "The note says hello." }),
    ]);

    const result = await runAgent({
      task: "What does note.txt say?",
      workspace: root,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: null,
      shellSandbox: "host",
    });

    assert.strictEqual(result.responded, true);
    assert.strictEqual(fs.existsSync(path.join(root, ".bantam-improvements.json")), false);
    assert.ok(!model.prompts[1].includes("[integrated-decider]"));
    assert.strictEqual(result.metrics.sequenceStrategyDecisions.total, 0);
  });

  it("injects a hint only when the decider is explicitly enabled", async () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "note.txt"), "hello\n");
    const model = scriptedModel([
      JSON.stringify({ a: "read_file", p: "note.txt" }),
      JSON.stringify({ a: "respond", text: "The note says hello." }),
    ]);

    const result = await runAgent({
      task: "What does note.txt say?",
      workspace: root,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: null,
      shellSandbox: "host",
      integratedDecider: true,
    });

    assert.ok(model.prompts[1].includes("[integrated-decider]"));
    assert.strictEqual(fs.existsSync(path.join(root, ".bantam-improvements.json")), false);
    assert.strictEqual(result.metrics.sequenceStrategyDecisions.total, 1);
  });
});

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}
