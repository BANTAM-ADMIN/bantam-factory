// Controlled native/BANTAM/factory comparison for the keyed lifecycle cell.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "../atomic-file.js";
import { runCodexDelegate } from "../codex-delegate.js";
import { runContractGrader, findContractGrader } from "../contract-grader.js";
import { runFixture, materializeFixtureRepo } from "../fixture-runner.js";
import { FactLog } from "../logic/fact-log.js";
import { canonicalJson } from "../journal.js";
import { ModelClient } from "../model.js";
import { WorkspaceStore } from "../workspace-store.js";
import { runLifecycleFactoryCell } from "./lifecycle-cell.js";

const KIND = "bantam.factory-lifecycle-cohort";
const ARMS = Object.freeze(["native", "bantam", "factory"]);
const MODELS = Object.freeze({ terra: "gpt-5.6-terra", sol: "gpt-5.6-sol", "gpt-5.6-terra": "gpt-5.6-terra", "gpt-5.6-sol": "gpt-5.6-sol" });
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export async function runLifecycleCohort({
  fixtureDir,
  root,
  id = null,
  model = "terra",
  effort = "medium",
  order = ARMS,
  diagnosisMaxTurns = 8,
  mutationMaxTurns = 30,
  maxReworkCycles = 1,
  timeoutMs = 900_000,
  verificationTimeoutMs = 120_000,
  signal = null,
  armRunners = null,
} = {}) {
  const fixture = requireDirectory(fixtureDir, "lifecycle cohort fixture");
  const cohortRoot = path.resolve(requireString(root, "lifecycle cohort root"));
  const cohortId = id === null ? makeId() : requireId(id);
  const selectedModel = normalizeModel(model);
  const selectedEffort = normalizeEffort(effort);
  const armOrder = normalizeOrder(order);
  const specPath = path.join(fixture, "task.json");
  const taskBytes = fs.readFileSync(specPath);
  const spec = JSON.parse(taskBytes);
  if (!findContractGrader(fixture)) throw new Error("lifecycle cohort requires a hidden contract grader");
  const directory = path.join(cohortRoot, "cohorts", cohortId);
  if (fs.existsSync(directory)) throw new Error(`lifecycle cohort already exists: ${cohortId}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new WorkspaceStore(path.join(directory, "workspace-store"));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-factory-cohort-${cohortId}-`));
  const baselineWorkspace = path.join(runtime, "baseline");
  materializeFixtureRepo(fixture, spec, baselineWorkspace);
  const baseline = store.capture(baselineWorkspace, { message: `BANTAMFACTORY cohort ${cohortId} baseline` });
  const context = Object.freeze({
    cohortId, directory, fixture, spec, baselineWorkspace, baseline, store,
    model: selectedModel, effort: selectedEffort, timeoutMs, verificationTimeoutMs,
    diagnosisMaxTurns, mutationMaxTurns, maxReworkCycles, signal,
  });
  const runners = armRunners ?? defaultArmRunners();
  const startedAt = new Date().toISOString();
  const rows = [];
  try {
    for (const arm of armOrder) {
      const started = Date.now();
      try {
        const row = await runners[arm](context);
        rows.push(normalizeArmRow(arm, row, baseline.tree, selectedModel, selectedEffort, Date.now() - started));
      } catch (error) {
        rows.push(normalizeArmRow(arm, {
          status: "infrastructure",
          pass: false,
          error: String(error?.stack ?? error?.message ?? error).slice(0, 8_000),
        }, baseline.tree, selectedModel, selectedEffort, Date.now() - started));
      }
      writeJsonAtomic(path.join(directory, "checkpoint.json"), checkpoint({
        cohortId, fixture, spec, selectedModel, selectedEffort, armOrder, baseline, startedAt, rows,
      }));
    }
    const body = checkpoint({ cohortId, fixture, spec, selectedModel, selectedEffort, armOrder, baseline, startedAt, rows });
    const manifest = {
      ...body,
      completedAt: new Date().toISOString(),
      comparability: comparability(rows, baseline.tree, selectedModel, selectedEffort),
      summary: summarize(rows),
    };
    manifest.ref = `cohort:${cohortId}:sha256:${sha256(canonicalJson(manifest))}`;
    const manifestPath = writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
    return { manifest: deepFreeze(manifest), manifestPath, directory };
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

export function loadLifecycleCohort(target) {
  const file = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()
    ? path.join(target, "manifest.json") : path.resolve(target);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest?.kind !== KIND || manifest.schema !== 1) throw new Error("invalid lifecycle cohort manifest");
  const { ref, ...body } = manifest;
  const expected = `cohort:${manifest.id}:sha256:${sha256(canonicalJson(body))}`;
  if (ref !== expected) throw new Error("lifecycle cohort manifest reference mismatch");
  return deepFreeze(manifest);
}

export function formatLifecycleCohort(manifest) {
  const lines = [
    "BANTAMFACTORY LIFECYCLE COHORT",
    `cohort ${manifest.id}`,
    `fixture ${manifest.fixture.name}  baseline ${manifest.baseline.tree}`,
    `model ${manifest.model}  effort ${manifest.effort}`,
    "",
  ];
  for (const row of manifest.arms) {
    const usage = row.usage ?? {};
    lines.push(`${row.pass ? "[OK]" : "[!!]"} ${row.id.padEnd(8)} ${String(row.status).padEnd(16)} ${formatMs(row.durationMs)}  turns ${show(usage.turns)}  requests ${show(usage.requests)}  tokens ${show(usage.totalTokens)}`);
  }
  lines.push("", `comparable ${manifest.comparability.valid ? "yes" : "NO"}  passed ${manifest.summary.passed}/${manifest.summary.completed}`);
  return lines.join("\n");
}

function defaultArmRunners() {
  return {
    native: runNativeArm,
    bantam: runBantamArm,
    factory: runFactoryArm,
  };
}

async function runNativeArm(context) {
  const nativeRoot = path.join(context.directory, "native");
  const run = await runCodexDelegate({
    workspace: context.baselineWorkspace,
    task: context.spec.task,
    model: context.model,
    effort: context.effort,
    verificationScript: context.spec.verify,
    timeoutMs: context.timeoutMs,
    verifyTimeoutMs: context.verificationTimeoutMs,
    stateRoot: nativeRoot,
    id: `${context.cohortId}-native`,
  });
  const candidateWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cohort-native-candidate-"));
  try {
    const candidateStore = new WorkspaceStore(run.artifact.storeRoot);
    candidateStore.materialize(run.artifact.candidate.commit, candidateWorkspace);
    const contract = await runContractGrader({ fixtureDir: context.fixture, workspace: candidateWorkspace, timeoutMs: context.verificationTimeoutMs });
    return {
      status: run.artifact.result.pass && contract?.pass ? "pass" : (contract?.status === "pass" ? run.artifact.result.status : `contract-${contract?.status ?? "missing"}`),
      pass: Boolean(run.artifact.result.pass && contract?.pass),
      baselineTree: run.artifact.baseline.tree,
      candidateTree: run.artifact.candidate.tree,
      public: run.artifact.verification,
      contract,
      durationMs: run.artifact.execution.durationMs,
      usage: {
        turns: run.artifact.usage.turns,
        requests: run.artifact.usage.turns,
        inputTokens: run.artifact.usage.inputTokens,
        outputTokens: run.artifact.usage.outputTokens,
        totalTokens: run.artifact.usage.totalTokens,
        cacheHitTokens: run.artifact.usage.cachedInputTokens,
        cacheMissTokens: run.artifact.usage.cacheMissTokens,
        reasoningTokens: run.artifact.usage.reasoningOutputTokens,
      },
      artifact: run.artifactPath,
      hiddenVisibleToWorker: false,
    };
  } finally {
    fs.rmSync(candidateWorkspace, { recursive: true, force: true });
  }
}

async function runBantamArm(context) {
  const model = new ModelClient({ codex: true, model: context.model, codexEffort: context.effort });
  try {
    const result = await runFixture({
      dir: context.fixture,
      model,
      captureArtifact: true,
      artifactPathForRun: () => path.join(context.directory, "bantam", "artifact.json"),
      factsLog: FactLog.open(path.join(context.directory, "bantam", "facts.jsonl")),
      experiment: { id: context.cohortId, name: "BANTAMFACTORY lifecycle cohort", arm: "bantam", round: 1 },
      onCandidatePrepared: ({ workspace }) => context.store.capture(workspace, {
        parent: context.baseline.commit,
        message: `BANTAMFACTORY cohort ${context.cohortId} BANTAM candidate`,
      }),
    });
    return {
      status: result.status,
      pass: result.status === "pass",
      baselineTree: context.baseline.tree,
      candidateTree: result.candidateEvidence?.tree ?? null,
      public: { status: result.publicStatus, pass: result.publicPass },
      contract: { status: result.contractStatus, pass: result.contractStatus === "pass", tests: result.contractTests, passed: result.contractPassed, failed: result.contractFailed, durationMs: result.contractDurationMs },
      durationMs: result.durationMs,
      usage: {
        turns: result.turns, requests: result.requests, inputTokens: result.inputTok,
        outputTokens: result.outputTok, totalTokens: sumKnown(result.inputTok, result.outputTok),
        cacheHitTokens: result.cacheHitTok, cacheMissTokens: result.cacheMissTok,
        reasoningTokens: result.reasoningTok,
      },
      artifact: result.artifactPath,
      hiddenVisibleToWorker: false,
    };
  } finally {
    model.close?.();
  }
}

async function runFactoryArm(context) {
  const model = new ModelClient({ codex: true, model: context.model, codexEffort: context.effort });
  try {
    const grader = findContractGrader(context.fixture);
    const hidden = `CANDIDATE_ROOT="$PWD" ${shellQuote(process.execPath)} --test ${shellQuote(grader)}`;
    const built = await runLifecycleFactoryCell({
      workspace: context.baselineWorkspace,
      task: context.spec.task,
      publicVerificationScript: context.spec.verify,
      verificationScript: hidden,
      root: path.join(context.directory, "factory"),
      jobId: `${context.cohortId}-factory`,
      model,
      diagnosisMaxTurns: context.diagnosisMaxTurns,
      mutationMaxTurns: context.mutationMaxTurns,
      maxReworkCycles: context.maxReworkCycles,
      verificationTimeoutMs: context.verificationTimeoutMs,
      signal: context.signal,
    });
    const performance = aggregateFactoryUsage(built.line.events);
    return {
      status: built.manifest.status,
      pass: built.manifest.status === "released",
      baselineTree: built.manifest.baseline.tree,
      candidateTree: built.manifest.candidate.tree,
      public: built.manifest.inspections.public ?? null,
      contract: built.manifest.inspections.final ?? null,
      durationMs: performance.durationMs,
      usage: performance.usage,
      artifact: built.manifestPath,
      traveler: { jobId: built.manifest.id, events: built.line.events.length, routeRef: built.manifest.routeRef },
      hiddenVisibleToWorker: false,
    };
  } finally {
    model.close?.();
  }
}

function aggregateFactoryUsage(events) {
  const rows = events.filter((event) => event.type === "station.performance").map((event) => event.payload);
  const sum = (field) => {
    const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    durationMs: rows.reduce((total, row) => total + row.operationMs + row.inspectionMs, 0),
    usage: {
      turns: sum("turns"), requests: sum("modelRequests"), inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"),
      cacheHitTokens: sum("cacheHitTokens"), cacheMissTokens: sum("cacheMissTokens"),
      reasoningTokens: sum("reasoningTokens"),
    },
  };
}

function checkpoint({ cohortId, fixture, spec, selectedModel, selectedEffort, armOrder, baseline, startedAt, rows }) {
  return {
    schema: 1,
    kind: KIND,
    id: cohortId,
    startedAt,
    fixture: { name: spec.name, directory: fixture, taskDigest: sha256(spec.task), publicVerify: spec.verify, hiddenGraderDigest: sha256(fs.readFileSync(findContractGrader(fixture))) },
    model: selectedModel,
    effort: selectedEffort,
    order: armOrder,
    baseline: { commit: baseline.commit, tree: baseline.tree, files: baseline.files },
    arms: rows,
  };
}

function normalizeArmRow(id, value, baselineTree, model, effort, measuredDurationMs) {
  const row = value && typeof value === "object" ? value : {};
  return {
    id,
    status: requireString(row.status ?? "invalid", `${id} status`),
    pass: Boolean(row.pass),
    baselineTree: row.baselineTree ?? baselineTree,
    candidateTree: row.candidateTree ?? null,
    model,
    effort,
    durationMs: measuredDurationMs,
    operationDurationMs: finite(row.durationMs),
    public: row.public ?? null,
    contract: row.contract ?? null,
    usage: row.usage ?? null,
    artifact: row.artifact ?? null,
    traveler: row.traveler ?? null,
    hiddenVisibleToWorker: Boolean(row.hiddenVisibleToWorker),
    error: row.error ?? null,
  };
}

function comparability(rows, baselineTree, model, effort) {
  const checks = {
    allArmsPresent: rows.length === ARMS.length && ARMS.every((arm) => rows.some((row) => row.id === arm)),
    identicalBaseline: rows.every((row) => row.baselineTree === baselineTree),
    identicalModel: rows.every((row) => row.model === model),
    identicalEffort: rows.every((row) => row.effort === effort),
    hiddenBoundary: rows.every((row) => row.hiddenVisibleToWorker === false),
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}

function summarize(rows) {
  return { completed: rows.length, passed: rows.filter((row) => row.pass).length, failed: rows.filter((row) => !row.pass).length };
}

function normalizeOrder(value) {
  const rows = (typeof value === "string" ? value.split(",") : value).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (rows.length !== ARMS.length || new Set(rows).size !== ARMS.length || rows.some((row) => !ARMS.includes(row))) {
    throw new Error(`lifecycle cohort order must contain exactly: ${ARMS.join(", ")}`);
  }
  return Object.freeze(rows);
}
function normalizeModel(value) { const model = MODELS[String(value).trim().toLowerCase()]; if (!model) throw new Error(`invalid lifecycle cohort model: ${value}`); return model; }
function normalizeEffort(value) { const effort = String(value).trim().toLowerCase(); if (!EFFORTS.has(effort)) throw new Error(`invalid lifecycle cohort effort: ${value}`); return effort; }
function requireDirectory(value, label) { const full = path.resolve(requireString(value, label)); if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} is not a directory: ${full}`); return full; }
function requireString(value, label) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function requireId(value) { const text = requireString(value, "lifecycle cohort id"); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`invalid lifecycle cohort id: ${text}`); return text; }
function makeId() { return `lifecycle-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function finite(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function sumKnown(...values) { return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null; }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function formatMs(value) { return Number.isFinite(value) ? (value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`) : "—"; }
function show(value) { return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—"; }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
