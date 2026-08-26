import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeToolOutcome,
  ToolRegistry,
} from "../src/logic/tools.js";
import { buildArtifact } from "../src/artifact.js";
import { runAgent } from "../src/agent.js";
import { formatExperimentSummary } from "../src/experiment.js";

test("tool registry normalizes pass, partial, blocked, preview, and legacy outcomes", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "plain",
    description: "plain tool",
    verbs: ["plain"],
    answer: () => "plain answer",
  });
  const image = {
    name: "image",
    description: "legacy outcome tool",
    verbs: ["image"],
    lastOutcome: null,
    answer() {
      this.lastOutcome = {
        status: "partial",
        artifacts: ["a.png", "a.png", "review.html"],
        failures: [{ kind: "idle_timeout", reason: "quiet worker" }],
        completed: 1,
        variants: 2,
      };
      return "one image survived";
    },
  };
  registry.register(image);
  const preview = {
    name: "preview",
    description: "legacy preview proof",
    verbs: ["preview"],
    lastResult: null,
    answer() {
      this.lastResult = { status: "problems", mode: "load", problemCount: 2 };
      return "page has problems";
    },
  };
  registry.register(preview);
  const blocked = {
    name: "blocked",
    description: "blocked tool",
    verbs: ["blocked"],
    lastOutcome: null,
    answer() {
      this.lastOutcome = {
        status: "blocked",
        blocked: {
          terminal: true,
          ecosystem: "codex",
          operation: "image generation",
          reason: "provider unavailable",
        },
      };
      return "blocked";
    },
  };
  registry.register(blocked);

  assert.equal(await registry.answer("plain"), "plain answer");
  assert.deepEqual(
    { tool: registry.lastOutcome.tool, status: registry.lastOutcome.status },
    { tool: "plain", status: "pass" },
  );

  assert.equal(await registry.answer("image"), "one image survived");
  assert.equal(registry.lastOutcome.status, "partial");
  assert.deepEqual(registry.lastOutcome.artifacts, ["a.png", "review.html"]);
  assert.equal(registry.lastOutcome.failures[0].kind, "idle_timeout");
  assert.deepEqual(registry.lastOutcome.details, { completed: 1, variants: 2 });

  assert.equal(await registry.answer("preview"), "page has problems");
  assert.equal(registry.lastOutcome.status, "failed");
  assert.equal(registry.lastOutcome.proof.status, "problems");
  assert.equal(registry.lastOutcome.details.previewStatus, "problems");

  assert.equal(await registry.answer("blocked"), "blocked");
  assert.equal(registry.lastOutcome.status, "blocked");
  assert.equal(registry.lastOutcome.terminal, true);
  assert.equal(registry.lastOutcome.blocked.operation, "image generation");
});

test("tool registry converts async rejection and malformed legacy state into evidence", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "rejecting",
    description: "rejecting tool",
    verbs: ["rejecting"],
    async answer() {
      const error = new Error("injected async failure");
      error.code = "EINJECTED";
      error.retryable = false;
      throw error;
    },
  });
  registry.register({
    name: "malformed",
    description: "malformed legacy tool",
    verbs: ["malformed"],
    lastOutcome: { status: "mystery" },
    answer() { return "ambiguous"; },
  });

  assert.match(await registry.answer("rejecting"), /injected async failure/);
  assert.equal(registry.lastOutcome.status, "error");
  assert.equal(registry.lastOutcome.retryable, false);
  assert.equal(registry.lastOutcome.failures[0].kind, "EINJECTED");

  await registry.answer("malformed");
  assert.equal(registry.lastOutcome.status, "error");
  assert.equal(registry.lastOutcome.failures[0].kind, "invalid_outcome_status");
});

test("normalized tool outcomes persist in run artifacts with aggregate counts", () => {
  const outcome = normalizeToolOutcome({
    tool: "generate_image",
    raw: {
      status: "partial",
      artifacts: ["assets/generated/one.png"],
      failures: [{ kind: "hard_timeout", reason: "deadline" }],
      completed: 1,
      variants: 2,
    },
  });
  const artifact = buildArtifact({
    runId: "run-tool-outcome-proof",
    stamp: "2026-07-29T00-00-00-000Z",
    fixture: "tool-outcome-proof",
    task: "prove normalized tool outcomes",
    model: {
      endpoint: null,
      profileName: "test",
      metadata: () => ({ runtime: "test", model: "scripted" }),
      requestLog: () => [],
    },
    modelId: "scripted",
    result: {
      finalStatus: "pass",
      turns: [{
        i: 0,
        action: { a: "query", q: "generate_image probe" },
        observation: "one image survived",
        queryExecuted: true,
        queryTool: "generate_image",
        toolOutcome: outcome,
      }],
      rejectedOutputs: [],
      warnings: [],
      metrics: {
        turns: 1,
        toolOutcomeCounts: { partial: 1 },
      },
    },
  });

  assert.deepEqual(artifact.turns[0].toolOutcome, outcome);
  assert.deepEqual(artifact.metrics.toolOutcomeCounts, { partial: 1 });
});

test("runAgent consumes a normalized terminal tool block and persists the turn", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-tool-block-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "README.md"), "# probe\n");
  const model = {
    codex: false,
    endpoint: null,
    metadata: () => ({ runtime: "test", model: "scripted" }),
    async complete() {
      return {
        content: JSON.stringify({ a: "query", q: "terminal_probe" }),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
  const terminalTool = {
    name: "terminal_probe",
    description: "emit a terminal infrastructure block",
    verbs: ["terminal_probe"],
    lastOutcome: null,
    answer() {
      this.lastOutcome = {
        status: "blocked",
        blocked: {
          terminal: true,
          ecosystem: "test-provider",
          operation: "probe",
          reason: "injected terminal condition",
        },
      };
      return "probe blocked";
    },
  };

  const result = await runAgent({
    task: "Run terminal_probe once.",
    workspace,
    model,
    grounding: true,
    extraTools: [terminalTool],
    maxTurns: 3,
    preGate: false,
  });

  assert.equal(result.blocked.terminal, true);
  assert.equal(result.blocked.reason, "injected terminal condition");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].toolOutcome.status, "blocked");
  assert.equal(result.metrics.toolOutcomeCounts.blocked, 1);

  const summary = formatExperimentSummary({
    id: "tool-outcome-lifecycle",
    name: "tool-outcome-lifecycle",
    status: "complete_with_failures",
    specSha256: "abc123",
    spec: {
      rounds: 1,
      fixtures: ["terminal-probe"],
      arms: [{ name: "scripted", model: { runtime: "test", name: "scripted" } }],
    },
    schedule: [{
      arm: "scripted",
      round: 1,
      status: "complete",
      durationMs: 1,
      runs: [{
        name: "terminal-probe",
        status: "blocked",
        turns: 1,
        toolOutcomeCounts: result.metrics.toolOutcomeCounts,
      }],
    }],
  });
  assert.match(summary, /## Tool outcomes/);
  assert.match(summary, /\| Arm \| blocked \|/);
  assert.match(summary, /\| scripted \| 1 \|/);
});
