// The first executable BANTAMFACTORY coding cell.
//
// Model work is confined to a private WorkspaceStore materialization.  A
// released traveler is only an approved candidate; changing the operator's
// checkout is a separate, baseline-CAS guarded WorkspaceTransaction.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../agent.js";
import { writeJsonAtomic } from "../atomic-file.js";
import { ModelClient } from "../model.js";
import { runProcess } from "../process-runner.js";
import { WorkspaceStore } from "../workspace-store.js";
import { WorkspaceTransaction, recoverWorkspaceTransactions } from "../workspace-transaction.js";
import { FactoryLineController } from "./line-controller.js";
import { StationRegistry } from "./station-registry.js";
import { gaugeRef } from "./compatibility-line.js";

const MANIFEST_KIND = "bantam.factory-coding-cell";

export function codingCellLine() {
  const registry = new StationRegistry();
  const intake = registry.install(station({
    id: "coding-cell-intake",
    title: "Immutable chassis intake",
    purpose: "Admit an exact source revision into a private production workspace.",
    worker: { kind: "tool", adapter: "bantam.factory.coding-intake/v1" },
    inputs: [],
    capabilities: ["workspace.snapshot"],
    authority: ["workspace.read"],
    gauge: { id: "immutable-intake", version: 1, independent: true },
    presentation: { group: "intake", icon: "scan", color: "blue" },
  }));
  const implementation = registry.install(station({
    id: "bantam-implementation",
    title: "BANTAM implementation cell",
    purpose: "Run the bounded BANTAM agent loop against only the private chassis.",
    worker: { kind: "model", adapter: "bantam.factory.agent-cell/v1" },
    inputs: [chassisPort()],
    capabilities: ["code.general"],
    authority: ["workspace.read", "workspace.write"],
    gauge: { id: "agent-disposition", version: 1, independent: false },
    presentation: { group: "production", icon: "robot-arm", color: "amber" },
  }));
  const inspection = registry.install(station({
    id: "final-inspection",
    title: "Independent final inspection",
    purpose: "Run the configured acceptance command without granting write authority.",
    worker: { kind: "tool", adapter: "bantam.factory.final-inspection/v1" },
    inputs: [chassisPort()],
    capabilities: ["quality.verify"],
    authority: ["workspace.read"],
    gauge: { id: "acceptance-verifier", version: 1, independent: true },
    presentation: { group: "quality", icon: "gauge", color: "green" },
  }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "bantam-coding-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "implementation", station: implementation.ref },
      { id: "inspection", station: inspection.ref },
    ],
    edges: [
      { from: "intake", out: "chassis", to: "implementation", in: "chassis" },
      { from: "implementation", out: "chassis", to: "inspection", in: "chassis" },
    ],
  }, { authority: ["workspace.read", "workspace.write"] });
  return Object.freeze({ registry, route, assets: Object.freeze({ intake, implementation, inspection }) });
}

export async function runFactoryCodingCell({
  workspace,
  task,
  verificationScript,
  focusedVerificationScript = null,
  root = null,
  jobId = null,
  model = undefined,
  maxTurns = 30,
  verificationTimeoutMs = 120_000,
  signal = null,
  runAgentFn = runAgent,
  verifier = runFactoryVerifier,
} = {}) {
  const source = requireDirectory(workspace, "factory source workspace");
  const request = requireString(task, "factory task");
  const finalVerifier = requireString(verificationScript, "factory verification command");
  if (typeof runAgentFn !== "function") throw new TypeError("factory runAgentFn must be a function");
  if (typeof verifier !== "function") throw new TypeError("factory verifier must be a function");
  const factoryRoot = path.resolve(root ?? path.join(source, ".bantam", "factory"));
  const id = jobId === null ? makeJobId() : requireId(jobId, "factory job id");
  const jobDirectory = path.join(factoryRoot, "jobs", id);
  const manifestPath = path.join(jobDirectory, "manifest.json");
  if (fs.existsSync(jobDirectory)) throw new Error(`factory coding job already exists: ${id}`);
  fs.mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });

  const storeRoot = path.join(factoryRoot, "workspace-store");
  const store = new WorkspaceStore(storeRoot);
  const baseline = store.capture(source, {
    message: `BANTAMFACTORY ${id} baseline`,
    excludePaths: [path.join(source, ".bantam"), factoryRoot],
  });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-factory-${id}-`));
  const candidateWorkspace = path.join(runtime, "workspace");
  const ownsModel = model === undefined && runAgentFn === runAgent;
  const workerModel = model ?? (ownsModel ? new ModelClient() : undefined);
  let candidate = baseline;
  let agentResult = null;
  let finalInspection = null;
  try {
    store.materialize(baseline.commit, candidateWorkspace);
    copyRuntimeDependencies(source, candidateWorkspace);
    const { registry, route, assets } = codingCellLine();
    const chassis = (revision) => ({
      schema: 1,
      kind: "bantam.factory-workspace",
      commit: revision.commit,
      tree: revision.tree,
      files: revision.files,
    });
    const adapters = {
      "bantam.factory.coding-intake/v1": async () => ({
        productRevision: treeRevision(baseline.tree),
        outputs: { chassis: chassis(baseline) },
        evidence: [{ kind: "immutable-workspace-intake", commit: baseline.commit, tree: baseline.tree }],
      }),
      "bantam.factory.agent-cell/v1": async (_order, { emit }) => {
        const usageBefore = usageSnapshot(workerModel);
        agentResult = await runAgentFn({
          task: request,
          workspace: candidateWorkspace,
          ...(workerModel === undefined ? {} : { model: workerModel }),
          maxTurns,
          verificationScript: optionalString(focusedVerificationScript),
          verificationTimeoutMs,
          signal,
          onEvent: (event) => emit("bantam-agent-event", compactAgentEvent(event)),
        });
        candidate = store.capture(candidateWorkspace, {
          parent: baseline.commit,
          message: `BANTAMFACTORY ${id} candidate`,
          excludePaths: [path.join(candidateWorkspace, ".bantam")],
        });
        return {
          productRevision: treeRevision(candidate.tree),
          outputs: { chassis: chassis(candidate) },
          evidence: [{ kind: "bantam-agent-result", result: compactAgentResult(agentResult) }],
          performance: agentPerformance(agentResult, usageDelta(usageBefore, usageSnapshot(workerModel)), workerModel),
        };
      },
      "bantam.factory.final-inspection/v1": async (order) => ({
        productRevision: order.inputProductRevision,
        outputs: { chassis: order.inputs[0].value },
        evidence: [{ kind: "inspection-admission", commit: order.inputs[0].value.commit }],
      }),
    };
    const gauges = new Map([
      [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ baselineCommit: baseline.commit }] })],
      [gaugeRef(assets.implementation), async () => ({
        status: agentDisposition(agentResult, Boolean(optionalString(focusedVerificationScript))),
        evidence: [{ kind: "agent-disposition", result: compactAgentResult(agentResult) }],
      })],
      [gaugeRef(assets.inspection), async () => {
        finalInspection = await verifier(candidateWorkspace, finalVerifier, verificationTimeoutMs, { signal });
        finalInspection = rejectMutatingVerifier(finalInspection, store, candidateWorkspace, candidate);
        return { status: finalInspection.pass ? "pass" : inspectionStatus(finalInspection), evidence: [finalInspection] };
      }],
    ]);
    const line = await new FactoryLineController({
      root: factoryRoot,
      jobId: id,
      task: request,
      taskFamily: "general-coding",
      initialProductRevision: treeRevision(baseline.tree),
      route,
      registry,
      authority: ["workspace.read", "workspace.write"],
      adapters,
      gauges,
      workspaceLabel: source,
    }).run({ signal });
    const manifest = {
      schema: 1,
      kind: MANIFEST_KIND,
      id,
      status: line.supervisor.status,
      createdAt: line.events[0].time,
      completedAt: new Date().toISOString(),
      sourceWorkspace: source,
      factoryRoot,
      storeRoot,
      routeRef: route.ref,
      task: request,
      verification: { focused: optionalString(focusedVerificationScript), final: finalVerifier, timeoutMs: verificationTimeoutMs },
      baseline,
      candidate,
      agent: compactAgentResult(agentResult),
      finalInspection,
      traveler: { jobId: id, events: line.events.length, finalEventId: line.events.at(-1).id },
      apply: null,
    };
    writeJsonAtomic(manifestPath, manifest);
    return { manifest, manifestPath, line };
  } finally {
    if (ownsModel) workerModel?.close?.();
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

export async function applyFactoryCodingCell({
  manifestPath,
  workspace = null,
  verificationTimeoutMs = null,
  verifier = runFactoryVerifier,
} = {}) {
  const file = resolveManifestPath(manifestPath);
  const manifest = readManifest(file);
  if (manifest.status !== "released") throw new Error(`factory apply refused: job is ${manifest.status}, not released`);
  if (manifest.apply) throw new Error(`factory apply refused: job was already applied at ${manifest.apply.at}`);
  const live = requireDirectory(workspace ?? manifest.sourceWorkspace, "factory live workspace");
  if (live !== path.resolve(manifest.sourceWorkspace)) throw new Error("factory apply workspace does not match the source workspace");
  const timeoutMs = verificationTimeoutMs ?? manifest.verification.timeoutMs;
  const store = new WorkspaceStore(manifest.storeRoot);
  const transactionRoot = path.join(path.dirname(file), "transactions");
  recoverWorkspaceTransactions({ workspace: live, transactionRoot });
  const liveTree = store.treeForWorkspace(live, {
    excludePaths: [path.join(live, ".bantam"), manifest.factoryRoot],
  }).tree;
  if (liveTree !== manifest.baseline.tree) {
    throw new Error("factory apply refused: live workspace changed since chassis intake");
  }
  if (manifest.candidate.tree === manifest.baseline.tree) {
    throw new Error("factory apply refused: released candidate is byte-identical to the baseline");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-factory-apply-${manifest.id}-`));
  try {
    const baselineRoot = path.join(temp, "baseline");
    const candidateRoot = path.join(temp, "candidate");
    store.materialize(manifest.baseline.commit, baselineRoot);
    store.materialize(manifest.candidate.commit, candidateRoot);
    copyRuntimeDependencies(live, candidateRoot);
    let candidateVerification = await verifier(candidateRoot, manifest.verification.final, timeoutMs);
    candidateVerification = rejectMutatingVerifier(candidateVerification, store, candidateRoot, manifest.candidate);
    if (!candidateVerification.pass) {
      throw new Error(`factory apply refused: released candidate verifier ${candidateVerification.status}`);
    }
    const transaction = new WorkspaceTransaction({
      workspace: live,
      baselineRoot,
      candidateRoot,
      transactionRoot,
      id: `apply-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
      metadata: { kind: "factory-coding-cell-apply", jobId: manifest.id, routeRef: manifest.routeRef },
    });
    transaction.prepare();
    transaction.apply();
    try {
      const installedTree = store.treeForWorkspace(live, {
        excludePaths: [path.join(live, ".bantam"), manifest.factoryRoot],
      }).tree;
      if (installedTree !== manifest.candidate.tree) {
        throw new Error(`installed tree mismatch: expected ${manifest.candidate.tree}, observed ${installedTree}`);
      }
      const postApplyRoot = path.join(temp, "post-apply-verification");
      store.materialize(manifest.candidate.commit, postApplyRoot);
      copyRuntimeDependencies(live, postApplyRoot);
      let liveVerification = await verifier(postApplyRoot, manifest.verification.final, timeoutMs);
      liveVerification = rejectMutatingVerifier(liveVerification, store, postApplyRoot, manifest.candidate);
      if (!liveVerification.pass) throw new Error(`post-apply verifier ${liveVerification.status}`);
      transaction.markVerified({ ...liveVerification, installedTree });
      transaction.markPromoted({ kind: "operator-approved-factory-release", jobId: manifest.id });
      transaction.commit();
      manifest.status = "applied";
      manifest.apply = {
        at: new Date().toISOString(),
        candidateVerification,
        liveVerification,
        transaction: transaction.view(),
      };
      writeJsonAtomic(file, manifest);
      return { manifestPath: file, workspace: live, verification: liveVerification, transaction: transaction.view() };
    } catch (error) {
      transaction.rollback({ reason: `factory post-apply verification failed: ${error.message}` });
      throw new Error(`factory apply rolled back: ${error.message}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function runFactoryVerifier(workspace, command, timeoutMs = 120_000, { signal = null } = {}) {
  const started = Date.now();
  const result = await runProcess("/bin/bash", ["-o", "pipefail", "-c", requireString(command, "verification command")], {
    cwd: requireDirectory(workspace, "verification workspace"),
    timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  const status = result.timedOut ? "timeout"
    : result.aborted ? "interrupted"
      : result.bufferExceeded ? "output-limit"
        : result.error ? "infrastructure"
          : result.code === 0 ? "pass" : "fail";
  return {
    schema: 1,
    kind: "bantam.factory-verification",
    command,
    pass: status === "pass",
    status,
    exitCode: Number.isInteger(result.code) ? result.code : null,
    durationMs: Date.now() - started,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 16_000),
  };
}

function station(overrides) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    version: 1,
    outputs: [chassisPort()],
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    ...overrides,
  };
}

function chassisPort() {
  return { name: "chassis", artifactType: "bantam.workspace/v1", required: true };
}

function agentDisposition(result, focusedRequired) {
  if (!result) return "infrastructure";
  if (result.modelFailure) return "infrastructure";
  if (result.interrupted || result.blocked) return "blocked";
  if (!result.reachedDone) return "fail";
  return !focusedRequired || result.verification?.status === "pass" ? "pass" : "fail";
}

function compactAgentResult(result) {
  if (!result) return null;
  return {
    reachedDone: Boolean(result.reachedDone),
    interrupted: Boolean(result.interrupted),
    blocked: Boolean(result.blocked),
    modelFailure: result.modelFailure ?? null,
    summary: String(result.summary ?? "").slice(0, 8_000),
    verification: result.verification ?? null,
    metrics: result.metrics ?? null,
    turns: Array.isArray(result.turns) ? result.turns.length : 0,
    rejectedOutputs: Array.isArray(result.rejectedOutputs) ? result.rejectedOutputs.length : 0,
  };
}

function agentPerformance(result, usage, model) {
  const metrics = result?.metrics ?? {};
  const outputTokens = usage?.outputTokens || integerOrNull(metrics.tokens);
  const inputTokens = usage ? usage.inputTokens : null;
  return {
    workerRef: modelIdentity(model),
    turns: integerOrNull(metrics.turns ?? (Array.isArray(result?.turns) ? result.turns.length : null)),
    modelRequests: integerOrNull(usage?.requests ?? metrics.modelRequests),
    inputTokens,
    outputTokens,
    totalTokens: usage ? usage.totalTokens : outputTokens,
    cacheHitTokens: usage ? usage.cacheHitTokens : null,
    cacheMissTokens: usage ? usage.cacheMissTokens : null,
    reasoningTokens: usage ? usage.reasoningTokens : null,
    estimatedCostUsd: usage ? Math.max(0, Number(usage.costUsd) || 0) : null,
  };
}

function modelIdentity(model) {
  if (typeof model?.metadata !== "function") return "bantam-agent:injected";
  const metadata = model.metadata();
  return [metadata.runtime ?? "model", metadata.model ?? metadata.profile ?? "unknown", metadata.reasoningEffort]
    .filter(Boolean)
    .join(":");
}

function usageSnapshot(model) {
  return typeof model?.usageSummary === "function" ? model.usageSummary() : null;
}

function usageDelta(before, after) {
  if (!before || !after) return null;
  const fields = [
    "requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens",
    "cacheMissTokens", "reasoningTokens", "costUsd",
  ];
  return Object.fromEntries(fields.map((field) => [field, Math.max(0, Number(after[field] ?? 0) - Number(before[field] ?? 0))]));
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function compactAgentEvent(event) {
  if (!event || typeof event !== "object") return { type: "unknown" };
  const copy = JSON.parse(JSON.stringify(event));
  if (typeof copy.detail === "string") copy.detail = copy.detail.slice(0, 4_000);
  return copy;
}

function inspectionStatus(result) {
  return result?.status === "infrastructure" ? "infrastructure"
    : result?.status === "interrupted" ? "blocked" : "fail";
}

function rejectMutatingVerifier(result, store, workspace, expected) {
  const observedTree = store.treeForWorkspace(workspace, {
    baselineCommit: expected.commit,
    excludePaths: [path.join(workspace, ".bantam")],
  }).tree;
  if (observedTree === expected.tree) return result;
  return {
    ...(result && typeof result === "object" ? result : {}),
    pass: false,
    status: "mutated-workspace",
    expectedTree: expected.tree,
    observedTree,
    detail: "verification command changed authored workspace bytes",
  };
}

function copyRuntimeDependencies(source, destination) {
  const from = path.join(source, "node_modules");
  const to = path.join(destination, "node_modules");
  if (isRealDirectory(from) && !fs.existsSync(to)) {
    fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
  }
}

function isRealDirectory(value) {
  try { return fs.lstatSync(value).isDirectory() && !fs.lstatSync(value).isSymbolicLink(); }
  catch { return false; }
}

function readManifest(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schema !== 1 || value?.kind !== MANIFEST_KIND || typeof value.id !== "string") {
    throw new Error("invalid factory coding-cell manifest");
  }
  return value;
}

function resolveManifestPath(value) {
  const resolved = path.resolve(requireString(value, "factory manifest"));
  return fs.statSync(resolved).isDirectory() ? path.join(resolved, "manifest.json") : resolved;
}

function treeRevision(tree) { return `tree:${tree}`; }
function makeJobId() { return `cell-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`; }
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requireString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
function requireId(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`invalid ${label}: ${text}`);
  return text;
}
function requireDirectory(value, label) {
  const resolved = path.resolve(requireString(value, label));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}
