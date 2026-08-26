// Reference-witness: learn from a stronger reference agent.
//
// When a recorded four-arm comparison has a reference arm (claude-code / codex)
// that PASSED a task bantam FAILED, the difference between their final solutions
// is the richest learning signal in the system — a stronger agent's correct answer
// sitting next to bantam's wrong one, on the same task. This turns that divergence
// into a gap with a self-generated, evidence-grounded remedy, for the same
// witness -> replay-score -> promote loop the completeness critic uses.
//
// Pure/injectable so every branch is unit-tested against recorded artifacts —
// no live Claude/Codex/model calls here. See
// docs/superpowers/plans/2026-07-18-reference-witness-plan.md (S1-S5).

import fs from "node:fs";
import path from "node:path";

// Preference order when several reference arms passed: the richer trajectory first.
const REFERENCE_ARMS = ["claude-code", "codex"];

/** A fully clean pass: public green, contract fully green, no scope violations. */
export function armPassed(result) {
  if (!result?.public?.pass) return false;
  const c = result.contract;
  if (!c || c.passed !== c.tests) return false;
  const v = result.scope?.violations;
  const clean = v == null || (Array.isArray(v) ? v.length === 0 : v === 0);
  return clean;
}

/**
 * Find a `reference-passed / bantam-failed` divergence.
 * @param {{bantam?, "claude-code"?, codex?}} arms  map of arm -> result object
 * @returns {{referenceArm, referenceResult, bantamResult} | null}
 */
export function findReferenceDivergence(arms = {}) {
  const bantam = arms.bantam ?? arms["bantam-dev"];
  if (!bantam || armPassed(bantam)) return null; // nothing to learn if bantam passed
  for (const name of REFERENCE_ARMS) {
    if (arms[name] && armPassed(arms[name])) {
      return { referenceArm: name, referenceResult: arms[name], bantamResult: bantam };
    }
  }
  return null;
}

/** A ±window excerpt of `lines` around the 1-based `at` line. */
function excerptAround(lines, at, window = 3) {
  const from = Math.max(0, at - 1 - window);
  const to = Math.min(lines.length, at + window);
  return lines.slice(from, to).join("\n");
}

/**
 * Editable files whose bantam-final content differs from the reference-final one.
 * @param {{bantamFiles:Object, referenceFiles:Object, editable:string[]}} in
 *   *Files are { relpath: content } maps.
 * @returns {Array<{file, firstDiffLine, referenceExcerpt, bantamExcerpt}>}
 */
export function diffSolutions({ bantamFiles = {}, referenceFiles = {}, editable = [] }) {
  const out = [];
  for (const file of editable) {
    const b = bantamFiles[file];
    const r = referenceFiles[file];
    if (b == null || r == null || b === r) continue;
    const bl = b.split("\n");
    const rl = r.split("\n");
    let i = 0;
    while (i < bl.length && i < rl.length && bl[i] === rl[i]) i += 1;
    const firstDiffLine = i + 1; // 1-based; if one is a prefix of the other, this is the divergence point
    out.push({
      file,
      firstDiffLine,
      referenceExcerpt: excerptAround(rl, firstDiffLine),
      bantamExcerpt: excerptAround(bl, firstDiffLine),
    });
  }
  return out;
}

/**
 * Turn diffs into gaps with grounded, gate-voiced remedies.
 * @returns {Array<{kind, target, arm, site:{file,line}, evidence, remedy}>}
 */
export function witnessReferenceGaps({ referenceArm, diffs = [] }) {
  return diffs.map((d) => ({
    kind: "reference-divergence",
    target: d.file,
    arm: referenceArm,
    site: { file: d.file, line: d.firstDiffLine },
    evidence: { referenceExcerpt: d.referenceExcerpt, bantamExcerpt: d.bantamExcerpt },
    remedy:
      `[reference] Your change to ${d.file} is not what the passing ${referenceArm} solution did. `
      + `Around line ${d.firstDiffLine} it wrote:\n${d.referenceExcerpt}\n`
      + `Your version has:\n${d.bantamExcerpt}\n`
      + `You failed the hidden check and ${referenceArm} passed it — examine ${d.file} at line ${d.firstDiffLine} and reconcile toward the reference before finishing.`,
  }));
}

/** Does an action read or edit the file the reference gap points at? */
export function engagesReferenceGap(actionJson, gap) {
  const file = gap?.site?.file ?? gap?.target;
  if (!file) return false;
  let a;
  try { a = typeof actionJson === "string" ? JSON.parse(actionJson) : actionJson; } catch { a = null; }
  if (!a) return false;
  const editVerbs = new Set(["replace", "edit_lines", "write_file", "patch"]);
  if ((a.a === "read_file" || editVerbs.has(a.a)) && a.p === file) return true;
  return false;
}

// --- loading a recorded task run (for the CLI) ---

const ARMS = ["bantam", "bantam-dev", "claude-code", "codex"];

function readJson(fsImpl, file) {
  try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return null; }
}

/** Read a workspace dir into { relpath: content } for the given editable paths only. */
function readEditable(fsImpl, wsDir, editable) {
  const files = {};
  for (const rel of editable) {
    try { files[rel] = fsImpl.readFileSync(path.join(wsDir, rel), "utf8"); } catch { /* absent */ }
  }
  return files;
}

/**
 * Load a recorded comparison task run: per-arm results + editable final trees + the
 * task's editable scope.
 * @param {string} dir  e.g. comparison/runs/2026-07-13/continuity-repair
 * @param {{tasksRoot?, fsImpl?}} opts
 * @returns {{task, editable, arms:{[arm]:result}, trees:{[arm]:files}}}
 */
export function loadTaskRun(dir, { tasksRoot = "comparison/tasks", fsImpl = fs } = {}) {
  const task = path.basename(dir);
  const taskJson = readJson(fsImpl, path.join(tasksRoot, task, "task.json"));
  const editable = Array.isArray(taskJson?.editable) ? taskJson.editable : [];
  const arms = {};
  const trees = {};
  for (const arm of ARMS) {
    const armDir = path.join(dir, arm);
    const result = readJson(fsImpl, path.join(armDir, "result.json"));
    if (!result) continue;
    const key = arm === "bantam-dev" ? "bantam" : arm;
    arms[key] = result;
    trees[key] = readEditable(fsImpl, path.join(armDir, "workspace"), editable);
  }
  return { task, editable, arms, trees };
}

// --- scoring a reference remedy (does surfacing it move bantam toward the fix?) ---

/** Site-relevant engagement signals in one replayed action for a reference gap. */
export function referenceEngagementSignals(output, gap) {
  const file = gap?.site?.file ?? gap?.target;
  const sigs = new Set();
  if (!file) return sigs;
  let a;
  try { a = typeof output === "string" ? JSON.parse((output.match(/\{[^]*\}/) || [output])[0]) : output; } catch { a = null; }
  if (!a) return sigs;
  if (a.a === "read_file" && a.p === file) sigs.add(`read:${file}`);
  if (["replace", "edit_lines", "write_file", "patch"].includes(a.a) && a.p === file) sigs.add(`edit:${file}`);
  if (a.a === "search" && typeof a.q === "string" && a.q.includes(path.basename(file, path.extname(file)))) sigs.add(`search:${file}`);
  return sigs;
}

/**
 * Score whether the reference remedy INTRODUCES a site-relevant engagement the
 * baseline never showed (set difference), same discipline as the completeness
 * scorer. Promote only on a novel signal; no novel signal is inconclusive.
 */
export function scoreReferenceRemedy(baselineOutputs, remedyOutputs, gap) {
  const union = (outs) => { const s = new Set(); for (const o of outs) for (const sig of referenceEngagementSignals(o, gap)) s.add(sig); return s; };
  const base = union(baselineOutputs);
  const rem = union(remedyOutputs);
  const novel = [...rem].filter((sig) => !base.has(sig));
  const rate = (outs) => outs.filter((o) => engagesReferenceGap(o, gap)).length / (outs.length || 1);
  return {
    baseline: { rate: rate(baselineOutputs), n: baselineOutputs.length, signals: [...base] },
    remedy: { rate: rate(remedyOutputs), n: remedyOutputs.length, signals: [...rem] },
    novel,
    verdict: novel.length > 0 ? "promote" : "inconclusive",
  };
}

/** End-to-end: recorded run dir -> reference-divergence gaps (or []). */
export function witnessTaskRun(dir, opts = {}) {
  const { editable, arms, trees } = loadTaskRun(dir, opts);
  const divergence = findReferenceDivergence(arms);
  if (!divergence) return [];
  const diffs = diffSolutions({
    bantamFiles: trees.bantam ?? {},
    referenceFiles: trees[divergence.referenceArm] ?? {},
    editable,
  });
  return witnessReferenceGaps({ referenceArm: divergence.referenceArm, diffs });
}
