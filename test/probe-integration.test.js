import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { actionDefinition, actionPromptMenu, actionPromptRules, enabledActionDefinitions, PROBE_ACTION_FEATURE } from "../src/action-protocol.js";
import { ActionSchema } from "../src/actions.js";
import { actionGrammar, actionJsonSchema } from "../src/grammar.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { verificationVerdict } from "../src/done-guard.js";
import { unresolvedRunFailure } from "../src/logic/evidence-guard.js";
import { classifyAction } from "../src/diagnose.js";
import { FactoryRunTelemetry, FactoryStore, projectFactorySupervisor } from "../src/factory.js";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-probe-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = directory(t), workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace, "src/value.js"), "export const value = 1;\n");
  return { root, workspace };
}

const probe = {
  a: "probe", question: "Does the copied implementation expose the expected value?",
  inputs: [{ p: "src/value.js" }, { p: "package.json" }],
  setup: "printf '42\\n' > expected.txt",
  witness: "test -s expected.txt",
  check: "node --input-type=module -e 'import {value} from \"./subject/src/value.js\"; if (value !== 42) process.exit(1)'",
};

function scriptedModel(actions, inspect = () => {}) {
  let calls = 0;
  return { assistantPrefill: "", actTemperature: null, async complete(prompt, options) {
    inspect(String(prompt), options, calls);
    const action = actions[Math.min(calls++, actions.length - 1)];
    return { content: JSON.stringify(action), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  } };
}

function options(workspace, model, extra = {}) {
  return { workspace, model, task: "Inspect the value and report the result.",
    maxTurns: 8, interactive: true, useGrammar: false, grounding: false,
    completionAudit: false, stateAudit: "off", contractStateAudit: "off",
    progressAwareness: false, shellSandbox: "docker", probeEnabled: true,
    ...extra };
}

const processResult = (code, stdout = "", extra = {}) => ({ code, stdout, stderr: "", ...extra });

test("probe has one opt-in protocol shape with 0..16 inputs and no inspect reachability", () => {
  assert.ok(!enabledActionDefinitions().some(({ verb }) => verb === "probe"));
  assert.doesNotMatch(actionPromptMenu(), /"a":"probe"/);
  const features = [PROBE_ACTION_FEATURE];
  assert.match(actionPromptMenu({ features }), /"a":"probe"/);
  assert.match(actionPromptRules({ features }), /NEVER whole-task verification/);
  assert.match(actionPromptRules({ features }), /not independent semantic proof/);
  for (const length of [0, 1, 16]) {
    assert.equal(ActionSchema.safeParse({ ...probe, inputs: Array.from({ length }, (_, i) => ({ p: `file-${i}.js` })) }).success, true);
  }
  assert.equal(ActionSchema.safeParse({ ...probe, inputs: Array.from({ length: 17 }, () => ({ p: "file.js" })) }).success, false);
  assert.equal(ActionSchema.safeParse({ a: "inspect", ops: [probe] }).success, false);
  assert.deepEqual(actionDefinition("probe").groups, []);
  assert.equal(classifyAction(JSON.stringify(probe)), "recon", "an experiment is not an implementation edit");
  assert.equal(actionJsonSchema({ features }).properties.inputs.minItems, 0);
  assert.equal(actionJsonSchema({ features }).properties.inputs.maxItems, 16);
  assert.ok(!actionJsonSchema().properties.a.enum.includes("probe"));
  assert.ok(actionJsonSchema({ features }).properties.a.enum.includes("probe"));
  assert.ok(!actionJsonSchema({ features, excludeVerbs: ["probe"] }).properties.a.enum.includes("probe"));
  const grammar = actionGrammar({ features });
  const rule = grammar.split("\n").find(line => line.startsWith("probe-inputs ::="));
  assert.match(rule, /"\[" ws \( probe-input/);
  assert.equal([...rule.split("::=")[1].matchAll(/probe-input\b/g)].length, 16, "zero-input alternative must not accidentally permit seventeen");
  assert.match(rule, /\)\? ws "\]"$/);
});

test("agent refuses feature-disabled probe even without sampling grammar", async t => {
  const { workspace } = fixture(t);
  const events = [];
  let executions = 0;
  const result = await runAgent(options(workspace,
    scriptedModel([probe, { a: "respond", text: "Feature unavailable." }]), {
      probeEnabled: false,
      shellProcessRunner: async () => { executions++; return processResult(0); },
      onEvent: event => events.push(event),
    }));
  assert.equal(executions, 0);
  assert.equal(result.metrics.probeEnabled, false);
  assert.ok(!result.turns.some(turn => turn.action?.a === "probe"));
  assert.ok(events.some(event => event.type === "invalid_action" && /probe.*disabled/.test(event.error)));
});

test("probe consumes investigation budget and is masked at wrap-up", async t => {
  const { workspace } = fixture(t), offered = [];
  await runAgent(options(workspace,
    scriptedModel([probe, { a: "respond", text: "Scoped experiment complete." }],
      (_prompt, request) => offered.push(request.jsonSchema.properties.a.enum)), {
      useGrammar: true, investigationActionLimit: 1,
      shellProcessRunner: async () => processResult(0),
    }));
  assert.ok(offered[0].includes("probe"));
  assert.ok(!offered[1].includes("probe"));
  assert.ok(offered[1].includes("respond"));
});

test("agent consumes a fixture counterexample, repairs actual source, and verifies separately", async t => {
  const { workspace } = fixture(t);
  const events = [], prompts = [], checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const initial = fs.readFileSync(path.join(workspace, "src/value.js"), "utf8");
  let stages = 0;
  const actions = [probe,
    { a: "replace", p: "src/value.js", old: "value = 1", new: "value = 42" },
    probe, { a: "shell", c: "npm test" }, { a: "respond", text: "Repaired and independently checked." }];
  const result = await runAgent(options(workspace,
    scriptedModel(actions, prompt => prompts.push(prompt)), {
      shellProcessRunner: async (file, args, runOptions) => {
        assert.equal(file, "docker");
        if (runOptions.cwd === workspace) return processResult(0, "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n");
        assert.ok(args.includes("none"), "fixture remains offline");
        const phase = stages++ % 3;
        if (phase === 0) return processResult(0, "Fixture prepared.\n");
        if (phase === 1) return processResult(0, "Expected case asserted.\n");
        const source = fs.readFileSync(path.join(runOptions.cwd, "subject/src/value.js"), "utf8");
        if (stages === 3) assert.equal(fs.readFileSync(path.join(workspace, "src/value.js"), "utf8"), initial);
        return source.includes("value = 42") ? processResult(0, "Value assertion passed.\n")
          : processResult(1, "COUNTEREXAMPLE: expected 42, received 1.\n");
      },
      onEvent: event => { events.push(event); checkpoint.note(event); },
    }));
  assert.equal(stages, 6);
  assert.match(prompts[1], /COUNTEREXAMPLE: expected 42, received 1/);
  assert.equal(fs.readFileSync(path.join(workspace, "src/value.js"), "utf8"), "export const value = 42;\n");
  const probes = result.turns.filter(turn => turn.action?.a === "probe");
  assert.deepEqual(probes.map(turn => turn.probeEvidence.projection.status), ["assertion_failed", "assertion_passed"]);
  for (const turn of probes) {
    assert.equal(turn.verificationEvidence, null);
    assert.equal(turn.shellExecution, null);
    assert.equal(verificationVerdict(turn), null);
  }
  const verified = result.turns.find(turn => turn.action?.a === "shell");
  assert.equal(verified.verificationEvidence.status, "pass");
  assert.equal(verified.verificationEvidence.generation, 1, "only the real edit advances candidate generation");
  assert.equal(events.filter(event => event.type === "probe").length, 2);
  const saved = buildArtifact({ runId: "probe-integration", stamp: "test", model: {}, result });
  for (const turn of probes) {
    assert.deepEqual(saved.turns[turn.i].probeEvidence, turn.probeEvidence);
    assert.deepEqual(checkpoint.turns()[turn.i].probeEvidence, turn.probeEvidence);
  }
});

test("passing probe cannot erase a failed ordinary verification or become final proof", async t => {
  const { workspace } = fixture(t);
  const result = await runAgent(options(workspace,
    scriptedModel([{ a: "shell", c: "npm test" }, probe, { a: "respond", text: "The fixture passed; the project verifier still fails." }]), {
      shellProcessRunner: async (_file, _args, runOptions) => runOptions.cwd === workspace
        ? processResult(1, "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n") : processResult(0),
    }));
  const observed = result.turns.find(turn => turn.action?.a === "probe");
  assert.ok(observed?.probeEvidence);
  assert.equal(observed.probeEvidence.projection.status, "assertion_passed");
  assert.equal(verificationVerdict(observed), null);
  const unresolved = unresolvedRunFailure(result.turns, { workspaceGeneration: 0 });
  assert.equal(unresolved?.cmd, "npm test");
  assert.equal(unresolved?.reason, "exit 1");
});

test("probe evidence and explicit null verification survive saved, resumed, and interrupted turns", async t => {
  const { workspace } = fixture(t);
  const evidence = { schema: 1, projection: { status: "unresolved", reasons: ["interrupted"] }, stages: [] };
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  checkpoint.note({ type: "action", action: probe });
  checkpoint.note({ type: "observation", observation: "Probe interrupted.", probeEvidence: evidence,
    verificationEvidence: null, shellExecution: null });
  evidence.projection.status = "tampered-after-event";
  assert.equal(checkpoint.turns()[0].probeEvidence.projection.status, "unresolved");
  const result = await runAgent(options(workspace,
    scriptedModel([{ a: "respond", text: "No verified conclusion." }]), {
      resumeTurns: checkpoint.turns(),
      shellProcessRunner: async () => { throw new Error("must not re-execute a resumed probe"); },
    }));
  assert.equal(result.turns[0].probeEvidence.projection.status, "unresolved");
  assert.equal(result.turns[0].verificationEvidence, null);
  assert.equal(result.turns[0].shellExecution, null);
  const artifact = buildArtifact({ runId: "probe-resume", stamp: "test", model: {}, result });
  assert.deepEqual(artifact.turns[0].probeEvidence, checkpoint.turns()[0].probeEvidence);
  const interrupted = await runAgent(options(workspace, scriptedModel([probe]), {
    shellProcessRunner: async () => processResult(1, "Partial setup output.", { aborted: true }),
  }));
  assert.equal(interrupted.interrupted, true);
  assert.ok(interrupted.turns[0].probeEvidence);
  assert.equal(interrupted.turns[0].verificationEvidence, null);
});

test("factory traveler retains probe evidence without treating it as a verification release", t => {
  const { root, workspace } = fixture(t), factoryRoot = path.join(root, "factory");
  const telemetry = new FactoryRunTelemetry({ root: factoryRoot, jobId: "probe-traveler", workspace, task: "Investigate one assumption." });
  const event = { type: "probe", probeEvidence: { schema: 1, projection: { status: "assertion_passed" }, subject: { sha256: "snapshot-only" } } };
  assert.equal(telemetry.note(event), true);
  telemetry.finish({ reachedDone: true, verification: null, metrics: {} });
  const store = new FactoryStore(factoryRoot), traveler = store.load("probe-traveler");
  const recorded = traveler.find(row => row.type === "station.telemetry" && row.payload.sourceType === "probe");
  assert.ok(recorded);
  assert.deepEqual(store.getEvidence(recorded.payload.artifactRef), event);
  assert.equal(projectFactorySupervisor(traveler).status, "completed-unverified");
});
