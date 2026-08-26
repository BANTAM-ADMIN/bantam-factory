// Run a native Codex or Claude Code delegate against the exact same isolated
// fixture and hidden contract used by BANTAM experiments.
//
// Native CLIs own their internal tool loops. BANTAM still owns the immutable
// source snapshot, candidate bytes, public verifier, hidden grader, scope
// verdict, and durable evidence. This keeps "native was smarter" measurable
// instead of trusting the delegate's final prose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";
import { runContractGrader } from "./contract-grader.js";
import { gradeExpectation, materializeFixtureRepo } from "./fixture-runner.js";
import { runNativeDelegate } from "./native-delegate.js";
import { checkWorkspace, snapshotTree } from "./scope-guard.js";
import { WorkspaceStore } from "./workspace-store.js";

export function isNativeExperimentArm(arm) {
  return arm?.model?.runtime === "native-codex" || arm?.model?.runtime === "native-claude";
}

export async function runNativeFixture({
  dir,
  arm,
  outputDir,
  experiment = null,
  artifactPathLabel = (filePath) => filePath,
  onEvent = () => {},
  runNativeDelegateFn = runNativeDelegate,
  runContractGraderFn = runContractGrader,
} = {}) {
  if (!dir) throw new Error("native fixture directory is required");
  if (!isNativeExperimentArm(arm)) throw new Error("native fixture arm must use native-codex or native-claude");
  if (!outputDir) throw new Error("native fixture output directory is required");

  const fixtureDir = path.resolve(dir);
  const spec = JSON.parse(fs.readFileSync(path.join(fixtureDir, "task.json"), "utf8"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-native-fixture-"));
  const sourceWorkspace = path.join(scratch, "source");
  const candidateWorkspace = path.join(scratch, "candidate");
  fs.mkdirSync(sourceWorkspace, { recursive: true });

  try {
    materializeFixtureRepo(fixtureDir, spec, sourceWorkspace);
    const before = snapshotTree(sourceWorkspace);
    const provider = arm.model.runtime === "native-claude" ? "claude" : "codex";
    const delegate = await runNativeDelegateFn({
      provider,
      workspace: sourceWorkspace,
      task: spec.task,
      model: arm.model.name,
      effort: arm.model.effort ?? "high",
      ...(provider === "claude"
        ? { permissionMode: arm.model.permissionMode ?? "acceptEdits" }
        : { bypassSandbox: Boolean(arm.model.bypassSandbox) }),
      verificationScript: spec.verify ?? null,
      timeoutMs: arm.model.timeoutMs ?? 900_000,
      verifyTimeoutMs: arm.model.verifyTimeoutMs ?? 120_000,
      stateRoot: path.resolve(outputDir),
      onEvent: (record) => onEvent(record?.event ?? record),
    });
    const artifact = delegate.artifact;
    const store = new WorkspaceStore(artifact.storeRoot);
    store.materialize(artifact.candidate.commit, candidateWorkspace);
    copyRuntimeDependencies(sourceWorkspace, candidateWorkspace);

    const integrity = checkWorkspace(before, candidateWorkspace, spec);
    const contract = await runContractGraderFn({
      fixtureDir,
      workspace: candidateWorkspace,
      timeoutMs: spec.contractTimeoutMs,
    });
    const publicStatus = artifact.verification?.status ?? artifact.result?.status ?? "unverified";
    const publicPass = artifact.verification?.pass ?? artifact.result?.pass ?? false;
    let status = publicPass ? "pass" : publicStatus;
    if (status === "pass" && contract && !contract.pass) status = `contract-${contract.status}`;
    if (!integrity.clean) status = "cheated";
    if (status !== "pass" && integrity.clean && nativeSandboxFailed(artifact)) {
      status = "native-sandbox-error";
    }

    const expectation = gradeExpectation(spec.expect, { status, publicStatus, contract });
    if (expectation) {
      if (expectation.met) status = "pass";
      else if (status === "pass") status = "expectation-miss";
    }

    // Preserve the delegate's own public verdict, then make the top-level result
    // reflect BANTAM's independent hidden/scope grading. Comparison tools that
    // read the artifact therefore cannot accidentally award a doctored green.
    artifact.publicResult = artifact.result;
    artifact.experiment = experiment;
    artifact.independentEvaluation = {
      fixture: spec.name,
      publicStatus,
      publicPass,
      expectation: expectation ?? null,
      contract,
      integrity,
      seedApplied: false,
    };
    artifact.result = { status, pass: status === "pass" };
    writeJsonAtomic(delegate.artifactPath, artifact);

    const usage = artifact.usage ?? {};
    return {
      name: spec.name,
      status,
      publicStatus,
      publicPass,
      expectation: expectation ?? null,
      turns: finite(usage.turns),
      requests: finite(usage.turns),
      inputTok: finite(usage.inputTokens),
      outputTok: finite(usage.outputTokens),
      cacheHitTok: finite(usage.cachedInputTokens),
      cacheMissTok: finite(usage.cacheMissTokens),
      reasoningTok: finite(usage.reasoningOutputTokens),
      costUsd: finite(usage.costUsd),
      nativeProvider: provider,
      nativeRuntime: arm.model.runtime,
      contractStatus: contract?.status ?? null,
      contractTests: contract?.tests ?? null,
      contractPassed: contract?.passed ?? null,
      contractFailed: contract?.failed ?? null,
      contractDurationMs: contract?.durationMs ?? null,
      scopeViolations: integrity.violations.length,
      scopeViolationDetails: integrity.violations,
      durationMs: finite(artifact.execution?.durationMs) + finite(contract?.durationMs),
      turnLimit: spec.maxTurns ?? 30,
      artifactPath: artifactPathLabel(delegate.artifactPath),
      runArtifactIntegrityStatus: "not-applicable",
      invalid: 0,
      protocolViolations: 0,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nativeSandboxFailed(artifact) {
  const evidence = `${artifact?.execution?.stderr ?? ""}\n${artifact?.finalMessage ?? ""}`;
  return /(?:bwrap|bubblewrap).*(?:RTM_NEWADDR|operation not permitted)|fs sandbox helper failed/i.test(evidence);
}

function copyRuntimeDependencies(source, destination) {
  const from = path.join(source, "node_modules");
  const to = path.join(destination, "node_modules");
  if (fs.statSync(from, { throwIfNoEntry: false })?.isDirectory() && !fs.existsSync(to)) {
    fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
  }
}
