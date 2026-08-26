// Promotion evidence gate. CLAUDE.md: "move `regular` only after the
// comparison clears its declared bar." Before this module the bar lived in
// prose — `channel promote` was an unconditioned ref move. The bar here is
// deliberately minimal (a cleanly completed experiment whose candidate does
// not regress the reference); promoting on anything weaker must be said out
// loud with --allow-unevidenced, which the channel event records.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  buildExperimentSchedule,
  hashJson,
  normalizeExperimentPromotionBinding,
  normalizeExperimentSpec,
  summarizeExperiment,
} from "./experiment.js";
import {
  enabledOptInGateChanges,
  optInEnabled,
} from "./logic/gate-rejection-counts.js";

export class EvidenceError extends Error {}

export function validatePromotionEvidence(evidencePath, {
  arm,
  sourceChannel = null,
  candidateVersionRef = null,
  versionRef = null,
  workspaceCommit = null,
  workspaceTree = null,
  version = null,
  harnessRoot = process.cwd(),
} = {}) {
  const file = resolveManifestPath(evidencePath);
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = fs.readFileSync(file);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new EvidenceError(`cannot read experiment manifest ${file}: ${error.message}`);
  }
  if (manifest?.schema !== 1 || manifest?.kind !== "bantam-experiment") {
    throw new EvidenceError("promotion evidence is not a supported Bantam experiment manifest");
  }
  if (!["complete", "complete_with_failures"].includes(manifest.status)) {
    throw new EvidenceError(
      `experiment ${manifest.id ?? file} did not finish every scheduled run (status: ${manifest.status ?? "missing"}); ` +
      "resume or rerun it, or promote with --allow-unevidenced",
    );
  }

  const spec = validateSpec(file, manifest);
  validateSchedule(manifest, spec);
  const recomputedTotals = summarizeExperiment({ spec, schedule: manifest.schedule });
  const persistedTotals = backfillLegacyGateTotals(manifest.totals, recomputedTotals, manifest.schedule);
  if (!isDeepStrictEqual(persistedTotals, recomputedTotals)) {
    throw new EvidenceError("experiment totals do not match the persisted schedule; evidence may be stale or tampered");
  }

  const totals = recomputedTotals;
  const arms = totals.arms;
  const reference = totals.reference;
  const armNames = Object.keys(arms);
  const candidate = arm ?? (armNames.length === 2 ? armNames.find((name) => name !== reference) : undefined);
  if (!candidate || !arms[candidate]) {
    throw new EvidenceError(`cannot identify the candidate arm (arms: ${armNames.join(", ") || "none"}); pass --arm NAME`);
  }
  const declaredCandidate = declaredCandidateArm(manifest);
  if (declaredCandidate !== null && declaredCandidate !== candidate) {
    throw new EvidenceError(
      `manifest candidate arm "${declaredCandidate}" does not match selected arm "${candidate}"`,
    );
  }
  if (candidate === reference) throw new EvidenceError("candidate arm must differ from the reference arm");
  const expectedSamples = totals.expectedTasksPerArm;
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) {
    throw new EvidenceError("experiment has zero expected samples per arm");
  }
  for (const name of [reference, candidate]) {
    const samples = arms[name]?.tasks;
    if (!Number.isInteger(samples) || samples <= 0) {
      throw new EvidenceError(`arm "${name}" has zero completed samples`);
    }
    if (samples !== expectedSamples) {
      throw new EvidenceError(
        `arm "${name}" has ${samples} sample(s), expected ${expectedSamples}; experiment evidence is incomplete`,
      );
    }
  }
  if (arms[candidate].passed <= 0) {
    throw new EvidenceError(`candidate arm "${candidate}" has no passing samples`);
  }
  if ((arms[candidate].scopeViolations ?? 0) > 0 || (arms[candidate].cheated ?? 0) > 0) {
    throw new EvidenceError(`candidate arm "${candidate}" has scope/integrity violations`);
  }
  if ((arms[candidate].errored ?? 0) > 0) {
    throw new EvidenceError(`candidate arm "${candidate}" contains infrastructure errors`);
  }
  const comparison = (totals.comparisons ?? []).find((row) => row.arm === candidate && row.reference === reference);
  if (!comparison) throw new EvidenceError(`manifest has no ${candidate}-vs-${reference} comparison`);
  const passed = comparison.delta?.passed;
  const passRate = comparison.delta?.passRate;
  if (!Number.isFinite(passed) || !Number.isFinite(passRate)) {
    throw new EvidenceError("comparison lacks numeric pass deltas; regenerate the manifest");
  }
  if (passed < 0 || passRate < 0) {
    throw new EvidenceError(
      `candidate "${candidate}" does not clear the bar vs "${reference}": pass delta ${passed}, pass-rate delta ${passRate}`,
    );
  }
  const attribution = validatePromotionAttribution(spec, totals, candidate, reference);

  const expectedVersionRef = candidateVersionRef
    ?? versionRef
    ?? version?.versionRef
    ?? null;
  const expectedWorkspaceTree = workspaceTree
    ?? version?.workspaceTree
    ?? version?.value?.workspaceTree
    ?? null;
  const expectedWorkspaceCommit = workspaceCommit
    ?? version?.workspaceCommit
    ?? version?.value?.workspaceCommit
    ?? null;
  const binding = validateVersionBinding({
    manifest,
    file,
    expectedVersionRef,
    expectedWorkspaceCommit,
    expectedWorkspaceTree,
    sourceChannel,
    harnessRoot,
  });

  return {
    manifest: file,
    manifestSha256: sha256(manifestBytes),
    experimentId: manifest.id ?? null,
    specSha256: manifest.specSha256,
    candidate,
    reference,
    sourceChannel,
    candidateVersionRef: binding.candidateVersionRef,
    workspaceCommit: binding.workspaceCommit,
    workspaceTree: binding.workspaceTree,
    harness: binding.harness,
    delta: { passed, passRate },
    attribution,
    arms: {
      [candidate]: armView(arms[candidate]),
      [reference]: armView(arms[reference]),
    },
  };
}

export function validatePromotionAttribution(spec, totals, candidate, reference = totals?.reference) {
  const referenceArm = spec?.arms?.find((arm) => arm.name === reference);
  const candidateArm = spec?.arms?.find((arm) => arm.name === candidate);
  const changes = enabledOptInGateChanges(referenceArm, candidateArm).map((change) => ({
    ...change,
    rejections: totals?.arms?.[candidate]?.gateRejections?.[change.gate] ?? 0,
  }));
  if (
    !optInEnabled(referenceArm?.env?.BANTAM_VISUAL_COMPLETION_AUDIT)
    && optInEnabled(candidateArm?.env?.BANTAM_VISUAL_COMPLETION_AUDIT)
  ) {
    changes.push({
      env: "BANTAM_VISUAL_COMPLETION_AUDIT",
      gate: "visual_completion_audit",
      rejections: totals?.arms?.[candidate]?.visualCompletionAuditRevisions ?? 0,
    });
  }
  if (
    !optInEnabled(referenceArm?.env?.BANTAM_LEXICAL_CONTRACT_AUDIT)
    && optInEnabled(candidateArm?.env?.BANTAM_LEXICAL_CONTRACT_AUDIT)
  ) {
    changes.push({
      env: "BANTAM_LEXICAL_CONTRACT_AUDIT",
      gate: "lexical_contract_audit",
      rejections: totals?.arms?.[candidate]?.lexicalContractAuditHints ?? 0,
    });
  }
  if (
    !optInEnabled(referenceArm?.env?.BANTAM_VISUAL_ALT_COVERAGE)
    && optInEnabled(candidateArm?.env?.BANTAM_VISUAL_ALT_COVERAGE)
  ) {
    changes.push({
      env: "BANTAM_VISUAL_ALT_COVERAGE",
      gate: "visual_alt_coverage",
      rejections: totals?.arms?.[candidate]?.visualAltCoverageRevisions ?? 0,
    });
  }
  const inactive = changes.filter((change) => change.rejections === 0);
  if (inactive.length) {
    const detail = inactive.map((change) => `${change.env} (${change.gate})`).join(", ");
    throw new EvidenceError(
      `candidate "${candidate}" enabled ${detail} but recorded zero interventions; `
      + "its outcome delta is non-attributable to the candidate mechanism",
    );
  }
  return changes;
}

function backfillLegacyGateTotals(stored, recomputed, schedule) {
  if (!stored || typeof stored !== "object") return stored;
  const hasRowGateMaps = (schedule ?? []).some((entry) => (entry.runs ?? [])
    .some((row) => Object.prototype.hasOwnProperty.call(row, "gateRejections")));
  const scalarFields = [
    "lexicalContractAuditHints",
    "visualCompletionAuditHints",
    "visualCompletionAuditRevisions",
    "visualAltCoverageHints",
    "visualAltCoverageRevisions",
  ];
  const rowHasField = Object.fromEntries(scalarFields.map((field) => [
    field,
    (schedule ?? []).some((entry) => (entry.runs ?? [])
      .some((row) => Object.prototype.hasOwnProperty.call(row, field))),
  ]));
  if (hasRowGateMaps && scalarFields.every((field) => rowHasField[field])) return stored;

  const copy = structuredClone(stored);
  for (const [arm, totals] of Object.entries(recomputed.arms ?? {})) {
    if (!copy.arms?.[arm]) continue;
    if (!hasRowGateMaps && !Object.prototype.hasOwnProperty.call(copy.arms[arm], "gateRejections")) {
      copy.arms[arm].gateRejections = structuredClone(totals.gateRejections ?? {});
    }
    for (const field of scalarFields) {
      if (!rowHasField[field] && !Object.prototype.hasOwnProperty.call(copy.arms[arm], field)) {
        copy.arms[arm][field] = totals[field] ?? 0;
      }
    }
  }
  return copy;
}

function armView(row) {
  return { tasks: row?.tasks ?? null, passed: row?.passed ?? null, passRate: row?.passRate ?? null };
}

function validateSpec(file, manifest) {
  let spec;
  try {
    spec = normalizeExperimentSpec(manifest.spec);
  } catch (error) {
    throw new EvidenceError(`experiment manifest has an invalid spec: ${error.message}`);
  }
  const computed = hashJson(spec);
  if (typeof manifest.specSha256 !== "string" || manifest.specSha256 !== computed) {
    throw new EvidenceError("experiment spec hash does not match manifest.spec; evidence may be stale or tampered");
  }

  const specFile = path.join(path.dirname(file), "spec.json");
  if (!fs.existsSync(specFile)) {
    throw new EvidenceError("promotion evidence is missing its persisted spec.json");
  }
  let stored;
  try {
    stored = normalizeExperimentSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
  } catch (error) {
    throw new EvidenceError(`cannot validate persisted experiment spec ${specFile}: ${error.message}`);
  }
  if (hashJson(stored) !== computed || !isDeepStrictEqual(stored, spec)) {
    throw new EvidenceError("persisted spec.json does not match the experiment manifest");
  }
  return spec;
}

function validateSchedule(manifest, spec) {
  const expected = buildExperimentSchedule(spec);
  const actual = manifest.schedule;
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new EvidenceError(
      `experiment schedule has ${Array.isArray(actual) ? actual.length : 0} entries, expected ${expected.length}`,
    );
  }
  for (let index = 0; index < expected.length; index++) {
    const row = actual[index];
    const planned = expected[index];
    if (
      row?.sequence !== planned.sequence
      || row?.round !== planned.round
      || row?.arm !== planned.arm
      || row?.seed !== planned.seed
    ) {
      throw new EvidenceError(`experiment schedule entry ${index} does not match the preregistered spec`);
    }
    if (row.status !== "complete") {
      throw new EvidenceError(
        `experiment schedule entry ${index} is not complete (status: ${row.status ?? "missing"})`,
      );
    }
    if (!Array.isArray(row.runs) || row.runs.length !== spec.fixtures.length) {
      throw new EvidenceError(
        `experiment schedule entry ${index} has ${Array.isArray(row.runs) ? row.runs.length : 0} sample(s), expected ${spec.fixtures.length}`,
      );
    }
    for (let fixtureIndex = 0; fixtureIndex < spec.fixtures.length; fixtureIndex++) {
      const run = row.runs[fixtureIndex];
      if (!fixtureRunMatchesSpec(run?.name, spec.fixtures[fixtureIndex])) {
        throw new EvidenceError(
          `experiment schedule entry ${index} sample ${fixtureIndex} does not match fixture "${spec.fixtures[fixtureIndex]}"`,
        );
      }
      if (typeof run.status !== "string" || !run.status || run.status === "error") {
        throw new EvidenceError(
          `complete experiment schedule entry ${index} contains a non-terminal or infrastructure-error sample`,
        );
      }
    }
    if (row.error != null || row.inFlight != null) {
      throw new EvidenceError(`complete experiment schedule entry ${index} retains error or in-flight state`);
    }
  }
}

/**
 * Experiment specs retain the operator's requested fixture path while run rows
 * retain the resolved task name. Catalog paths use their final directory as
 * that name, so promotion validation must compare the same identity shape the
 * runner emits instead of requiring a path string to equal a task name.
 */
export function fixtureRunMatchesSpec(runName, requestedFixture) {
  if (typeof runName !== "string" || !runName) return false;
  if (typeof requestedFixture !== "string" || !requestedFixture) return false;
  if (runName === requestedFixture) return true;
  const normalized = requestedFixture.replaceAll("\\", "/").replace(/\/+$/, "");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename !== "" && runName === basename;
}

function declaredCandidateArm(manifest) {
  if (typeof manifest.candidateArm === "string") return manifest.candidateArm;
  if (typeof manifest.candidate === "string") return manifest.candidate;
  if (typeof manifest.promotion?.candidate === "string") return manifest.promotion.candidate;
  return null;
}

function validateVersionBinding({
  manifest,
  file,
  expectedVersionRef,
  expectedWorkspaceCommit,
  expectedWorkspaceTree,
  sourceChannel,
  harnessRoot,
}) {
  if (!expectedVersionRef || !expectedWorkspaceTree) {
    throw new EvidenceError(
      "promotion validation requires the exact candidate version ref and workspace tree",
    );
  }
  let pinnedPromotion = null;
  if (manifest.promotion !== undefined) {
    try {
      pinnedPromotion = normalizeExperimentPromotionBinding(manifest.promotion);
    } catch (error) {
      throw new EvidenceError(`experiment has an invalid pinned promotion binding: ${error.message}`);
    }
    if (manifest.candidateVersionRef !== undefined || manifest.workspaceTree !== undefined) {
      throw new EvidenceError("experiment mixes pinned and legacy promotion bindings");
    }
    if (sourceChannel !== null && pinnedPromotion.channel !== sourceChannel) {
      throw new EvidenceError(
        `evidence source channel ${pinnedPromotion.channel} does not match promotion source ${sourceChannel}`,
      );
    }
  }
  const declaredVersionRef = pinnedPromotion?.candidateVersionRef
    ?? manifest.candidateVersionRef
    ?? null;
  const declaredWorkspaceTree = pinnedPromotion?.workspaceTree
    ?? manifest.workspaceTree
    ?? null;
  const hasExplicitBinding = declaredVersionRef !== null || declaredWorkspaceTree !== null;
  if (hasExplicitBinding) {
    if (typeof declaredVersionRef !== "string" || typeof declaredWorkspaceTree !== "string") {
      throw new EvidenceError(
        "explicit promotion binding requires both candidateVersionRef and workspaceTree",
      );
    }
    if (declaredVersionRef !== expectedVersionRef) {
      throw new EvidenceError(
        `evidence candidate version ${declaredVersionRef} does not match promoted version ${expectedVersionRef}`,
      );
    }
    if (declaredWorkspaceTree !== expectedWorkspaceTree) {
      throw new EvidenceError(
        `evidence workspace tree ${declaredWorkspaceTree} does not match promoted tree ${expectedWorkspaceTree}`,
      );
    }
    if (
      pinnedPromotion
      && (
        typeof expectedWorkspaceCommit !== "string"
        || pinnedPromotion.workspaceCommit !== expectedWorkspaceCommit
      )
    ) {
      throw new EvidenceError(
        `evidence workspace commit ${pinnedPromotion.workspaceCommit} does not match promoted commit ${expectedWorkspaceCommit ?? "missing"}`,
      );
    }
    return {
      candidateVersionRef: expectedVersionRef,
      workspaceCommit: pinnedPromotion?.workspaceCommit ?? null,
      workspaceTree: expectedWorkspaceTree,
      harness: {
        binding: pinnedPromotion ? "pinned-channel-version-tree" : "explicit-version-tree",
        gitSha: manifest.harnessGit?.sha ?? null,
        ...(pinnedPromotion ? {
          channel: pinnedPromotion.channel,
          laneId: pinnedPromotion.laneId,
          workspaceCommit: pinnedPromotion.workspaceCommit,
        } : {}),
      },
    };
  }

  const harnessGit = manifest.harnessGit;
  if (
    !harnessGit
    || harnessGit.dirty !== false
    || typeof harnessGit.sha !== "string"
    || !/^[a-f0-9]{40,64}$/.test(harnessGit.sha)
  ) {
    throw new EvidenceError(
      "evidence has no exact version/tree binding and is not from a resolvable clean harness; use --allow-unevidenced",
    );
  }
  const resolved = resolveHarnessTree({
    sha: harnessGit.sha,
    expectedWorkspaceTree,
    manifest,
    manifestFile: file,
    harnessRoot,
  });
  if (!resolved) {
    throw new EvidenceError(
      `clean harness ${harnessGit.sha} cannot be resolved to promoted tree ${expectedWorkspaceTree}; use --allow-unevidenced`,
    );
  }
  return {
    candidateVersionRef: expectedVersionRef,
    workspaceCommit: null,
    workspaceTree: expectedWorkspaceTree,
    harness: {
      binding: "clean-git-tree",
      gitSha: harnessGit.sha,
      gitRoot: resolved.gitRoot,
      workspace: resolved.workspace,
    },
  };
}

function resolveHarnessTree({
  sha,
  expectedWorkspaceTree,
  manifest,
  manifestFile,
  harnessRoot,
}) {
  const starts = [
    harnessRoot,
    resolveOptionalPath(manifest.sourceSpec, path.dirname(manifestFile)),
    path.dirname(manifestFile),
  ].filter(Boolean);
  const checked = new Set();
  for (const start of starts) {
    let cursor;
    try {
      const stat = fs.statSync(start);
      cursor = stat.isDirectory() ? path.resolve(start) : path.dirname(path.resolve(start));
    } catch {
      continue;
    }
    let gitRoot;
    try {
      gitRoot = execFileSync("git", ["-C", cursor, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue;
    }
    while (cursor === gitRoot || cursor.startsWith(gitRoot + path.sep)) {
      const key = `${gitRoot}\0${cursor}`;
      if (!checked.has(key)) {
        checked.add(key);
        const rel = path.relative(gitRoot, cursor).split(path.sep).join("/");
        const treeish = rel ? `${sha}:${rel}` : `${sha}^{tree}`;
        try {
          const tree = execFileSync("git", ["-C", gitRoot, "rev-parse", treeish], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (tree === expectedWorkspaceTree) {
            return { gitRoot, workspace: cursor };
          }
        } catch {
          // This commit may not contain this subtree; keep walking upward.
        }
      }
      if (cursor === gitRoot) break;
      cursor = path.dirname(cursor);
    }
  }
  return null;
}

function resolveOptionalPath(value, base) {
  if (typeof value !== "string" || !value) return null;
  return path.resolve(base, value);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function resolveManifestPath(evidencePath) {
  const target = path.resolve(String(evidencePath ?? ""));
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new EvidenceError(`evidence path not found: ${target}`);
  }
  return stat.isDirectory() ? path.join(target, "manifest.json") : target;
}
