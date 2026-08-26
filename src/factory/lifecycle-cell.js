// Hand-authored S0-S8 production route for async keyed lifecycle repair.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "../agent.js";
import { writeJsonAtomic } from "../atomic-file.js";
import { ModelClient } from "../model.js";
import { createShellScopeGuard, immutableEditReason } from "../scope-guard.js";
import { ADVISORY_EXCLUDED_ACTIONS } from "../task-intent.js";
import { WorkspaceStore } from "../workspace-store.js";
import { gaugeRef } from "./compatibility-line.js";
import { runFactoryVerifier } from "./coding-cell.js";
import { FactoryLineController } from "./line-controller.js";
import { StationRegistry } from "./station-registry.js";

const MANIFEST_KIND = "bantam.factory-coding-cell";
const CELL_ID = "async-keyed-lifecycle";
const WORKSPACE = "bantam.workspace/v1";
const STATE_MAP = "bantam.lifecycle-state-map/v1";
const INVARIANTS = "bantam.lifecycle-invariants/v1";
const DIAGNOSIS = "bantam.lifecycle-diagnosis/v1";
const DEFAULT_EDITABLE = Object.freeze(["src/keyed-task-pool.js", "src/run-plan.js"]);
const FOCUSED_GAUGE = fileURLToPath(new URL("./gauges/keyed-lifecycle-probe.cjs", import.meta.url));

export function lifecycleCellLine() {
  const registry = new StationRegistry();
  const installed = {};
  installed.intake = registry.install(station({
    id: "lifecycle-intake", title: "S0 Contract and chassis intake",
    purpose: "Admit the exact workspace and keyed lifecycle work order.",
    worker: tool("bantam.factory.lifecycle-intake/v1"), inputs: [], outputs: [port("chassis", WORKSPACE)],
    capabilities: ["workspace.snapshot"], authority: ["workspace.read"], gauge: independent("lifecycle-intake"), group: "intake",
    standardWork: work("Scan and admit one chassis", ["Capture the immutable source revision.", "Bind the customer order to its digest and editable envelope."], ["Read-only source checkout", "Content-addressed workspace store"], ["Never alter source material during intake."], ["Baseline revision and declared edit scope are present."]),
  }));
  installed.map = registry.install(station({
    id: "lifecycle-state-map", title: "S1 Repository and state map",
    purpose: "Extract the bounded source and state-transition surface before reasoning.",
    worker: tool("bantam.factory.lifecycle-map/v1"), inputs: [port("chassis", WORKSPACE)],
    outputs: [port("chassis", WORKSPACE), port("state-map", STATE_MAP)],
    capabilities: ["code.map", "state.map"], authority: ["workspace.read"], gauge: independent("state-map-complete"), group: "engineering",
    standardWork: work("Stamp a bounded state map", ["Inspect only declared editable files.", "Record exports and lifecycle signals."], ["Declared editable-path jig", "Deterministic source scanner"], ["Do not propose or apply a repair."], ["Every declared file has a map record."]),
  }));
  installed.invariants = registry.install(station({
    id: "lifecycle-invariants", title: "S2 Lifecycle invariant extraction",
    purpose: "Turn the public product contract into explicit lifecycle obligations.",
    worker: tool("bantam.factory.lifecycle-invariants/v1"),
    inputs: [port("chassis", WORKSPACE), port("state-map", STATE_MAP)],
    outputs: [port("chassis", WORKSPACE), port("invariants", INVARIANTS)],
    capabilities: ["contract.extract"], authority: ["workspace.read"], gauge: independent("invariant-coverage"), group: "engineering",
    standardWork: work("Punch the public contract into invariant cards", ["Convert each public lifecycle obligation into one typed card."], ["Fixed keyed-lifecycle obligation die"], ["Never expose or infer hidden verifier content."], ["The complete required obligation set is present."]),
  }));
  installed.diagnosis = registry.install(station({
    id: "lifecycle-diagnosis", version: 2, title: "S3 Read-only lifecycle diagnosis",
    purpose: "Assign a bounded model worker to explain the defect without touching production material.",
    worker: modelWorker("bantam.factory.lifecycle-diagnosis/v2"),
    inputs: [port("chassis", WORKSPACE), port("state-map", STATE_MAP), port("invariants", INVARIANTS)],
    outputs: [port("chassis", WORKSPACE), port("diagnosis", DIAGNOSIS)],
    capabilities: ["code.diagnose", "state.reason"], authority: ["workspace.read"], gauge: dependent("diagnosis-present"), group: "production",
    standardWork: work("Peck the diagnosis button", ["Inspect the supplied chassis.", "Name state ownership and the earliest broken invariant.", "Return a bounded repair card."], ["Disposable read-only chassis", "Mutation actions removed from the harness"], ["Do not edit files.", "Do not invent hidden tests.", "Do not redesign unrelated code."], ["A nonempty diagnosis names ownership, locus, and bounded repair."]),
  }));
  installed.pool = registry.install(station({
    id: "lifecycle-pool-assembly", title: "S4 Keyed pool mechanism assembly",
    purpose: "Install only the keyed task-pool lifecycle mechanism.",
    worker: modelWorker("bantam.factory.lifecycle-pool-assembly/v1"),
    inputs: [port("chassis", WORKSPACE), port("state-map", STATE_MAP), port("invariants", INVARIANTS), port("diagnosis", DIAGNOSIS)],
    outputs: [port("chassis", WORKSPACE), port("invariants", INVARIANTS)], capabilities: ["code.repair", "state.machine"],
    authority: ["workspace.read", "workspace.write"], gauge: dependent("pool-assembly-disposition"), group: "production",
    standardWork: work("Peck one keyed-pool assembly button", ["Read the keyed-pool invariant cards and diagnosis card.", "Install the queue, coalescing, retirement, and idle mechanism in src/keyed-task-pool.js."], ["Single-file edit jig: src/keyed-task-pool.js", "Shell write-scope guard", "Immutable tests and run-plan source"], ["Do not edit src/run-plan.js.", "Do not edit tests or configuration.", "Do not run downstream product gauges."], ["The worker reports a coherent keyed-pool mechanism; the next station receives a distinct chassis revision."]),
  }));
  installed.plan = registry.install(station({
    id: "lifecycle-plan-assembly", title: "S5 Run-plan mechanism assembly",
    purpose: "Install only atomic plan validation and ordered result assembly.",
    worker: modelWorker("bantam.factory.lifecycle-plan-assembly/v1"),
    inputs: [port("chassis", WORKSPACE), port("invariants", INVARIANTS)],
    outputs: [port("chassis", WORKSPACE)], capabilities: ["code.repair", "plan.validate"],
    authority: ["workspace.read", "workspace.write"], gauge: dependent("plan-assembly-disposition"), group: "production",
    standardWork: work("Peck one run-plan assembly button", ["Read only the run-plan invariant cards.", "Install preflight validation and ordered value/rejection preservation in src/run-plan.js."], ["Single-file edit jig: src/run-plan.js", "Shell write-scope guard", "Immutable tests and keyed-pool source"], ["Do not edit src/keyed-task-pool.js.", "Do not redesign the keyed pool.", "Do not run downstream product gauges."], ["The worker reports a coherent run-plan mechanism; downstream gauges own product release."]),
  }));
  installed.focused = registry.install(station({
    id: "lifecycle-focused-probe", title: "S6 Focused lifecycle probe",
    purpose: "Exercise reentrancy, retirement, queue drain, and idle ordering immediately after mutation.",
    worker: tool("bantam.factory.lifecycle-focused/v1"), inputs: [port("chassis", WORKSPACE)], outputs: [port("chassis", WORKSPACE)],
    capabilities: ["quality.lifecycle-probe"], authority: ["workspace.read"], gauge: independent("focused-lifecycle-probe"), group: "quality",
    standardWork: work("Press the focused lifecycle gauge", ["Exercise reentrancy, retirement, queue drain, and idle ordering."], ["Independent deterministic lifecycle probe"], ["Do not repair a failing chassis."], ["Every focused lifecycle check passes."]),
  }));
  installed.regression = registry.install(station({
    id: "lifecycle-regression", title: "S7 Public regression",
    purpose: "Run the repository's declared public regression command.",
    worker: tool("bantam.factory.lifecycle-regression/v1"), inputs: [port("chassis", WORKSPACE)], outputs: [port("chassis", WORKSPACE)],
    capabilities: ["quality.regression"], authority: ["workspace.read"], gauge: independent("public-regression"), group: "quality",
    standardWork: work("Press the public regression gauge", ["Run the customer-visible regression command against the candidate chassis."], ["Read-only candidate materialization", "Declared public command"], ["Do not mutate authored bytes."], ["The command exits successfully and authored bytes remain unchanged."]),
  }));
  installed.verification = registry.install(station({
    id: "lifecycle-product-verification", title: "S8 Hidden product verification",
    purpose: "Apply the independent product contract without exposing it to model stations.",
    worker: tool("bantam.factory.lifecycle-verification/v1"), inputs: [port("chassis", WORKSPACE)], outputs: [port("chassis", WORKSPACE)],
    capabilities: ["quality.product-contract"], authority: ["workspace.read"], gauge: independent("hidden-product-contract"), group: "quality",
    standardWork: work("Press the independent product gauge", ["Run the held-out product contract without exposing it upstream."], ["Hidden-command isolation", "Read-only candidate materialization"], ["Do not disclose gauge contents to model workers.", "Do not mutate authored bytes."], ["The independent product contract passes."]),
  }));
  installed.audit = registry.install(station({
    id: "lifecycle-evidence-audit", title: "S9 Evidence audit and release",
    purpose: "Reconcile exact candidate bytes and all preceding gauge evidence before release.",
    worker: tool("bantam.factory.lifecycle-audit/v1"), inputs: [port("chassis", WORKSPACE)], outputs: [port("chassis", WORKSPACE)],
    capabilities: ["evidence.audit"], authority: ["workspace.read"], gauge: independent("route-evidence-audit"), group: "release",
    standardWork: work("Open the final wicket", ["Reconcile the exact chassis tree with focused, public, and product evidence."], ["Content-addressed tree comparison", "All preceding gauge records"], ["Never release on missing, stale, or red evidence."], ["Chassis bytes match the captured candidate and every required gauge is green."]),
  }));

  const stations = ["intake", "map", "invariants", "diagnosis", "pool", "plan", "focused", "regression", "verification", "audit"];
  const edge = (from, out, to, input = out) => ({ from, out, to, in: input });
  const route = registry.validateRoute({
    schema: 1, kind: "bantam.factory-route", id: "async-keyed-lifecycle-cell",
    stations: stations.map((id) => ({ id, station: installed[id].ref })),
    edges: [
      edge("intake", "chassis", "map"),
      edge("map", "chassis", "invariants"), edge("map", "state-map", "invariants"),
      edge("invariants", "chassis", "diagnosis"), edge("map", "state-map", "diagnosis"), edge("invariants", "invariants", "diagnosis"),
      edge("diagnosis", "chassis", "pool"), edge("map", "state-map", "pool"), edge("invariants", "invariants", "pool"), edge("diagnosis", "diagnosis", "pool"),
      edge("pool", "chassis", "plan"), edge("pool", "invariants", "plan"),
      edge("plan", "chassis", "focused"), edge("focused", "chassis", "regression"),
      edge("regression", "chassis", "verification"), edge("verification", "chassis", "audit"),
    ],
  }, { authority: ["workspace.read", "workspace.write"] });
  return Object.freeze({ registry, route, assets: Object.freeze({ ...installed, mutation: installed.plan }) });
}

export async function runLifecycleFactoryCell({
  workspace, task, verificationScript, publicVerificationScript,
  focusedVerificationScript = null, editablePaths = DEFAULT_EDITABLE,
  root = null, jobId = null, model = undefined,
  diagnosisMaxTurns = 12, mutationMaxTurns = 30, verificationTimeoutMs = 120_000,
  maxReworkCycles = 1,
  workforce = null,
  signal = null, runAgentFn = runAgent, verifier = runFactoryVerifier,
} = {}) {
  const source = requireDirectory(workspace, "lifecycle source workspace");
  const request = requireString(task, "lifecycle task");
  assertLifecycleTask(request);
  const finalCommand = requireString(verificationScript, "lifecycle final verification command");
  const publicCommand = requireString(publicVerificationScript, "lifecycle public verification command");
  const focusedCommand = optionalString(focusedVerificationScript) ?? `node ${shellQuote(FOCUSED_GAUGE)}`;
  const editable = normalizeEditable(editablePaths);
  for (const required of DEFAULT_EDITABLE) if (!editable.includes(required)) throw new Error(`lifecycle assembly line requires editable path: ${required}`);
  if (!Number.isInteger(maxReworkCycles) || maxReworkCycles < 0 || maxReworkCycles > 10) {
    throw new Error("lifecycle maxReworkCycles must be an integer from 0 to 10");
  }
  const factoryRoot = path.resolve(root ?? path.join(source, ".bantam", "factory"));
  const id = jobId === null ? makeJobId() : requireId(jobId, "lifecycle job id");
  const directory = path.join(factoryRoot, "jobs", id);
  const manifestPath = path.join(directory, "manifest.json");
  if (fs.existsSync(directory)) throw new Error(`factory lifecycle job already exists: ${id}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storeRoot = path.join(factoryRoot, "workspace-store");
  const store = new WorkspaceStore(storeRoot);
  const baseline = store.capture(source, { message: `BANTAMFACTORY ${id} baseline`, excludePaths: [path.join(source, ".bantam"), factoryRoot] });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-lifecycle-${id}-`));
  let candidateWorkspace = path.join(runtime, "candidate-1");
  const ownsModel = model === undefined && runAgentFn === runAgent;
  const workerModel = model ?? (ownsModel ? new ModelClient() : undefined);
  let candidate = baseline;
  let diagnosisResult = null;
  let mutationResult = null;
  const assemblyResults = { pool: null, plan: null };
  const inspections = {};
  const staffing = [];
  try {
    store.materialize(baseline.commit, candidateWorkspace);
    copyRuntimeDependencies(source, candidateWorkspace);
    const { registry, route, assets } = lifecycleCellLine();
    const descriptor = (revision) => ({ schema: 1, kind: "bantam.factory-workspace", commit: revision.commit, tree: revision.tree, files: revision.files });
    const passThrough = async (order) => ({ productRevision: order.inputProductRevision, outputs: { chassis: input(order, "chassis") } });
    let stateMap = null;
    let invariants = null;
    let diagnosis = null;
    const adapters = {
      "bantam.factory.lifecycle-intake/v1": async () => ({ productRevision: treeRef(baseline.tree), outputs: { chassis: descriptor(baseline) }, evidence: [{ kind: "lifecycle-contract-intake", taskDigest: digest(request), editable }] }),
      "bantam.factory.lifecycle-map/v1": async (order) => {
        stateMap = buildStateMap(candidateWorkspace, editable);
        return { productRevision: order.inputProductRevision, outputs: { chassis: input(order, "chassis"), "state-map": stateMap }, evidence: [{ kind: "state-map-summary", files: stateMap.files.length, signals: stateMap.signals.length }] };
      },
      "bantam.factory.lifecycle-invariants/v1": async (order) => {
        invariants = extractLifecycleInvariants(request);
        return { productRevision: order.inputProductRevision, outputs: { chassis: input(order, "chassis"), invariants }, evidence: [{ kind: "invariant-summary", obligations: invariants.obligations.map((row) => row.id) }] };
      },
      "bantam.factory.lifecycle-diagnosis/v2": async (order, { emit }) => {
        const diagnosisWorkspace = path.join(runtime, order.stationAttempt);
        const inputChassis = input(order, "chassis");
        store.materialize(inputChassis.commit, diagnosisWorkspace);
        copyRuntimeDependencies(source, diagnosisWorkspace);
        const recommendation = shadowStaffing(workforce, assets.diagnosis.ref, order.stationAttempt);
        if (recommendation) {
          staffing.push(recommendation);
          emit("staffing-shadow", recommendation);
        }
        const prompt = diagnosisPrompt(input(order, "state-map"), input(order, "invariants"), order.rework, order.standardWork);
        emitWorkerButton(emit, order, workerModel, prompt, {
          advisoryMode: true, maxTurns: diagnosisMaxTurns, editable: [], hiddenVerificationAvailable: false,
        });
        const before = usageSnapshot(workerModel);
        try {
          diagnosisResult = await runAgentFn({
            task: prompt,
            workspace: diagnosisWorkspace, ...(workerModel === undefined ? {} : { model: workerModel }),
            maxTurns: diagnosisMaxTurns, verificationScript: null, signal,
            advisoryMode: true,
            excludeActions: ADVISORY_EXCLUDED_ACTIONS,
            investigationActionLimit: Math.max(2, diagnosisMaxTurns - 2),
            verificationPolicy: "after_edit",
            progressAwareness: false,
            autoForceEditAfter: 0,
            completionAudit: false,
            stateAudit: "off",
            editGuard: () => "This diagnosis station is read-only; return a diagnosis artifact instead of editing.",
            onEvent: (event) => emit("lifecycle-diagnosis-event", compactEvent(event)),
          });
        } catch (error) {
          observeWorkerException(workforce, workerModel, error, order.stationAttempt);
          throw error;
        }
        observeWorkerHealth(workforce, workerModel, diagnosisResult, order.stationAttempt);
        emitWorkerPeck(emit, order, workerModel, diagnosisResult);
        diagnosis = { schema: 1, kind: "bantam.lifecycle-diagnosis", summary: resultText(diagnosisResult), sourceTree: inputChassis.tree, rework: order.rework };
        return { productRevision: order.inputProductRevision, outputs: { chassis: input(order, "chassis"), diagnosis }, evidence: [{ kind: "diagnosis-result", result: compactResult(diagnosisResult) }], performance: agentPerformance(diagnosisResult, usageDelta(before, usageSnapshot(workerModel)), workerModel) };
      },
      "bantam.factory.lifecycle-pool-assembly/v1": async (order, { emit }) => {
        const inputChassis = input(order, "chassis");
        if (candidate.tree !== inputChassis.tree) {
          candidateWorkspace = path.join(runtime, `candidate-${order.stationAttempt}`);
          store.materialize(inputChassis.commit, candidateWorkspace);
          copyRuntimeDependencies(source, candidateWorkspace);
          candidate = inputChassis;
        }
        const recommendation = shadowStaffing(workforce, assets.pool.ref, order.stationAttempt);
        if (recommendation) {
          staffing.push(recommendation);
          emit("staffing-shadow", recommendation);
        }
        const target = "src/keyed-task-pool.js";
        const targetInvariants = selectInvariants(input(order, "invariants"), ["bounded-concurrency", "fifo-unique-keys", "queued-and-running-coalescing", "publish-before-user-code", "retire-before-observation", "sync-throw-capacity", "idle-after-running-and-queue"]);
        const prompt = assemblyPrompt("KEYED POOL", target, targetInvariants, input(order, "diagnosis"), order.rework, order.standardWork, input(order, "state-map"));
        emitWorkerButton(emit, order, workerModel, prompt, {
          advisoryMode: false, maxTurns: mutationMaxTurns, editable: [target], hiddenVerificationAvailable: false,
        });
        const before = usageSnapshot(workerModel);
        const scopeSpec = { editable: [target] };
        try {
          assemblyResults.pool = await runAgentFn({
            task: prompt,
            workspace: candidateWorkspace, ...(workerModel === undefined ? {} : { model: workerModel }),
            maxTurns: mutationMaxTurns, verificationScript: null, signal,
            editGuard: (relative) => scopeReason(relative, scopeSpec),
            shellScopeGuard: createShellScopeGuard(candidateWorkspace, scopeSpec),
            onEvent: (event) => emit("lifecycle-mutation-event", compactEvent(event)),
          });
        } catch (error) {
          observeWorkerException(workforce, workerModel, error, order.stationAttempt);
          throw error;
        }
        observeWorkerHealth(workforce, workerModel, assemblyResults.pool, order.stationAttempt);
        emitWorkerPeck(emit, order, workerModel, assemblyResults.pool);
        candidate = store.capture(candidateWorkspace, { parent: inputChassis.commit, message: `BANTAMFACTORY ${id} keyed pool assembly`, excludePaths: [path.join(candidateWorkspace, ".bantam")] });
        return { productRevision: treeRef(candidate.tree), outputs: { chassis: descriptor(candidate), invariants: input(order, "invariants") }, evidence: [{ kind: "assembly-result", operation: "keyed-pool", result: compactResult(assemblyResults.pool), editable: [target] }], performance: agentPerformance(assemblyResults.pool, usageDelta(before, usageSnapshot(workerModel)), workerModel) };
      },
      "bantam.factory.lifecycle-plan-assembly/v1": async (order, { emit }) => {
        const inputChassis = input(order, "chassis");
        if (candidate.tree !== inputChassis.tree) {
          candidateWorkspace = path.join(runtime, `candidate-${order.stationAttempt}`);
          store.materialize(inputChassis.commit, candidateWorkspace);
          copyRuntimeDependencies(source, candidateWorkspace);
          candidate = inputChassis;
        }
        const recommendation = shadowStaffing(workforce, assets.plan.ref, order.stationAttempt);
        if (recommendation) {
          staffing.push(recommendation);
          emit("staffing-shadow", recommendation);
        }
        const target = "src/run-plan.js";
        const targetInvariants = selectInvariants(input(order, "invariants"), ["atomic-plan-validation", "identity-and-input-preservation"]);
        const prompt = assemblyPrompt("RUN PLAN", target, targetInvariants, null, order.rework, order.standardWork, null);
        emitWorkerButton(emit, order, workerModel, prompt, {
          advisoryMode: false, maxTurns: mutationMaxTurns, editable: [target], hiddenVerificationAvailable: false,
        });
        const before = usageSnapshot(workerModel);
        const scopeSpec = { editable: [target] };
        try {
          assemblyResults.plan = await runAgentFn({
            task: prompt,
            workspace: candidateWorkspace, ...(workerModel === undefined ? {} : { model: workerModel }),
            maxTurns: mutationMaxTurns, verificationScript: null, signal,
            editGuard: (relative) => scopeReason(relative, scopeSpec),
            shellScopeGuard: createShellScopeGuard(candidateWorkspace, scopeSpec),
            onEvent: (event) => emit("lifecycle-mutation-event", compactEvent(event)),
          });
        } catch (error) {
          observeWorkerException(workforce, workerModel, error, order.stationAttempt);
          throw error;
        }
        mutationResult = assemblyResults.plan;
        observeWorkerHealth(workforce, workerModel, assemblyResults.plan, order.stationAttempt);
        emitWorkerPeck(emit, order, workerModel, assemblyResults.plan);
        candidate = store.capture(candidateWorkspace, { parent: inputChassis.commit, message: `BANTAMFACTORY ${id} run plan assembly`, excludePaths: [path.join(candidateWorkspace, ".bantam")] });
        return { productRevision: treeRef(candidate.tree), outputs: { chassis: descriptor(candidate) }, evidence: [{ kind: "assembly-result", operation: "run-plan", result: compactResult(assemblyResults.plan), editable: [target] }], performance: agentPerformance(assemblyResults.plan, usageDelta(before, usageSnapshot(workerModel)), workerModel) };
      },
      "bantam.factory.lifecycle-focused/v1": passThrough,
      "bantam.factory.lifecycle-regression/v1": passThrough,
      "bantam.factory.lifecycle-verification/v1": passThrough,
      "bantam.factory.lifecycle-audit/v1": passThrough,
    };
    const inspect = async (name, command) => {
      let result = await verifier(candidateWorkspace, command, verificationTimeoutMs, { signal });
      result = rejectMutation(result, store, candidateWorkspace, candidate);
      inspections[name] = result;
      return { status: result.pass ? "pass" : gaugeStatus(result), evidence: [result] };
    };
    const gauges = new Map([
      [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ baseline: baseline.commit, taskClass: CELL_ID }] })],
      [gaugeRef(assets.map), async () => ({ status: stateMap?.files?.length ? "pass" : "fail", evidence: [stateMap ?? { missing: true }] })],
      [gaugeRef(assets.invariants), async () => ({ status: invariants?.obligations?.length >= 6 ? "pass" : "fail", evidence: [invariants ?? { missing: true }] })],
      [gaugeRef(assets.diagnosis), async () => ({ status: modelDisposition(diagnosisResult, { allowResponded: true, requireText: true }), evidence: [{ diagnosis, result: compactResult(diagnosisResult) }] })],
      [gaugeRef(assets.pool), async () => ({ status: modelDisposition(assemblyResults.pool), evidence: [{ operation: "keyed-pool", result: compactResult(assemblyResults.pool), baselineTree: baseline.tree, candidateTree: candidate.tree }] })],
      [gaugeRef(assets.plan), async () => ({ status: modelDisposition(assemblyResults.plan), evidence: [{ operation: "run-plan", result: compactResult(assemblyResults.plan), baselineTree: baseline.tree, candidateTree: candidate.tree }] })],
      [gaugeRef(assets.focused), async () => inspect("focused", focusedCommand)],
      [gaugeRef(assets.regression), async () => inspect("public", publicCommand)],
      [gaugeRef(assets.verification), async () => inspect("final", finalCommand)],
      [gaugeRef(assets.audit), async () => {
        const observed = store.treeForWorkspace(candidateWorkspace, { baselineCommit: candidate.commit, excludePaths: [path.join(candidateWorkspace, ".bantam")] }).tree;
        const pass = observed === candidate.tree && ["focused", "public", "final"].every((name) => inspections[name]?.pass);
        return { status: pass ? "pass" : "fail", evidence: [{ kind: "route-evidence-audit", observedTree: observed, candidateTree: candidate.tree, inspections: Object.fromEntries(Object.entries(inspections).map(([name, value]) => [name, value.status])) }] };
      }],
    ]);
    const line = await new FactoryLineController({
      root: factoryRoot, jobId: id, task: request, taskFamily: "async-keyed-lifecycle", initialProductRevision: treeRef(baseline.tree), route, registry,
      authority: ["workspace.read", "workspace.write"], adapters, gauges, workspaceLabel: source,
      rework: maxReworkCycles > 0 ? { focused: { restartAt: "diagnosis", maxCycles: maxReworkCycles } } : {},
    }).run({ signal });
    const manifest = {
      schema: 1, kind: MANIFEST_KIND, id, cell: CELL_ID, status: line.supervisor.status,
      createdAt: line.events[0].time, completedAt: new Date().toISOString(), sourceWorkspace: source,
      factoryRoot, storeRoot, routeRef: route.ref, task: request, editable,
      verification: { focused: focusedCommand, public: publicCommand, final: finalCommand, timeoutMs: verificationTimeoutMs },
      reworkPolicy: { detector: "focused", restartAt: "diagnosis", maxCycles: maxReworkCycles },
      staffing,
      baseline, candidate, agents: { diagnosis: compactResult(diagnosisResult), mutation: compactResult(mutationResult), assembly: { pool: compactResult(assemblyResults.pool), plan: compactResult(assemblyResults.plan) } }, inspections,
      traveler: { jobId: id, events: line.events.length, finalEventId: line.events.at(-1).id }, apply: null,
    };
    writeJsonAtomic(manifestPath, manifest);
    return { manifest, manifestPath, line };
  } finally {
    if (ownsModel) workerModel?.close?.();
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

export function extractLifecycleInvariants(task) {
  assertLifecycleTask(task);
  const obligations = [
    ["bounded-concurrency", "Never run more unique tasks than the configured concurrency."],
    ["fifo-unique-keys", "Start queued unique keys in first-in order."],
    ["queued-and-running-coalescing", "Return the exact same Promise for an already queued or running key."],
    ["publish-before-user-code", "Publish the key-to-Promise association before user task code may reenter."],
    ["retire-before-observation", "Retire the exact association before fulfillment or rejection becomes observable."],
    ["sync-throw-capacity", "Convert synchronous task throws to asynchronous rejection without leaking capacity."],
    ["idle-after-running-and-queue", "Resolve all idle waiters only after running and queued work are empty."],
    ["atomic-plan-validation", "Validate the whole plan and worker before starting work."],
    ["identity-and-input-preservation", "Preserve values, rejection identity, input order, and input bytes."],
  ].map(([id, text]) => ({ id, text, source: "public-task-contract" }));
  return { schema: 1, kind: "bantam.lifecycle-invariants", taskDigest: digest(task), obligations };
}

function buildStateMap(workspace, editable) {
  const files = editable.map((relative) => {
    const absolute = path.resolve(workspace, relative);
    if (!absolute.startsWith(`${path.resolve(workspace)}${path.sep}`) || !fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      return { path: relative, exists: false, bytes: 0, exports: [], signals: [] };
    }
    const source = fs.readFileSync(absolute, "utf8");
    return {
      path: relative, exists: true, bytes: Buffer.byteLength(source),
      exports: [...source.matchAll(/export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
      signals: ["Map", "Promise", "queue", "running", "idle", "concurrency"].filter((signal) => new RegExp(`\\b${signal}\\b`, "i").test(source)),
    };
  });
  return { schema: 1, kind: "bantam.lifecycle-state-map", files, signals: [...new Set(files.flatMap((file) => file.signals))].sort() };
}

function diagnosisPrompt(map, invariants, rework, standardWork) {
  return `[LIFECYCLE DIAGNOSIS STATION]\n${standardWorkText(standardWork)}\n\nSTATE MAP:\n${clip(map)}\n\nINVARIANT CARDS:\n${clip(invariants)}${rework ? `\n\nREWORK SIGNAL:\n${clip(rework)}` : ""}`;
}

function assemblyPrompt(label, target, invariants, diagnosis, rework, standardWork, map) {
  return `[${label} ASSEMBLY STATION]\n${standardWorkText(standardWork)}\n\nSINGLE-FILE EDIT JIG:\n${target}${map ? `\n\nTARGET STATE MAP:\n${clip({ ...map, files: map.files.filter((row) => row.path === target) })}` : ""}\n\nONLY THESE INVARIANT CARDS:\n${clip(invariants)}${diagnosis ? `\n\nUPSTREAM DIAGNOSIS CARD:\n${clip(diagnosis)}` : ""}${rework ? `\n\nREWORK SIGNAL:\n${clip(rework)}` : ""}`;
}

function selectInvariants(value, ids) {
  const allowed = new Set(ids);
  return { ...value, obligations: value.obligations.filter((row) => allowed.has(row.id)) };
}

function standardWorkText(value) {
  if (!value) return "Perform only the operation named by this station.";
  return [`OPERATION: ${value.operation}`, "STEPS:", ...value.instructions.map((row) => `- ${row}`), "FIXTURES:", ...value.fixtures.map((row) => `- ${row}`), "PROHIBITED:", ...value.prohibited.map((row) => `- ${row}`), "RELEASE CRITERIA:", ...value.releaseCriteria.map((row) => `- ${row}`)].join("\n");
}

function emitWorkerButton(emit, order, model, prompt, harness) {
  emit("worker-button", { schema: 1, kind: "bantam.factory-worker-packet", assignedBy: "factory-controller", stationAttempt: order.stationAttempt, stationRef: order.stationRef, workerRef: modelIdentity(model), inputProductRevision: order.inputProductRevision, standardWork: order.standardWork, authority: order.authority, capabilities: order.capabilities, harness, prompt });
  emit("worker-peck", { schema: 1, kind: "bantam.factory-worker-peck", phase: "button-lit", assignedBy: "factory-controller", stationAttempt: order.stationAttempt, workerRef: modelIdentity(model), promptDigest: digest(prompt), selfReported: false });
}

function emitWorkerPeck(emit, order, model, result) {
  emit("worker-peck", { schema: 1, kind: "bantam.factory-worker-peck", phase: "response-received", assignedBy: "factory-controller", stationAttempt: order.stationAttempt, workerRef: modelIdentity(model), disposition: modelDisposition(result, { allowResponded: true }), response: compactResult(result), selfReported: true });
}

function modelDisposition(result, { allowResponded = false, requireText = false } = {}) {
  if (!result || result.modelFailure) return "infrastructure";
  if (result.interrupted || result.blocked) return "blocked";
  if (!(result.reachedDone || (allowResponded && result.responded))) return "fail";
  if (requireText && !resultText(result)) return "fail";
  return "pass";
}

function scopeReason(relative, spec) {
  const reason = immutableEditReason(relative, spec);
  return reason ? `Lifecycle mutation station refused ${reason} path: ${relative}` : null;
}

function rejectMutation(result, store, workspace, expected) {
  const observedTree = store.treeForWorkspace(workspace, { baselineCommit: expected.commit, excludePaths: [path.join(workspace, ".bantam")] }).tree;
  return observedTree === expected.tree ? result : { ...(result ?? {}), pass: false, status: "mutated-workspace", expectedTree: expected.tree, observedTree, detail: "verification command changed authored workspace bytes" };
}

function input(order, name) {
  const material = order.inputs.find((entry) => entry.port === name);
  if (!material) throw new Error(`lifecycle work order is missing ${name}`);
  return material.value;
}

function compactResult(result) {
  if (!result) return null;
  return { reachedDone: Boolean(result.reachedDone), responded: Boolean(result.responded), interrupted: Boolean(result.interrupted), blocked: Boolean(result.blocked), modelFailure: result.modelFailure ?? null, summary: resultText(result).slice(0, 8_000), verification: result.verification ?? null, metrics: result.metrics ?? null, turns: Array.isArray(result.turns) ? result.turns.length : 0 };
}

function resultText(result) { return String(result?.summary ?? result?.response ?? "").trim(); }
function compactEvent(event) { try { return JSON.parse(JSON.stringify(event)); } catch { return { type: "unserializable" }; } }
function usageSnapshot(model) { return typeof model?.usageSummary === "function" ? model.usageSummary() : null; }
function usageDelta(before, after) {
  if (!before || !after) return null;
  return Object.fromEntries(["requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens", "cacheMissTokens", "reasoningTokens", "costUsd"].map((field) => [field, Math.max(0, Number(after[field] ?? 0) - Number(before[field] ?? 0))]));
}
function agentPerformance(result, usage, model) {
  const metrics = result?.metrics ?? {};
  const output = usage?.outputTokens || integer(metrics.tokens);
  return { workerRef: modelIdentity(model), turns: integer(metrics.turns ?? result?.turns?.length), modelRequests: integer(usage?.requests ?? metrics.modelRequests), inputTokens: usage?.inputTokens ?? null, outputTokens: output, totalTokens: usage?.totalTokens ?? output, cacheHitTokens: usage?.cacheHitTokens ?? null, cacheMissTokens: usage?.cacheMissTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, estimatedCostUsd: usage ? Math.max(0, Number(usage.costUsd) || 0) : null };
}
function modelIdentity(model) { if (typeof model?.metadata !== "function") return "bantam-agent:injected"; const data = model.metadata(); return [data.runtime ?? "model", data.model ?? data.profile ?? "unknown", data.reasoningEffort].filter(Boolean).join(":"); }
function shadowStaffing(workforce, stationRef, stationAttempt) {
  if (!workforce || typeof workforce.eligible !== "function") return null;
  try {
    const report = workforce.eligible({ stationRef, taskFamily: "async-keyed-lifecycle" });
    return {
      schema: 1,
      kind: "bantam.factory-shadow-staffing",
      stationAttempt,
      stationRef,
      selected: report.selected,
      workforceHead: report.workforceHead,
      eligible: report.eligible.map((row) => row.workerRef),
      rejected: report.rejected.map((row) => ({ workerRef: row.workerRef, reasons: row.reasons })),
    };
  } catch (error) {
    return { schema: 1, kind: "bantam.factory-shadow-staffing", stationAttempt, stationRef, selected: null, workforceHead: null, eligible: [], rejected: [], error: String(error.message ?? error).slice(0, 500) };
  }
}
function observeWorkerHealth(workforce, model, result, stationAttempt) {
  if (!workforce || typeof workforce.observeRuntimeHealth !== "function") return null;
  const failed = Boolean(result?.modelFailure);
  const interrupted = Boolean(result?.interrupted || result?.blocked);
  const condition = failed ? "unavailable" : interrupted ? "degraded" : "available";
  const message = String(result?.modelFailure?.message ?? result?.modelFailure ?? "");
  const code = failed
    ? (/quota|usage limit|credits|tokens/i.test(message) ? "quota-unavailable" : "transport-unavailable")
    : interrupted ? "station-interrupted" : "station-response";
  try { return workforce.observeRuntimeHealth({ identity: modelIdentity(model), condition, code, ttlMs: 60_000, detail: stationAttempt }); }
  catch { return null; }
}
function observeWorkerException(workforce, model, error, stationAttempt) {
  if (!workforce || typeof workforce.observeRuntimeHealth !== "function") return null;
  const message = String(error?.message ?? error ?? "adapter exception");
  const code = /quota|usage limit|credits|tokens/i.test(message) ? "quota-unavailable" : "adapter-exception";
  try { return workforce.observeRuntimeHealth({ identity: modelIdentity(model), condition: "unavailable", code, ttlMs: 60_000, detail: `${stationAttempt}: ${message}`.slice(0, 1_000) }); }
  catch { return null; }
}
function integer(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }

function station(value) { const { group, ...asset } = value; return { schema: 2, kind: "bantam.factory-station", version: value.version ?? 1, dispositions: ["released", "blocked", "contained", "infrastructure"], presentation: { group, icon: value.worker.kind === "model" ? "robot-arm" : "station", color: group === "quality" ? "green" : group === "production" ? "amber" : "blue" }, ...asset }; }
function work(operation, instructions, fixtures, prohibited, releaseCriteria) { return { operation, instructions, fixtures, prohibited, releaseCriteria }; }
function port(name, artifactType) { return { name, artifactType, required: true }; }
function tool(adapter) { return { kind: "tool", adapter }; }
function modelWorker(adapter) { return { kind: "model", adapter }; }
function independent(id) { return { id, version: 1, independent: true }; }
function dependent(id) { return { id, version: 1, independent: false }; }
function treeRef(tree) { return `tree:${tree}`; }
function digest(value) { return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`; }
function clip(value) { return JSON.stringify(value).slice(0, 16_000); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function makeJobId() { return `lifecycle-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`; }
function assertLifecycleTask(task) { if (!/KeyedTaskPool|keyed.{0,20}(?:task|pool)/i.test(task) || !/onIdle|coalesc|concurrenc/i.test(task)) throw new Error("async keyed lifecycle cell requires a keyed-task-pool lifecycle contract"); }
function normalizeEditable(value) { if (!Array.isArray(value) || !value.length) throw new Error("lifecycle editable paths are required"); return [...new Set(value.map((entry) => requireRelative(entry)))].sort(); }
function requireRelative(value) { const text = requireString(value, "editable path").replaceAll("\\", "/"); if (path.posix.isAbsolute(text) || text === "." || text.startsWith("../") || path.posix.normalize(text) !== text) throw new Error(`invalid lifecycle editable path: ${value}`); return text; }
function requireString(value, label) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function requireId(value, label) { const text = String(value ?? ""); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`invalid ${label}: ${text}`); return text; }
function requireDirectory(value, label) { const resolved = path.resolve(requireString(value, label)); if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`); return resolved; }
function copyRuntimeDependencies(source, destination) { const from = path.join(source, "node_modules"), to = path.join(destination, "node_modules"); if (fs.statSync(from, { throwIfNoEntry: false })?.isDirectory() && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true }); }
function gaugeStatus(result) { return result?.status === "infrastructure" ? "infrastructure" : result?.status === "interrupted" ? "blocked" : "fail"; }
