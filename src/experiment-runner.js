import fs from "node:fs";
import path from "node:path";
import { fetchModelId } from "./artifact.js";
import { writeJsonAtomic } from "./atomic-file.js";
import {
  checkpointExperiment,
  createExperimentManifest,
  normalizeExperimentSpec,
  saveExperimentSummary,
  slugify,
} from "./experiment.js";
import { prepareExperimentResume } from "./experiment-resume.js";
import { deriveEscalationDecision } from "./escalation-policy.js";
import { runFixture } from "./fixture-runner.js";
import { writeExperimentTrajectoryAudit } from "./trajectory-audit.js";
import {
  isNativeExperimentArm,
  runNativeFixture,
} from "./native-fixture-runner.js";

// An arm's skills field becomes a RETRIEVAL-ONLY config: distillation during an
// experiment would append to the library mid-run and leak learned lessons across
// arms and rounds, so it is forced off here regardless of what interactive use does.
export function armSkillsConfig(arm, { defaultLibrary = path.resolve("skills", "library.jsonl") } = {}) {
  if (!arm?.skills) return null;
  const library = arm.skills.library ? path.resolve(arm.skills.library) : defaultLibrary;
  return { library, retrieve: true, distill: false, language: null };
}

export async function runExperiment({
  spec: rawSpec,
  fixtures,
  outputDir,
  harnessGit = null,
  promotionBinding = null,
  sourceSpec = null,
  invocation = null,
  resume = false,
  id = null,
  startedAt = new Date().toISOString(),
  createModel,
  onEvent = () => {},
  onRunStart = () => {},
  onRunComplete = () => {},
  fetchModelIdFn = fetchModelId,
  runFixtureFn = runFixture,
  runNativeFixtureFn = runNativeFixture,
} = {}) {
  const spec = normalizeExperimentSpec(rawSpec);
  validateResolvedFixtures(fixtures, spec);
  if (spec.arms.some((arm) => !isNativeExperimentArm(arm)) && typeof createModel !== "function") {
    throw new Error("experiment createModel callback is required for non-native arms");
  }
  const destination = path.resolve(outputDir);
  const manifestPath = path.join(destination, "manifest.json");
  const summaryPath = path.join(destination, "summary.md");
  const ledgerPath = path.join(destination, "ledger.jsonl");
  let manifest;
  if (resume) {
    manifest = prepareExperimentResume({
      destination,
      spec,
      fixtures,
      harnessGit,
      promotionBinding,
      invocation,
      resumedAt: startedAt,
    });
    persist(manifestPath, summaryPath, manifest);
  } else {
    ensureEmptyOutputDirectory(destination);
    manifest = createExperimentManifest({
      spec,
      id,
      startedAt,
      harnessGit,
      promotionBinding,
    });
    manifest.sourceSpec = sourceSpec;
    manifest.outputDir = destination;
    manifest.invocation = invocation;
    writeJsonAtomic(path.join(destination, "spec.json"), spec);
    persist(manifestPath, summaryPath, manifest);
  }

  const arms = new Map(spec.arms.map((arm) => [arm.name, arm]));
  const modelIds = new Map();
  for (const entry of manifest.schedule) {
    if (entry.modelId) modelIds.set(entry.arm, entry.modelId);
  }
  let anyNonPass = manifest.schedule.some((entry) => (entry.runs ?? []).some((row) => row.status !== "pass"));
  let infrastructureFailure = false;
  let stoppedEarly = false;

  for (const entry of manifest.schedule) {
    if (stoppedEarly || infrastructureFailure) break;
    if (entry.status === "complete") continue;
    const arm = arms.get(entry.arm);
    const fixtureStart = entry.runs.length;
    if (fixtureStart >= fixtures.length) {
      entry.status = "complete";
      persist(manifestPath, summaryPath, manifest);
      continue;
    }
    entry.status = "running";
    entry.startedAt = new Date().toISOString();
    persist(manifestPath, summaryPath, manifest);
    const entryStart = Date.now();
    let activeModel = null;

    try {
      await withEnvironment(arm.env, async () => {
        if (isNativeExperimentArm(arm)) {
          entry.effectiveModel = {
            runtime: arm.model.runtime,
            model: arm.model.name,
            reasoningEffort: arm.model.effort ?? "high",
          };
          entry.modelId = arm.model.name;
          modelIds.set(arm.name, arm.model.name);
          persist(manifestPath, summaryPath, manifest);

          for (let fixtureIndex = fixtureStart; fixtureIndex < fixtures.length; fixtureIndex++) {
            const fixture = fixtures[fixtureIndex];
            onRunStart({ entry, arm, fixture });
            let row;
            try {
              row = await runNativeFixtureFn({
                dir: fixture.dir,
                arm,
                outputDir: path.join(
                  destination,
                  "runs",
                  arm.name,
                  `round-${String(entry.round).padStart(2, "0")}`,
                ),
                experiment: {
                  id: manifest.id,
                  name: manifest.name,
                  arm: arm.name,
                  round: entry.round,
                  sequence: entry.sequence,
                  seed: entry.seed,
                },
                artifactPathLabel: (filePath) => relativePosix(destination, filePath),
                onEvent,
              });
            } catch (error) {
              row = errorRow(fixture, error);
              infrastructureFailure = true;
            }
            annotateEscalation(row, { manifest, arm, fixture });
            entry.runs.push(row);
            anyNonPass ||= row.status !== "pass";
            onRunComplete({ entry, arm, fixture, row });
            persist(manifestPath, summaryPath, manifest);
            if (spec.stopOnFailure && row.status !== "pass") {
              stoppedEarly = true;
              break;
            }
            if (infrastructureFailure) break;
          }
          return;
        }

        let model = await createModel(arm, modelContext(entry, fixtures[fixtureStart], fixtureStart));
        activeModel = model;
        if (!model || typeof model.health !== "function") throw new Error(`arm ${arm.name} did not create a valid model client`);
        if (!(await model.health())) throw new Error(`model is unreachable for arm ${arm.name} at ${model.endpoint ?? "unknown endpoint"}`);
        entry.effectiveModel = typeof model.metadata === "function" ? model.metadata() : null;
        if (!modelIds.has(arm.name)) {
          modelIds.set(
            arm.name,
            entry.effectiveModel?.runtime === "codex"
              ? entry.effectiveModel.model
              : await fetchModelIdFn(model.endpoint),
          );
        }
        entry.modelId = modelIds.get(arm.name);
        persist(manifestPath, summaryPath, manifest);

        for (let fixtureIndex = fixtureStart; fixtureIndex < fixtures.length; fixtureIndex++) {
          const fixture = fixtures[fixtureIndex];
          if (fixtureIndex > fixtureStart) {
            model?.close?.();
            model = await createModel(arm, modelContext(entry, fixture, fixtureIndex));
            activeModel = model;
          }
          onRunStart({ entry, arm, fixture });
          let row;
          try {
            row = await runFixtureFn({
              dir: fixture.dir,
              model,
              thinkMode: spec.thinkMode,
              planMode: spec.planMode,
              preGate: spec.preGate,
              skills: armSkillsConfig(arm),
              onEvent,
              captureArtifact: true,
              harnessGitState: harnessGit,
              modelId: entry.modelId,
              experiment: {
                id: manifest.id,
                name: manifest.name,
                arm: arm.name,
                round: entry.round,
                sequence: entry.sequence,
                seed: entry.seed,
              },
              artifactPathForRun: ({ runId, spec: fixtureSpec }) => path.join(
                destination,
                "runs",
                arm.name,
                `round-${String(entry.round).padStart(2, "0")}`,
                `${slugify(fixtureSpec.name)}-${runId}.json`,
              ),
              artifactPathLabel: (filePath) => relativePosix(destination, filePath),
              ledgerPath,
              ledgerArtifactPath: (filePath) => relativePosix(destination, filePath),
              onArtifactPrepared: ({ runId, stamp, artifactPath }) => {
                entry.inFlight = {
                  fixture: fixture.name,
                  runId,
                  stamp,
                  artifactPath,
                  seed: entry.seed,
                };
                persist(manifestPath, summaryPath, manifest);
              },
            });
          } catch (error) {
            row = errorRow(fixture, error);
            infrastructureFailure = true;
          }
          annotateEscalation(row, { manifest, arm, fixture });
          entry.runs.push(row);
          if (row.status !== "error") entry.inFlight = null;
          anyNonPass ||= row.status !== "pass";
          onRunComplete({ entry, arm, fixture, row });
          persist(manifestPath, summaryPath, manifest);
          if (spec.stopOnFailure && row.status !== "pass") {
            stoppedEarly = true;
            break;
          }
          if (infrastructureFailure) break;
        }
      });
      entry.status = infrastructureFailure ? "failed" : stoppedEarly ? "stopped" : "complete";
    } catch (error) {
      infrastructureFailure = true;
      anyNonPass = true;
      entry.status = "failed";
      entry.error = error.message;
      manifest.error ??= error.message;
    } finally {
      activeModel?.close?.();
      entry.completedAt = new Date().toISOString();
      entry.durationMs = Date.now() - entryStart;
      persist(manifestPath, summaryPath, manifest);
    }
  }

  manifest.completedAt = new Date().toISOString();
  manifest.status = infrastructureFailure
    ? "failed"
    : stoppedEarly ? "stopped"
      : anyNonPass ? "complete_with_failures" : "complete";
  persist(manifestPath, summaryPath, manifest);
  try {
    manifest.trajectoryAudit = writeExperimentTrajectoryAudit(destination, manifest);
  } catch (error) {
    manifest.trajectoryAudit = { status: "error", error: String(error?.message ?? error).slice(0, 500) };
  }
  persist(manifestPath, summaryPath, manifest);
  return {
    manifest,
    manifestPath,
    summaryPath,
    ledgerPath,
    exitCode: infrastructureFailure || anyNonPass ? 1 : 0,
  };
}

export async function withEnvironment(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function persist(manifestPath, summaryPath, manifest) {
  checkpointExperiment(manifestPath, manifest);
  saveExperimentSummary(summaryPath, manifest);
}

function validateResolvedFixtures(fixtures, spec) {
  if (!Array.isArray(fixtures) || fixtures.length !== spec.fixtures.length) {
    throw new Error("resolved experiment fixtures do not match the spec");
  }
  for (const fixture of fixtures) {
    if (!fixture?.dir || !fixture?.name) throw new Error("resolved fixture requires dir and name");
  }
}

function ensureEmptyOutputDirectory(outputDir) {
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
    throw new Error(`experiment output directory is not empty: ${outputDir}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
}

function relativePosix(root, filePath) {
  return path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
}

function modelContext(entry, fixture, fixtureIndex) {
  return {
    round: entry.round,
    sequence: entry.sequence,
    seed: entry.seed,
    fixture,
    fixtureIndex,
  };
}

function errorRow(fixture, error) {
  return {
    name: fixture.name,
    status: "error",
    turns: 0,
    thinkPhases: 0,
    genTok: 0,
    thinkTok: 0,
    actionTok: 0,
    thinkTokenBudget: null,
    invalid: 0,
    protocolViolations: 0,
    duplicateActionRejections: 0,
    duplicateShellRejections: 0,
    immutableEditRejections: 0,
    shellScopeRollbacks: 0,
    shellScopeViolationFiles: 0,
    noOpEdits: 0,
    repeatEscapeMasks: 0,
    patchActions: 0,
    patchFailures: 0,
    patchActionMode: "off",
    patchActionAvailable: false,
    patchActionReason: null,
    deleteFileActions: 0,
    moveFileActions: 0,
    fileOperationFailures: 0,
    fileOperationMode: "off",
    fileOperationAvailable: false,
    fileOperationReason: null,
    scopeViolations: 0,
    durationMs: 0,
    artifactPath: null,
    error: error.message,
  };
}

function annotateEscalation(row, { manifest, arm, fixture }) {
  const prior = [];
  for (const scheduled of manifest.schedule ?? []) {
    if (scheduled.arm !== arm.name) continue;
    for (const attempt of scheduled.runs ?? []) {
      if (attempt.name === fixture.name) prior.push(attempt);
    }
  }
  const runtime = arm.model?.runtime ?? "local";
  const stage = runtime === "local" || runtime === "api" ? "local" : "delegate";
  row.escalation = deriveEscalationDecision({
    attempts: [...prior, { ...row, stage }],
  });
}
