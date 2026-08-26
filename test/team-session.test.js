import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTeamPrimary,
  formatTeamComparison,
  loadTeamManifest,
  TeamSession,
} from "../src/team-session.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-team-"));
  fs.writeFileSync(path.join(root, "source.js"), "export const value = 'baseline';\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  return root;
}

function fakeModel(arm) {
  return {
    endpoint: arm.name === "local" ? "http://localhost:8085" : null,
    modelName: arm.model.name ?? "local",
    profileName: arm.name,
    codex: arm.model.runtime === "codex",
    async health() { return true; },
    metadata() { return { model: this.modelName }; },
    usageSummary() {
      return {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costUsd: 0,
      };
    },
    requestLog() { return []; },
    close() { this.closed = true; },
  };
}

function result({ summary, advisory }) {
  return {
    done: true,
    reachedDone: true,
    responded: advisory,
    summary,
    interrupted: false,
    blocked: null,
    modelFailure: null,
    warnings: [],
    verification: advisory
      ? { status: "skipped", detail: "read only" }
      : { status: "pass", detail: "ok", exitCode: 0 },
    turns: [],
    rejectedOutputs: [],
    integrity: null,
    metrics: {
      turns: 1,
      invalid: 0,
      protocolViolations: 0,
      tokens: 10,
      thinkTokens: 0,
      actionTokens: 10,
      actions: advisory ? { respond: 1 } : { write_file: 1 },
    },
  };
}

const verifier = async () => ({
  pass: true,
  status: "pass",
  exitCode: 0,
  durationMs: 1,
  detail: "ok",
});

test("Team runs read-only specialists concurrently, then one Terra writer", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scoutStarts = [];
  let releaseScouts;
  const allScouts = new Promise((resolve) => { releaseScouts = resolve; });
  const calls = [];
  const session = new TeamSession({
    workspace: root,
    id: "parallel-specialists",
    includeLocal: true,
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: verifier,
    runAgentImpl: async (options) => {
      const arm = path.basename(options.workspace);
      const advisory = Array.isArray(options.excludeActions);
      calls.push({ arm, advisory, options });
      if (advisory) {
        scoutStarts.push(arm);
        if (scoutStarts.length === 3) releaseScouts();
        await allScouts;
        return result({ summary: `${arm} evidence`, advisory: true });
      }
      assert.equal(arm, "terra");
      assert.doesNotMatch(options.task, /continuing BANTAM trio lane/);
      assert.equal(options.investigationActionLimit, null);
      assert.match(options.task, /Parallel specialist findings:/);
      assert.match(options.task, /local evidence/);
      assert.match(options.task, /luna evidence/);
      assert.match(options.task, /sol evidence/);
      assert.match(options.task, /requirement ledger from the ORIGINAL operator task/);
      assert.match(options.task, /green supplied test suite is necessary but not sufficient/);
      fs.writeFileSync(path.join(options.workspace, "answer.txt"), "terra integrated\n");
      return result({ summary: "Terra integrated and verified.", advisory: false });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });

  const started = await session.start();
  assert.equal(started.includeLocal, true);
  const outcome = await session.runTask("Implement the feature.");

  assert.deepEqual(new Set(scoutStarts), new Set(["local", "luna", "sol"]));
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => !call.advisory).length, 1);
  for (const call of calls.filter((entry) => entry.advisory)) {
    for (const verb of [
      "replace", "edit_lines", "patch", "write_file",
      "delete_file", "move_file", "shell", "done",
    ]) {
      assert.ok(call.options.excludeActions.includes(verb), `${verb} must be disabled`);
    }
    assert.equal(call.options.maxTurns, 5);
    assert.equal(call.options.investigationActionLimit, 2);
    assert.equal(call.options.advisoryMode, true);
    assert.equal(call.options.verificationScript, null);
  }
  const lunaCall = calls.find((call) => call.arm === "luna" && call.advisory);
  const solCall = calls.find((call) => call.arm === "sol" && call.advisory);
  assert.match(lunaCall.options.task, /SATISFIED, GAP, or UNKNOWN/);
  assert.match(lunaCall.options.task, /under 8,000 characters/);
  assert.match(solCall.options.task, /prioritize observed code gaps/);
  assert.match(calls.find((call) => !call.advisory).options.task, /preserve every already-compliant file/);
  assert.equal(outcome.findings.length, 3);
  assert.equal(outcome.primary.arm, "terra");
  assert.equal(outcome.comparison.rows.length, 4);
  assert.equal(outcome.comparison.totalCacheHitTokens, 0);
  assert.equal(outcome.comparison.totalCacheMissTokens, 0);
  for (const row of outcome.comparison.rows) {
    assert.equal(typeof row.cacheHitTokens, "number");
    assert.equal(typeof row.cacheMissTokens, "number");
  }
  const formatted = formatTeamComparison(outcome.comparison);
  assert.match(formatted, /terra-primary/);
  assert.match(formatted, /Cache hit/);
  assert.match(formatted, /Total cache hit\/miss:/);
  assert.equal(fs.existsSync(path.join(root, "answer.txt")), false);
  assert.equal(
    fs.readFileSync(path.join(session.engine.view().arms.terra.workspace, "answer.txt"), "utf8"),
    "terra integrated\n",
  );
  for (const arm of ["local", "luna", "sol"]) {
    const state = session.engine.view().arms[arm];
    assert.equal(fs.readFileSync(path.join(state.workspace, "answer.txt"), "utf8"), "terra integrated\n");
    assert.equal(state.synchronizedFrom.arm, "terra");
  }
  assert.ok(fs.existsSync(path.join(session.directory, "team-summary.md")));
  assert.ok(fs.existsSync(path.join(session.directory, "team-report", "index.html")));
  assert.equal(loadTeamManifest(session.directory).taskCount, 1);
});

test("Team skips Local cleanly and transactionally applies only Terra", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new TeamSession({
    workspace: root,
    id: "no-local-safe-apply",
    includeLocal: false,
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: verifier,
    runAgentImpl: async (options) => {
      const advisory = Array.isArray(options.excludeActions);
      if (!advisory) fs.writeFileSync(path.join(options.workspace, "answer.txt"), "terra only\n");
      return result({
        summary: advisory ? `${path.basename(options.workspace)} finding` : "Terra complete.",
        advisory,
      });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });
  await session.start();
  const outcome = await session.runTask("Implement safely.");
  assert.deepEqual(outcome.findings.map((row) => row.arm), ["luna", "sol"]);
  assert.equal(session.view().includeLocal, false);

  const applied = await applyTeamPrimary({
    sessionDir: session.directory,
    workspace: root,
    runVerifier: verifier,
  });
  assert.equal(applied.arm, "terra");
  assert.equal(fs.readFileSync(path.join(root, "answer.txt"), "utf8"), "terra only\n");
});

test("Team advisory tasks keep the Terra synthesis read-only", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const session = new TeamSession({
    workspace: root,
    id: "advisory-team",
    includeLocal: false,
    modelFactory: async (arm) => fakeModel(arm),
    runAgentImpl: async (options) => {
      calls.push(options);
      return result({ summary: "Read-only advice.", advisory: true });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });
  await session.start();
  const outcome = await session.runTask("What should we improve next?");
  assert.equal(outcome.comparison.intent, "advisory");
  assert.equal(calls.length, 3);
  for (const options of calls) {
    assert.ok(options.excludeActions.includes("write_file"));
    assert.equal(options.verificationPolicy, "after_edit");
  }
  assert.match(calls.at(-1).task, /only Team answer the operator will see/);
  assert.match(calls.at(-1).task, /state the requested finding, reasoning, and concrete evidence/);
  assert.equal(calls.at(-1).investigationActionLimit, 2);
  assert.equal(fs.readFileSync(path.join(root, "source.js"), "utf8"), "export const value = 'baseline';\n");
  await assert.rejects(
    applyTeamPrimary({
      sessionDir: session.directory,
      workspace: root,
      runVerifier: verifier,
    }),
    /implementation task/,
  );
});

test("Team substitutes grounded findings for a content-free Terra advisory synthesis", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const session = new TeamSession({
    workspace: root,
    id: "advisory-fallback-team",
    includeLocal: false,
    modelFactory: async (arm) => fakeModel(arm),
    runAgentImpl: async (options) => {
      calls += 1;
      const advisory = Array.isArray(options.excludeActions);
      return result({
        summary: calls <= 2
          ? `${path.basename(options.workspace)} found src/team-session.js lacks a phase-boundary assertion.`
          : "The requested analysis has been provided.",
        advisory,
      });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });

  await session.start();
  const outcome = await session.runTask("Audit Team mode and identify one risk.");

  assert.equal(outcome.primary.synthesisFallback, true);
  assert.match(outcome.primary.summary, /Team findings/);
  assert.match(outcome.primary.summary, /src\/team-session\.js/);
  assert.equal(outcome.primary.status, "response-fallback");
});

test("Team restores every scout lane and refuses integration after any scout mutation", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let primaryCalls = 0;
  const session = new TeamSession({
    workspace: root,
    id: "scout-mutation-fail-closed",
    includeLocal: false,
    modelFactory: async (arm) => fakeModel(arm),
    runAgentImpl: async (options) => {
      const advisory = Array.isArray(options.excludeActions);
      if (!advisory) {
        primaryCalls += 1;
        return result({ summary: "must not run", advisory: false });
      }
      if (path.basename(options.workspace) === "sol") {
        fs.writeFileSync(path.join(options.workspace, "scout-leak.txt"), "forbidden\n");
      }
      return result({ summary: `${path.basename(options.workspace)} finding`, advisory: true });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });

  await session.start();
  const outcome = await session.runTask("Implement the reviewed change.");

  assert.equal(primaryCalls, 0);
  assert.equal(outcome.primary, null);
  assert.equal(outcome.comparison.status, "scout-policy-violation");
  assert.deepEqual(session.view().tasks[0].unsafeScouts, [{
    arm: "sol",
    status: "policy-violation",
    files: ["scout-leak.txt"],
  }]);
  for (const state of Object.values(session.engine.view().arms)) {
    assert.equal(fs.existsSync(path.join(state.workspace, "scout-leak.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(state.workspace, "source.js"), "utf8"),
      "export const value = 'baseline';\n",
    );
    assert.deepEqual(state.history, []);
  }
  assert.equal(fs.existsSync(path.join(root, "scout-leak.txt")), false);
});

test("Team interruption after scouting does not launch the Terra primary", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let calls = 0;
  const session = new TeamSession({
    workspace: root,
    id: "interrupted-team",
    includeLocal: false,
    modelFactory: async (arm) => fakeModel(arm),
    runAgentImpl: async () => {
      calls += 1;
      controller.abort();
      return result({ summary: "Bounded scout result.", advisory: true });
    },
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });
  await session.start();
  const outcome = await session.runTask("Review the design.", { signal: controller.signal });
  assert.equal(calls, 2);
  assert.equal(outcome.primary, null);
  assert.equal(outcome.comparison.status, "interrupted");
  assert.equal(outcome.comparison.rows.length, 2);
});

test("Team refuses an overlapping task while a task is active", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new TeamSession({
    workspace: root,
    id: "overlap-team",
    includeLocal: false,
    modelFactory: async (arm) => fakeModel(arm),
    runAgentImpl: async () => result({ summary: "unused", advisory: true }),
  });
  t.after(() => {
    session.close();
    if (session.engine.runtimeRoot) {
      fs.rmSync(session.engine.runtimeRoot, { recursive: true, force: true });
    }
  });
  await session.start();
  session.team.status = "active";
  await assert.rejects(session.runTask("Review again."), /not ready/);
});
