import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  applyFactoryCodingCell,
  FactoryStore,
  lifecycleCellLine,
  runLifecycleFactoryCell,
} from "../src/factory.js";
import { runFactoryCommand } from "../src/factory-cli.js";

const temporary = new Set();
const fixture = path.resolve("gauntlet/fixtures/keyed-task-pool-strong");
const spec = JSON.parse(fs.readFileSync(path.join(fixture, "task.json"), "utf8"));
const hiddenGrader = path.join(fixture, "grader", "contract.test.cjs");

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lifecycle-cell-test-"));
  temporary.add(root);
  const source = path.join(root, "source");
  fs.cpSync(path.join(fixture, "repo"), source, { recursive: true });
  return { root, source, factoryRoot: path.join(source, ".bantam", "factory") };
}

function hiddenCommand() {
  return `CANDIDATE_ROOT="$PWD" node ${quote(hiddenGrader)}`;
}

function fakeWorkers(prompts, { focusedFailure = false } = {}) {
  let poolAttempt = 0;
  let planAttempt = 0;
  return async (options) => {
    prompts.push(options.task);
    if (options.task.includes("[LIFECYCLE DIAGNOSIS STATION]")) {
      assert.equal(options.advisoryMode, true);
      assert.equal(options.verificationPolicy, "after_edit");
      assert.equal(options.progressAwareness, false);
      assert.ok(options.excludeActions.includes("write_file"));
      assert.ok(options.investigationActionLimit >= 2);
      // Even a badly behaved diagnostic worker receives a disposable chassis.
      fs.writeFileSync(path.join(options.workspace, "src", "keyed-task-pool.js"), "throw new Error('diagnosis escaped');\n");
      return result({ responded: true, summary: "The key Promise must be published before task invocation and retired before settlement." });
    }
    assert.match(options.editGuard("test/public.test.js"), /refused grader path/);
    if (options.task.includes("[KEYED POOL ASSEMBLY STATION]")) {
      assert.equal(options.editGuard("src/keyed-task-pool.js"), null);
      assert.match(options.editGuard("src/run-plan.js"), /refused .*path/);
      poolAttempt++;
      fs.writeFileSync(path.join(options.workspace, "src", "keyed-task-pool.js"), `${POOL}\n// factory pool assembly ${poolAttempt}\n`);
      if (focusedFailure) fs.appendFileSync(path.join(options.workspace, "src", "keyed-task-pool.js"), "\n// candidate selected for planted red gauge\n");
      return result({ reachedDone: true, summary: "Installed the keyed pool lifecycle mechanism." });
    }
    assert.match(options.task, /\[RUN PLAN ASSEMBLY STATION\]/);
    assert.equal(options.editGuard("src/run-plan.js"), null);
    assert.match(options.editGuard("src/keyed-task-pool.js"), /refused .*path/);
    planAttempt++;
    fs.writeFileSync(path.join(options.workspace, "src", "run-plan.js"), `${RUN_PLAN}\n// factory plan assembly ${planAttempt}\n`);
    return result({ reachedDone: true, summary: "Implemented bounded keyed lifecycle state transitions." });
  };
}

function result(overrides) {
  return {
    reachedDone: false,
    responded: false,
    interrupted: false,
    blocked: false,
    modelFailure: null,
    metrics: { turns: 2, tokens: 80, modelRequests: 2 },
    turns: [{}, {}],
    rejectedOutputs: [],
    ...overrides,
  };
}

describe("async keyed lifecycle production cell", () => {
  it("compiles the hand-authored S0-S9 route with one file jig per assembly worker", () => {
    const { route, assets } = lifecycleCellLine();
    assert.equal(route.stations.length, 10);
    assert.equal(route.edges.length, 16);
    assert.deepEqual(assets.diagnosis.authority, ["workspace.read"]);
    assert.equal(assets.diagnosis.version, 2);
    assert.equal(assets.diagnosis.worker.adapter, "bantam.factory.lifecycle-diagnosis/v2");
    assert.deepEqual(assets.pool.authority, ["workspace.read", "workspace.write"]);
    assert.deepEqual(assets.plan.authority, ["workspace.read", "workspace.write"]);
    assert.equal(assets.pool.schema, 2);
    assert.match(assets.pool.standardWork.fixtures.join(" "), /src\/keyed-task-pool\.js/);
    assert.match(assets.plan.standardWork.fixtures.join(" "), /src\/run-plan\.js/);
    assert.equal(assets.audit.gauge.independent, true);
  });

  it("manufactures a hidden-contract-green candidate through all ten stations", async () => {
    const { source, factoryRoot } = workspace();
    const original = fs.readFileSync(path.join(source, "src", "keyed-task-pool.js"), "utf8");
    const prompts = [];
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-green",
      task: spec.task,
      publicVerificationScript: spec.verify,
      verificationScript: hiddenCommand(),
      runAgentFn: fakeWorkers(prompts),
    });

    assert.equal(built.manifest.cell, "async-keyed-lifecycle");
    assert.equal(built.line.supervisor.status, "released");
    assert.equal(built.line.supervisor.stations.length, 10);
    assert.deepEqual(built.line.supervisor.stations.map((station) => station.gaugeStatus), Array(10).fill("pass"));
    assert.equal(built.manifest.inspections.focused.pass, true);
    assert.equal(built.manifest.inspections.public.pass, true);
    assert.equal(built.manifest.inspections.final.pass, true);
    assert.notEqual(built.manifest.baseline.tree, built.manifest.candidate.tree);
    assert.equal(fs.readFileSync(path.join(source, "src", "keyed-task-pool.js"), "utf8"), original);
    assert.equal(prompts.length, 3);
    assert.equal(prompts.every((prompt) => !prompt.includes(hiddenGrader)), true);
    assert.equal(prompts.every((prompt) => !prompt.includes("PUBLIC TASK:")), true);
    assert.match(prompts[1], /publish-before-user-code/);
    assert.match(prompts[1], /UPSTREAM DIAGNOSIS/);
    assert.doesNotMatch(prompts[1], /atomic-plan-validation/);
    assert.match(prompts[2], /atomic-plan-validation/);
    assert.doesNotMatch(prompts[2], /publish-before-user-code/);
    const packets = built.line.events.filter((event) => event.type === "station.telemetry" && event.payload.sourceType === "worker-button");
    const pecks = built.line.events.filter((event) => event.type === "station.telemetry" && event.payload.sourceType === "worker-peck");
    assert.equal(packets.length, 3);
    assert.equal(pecks.length, 6);
    const packetValues = packets.map((event) => new FactoryStore(factoryRoot).getEvidence(event.payload.artifactRef));
    assert.deepEqual(packetValues.map((packet) => packet.kind), Array(3).fill("bantam.factory-worker-packet"));
    assert.deepEqual(packetValues.map((packet) => packet.stationAttempt), ["diagnosis-1", "pool-1", "plan-1"]);
    assert.equal(packetValues.every((packet) => packet.assignedBy === "factory-controller"), true);
    assert.deepEqual(packetValues[1].harness.editable, ["src/keyed-task-pool.js"]);
    assert.deepEqual(packetValues[2].harness.editable, ["src/run-plan.js"]);
  });

  it("promotes the released lifecycle chassis through the generic safe apply gate", async () => {
    const { source, factoryRoot } = workspace();
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-apply",
      task: spec.task,
      publicVerificationScript: spec.verify,
      verificationScript: hiddenCommand(),
      runAgentFn: fakeWorkers([]),
    });
    const applied = await applyFactoryCodingCell({ manifestPath: built.manifestPath });
    assert.equal(applied.transaction.state, "committed");
    assert.match(fs.readFileSync(path.join(source, "src", "keyed-task-pool.js"), "utf8"), /class KeyedTaskPool/);
  });

  it("contains a planted focused-gauge failure before public or hidden verification", async () => {
    const { source, factoryRoot } = workspace();
    const commands = [];
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-focused-red",
      task: spec.task,
      focusedVerificationScript: "focused-red",
      publicVerificationScript: "public-must-not-run",
      verificationScript: "hidden-must-not-run",
      runAgentFn: fakeWorkers([], { focusedFailure: true }),
      verifier: async (_workspace, command) => {
        commands.push(command);
        return { pass: command !== "focused-red", status: command === "focused-red" ? "fail" : "pass" };
      },
      maxReworkCycles: 0,
    });

    assert.deepEqual(commands, ["focused-red"]);
    assert.equal(built.line.supervisor.status, "blocked");
    assert.equal(built.line.supervisor.stations.at(-1).stationAttempt, "focused-1");
    assert.deepEqual(built.line.supervisor.chassis.contained, [`tree:${built.manifest.candidate.tree}`]);
    assert.equal(fs.readFileSync(path.join(source, "src", "keyed-task-pool.js"), "utf8").includes("class KeyedTaskPool"), true);
    assert.equal(fs.readFileSync(path.join(source, "src", "keyed-task-pool.js"), "utf8").includes("TODO"), true);
  });

  it("contains the first candidate and releases one bounded diagnosis-mutation rework", async () => {
    const { source, factoryRoot } = workspace();
    const prompts = [];
    const commands = [];
    let focused = 0;
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-rework-green",
      task: spec.task,
      focusedVerificationScript: "focused-check",
      publicVerificationScript: "public-check",
      verificationScript: "hidden-check",
      runAgentFn: fakeWorkers(prompts),
      verifier: async (_workspace, command) => {
        commands.push(command);
        if (command === "focused-check" && ++focused === 1) return { pass: false, status: "fail", detail: "planted first-article red" };
        return { pass: true, status: "pass" };
      },
    });

    assert.deepEqual(commands, ["focused-check", "focused-check", "public-check", "hidden-check"]);
    assert.equal(built.line.supervisor.status, "released");
    assert.equal(built.line.supervisor.reworkCount, 1);
    assert.equal(built.line.supervisor.stations.length, 14);
    assert.equal(built.line.supervisor.chassis.contained.length, 1);
    assert.notEqual(built.line.supervisor.chassis.contained[0], built.line.supervisor.chassis.released);
    assert.equal(prompts.length, 6);
    assert.match(prompts[3], /REWORK SIGNAL/);
    assert.match(prompts[3], /focused-1/);
    assert.equal(built.line.events.filter((event) => event.type === "rework.authorized").length, 1);
  });

  it("refuses to route an unrelated task through the specialist cell", async () => {
    const { source, factoryRoot } = workspace();
    await assert.rejects(runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      task: "Change the page background color.",
      publicVerificationScript: "npm test",
      verificationScript: "npm test",
      runAgentFn: fakeWorkers([]),
    }), /requires a keyed-task-pool lifecycle contract/);
  });

  it("dispatches the specialist route from the factory build command", async () => {
    const { source, factoryRoot } = workspace();
    const stdout = sink();
    const stderr = sink();
    const code = await runFactoryCommand([
      "factory", "build", spec.task,
      "--cell", "keyed-lifecycle",
      "--public-verify", spec.verify,
      "--verify", hiddenCommand(),
      "--job-id", "lifecycle-cli",
      "--factory-home", factoryRoot,
      "--json",
    ], { cwd: source, stdout, stderr, runAgentFn: fakeWorkers([]) });
    assert.equal(code, 0, stderr.text());
    const result = JSON.parse(stdout.text());
    assert.equal(result.cell, "async-keyed-lifecycle");
    assert.equal(result.status, "released");
    assert.equal(result.travelerEvents > 40, true);
  });

  it("records shadow staffing and worker attendance without changing model dispatch", async () => {
    const { source, factoryRoot } = workspace();
    const eligible = [];
    const health = [];
    const workforce = {
      eligible(options) {
        eligible.push(options);
        return {
          selected: "worker:shadow@1:sha256:" + "a".repeat(64),
          workforceHead: "sha256:" + "b".repeat(64),
          eligible: [{ workerRef: "worker:shadow@1:sha256:" + "a".repeat(64) }],
          rejected: [{ workerRef: "worker:late@1:sha256:" + "c".repeat(64), reasons: ["unavailable:quota-empty"] }],
        };
      },
      observeRuntimeHealth(value) { health.push(value); },
    };
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-shadow-staffing",
      task: spec.task,
      publicVerificationScript: spec.verify,
      verificationScript: hiddenCommand(),
      runAgentFn: fakeWorkers([]),
      workforce,
    });
    assert.equal(built.manifest.status, "released");
    assert.equal(built.manifest.staffing.length, 3);
    assert.deepEqual(eligible.map((row) => row.taskFamily), ["async-keyed-lifecycle", "async-keyed-lifecycle", "async-keyed-lifecycle"]);
    assert.deepEqual(health.map((row) => ({ identity: row.identity, condition: row.condition, code: row.code })), [
      { identity: "bantam-agent:injected", condition: "available", code: "station-response" },
      { identity: "bantam-agent:injected", condition: "available", code: "station-response" },
      { identity: "bantam-agent:injected", condition: "available", code: "station-response" },
    ]);
    assert.equal(built.line.events.filter((event) => event.type === "station.telemetry" && event.payload.sourceType === "staffing-shadow").length, 3);
  });

  it("records a quota no-show as workforce unavailability at the stopped station", async () => {
    const { source, factoryRoot } = workspace();
    const health = [];
    const workforce = {
      eligible() { return { selected: null, workforceHead: null, eligible: [], rejected: [] }; },
      observeRuntimeHealth(value) { health.push(value); },
    };
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-worker-no-show",
      task: spec.task,
      publicVerificationScript: spec.verify,
      verificationScript: hiddenCommand(),
      runAgentFn: async () => result({ modelFailure: { message: "usage limit reached; out of tokens" } }),
      workforce,
    });
    assert.equal(built.manifest.status, "blocked");
    assert.equal(built.manifest.staffing.length, 1);
    assert.equal(health.length, 1);
    assert.equal(health[0].condition, "unavailable");
    assert.equal(health[0].code, "quota-unavailable");
    assert.equal(built.line.supervisor.stations.at(-1).stationAttempt, "diagnosis-1");
  });

  it("records a thrown adapter outage before containing the job", async () => {
    const { source, factoryRoot } = workspace();
    const health = [];
    const workforce = {
      eligible() { return { selected: null, workforceHead: null, eligible: [], rejected: [] }; },
      observeRuntimeHealth(value) { health.push(value); },
    };
    const built = await runLifecycleFactoryCell({
      workspace: source,
      root: factoryRoot,
      jobId: "lifecycle-worker-adapter-outage",
      task: spec.task,
      publicVerificationScript: spec.verify,
      verificationScript: hiddenCommand(),
      runAgentFn: async () => { throw new Error("provider connection refused"); },
      workforce,
    });
    assert.equal(built.manifest.status, "blocked");
    assert.equal(built.manifest.staffing.length, 1);
    assert.equal(health.length, 1);
    assert.equal(health[0].condition, "unavailable");
    assert.equal(health[0].code, "adapter-exception");
    assert.match(health[0].detail, /^diagnosis-1: provider connection refused$/);
    assert.equal(built.line.supervisor.stations.at(-1).stationAttempt, "diagnosis-1");
  });
});

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sink() {
  let value = "";
  return { write(chunk) { value += chunk; }, text() { return value; } };
}

const POOL = `export class KeyedTaskPool {
  constructor({ concurrency = 2 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("invalid concurrency");
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.byKey = new Map();
    this.idleWaiters = [];
  }

  run(key, task) {
    if (typeof key !== "string" || key.length === 0) throw new TypeError("key must be a non-empty string");
    if (typeof task !== "function") throw new TypeError("task must be a function");
    if (this.byKey.has(key)) return this.byKey.get(key).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const record = { key, task, promise, resolve, reject };
    this.byKey.set(key, record);
    this.queue.push(record);
    this.#drain();
    return promise;
  }

  onIdle() {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const record = this.queue.shift();
      this.running++;
      let result;
      try { result = record.task(); }
      catch (error) { this.#settle(record, false, error); continue; }
      Promise.resolve(result).then(
        (value) => this.#settle(record, true, value),
        (error) => this.#settle(record, false, error),
      );
    }
    this.#resolveIdle();
  }

  #settle(record, fulfilled, value) {
    if (this.byKey.get(record.key) === record) this.byKey.delete(record.key);
    this.running--;
    this.#drain();
    if (fulfilled) record.resolve(value); else record.reject(value);
    this.#resolveIdle();
  }

  #resolveIdle() {
    if (this.running !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
`;

const RUN_PLAN = `import { KeyedTaskPool } from "./keyed-task-pool.js";

export async function runPlan(steps, worker, options = {}) {
  if (!Array.isArray(steps) || typeof worker !== "function") throw new TypeError("invalid plan");
  for (const step of steps) {
    if (!step || typeof step !== "object" || typeof step.key !== "string" || step.key.length === 0 || !("payload" in step)) {
      throw new TypeError("invalid plan step");
    }
  }
  const pool = new KeyedTaskPool(options);
  const work = steps.map((step) => pool.run(step.key, () => worker(step.payload, step.key)));
  const results = await Promise.all(work.map((promise, index) => promise.then(
    (value) => ({ key: steps[index].key, status: "fulfilled", value }),
    (reason) => ({ key: steps[index].key, status: "rejected", reason }),
  )));
  await pool.onIdle();
  return results;
}
`;
