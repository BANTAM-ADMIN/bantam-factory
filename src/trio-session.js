// Parallel, isolated Local/Sol/Terra operating sessions.
//
// Trio is deliberately additive: it snapshots one live workspace, materializes
// one private workspace per arm, and runs the ordinary BANTAM agent in each.
// The live workspace is never touched until applyTrioArm() is called explicitly.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "./agent.js";
import {
  buildArtifact,
  fetchModelId,
  makeRunId,
  makeStamp,
  saveArtifact,
} from "./artifact.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { captureFinalDiff, prepareDiffBaseline } from "./diff.js";
import { GAUNTLET_MODELS } from "./gauntlet.js";
import { runProcess } from "./process-runner.js";
import { ADVISORY_EXCLUDED_ACTIONS, classifyTaskIntent } from "./task-intent.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceTransaction } from "./workspace-transaction.js";

const KIND = "bantam-trio-session";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const ARM_NAMES = Object.freeze(["local", "sol", "terra"]);

/**
 * Implementation-mode outcome for one arm.
 *
 * A green verifier is not a finished ticket: an arm that hits its turn cap can
 * leave the verifier passing (it often runs a file the arm just wrote) while a
 * stated requirement was never touched. Measured 2026-08-15 — the ticket A trio
 * reported "all arms passed" when one arm had never wired the CLI and never
 * declared done. Completion is in the artifact; keep it in the verdict.
 */
export function implementationArmOutcome({ verification = null, reachedDone = false } = {}) {
  const verified = verification?.status === "pass";
  if (verified && reachedDone) return { pass: true, status: "pass" };
  if (verified) return { pass: false, status: "incomplete" };
  if (verification?.status) return { pass: false, status: verification.status };
  return { pass: false, status: reachedDone ? "unverified" : "incomplete" };
}

export class TrioSession {
  constructor({
    workspace,
    stateRoot = null,
    runtimeRoot = null,
    id = null,
    arms = ARM_NAMES,
    effort = "high",
    verificationScript = null,
    maxTurns = 30,
    thinkMode = "auto",
    preGate = true,
    modelFactory,
    runAgentImpl = runAgent,
    preflightVerifier = defaultVerifier,
    onEvent = () => {},
  } = {}) {
    this.workspace = requireDirectory(workspace, "trio workspace");
    this.stateRoot = path.resolve(stateRoot ?? path.join(this.workspace, ".bantam", "trios"));
    this.id = id ?? trioId();
    this.directory = path.join(this.stateRoot, this.id);
    this.storeRoot = path.join(this.stateRoot, "_workspace-store");
    this.runtimeRoot = runtimeRoot === null
      ? null
      : path.resolve(runtimeRoot);
    this.manifestPath = path.join(this.directory, "manifest.json");
    this.eventsPath = path.join(this.directory, "events.jsonl");
    this.arms = normalizeArms(arms, effort);
    this.verificationScript = optionalString(verificationScript);
    this.maxTurns = positiveInt(maxTurns, "trio maxTurns");
    this.thinkMode = String(thinkMode ?? "auto");
    this.preGate = Boolean(preGate);
    if (typeof modelFactory !== "function") throw new TypeError("trio modelFactory is required");
    if (typeof runAgentImpl !== "function") throw new TypeError("trio runAgentImpl must be a function");
    if (typeof preflightVerifier !== "function") throw new TypeError("trio preflightVerifier must be a function");
    if (typeof onEvent !== "function") throw new TypeError("trio onEvent must be a function");
    this.modelFactory = modelFactory;
    this.runAgentImpl = runAgentImpl;
    this.preflightVerifier = preflightVerifier;
    this.onEvent = onEvent;
    this.store = null;
    this.models = new Map();
    this.manifest = null;
    this.closed = false;
  }

  async start() {
    if (fs.existsSync(this.directory)) throw new Error(`trio session already exists: ${this.id}`);
    fs.mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateRoot, 0o700);
    fs.mkdirSync(this.directory, { mode: 0o700 });
    if (this.runtimeRoot === null) {
      this.runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-trio-${this.id}-`));
    } else {
      fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    }
    this.store = new WorkspaceStore(this.storeRoot);
    const captured = this.store.capture(this.workspace, {
      message: `BANTAM trio ${this.id} baseline`,
      excludePaths: [path.join(this.workspace, ".bantam"), this.stateRoot],
    });
    const startedAt = new Date().toISOString();
    this.manifest = {
      schema: 1,
      kind: KIND,
      id: this.id,
      status: "starting",
      startedAt,
      updatedAt: startedAt,
      sourceWorkspace: this.workspace,
      stateRoot: this.stateRoot,
      storeRoot: this.storeRoot,
      runtimeRoot: this.runtimeRoot,
      baseline: { commit: captured.commit, tree: captured.tree, files: captured.files },
      verificationScript: this.verificationScript,
      maxTurns: this.maxTurns,
      thinkMode: this.thinkMode,
      preGate: this.preGate,
      turnCount: 0,
      turns: [],
      armOrder: this.arms.map((arm) => arm.name),
      arms: {},
      preflight: null,
    };
    this.persist();

    try {
      for (const arm of this.arms) {
        const armWorkspace = path.join(this.runtimeRoot, "workspaces", arm.name);
        this.store.materialize(captured.commit, armWorkspace);
        prepareDiffBaseline(armWorkspace);
        const model = await this.modelFactory(arm);
        if (!model || typeof model.health !== "function") {
          throw new Error(`trio ${arm.name} model factory returned no usable model`);
        }
        this.models.set(arm.name, model);
        this.manifest.arms[arm.name] = {
          name: arm.name,
          description: arm.description,
          role: arm.role ?? null,
          model: arm.model,
          workspace: armWorkspace,
          status: "checking",
          candidateCommit: captured.commit,
          candidateTree: captured.tree,
          history: [],
          runtimeDependencies: [],
          preflight: null,
        };
      }
      this.persist();
      const health = await Promise.all(this.arms.map(async (arm) => {
        const ok = await this.models.get(arm.name).health();
        this.manifest.arms[arm.name].status = ok ? "ready" : "unavailable";
        this.emit(arm.name, { type: "trio_health", ok });
        return { arm: arm.name, ok };
      }));
      const unavailable = health.filter((entry) => !entry.ok).map((entry) => entry.arm);
      if (unavailable.length) {
        throw new Error(`trio model(s) unavailable: ${unavailable.join(", ")}`);
      }
      this.manifest.status = "ready";
      this.persist();
      return this.view();
    } catch (error) {
      this.manifest.status = "failed";
      this.manifest.error = error.message;
      this.persist();
      this.close();
      throw error;
    }
  }

  async runTurn(task, {
    signal = null,
    arms = null,
    armTasks = null,
    intent = null,
    maxTurns = null,
    investigationActionLimit = null,
  } = {}) {
    this.requireOpen();
    if (!this.manifest || !["ready", "active"].includes(this.manifest.status)) {
      throw new Error(`trio session ${this.id} is not ready`);
    }
    const request = requiredString(task, "trio task");
    const selectedArms = selectArms(this.arms, arms);
    const tasks = normalizeArmTasks(selectedArms, armTasks);
    const mode = intent === null ? classifyTaskIntent(request) : normalizeIntent(intent);
    const turnLimit = maxTurns === null ? this.maxTurns : positiveInt(maxTurns, "trio turn maxTurns");
    if (mode === "implementation") await this.ensureImplementationReady();
    const turn = this.manifest.turnCount + 1;
    const startedAt = new Date().toISOString();
    this.manifest.status = "active";
    this.manifest.turnCount = turn;
    const turnRecord = {
      turn,
      task: request,
      mode,
      selectedArms: selectedArms.map((arm) => arm.name),
      startedAt,
      completedAt: null,
      arms: {},
    };
    this.manifest.turns.push(turnRecord);
    this.persist();
    this.emit(null, { type: "trio_turn_started", turn, task: request, mode });

    const settled = await Promise.all(selectedArms.map(async (arm) => {
      try {
        const row = await this.runArmTurn(
          arm,
          tasks.get(arm.name) ?? request,
          turn,
          {
            signal,
            mode,
            originalTask: request,
            maxTurns: turnLimit,
            investigationActionLimit,
          },
        );
        turnRecord.arms[arm.name] = row;
        return row;
      } catch (error) {
        const row = {
          arm: arm.name,
          status: "error",
          pass: false,
          error: error.message,
          completedAt: new Date().toISOString(),
        };
        turnRecord.arms[arm.name] = row;
        this.emit(arm.name, { type: "trio_arm_error", error: error.message });
        return row;
      }
    }));

    turnRecord.completedAt = new Date().toISOString();
    this.manifest.status = "ready";
    this.persist();
    const comparison = buildTrioComparison(this.manifest, turn);
    writeJsonAtomic(path.join(this.directory, "comparisons", `turn-${pad(turn)}.json`), comparison);
    writeTextAtomic(path.join(this.directory, "summary.md"), formatTrioSummary(this.manifest));
    writeTrioReport(path.join(this.directory, "report", "index.html"), this.manifest);
    this.emit(null, { type: "trio_turn_completed", turn, comparison });
    return { turn, rows: settled, comparison, directory: this.directory };
  }

  async ensureImplementationReady() {
    const sourceDependencies = path.join(this.workspace, "node_modules");
    const sourceHasDependencies = isRealDirectory(sourceDependencies);
    for (const arm of this.arms) {
      const state = this.manifest.arms[arm.name];
      if (sourceHasDependencies) {
        const destination = path.join(state.workspace, "node_modules");
        if (!fs.existsSync(destination)) {
          fs.cpSync(sourceDependencies, destination, {
            recursive: true,
            dereference: false,
            preserveTimestamps: true,
          });
        }
        if (!state.runtimeDependencies.includes("node_modules")) {
          state.runtimeDependencies.push("node_modules");
        }
      }
    }
    if (this.manifest.preflight || !this.verificationScript) {
      this.persist();
      return;
    }

    // Verifiers sometimes generate coverage, build, or cache files. Run the
    // readiness probe in a disposable fourth materialization so none of that
    // output contaminates a model lane or its candidate diff.
    const preflightRoot = fs.mkdtempSync(path.join(this.runtimeRoot, "preflight-"));
    const preflightWorkspace = path.join(preflightRoot, "workspace");
    let checked;
    try {
      this.store.materialize(this.manifest.baseline.commit, preflightWorkspace);
      if (sourceHasDependencies && !fs.existsSync(path.join(preflightWorkspace, "node_modules"))) {
        fs.cpSync(sourceDependencies, path.join(preflightWorkspace, "node_modules"), {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        });
      }
      checked = await this.preflightVerifier(
        preflightWorkspace,
        this.verificationScript,
        120_000,
      );
    } finally {
      fs.rmSync(preflightRoot, { recursive: true, force: true });
    }
    this.manifest.preflight = {
      status: checked.status,
      pass: Boolean(checked.pass),
      exitCode: checked.exitCode ?? null,
      durationMs: checked.durationMs ?? null,
      infrastructureFailure: isInfrastructureFailure(checked),
      detail: String(checked.detail ?? "").slice(0, 4_000),
    };
    for (const arm of this.arms) {
      this.manifest.arms[arm.name].preflight = {
        status: this.manifest.preflight.status,
        infrastructureFailure: this.manifest.preflight.infrastructureFailure,
      };
    }
    this.persist();
    if (this.manifest.preflight.infrastructureFailure) {
      throw new Error(
        `trio implementation preflight failed: ${firstUsefulLine(checked.detail)}`,
      );
    }
  }

  synchronizeArmsFrom(sourceArm, { targets = null } = {}) {
    this.requireOpen();
    const sourceName = requiredString(sourceArm, "source arm");
    const source = this.manifest?.arms?.[sourceName];
    if (!source) throw new Error(`unknown synchronization source arm: ${sourceName}`);
    const selected = targets === null
      ? this.arms.map((arm) => arm.name).filter((name) => name !== sourceName)
      : [...new Set(targets.map((name) => requiredString(name, "target arm")))];
    for (const name of selected) {
      if (name === sourceName) continue;
      const target = this.manifest.arms[name];
      if (!target) throw new Error(`unknown synchronization target arm: ${name}`);
      const syncRoot = fs.mkdtempSync(path.join(this.runtimeRoot, `sync-${name}-`));
      const staged = path.join(syncRoot, "workspace");
      const backup = path.join(syncRoot, "previous");
      try {
        this.store.materialize(source.candidateCommit, staged);
        prepareDiffBaseline(staged);
        fs.renameSync(target.workspace, backup);
        try {
          fs.renameSync(staged, target.workspace);
        } catch (error) {
          fs.renameSync(backup, target.workspace);
          throw error;
        }
        fs.rmSync(backup, { recursive: true, force: true });
        target.candidateCommit = source.candidateCommit;
        target.candidateTree = source.candidateTree;
        target.history = [];
        target.runtimeDependencies = [];
        target.status = "ready";
        target.synchronizedFrom = {
          arm: sourceName,
          at: new Date().toISOString(),
          commit: source.candidateCommit,
        };
      } finally {
        fs.rmSync(syncRoot, { recursive: true, force: true });
      }
    }
    this.persist();
    this.emit(null, {
      type: "trio_arms_synchronized",
      source: sourceName,
      targets: selected.filter((name) => name !== sourceName),
    });
    return this.view();
  }

  checkpointArm(armName) {
    this.requireOpen();
    const name = requiredString(armName, "checkpoint arm");
    const state = this.manifest?.arms?.[name];
    if (!state) throw new Error(`unknown checkpoint arm: ${name}`);
    return {
      arm: name,
      commit: state.candidateCommit,
      tree: state.candidateTree,
      history: JSON.parse(JSON.stringify(state.history ?? [])),
    };
  }

  restoreArm(checkpoint) {
    this.requireOpen();
    const name = requiredString(checkpoint?.arm, "restore arm");
    const commit = requiredString(checkpoint?.commit, "restore commit");
    const state = this.manifest?.arms?.[name];
    if (!state) throw new Error(`unknown restore arm: ${name}`);
    if (!this.store.hasCommit(commit)) throw new Error(`unknown restore commit: ${commit}`);
    const restoreRoot = fs.mkdtempSync(path.join(this.runtimeRoot, `restore-${name}-`));
    const staged = path.join(restoreRoot, "workspace");
    const backup = path.join(restoreRoot, "previous");
    try {
      const materialized = this.store.materialize(commit, staged);
      prepareDiffBaseline(staged);
      fs.renameSync(state.workspace, backup);
      try {
        fs.renameSync(staged, state.workspace);
      } catch (error) {
        fs.renameSync(backup, state.workspace);
        throw error;
      }
      fs.rmSync(backup, { recursive: true, force: true });
      state.candidateCommit = commit;
      state.candidateTree = materialized.tree;
      state.history = JSON.parse(JSON.stringify(checkpoint.history ?? []));
      state.runtimeDependencies = [];
      state.status = "ready";
      delete state.synchronizedFrom;
    } finally {
      fs.rmSync(restoreRoot, { recursive: true, force: true });
    }
    this.persist();
    this.emit(null, { type: "trio_arm_restored", arm: name, commit });
    return this.view();
  }

  async runArmTurn(arm, task, turn, {
    signal,
    mode,
    originalTask = task,
    maxTurns = this.maxTurns,
    investigationActionLimit = null,
  }) {
    const model = this.models.get(arm.name);
    const state = this.manifest.arms[arm.name];
    const prior = state.history.slice(-6);
    const effectiveTask = prior.length
      ? [
          "This is a continuing BANTAM trio lane. The workspace contains your earlier work.",
          ...prior.map((entry) => `- Earlier request: ${entry.task}\n  Outcome: ${entry.summary}`),
          "",
          `New request: ${task}`,
        ].join("\n")
      : task;
    const stamp = makeStamp();
    const runId = makeRunId(stamp);
    const artifactPath = path.join(
      this.directory,
      "runs",
      arm.name,
      `turn-${pad(turn)}-${stamp}.json`,
    );
    const started = Date.now();
    const usageBefore = modelUsage(model);
    this.emit(arm.name, { type: "trio_arm_started", turn, workspace: state.workspace });
    const result = await this.runAgentImpl({
      task: effectiveTask,
      workspace: state.workspace,
      model,
      maxTurns,
      // Advisory lanes are graded by response + read-only diff, never by the
      // project's code verifier. Passing the script here also activates the
      // agent's terminal verify gate, which can reject a correct `respond`
      // merely because an isolated read-only lane has no installed toolchain.
      verificationScript: mode === "advisory" ? null : this.verificationScript,
      verificationPolicy: mode === "advisory" ? "after_edit" : "always",
      excludeActions: mode === "advisory" ? ADVISORY_EXCLUDED_ACTIONS : null,
      advisoryMode: mode === "advisory",
      investigationActionLimit,
      progressAwareness: mode !== "advisory",
      autoForceEditAfter: mode === "advisory" ? 0 : undefined,
      completionAudit: mode !== "advisory",
      stateAudit: mode === "advisory" ? "off" : undefined,
      readOnlyWorkspacePaths: state.runtimeDependencies,
      thinkMode: this.thinkMode,
      preGate: this.preGate,
      grounding: /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_GROUND ?? "")) || null,
      signal,
      onEvent: (event) => this.emit(arm.name, event),
    });
    const finalDiff = captureFinalDiff(state.workspace);
    const metadata = typeof model.metadata === "function" ? model.metadata() : null;
    const modelId = metadata?.model
      ?? metadata?.modelName
      ?? (model.codex ? model.modelName : await fetchModelId(model.endpoint));
    const artifact = buildArtifact({
      runId,
      stamp,
      fixture: null,
      task,
      model,
      modelId,
      result,
      finalDiff,
      experiment: {
        id: this.id,
        kind: "trio",
        arm: arm.name,
        round: turn,
        sequence: turn,
        mode,
        originalTask,
      },
    });
    saveArtifact(artifactPath, artifact);
    const candidate = this.store.capture(state.workspace, {
      parent: state.candidateCommit,
      message: `BANTAM trio ${this.id} ${arm.name} turn ${turn}`,
      excludePaths: [path.join(state.workspace, ".bantam")],
    });
    state.candidateCommit = candidate.commit;
    state.candidateTree = candidate.tree;
    state.status = result.interrupted ? "interrupted" : result.modelFailure ? "model-error" : "ready";
    const unchanged = finalDiff.status === "captured" && finalDiff.fileCount === 0;
    const advisorySuccess = mode === "advisory"
      && result.responded === true
      && result.reachedDone === true
      && unchanged
      && !result.interrupted
      && !result.modelFailure
      && !result.blocked;
    const implementationOutcome = implementationArmOutcome({
      verification: result.verification,
      reachedDone: result.reachedDone,
    });
    const pass = mode === "advisory" ? advisorySuccess : implementationOutcome.pass;
    const usage = usageDelta(usageBefore, modelUsage(model));
    const row = {
      arm: arm.name,
      mode,
      status: result.interrupted ? "interrupted"
        : result.modelFailure ? "model-error"
          : mode === "advisory" && !unchanged ? "policy-violation"
            : mode === "advisory" && advisorySuccess ? "response"
              : mode === "advisory" ? "incomplete"
          : implementationOutcome.status,
      pass,
      responded: Boolean(result.responded),
      summary: result.summary ?? "",
      turns: result.metrics?.turns ?? 0,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      costUsd: usage.costUsd,
      invalid: result.metrics?.invalid ?? 0,
      protocolViolations: result.metrics?.protocolViolations ?? 0,
      durationMs: Date.now() - started,
      artifactPath: path.relative(this.directory, artifactPath).split(path.sep).join("/"),
      diff: finalDiff,
      candidateCommit: candidate.commit,
      candidateTree: candidate.tree,
      completedAt: new Date().toISOString(),
    };
    state.history.push({
      turn,
      task,
      summary: String(result.summary ?? row.status).replace(/\s+/g, " ").slice(0, 500),
      artifactPath: row.artifactPath,
      pass,
    });
    prepareDiffBaseline(state.workspace);
    this.emit(arm.name, { type: "trio_arm_completed", turn, row });
    return row;
  }

  emit(arm, event) {
    const record = {
      time: new Date().toISOString(),
      sessionId: this.id,
      arm,
      event,
    };
    fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.onEvent(record);
  }

  persist() {
    this.manifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.manifestPath, this.manifest);
  }

  view() {
    return JSON.parse(JSON.stringify(this.manifest));
  }

  requireOpen() {
    if (this.closed) throw new Error(`trio session ${this.id} is closed`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const model of this.models.values()) {
      try { model.close?.(); } catch { /* best effort */ }
    }
    this.models.clear();
  }
}

export async function applyTrioArm({
  sessionDir,
  arm,
  workspace = null,
  verificationScript = null,
  timeoutMs = 120_000,
  runVerifier = defaultVerifier,
} = {}) {
  const directory = requireDirectory(sessionDir, "trio session");
  const manifest = readManifest(directory);
  const name = requiredString(arm, "trio arm").toLowerCase();
  const selected = manifest.arms[name];
  if (!selected) throw new Error(`unknown trio arm: ${name}`);
  const live = path.resolve(workspace ?? manifest.sourceWorkspace);
  if (live !== path.resolve(manifest.sourceWorkspace)) {
    throw new Error("trio apply workspace does not match the session source workspace");
  }
  requireDirectory(live, "trio live workspace");
  if (typeof runVerifier !== "function") throw new TypeError("trio runVerifier must be a function");
  const verifier = optionalString(verificationScript) ?? optionalString(manifest.verificationScript);
  if (!verifier) throw new Error("trio apply requires a verifier");
  const store = new WorkspaceStore(manifest.storeRoot);
  const liveTree = store.treeForWorkspace(live, {
    excludePaths: [path.join(live, ".bantam"), manifest.stateRoot],
  }).tree;
  if (liveTree !== manifest.baseline.tree) {
    throw new Error("trio apply refused: live workspace changed since the trio baseline");
  }
  if (selected.candidateTree === manifest.baseline.tree) {
    throw new Error(`trio arm ${name} is byte-identical to the baseline`);
  }

  const nonce = crypto.randomBytes(8).toString("hex");
  const materializations = fs.mkdtempSync(
    path.join(os.tmpdir(), `bantam-trio-apply-${manifest.id}-${name}-`),
  );
  const baselineRoot = path.join(materializations, "baseline");
  const candidateRoot = path.join(materializations, "candidate");
  try {
    store.materialize(manifest.baseline.commit, baselineRoot);
    store.materialize(selected.candidateCommit, candidateRoot);
    const candidateVerification = await runVerifier(candidateRoot, verifier, timeoutMs);
    if (!candidateVerification.pass) {
      throw new Error(`trio apply refused: ${name} candidate verifier ${candidateVerification.status}`);
    }

    const transaction = new WorkspaceTransaction({
      workspace: live,
      baselineRoot,
      candidateRoot,
      transactionRoot: path.join(directory, "transactions"),
      id: `apply-${name}-${Date.now()}-${nonce}`,
      metadata: { kind: "trio-apply", sessionId: manifest.id, arm: name },
    });
    transaction.prepare();
    transaction.apply();
    let liveVerification;
    try {
      liveVerification = await runVerifier(live, verifier, timeoutMs);
      if (!liveVerification.pass) {
        throw new Error(`live verifier ${liveVerification.status}`);
      }
      transaction.markVerified(liveVerification);
      transaction.markPromoted({ kind: "operator-selected-trio-arm", arm: name });
      transaction.commit();
    } catch (error) {
      transaction.rollback({ reason: `trio live verification failed: ${error.message}` });
      throw new Error(`trio apply rolled back: ${error.message}`);
    }
    manifest.applied = {
      arm: name,
      at: new Date().toISOString(),
      verifier,
      transaction: transaction.view(),
    };
    manifest.status = "applied";
    manifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
    return { arm: name, workspace: live, verification: liveVerification, transaction: transaction.view() };
  } finally {
    fs.rmSync(materializations, { recursive: true, force: true });
  }
}

export function loadTrioManifest(sessionDir) {
  return readManifest(requireDirectory(sessionDir, "trio session"));
}

export function buildTrioComparison(manifest, turn = null) {
  requireManifest(manifest);
  const selected = turn === null
    ? manifest.turns.at(-1)
    : manifest.turns.find((entry) => entry.turn === Number(turn));
  if (!selected) throw new Error(`trio turn not found: ${turn}`);
  const rows = Object.values(selected.arms)
    .map((row) => ({ ...row }))
    .sort((a, b) => {
      const order = Array.isArray(manifest.armOrder) ? manifest.armOrder : ARM_NAMES;
      const left = order.indexOf(a.arm);
      const right = order.indexOf(b.arm);
      return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
    });
  const passing = rows.filter((row) => row.pass);
  const fastest = [...rows].filter((row) => Number.isFinite(row.durationMs))
    .sort((a, b) => a.durationMs - b.durationMs)[0]?.arm ?? null;
  const fewestTurns = [...rows].filter((row) => Number.isFinite(row.turns))
    .sort((a, b) => a.turns - b.turns)[0]?.arm ?? null;
  return {
    schema: 1,
    kind: "bantam-trio-comparison",
    sessionId: manifest.id,
    turn: selected.turn,
    task: selected.task,
    mode: selected.mode ?? "implementation",
    startedAt: selected.startedAt,
    completedAt: selected.completedAt,
    allPassed: rows.length > 0 && passing.length === rows.length,
    passing: passing.map((row) => row.arm),
    fastest,
    fewestTurns,
    rows,
  };
}

export function formatTrioComparison(comparison) {
  const advisory = comparison.mode === "advisory";
  const successLabel = advisory ? "responded safely" : "passed";
  const lines = [
    `Trio turn ${comparison.turn} (${comparison.mode}): ${comparison.allPassed ? `all arms ${successLabel}` : `${comparison.passing.length}/${comparison.rows.length} ${successLabel}`}`,
    "",
    "Arm     Status       Turns  Requests  Input      Output     Reasoning  Time",
  ];
  for (const row of comparison.rows) {
    lines.push([
      String(row.arm).padEnd(8),
      String(row.status).padEnd(12),
      String(row.turns ?? 0).padStart(5),
      String(row.requests ?? 0).padStart(8),
      formatNumber(row.inputTokens).padStart(10),
      formatNumber(row.outputTokens).padStart(10),
      formatNumber(row.reasoningTokens).padStart(10),
      formatDuration(row.durationMs).padStart(7),
    ].join("  "));
  }
  if (comparison.fastest) lines.push("", `Fastest: ${comparison.fastest}`);
  if (comparison.fewestTurns) lines.push(`Fewest turns: ${comparison.fewestTurns}`);
  return lines.join("\n");
}

export function formatTrioSummary(manifest) {
  requireManifest(manifest);
  const lines = [
    `# BANTAM trio ${manifest.id}`,
    "",
    `Source workspace: \`${manifest.sourceWorkspace}\``,
    `Baseline tree: \`${manifest.baseline.tree}\``,
    `Turns: ${manifest.turnCount}`,
    "",
  ];
  for (const turn of manifest.turns) {
    lines.push(`## Turn ${turn.turn}`, "", turn.task, "");
    if (turn.completedAt) {
      const comparison = buildTrioComparison(manifest, turn.turn);
      lines.push("```text", formatTrioComparison(comparison), "```", "");
      for (const row of comparison.rows) {
        lines.push(`### ${row.arm}`, "", row.summary || `Status: ${row.status}`, "");
      }
    } else {
      lines.push("_In progress._", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function defaultVerifier(workspace, command, timeoutMs) {
  const started = Date.now();
  const result = await runProcess("/bin/bash", ["-o", "pipefail", "-c", command], {
    cwd: workspace,
    timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  const status = result.timedOut ? "timeout"
    : result.aborted ? "interrupted"
      : result.error ? "error"
        : result.code === 0 ? "pass" : "fail";
  return {
    pass: status === "pass",
    status,
    exitCode: Number.isInteger(result.code) ? result.code : null,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 12_000),
  };
}

function writeTrioReport(filePath, manifest) {
  const comparisons = manifest.turns
    .filter((turn) => turn.completedAt)
    .map((turn) => buildTrioComparison(manifest, turn.turn));
  const latest = comparisons.at(-1);
  const rows = latest?.rows ?? [];
  const cards = rows.map((row) => `<article><h2>${escapeHtml(row.arm)}</h2><strong>${escapeHtml(row.status)}</strong><dl><dt>Turns</dt><dd>${row.turns}</dd><dt>Requests</dt><dd>${row.requests}</dd><dt>Time</dt><dd>${formatDuration(row.durationMs)}</dd><dt>Input</dt><dd>${formatNumber(row.inputTokens)}</dd><dt>Output</dt><dd>${formatNumber(row.outputTokens)}</dd><dt>Reasoning</dt><dd>${formatNumber(row.reasoningTokens)}</dd></dl><p>${escapeHtml(row.summary)}</p><a href="../${escapeAttr(row.artifactPath)}">Run artifact</a></article>`).join("");
  const timeline = comparisons.map((comparison) => `<section><h2>Turn ${comparison.turn}</h2><p>${escapeHtml(comparison.task)}</p><table><thead><tr><th>Arm</th><th>Status</th><th>Turns</th><th>Requests</th><th>Time</th></tr></thead><tbody>${comparison.rows.map((row) => `<tr><td>${escapeHtml(row.arm)}</td><td>${escapeHtml(row.status)}</td><td>${row.turns}</td><td>${row.requests}</td><td>${formatDuration(row.durationMs)}</td></tr>`).join("")}</tbody></table></section>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BANTAM Trio ${escapeHtml(manifest.id)}</title><style>:root{color-scheme:dark;--bg:#07100f;--panel:#10201d;--ink:#f3f6e9;--muted:#9bb0a8;--line:#b5d8c326;--local:#c7fa62;--sol:#7db6ff;--terra:#d6a8ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,sans-serif}.shell{width:min(1120px,calc(100% - 32px));margin:auto}header{padding:72px 0 34px}h1{font-size:clamp(42px,7vw,82px);line-height:.95;letter-spacing:-.06em;margin:12px 0}header p,p{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.cards article,section{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px}.cards article:nth-child(1){border-top:3px solid var(--local)}.cards article:nth-child(2){border-top:3px solid var(--sol)}.cards article:nth-child(3){border-top:3px solid var(--terra)}dl{display:grid;grid-template-columns:1fr 1fr}dt{color:var(--muted)}dd{text-align:right;margin:0}a{color:var(--sol)}section{margin:18px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--line);padding:8px}@media(max-width:760px){.cards{grid-template-columns:1fr}}</style></head><body><header><div class="shell"><small>ISOLATED PARALLEL MODEL SESSION</small><h1>One task.<br>Three BANTAMs.</h1><p>Local Qwen, Codex Sol, and Codex Terra operate in independent workspaces captured from tree <code>${escapeHtml(manifest.baseline.tree)}</code>. The live source workspace remains untouched until an explicit verified apply.</p></div></header><main class="shell"><div class="cards">${cards}</div>${timeline}</main></body></html>`;
  writeTextAtomic(filePath, html);
}

function normalizeArms(values, effort) {
  const selected = Array.isArray(values)
    ? values
    : String(values ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!selected.length) throw new Error("trio arms cannot be empty");
  const reasoning = String(effort ?? "high").toLowerCase();
  if (!EFFORTS.has(reasoning)) throw new Error(`invalid trio Codex effort: ${effort}`);
  const seen = new Set();
  return selected.map((value) => {
    const input = value && typeof value === "object" ? value : { name: value };
    const name = String(input.name ?? "").toLowerCase();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const source = GAUNTLET_MODELS[name];
    if (!source) throw new Error(`unknown trio arm: ${name}`);
    const model = { ...source.model, ...(input.model ?? {}) };
    if (model.runtime === "codex") {
      const selectedEffort = String(input.effort ?? reasoning).toLowerCase();
      if (!EFFORTS.has(selectedEffort)) {
        throw new Error(`invalid trio Codex effort for ${name}: ${input.effort}`);
      }
      model.effort = selectedEffort;
    }
    return {
      name,
      description: optionalString(input.description) ?? source.description,
      role: optionalString(input.role),
      model,
    };
  }).filter(Boolean);
}

function selectArms(available, requested) {
  if (requested === null || requested === undefined) return available;
  const names = Array.isArray(requested)
    ? requested.map((value) => String(value).toLowerCase())
    : String(requested).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!names.length) throw new Error("trio selected arms cannot be empty");
  const byName = new Map(available.map((arm) => [arm.name, arm]));
  return [...new Set(names)].map((name) => {
    const arm = byName.get(name);
    if (!arm) throw new Error(`trio selected arm is unavailable: ${name}`);
    return arm;
  });
}

function normalizeArmTasks(arms, values) {
  if (values === null || values === undefined) return new Map();
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("trio armTasks must be an object");
  }
  const available = new Set(arms.map((arm) => arm.name));
  const entries = [];
  for (const [name, task] of Object.entries(values)) {
    if (!available.has(name)) throw new Error(`trio arm task targets an unavailable arm: ${name}`);
    entries.push([name, requiredString(task, `trio ${name} task`)]);
  }
  return new Map(entries);
}

function normalizeIntent(value) {
  const intent = String(value ?? "").toLowerCase();
  if (!["advisory", "implementation"].includes(intent)) {
    throw new Error(`invalid trio task intent: ${value}`);
  }
  return intent;
}

function readManifest(directory) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`cannot read trio manifest: ${error.message}`);
  }
  requireManifest(value);
  return value;
}

function requireManifest(value) {
  if (!value || value.schema !== 1 || value.kind !== KIND || typeof value.id !== "string") {
    throw new Error("invalid trio manifest");
  }
}

function modelUsage(model) {
  const keys = [
    "requests",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheHitTokens",
    "cacheMissTokens",
    "costUsd",
  ];
  const out = {};
  try {
    const summary = model.usageSummary?.() ?? {};
    for (const key of keys) {
      const value = Number(summary[key]);
      out[key] = Number.isFinite(value) && value >= 0 ? value : 0;
    }
  } catch {
    for (const key of keys) out[key] = 0;
  }
  return out;
}

function usageDelta(before, after) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, Math.max(0, after[key] - (before[key] ?? 0))]),
  );
}

function trioId() {
  return `${makeStamp()}-${crypto.randomBytes(4).toString("hex")}`;
}

function pad(value) {
  return String(value).padStart(3, "0");
}

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0) / 1000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
    : `${seconds.toFixed(1)}s`;
}

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalString(value) {
  if (value === null || value === undefined || value === false) return null;
  const text = String(value).trim();
  return text || null;
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function isRealDirectory(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isInfrastructureFailure(result) {
  const detail = String(result?.detail ?? "");
  return [
    /\bERR_MODULE_NOT_FOUND\b[\s\S]{0,300}\bCannot find package\b/i,
    /\bMODULE_NOT_FOUND\b[\s\S]{0,300}\bCannot find module ['"][^./][^'"]*['"]/i,
    /\b(?:npm|node|pnpm|yarn|python|pytest): command not found\b/i,
    /\bENOENT\b[\s\S]{0,200}\b(?:npm|node|pnpm|yarn|python|pytest)\b/i,
    /\bnpm error code ENOTCACHED\b/i,
  ].some((pattern) => pattern.test(detail));
}

function firstUsefulLine(value) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:error|cannot find|not found|command not found|ENOTCACHED)/i.test(line))
    ?? lines[0]
    ?? "dependency or toolchain unavailable";
}

function requireDirectory(value, label) {
  const target = path.resolve(requiredString(value, label));
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
  return target;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
