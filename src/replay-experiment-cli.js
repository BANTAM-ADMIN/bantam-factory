import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { actionGrammar } from "./grammar.js";
import { ModelClient, detectEndpoint } from "./model.js";
import {
  formatReplayExperimentSummary,
  normalizeReplayExperimentSpec,
  runReplayExperiment,
} from "./replay-experiment.js";
import { replayRuntimeOptions } from "./replay.js";
import { auditReplayExperimentEvidence } from "./replay-experiment-audit.js";
import { buildReplayExperimentPreflight } from "./replay-experiment-preflight.js";

export async function runReplayExperimentCli({
  specPath,
  output,
  endpoint,
  maxCalls,
  studyRoots,
  requireNewDesign = false,
  onProgress = () => {},
} = {}) {
  if (!specPath) throw new Error("a replay experiment spec file is required");
  const preflight = buildReplayExperimentPreflight({
    specPath,
    endpoint,
    maxCalls,
    studyRoots,
    requireNewDesign,
  });
  if (preflight.status !== "ready") {
    throw new Error(preflight.failures.join("; "));
  }
  const resolvedSpecPath = path.resolve(specPath);
  const rawSpecBytes = fs.readFileSync(resolvedSpecPath);
  const spec = normalizeReplayExperimentSpec(JSON.parse(rawSpecBytes));
  const artifactPath = path.resolve(path.dirname(resolvedSpecPath), spec.artifact);
  const artifactBytes = fs.readFileSync(artifactPath);
  const artifact = JSON.parse(artifactBytes);
  const outputDir = path.resolve(output ?? defaultOutputDir(spec.name));
  const archivedSpec = {
    ...spec,
    artifact: portableReplayArtifactPath(outputDir, artifactPath),
  };
  const runtimeOptions = replayRuntimeOptions(artifact, {
    transportOverride: Boolean(endpoint),
  });
  const recordedCodex = runtimeOptions.codex === true;
  const resolvedEndpoint = endpoint
    || (recordedCodex
      ? artifact.modelCalls?.find((call) =>
          String(call?.request?.url ?? "").startsWith("codex-app-server://"))
        ?.request?.url
      : null)
    || artifact.endpoint
    || await detectEndpoint();
  const client = new ModelClient({
    endpoint: resolvedEndpoint,
    profile: artifact.sampling?.profile,
    ...runtimeOptions,
  });

  let evidence;
  try {
    evidence = await runReplayExperiment({
      spec: archivedSpec,
      artifact,
      artifactPath: archivedSpec.artifact,
      artifactSha256: sha256(artifactBytes),
      ask: async (replay, meta) => {
        onProgress(meta);
        const capturedCodex = String(replay.request?.url ?? "").startsWith("codex-app-server://");
        const canReplayRequest = replay.request && !(endpoint && capturedCodex);
        if (canReplayRequest) {
          const request = endpoint
            ? { ...replay.request, url: `${resolvedEndpoint.replace(/\/$/, "")}/completion` }
            : replay.request;
          return client.completeRequest(request);
        }
        return client.complete(replay.prompt, {
          grammar: actionGrammar(),
          nPredict: 1024,
          seed: Number.isFinite(artifact.sampling?.seed)
            ? artifact.sampling.seed + meta.sample
            : undefined,
        });
      },
    });
  } finally {
    client.close();
  }

  const audit = auditReplayExperimentEvidence(evidence, { artifactBytes });
  if (audit.status !== "pass") {
    throw new Error(`generated replay evidence failed self-audit: ${audit.failures.join("; ")}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  writeJsonAtomic(path.join(outputDir, "spec.json"), evidence.spec);
  writeJsonAtomic(path.join(outputDir, "evidence.json"), evidence);
  writeTextAtomic(
    path.join(outputDir, "summary.md"),
    `${formatReplayExperimentSummary(evidence)}\n`,
  );
  writeJsonAtomic(path.join(outputDir, "audit.json"), audit);
  return {
    evidence,
    outputDir,
    summary: formatReplayExperimentSummary(evidence),
    exitCode: ["supported", "supported-unpaired"].includes(evidence.totals.verdict) ? 0 : 1,
  };
}

export function portableReplayArtifactPath(outputDir, artifactPath) {
  const relative = path.relative(path.resolve(outputDir), path.resolve(artifactPath));
  if (!relative) throw new Error("replay artifact must be a file, not the evidence directory");
  return relative.split(path.sep).join("/");
}

function defaultOutputDir(name) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return path.join(".bantam", "replay-experiments", `${stamp}-${slug || "replay"}`);
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temp, value, { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
