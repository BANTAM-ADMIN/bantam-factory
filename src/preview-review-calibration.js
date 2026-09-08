import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { describeImageWithCodex } from "./logic/vision.js";
import { previewVisionPrompt, runPreviewSync } from "./logic/preview.js";

const DEFAULT_MODELS = [
  { name: "gpt-5.6-terra", effort: "medium" },
  { name: "gpt-5.6-sol", effort: "high" },
];

// The preview runner's default browser budget (25s) is tuned for the
// interactive operator loop, where a human is waiting on one page. Calibration
// is a batch evidence run over a whole manifest, and it inherited that budget.
// Measured on CI 2026-09-08: a cold shared runner spent 26.6s on a one-element
// page, wrote no PNG, and the run failed on a missing screenshot.
const CALIBRATION_PREVIEW_TIMEOUT_MS = 75000;

/** Browser budget for one calibration case, overridable for slow hosts. */
export function calibrationPreviewTimeoutMs(env = process.env) {
  const raw = String(env?.BANTAM_CALIBRATION_PREVIEW_TIMEOUT_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return CALIBRATION_PREVIEW_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : CALIBRATION_PREVIEW_TIMEOUT_MS;
}

// A calibration that produced no pixels used to report one sentence naming the
// case and nothing else, so a timeout, a crashed browser and a missing binary
// all read identically. The runner already computes why; quote it back.
function describeMissingScreenshot(report, timeoutMs) {
  const reasons = [];
  if (report?.browserTimedOut) reasons.push(`the browser ran out of time after ${timeoutMs} ms`);
  if (report?.screenshotCaptureTimedOut) reasons.push("the screenshot capture ran out of time");
  const exitCode = Number(report?.browserExit);
  if (Number.isInteger(exitCode) && exitCode !== 0) {
    const tail = String(report?.browserStderrTail ?? "").trim();
    reasons.push(`the browser exited non-zero (exit ${exitCode})${tail ? `: ${tail}` : ""}`);
  }
  if (!reasons.length) {
    reasons.push(`the browser reported no failure within its ${timeoutMs} ms budget, so the page rendered no pixels`);
  }
  return reasons.join("; ");
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function classifyPreviewReview(text) {
  const match = String(text ?? "").match(/\bRESULT\s*:\s*(REPAIR|CLEAR)\b/i);
  return match ? match[1].toLowerCase() : "invalid";
}

export function scorePreviewReviewRows(rows, models = DEFAULT_MODELS) {
  return models.map((model) => {
    const selected = rows.filter((row) => row.model === model.name);
    const positives = selected.filter((row) => row.expected === "repair");
    const negatives = selected.filter((row) => row.expected === "clear");
    const correct = selected.filter((row) => row.correct).length;
    return {
      model: model.name,
      effort: model.effort,
      cases: selected.length,
      correct,
      accuracy: selected.length ? correct / selected.length : null,
      truePositives: positives.filter((row) => row.observed === "repair").length,
      falseNegatives: positives.filter((row) => row.observed !== "repair").length,
      trueNegatives: negatives.filter((row) => row.observed === "clear").length,
      falsePositives: negatives.filter((row) => row.observed !== "clear").length,
      invalid: selected.filter((row) => row.observed === "invalid").length,
      inputTokens: selected.reduce((sum, row) => sum + Number(row.usage?.inputTokens ?? 0), 0),
      outputTokens: selected.reduce((sum, row) => sum + Number(row.usage?.outputTokens ?? 0), 0),
      reasoningTokens: selected.reduce((sum, row) => sum + Number(row.usage?.reasoningTokens ?? 0), 0),
      durationMs: selected.reduce((sum, row) => sum + Number(row.durationMs ?? 0), 0),
    };
  });
}

export async function runPreviewReviewCalibration({
  manifestPath,
  outputRoot,
  models = DEFAULT_MODELS,
  reviewer = codexReviewer,
  preview = runPreviewSync,
  previewTimeoutMs = calibrationPreviewTimeoutMs(),
  onEvent = () => {},
} = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestBytes = fs.readFileSync(resolvedManifest);
  const manifest = normalizeManifest(JSON.parse(manifestBytes));
  const workspace = path.dirname(resolvedManifest);
  const destination = path.resolve(outputRoot);
  const screenshotRoot = path.join(destination, "screenshots");
  fs.mkdirSync(screenshotRoot, { recursive: true });
  const archivedManifest = path.join(destination, "manifest.json");
  writeTextAtomic(archivedManifest, manifestBytes.toString("utf8"));

  const evidence = {
    schema: 1,
    kind: "bantam-preview-review-calibration",
    name: manifest.name,
    status: "running",
    startedAt: new Date().toISOString(),
    manifest: {
      path: "manifest.json",
      sha256: sha256(manifestBytes),
    },
    models: models.map((model) => ({ ...model })),
    cases: [],
    rows: [],
    scores: [],
  };
  const evidencePath = path.join(destination, "evidence.json");

  for (const specimen of manifest.cases) {
    const report = preview(workspace, specimen.entry, { timeoutMs: previewTimeoutMs });
    if (!report.screenshotBytes || !report.screenshot) {
      throw new Error(`calibration screenshot missing for ${specimen.id}: ${describeMissingScreenshot(report, previewTimeoutMs)}`);
    }
    const screenshotName = `${specimen.id}.png`;
    const screenshotPath = path.join(screenshotRoot, screenshotName);
    fs.copyFileSync(report.screenshot, screenshotPath);
    const screenshotBytes = fs.readFileSync(screenshotPath);
    const prompt = previewVisionPrompt(specimen.task, { taskAware: true });
    evidence.cases.push({
      id: specimen.id,
      entry: specimen.entry,
      expected: specimen.expected,
      task: specimen.task,
      screenshot: path.relative(destination, screenshotPath),
      screenshotSha256: sha256(screenshotBytes),
      screenshotBytes: screenshotBytes.length,
      promptSha256: sha256(prompt),
    });

    for (const model of models) {
      onEvent({ type: "review_started", case: specimen.id, model: model.name });
      const startedAt = Date.now();
      let usage = null;
      let output = "";
      let error = null;
      try {
        const result = await reviewer({
          screenshotPath,
          prompt,
          specimen,
          model,
          workspace,
          onUsage(value) { usage = value; },
        });
        output = String(result?.output ?? result ?? "").trim();
        usage ??= result?.usage ?? null;
      } catch (caught) {
        error = String(caught?.message ?? caught).slice(0, 1000);
      }
      const observed = error ? "invalid" : classifyPreviewReview(output);
      const row = {
        case: specimen.id,
        model: model.name,
        effort: model.effort,
        expected: specimen.expected,
        observed,
        correct: observed === specimen.expected,
        output,
        error,
        usage,
        durationMs: Date.now() - startedAt,
      };
      evidence.rows.push(row);
      evidence.scores = scorePreviewReviewRows(evidence.rows, models);
      writeJsonAtomic(evidencePath, evidence);
      onEvent({ type: "review_finished", ...row });
    }
  }

  evidence.status = "complete";
  evidence.completedAt = new Date().toISOString();
  evidence.scores = scorePreviewReviewRows(evidence.rows, models);
  evidence.strict = evidence.scores.every((score) =>
    score.cases === manifest.cases.length
      && score.correct === score.cases
      && score.invalid === 0);
  writeJsonAtomic(evidencePath, evidence);
  return { evidence, evidencePath };
}

export function auditPreviewReviewCalibration(evidencePath) {
  const resolved = path.resolve(evidencePath);
  const root = path.dirname(resolved);
  const evidence = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const failures = [];
  if (evidence?.kind !== "bantam-preview-review-calibration") failures.push("unexpected evidence kind");
  let manifest = null;
  const manifestFile = path.resolve(root, String(evidence?.manifest?.path ?? ""));
  if (path.relative(root, manifestFile).startsWith("..")) {
    failures.push("manifest escapes evidence root");
  } else if (!fs.existsSync(manifestFile)) {
    failures.push("manifest missing");
  } else {
    const bytes = fs.readFileSync(manifestFile);
    if (sha256(bytes) !== evidence?.manifest?.sha256) failures.push("manifest hash mismatch");
    try {
      manifest = normalizeManifest(JSON.parse(bytes));
    } catch (error) {
      failures.push(`manifest invalid: ${String(error.message ?? error)}`);
    }
  }
  const manifestCases = new Map((manifest?.cases ?? []).map((item) => [item.id, item]));
  for (const specimen of evidence?.cases ?? []) {
    const contract = manifestCases.get(specimen.id);
    if (!contract) {
      failures.push(`${specimen.id}: absent from archived manifest`);
    } else {
      if (contract.entry !== specimen.entry
          || contract.expected !== specimen.expected
          || contract.task !== specimen.task) {
        failures.push(`${specimen.id}: archived contract mismatch`);
      }
      const prompt = previewVisionPrompt(contract.task, { taskAware: true });
      if (sha256(prompt) !== specimen.promptSha256) {
        failures.push(`${specimen.id}: prompt hash mismatch`);
      }
    }
    const screenshot = path.resolve(root, specimen.screenshot);
    if (path.relative(root, screenshot).startsWith("..")) {
      failures.push(`${specimen.id}: screenshot escapes evidence root`);
      continue;
    }
    if (!fs.existsSync(screenshot)) {
      failures.push(`${specimen.id}: screenshot missing`);
      continue;
    }
    if (sha256(fs.readFileSync(screenshot)) !== specimen.screenshotSha256) {
      failures.push(`${specimen.id}: screenshot hash mismatch`);
    }
  }
  for (const row of evidence?.rows ?? []) {
    const observed = row.error ? "invalid" : classifyPreviewReview(row.output);
    if (observed !== row.observed) failures.push(`${row.case}/${row.model}: observed verdict mismatch`);
    if ((observed === row.expected) !== row.correct) failures.push(`${row.case}/${row.model}: correctness mismatch`);
  }
  const recomputed = scorePreviewReviewRows(evidence?.rows ?? [], evidence?.models ?? []);
  if (JSON.stringify(recomputed) !== JSON.stringify(evidence?.scores ?? [])) {
    failures.push("aggregate score mismatch");
  }
  const expectedRows = (manifest?.cases?.length ?? 0) * (evidence?.models?.length ?? 0);
  if ((evidence?.rows?.length ?? 0) !== expectedRows) failures.push("incomplete model/case matrix");
  return {
    status: failures.length ? "fail" : "pass",
    failures,
    rows: evidence?.rows?.length ?? 0,
    scores: recomputed,
  };
}

async function codexReviewer({ screenshotPath, prompt, model, workspace, onUsage }) {
  const output = await describeImageWithCodex(screenshotPath, prompt, {
    workspace,
    model: model.name,
    effort: model.effort,
    purpose: "preview_review_calibration",
    onExternalUsage: (usage) => onUsage(usage),
  });
  return { output };
}

function normalizeManifest(value) {
  if (value?.schema !== 1 || !Array.isArray(value.cases) || !value.cases.length) {
    throw new Error("preview review calibration manifest must contain schema 1 cases");
  }
  const ids = new Set();
  return {
    name: String(value.name ?? "preview-review-calibration"),
    cases: value.cases.map((item) => {
      const id = String(item?.id ?? "");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) {
        throw new Error(`invalid or duplicate calibration case id: ${id}`);
      }
      ids.add(id);
      const expected = String(item.expected ?? "").toLowerCase();
      if (!["repair", "clear"].includes(expected)) {
        throw new Error(`${id}: expected must be repair or clear`);
      }
      const entry = String(item.entry ?? "");
      if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
        throw new Error(`${id}: entry must stay inside the calibration workspace`);
      }
      return { id, entry, expected, task: String(item.task ?? "") };
    }),
  };
}
