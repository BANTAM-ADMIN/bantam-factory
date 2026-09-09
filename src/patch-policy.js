const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * Decide whether the model should see the atomic patch action for this task.
 *
 * Local `auto` routing is deliberately conservative: patch can encourage
 * costly overreach when several failures share one coupled state bug. Codex
 * receives the guarded action from the start; explicit settings take priority.
 */
import { decideSeamSteer } from "./seam-steer.js";

export function decidePatchAction(task, setting = false, { largeRepo = false, codex = false } = {}) {
  const mode = normalizePatchActionMode(setting);
  if (mode === "on") return decision(mode, true, "forced-on");
  if (mode === "off") return decision(mode, false, "configured-off");

  // The local-model routing below deliberately limits batching. Codex can
  // select a bounded edit set without that task-shape heuristic. Hiding patch
  // made the snapshot extension spend five requests on separate replacements;
  // every member of a patch still passes the ordinary edit and scope gates.
  if (codex) return decision(mode, true, "auto-codex-edit-batching");

  const text = String(task ?? "").replace(/\s+/g, " ").trim();
  if (isMechanicalConsistencyTask(text)) {
    return decision(mode, true, "auto-mechanical-consistency");
  }
  if (isIndependentMultiFileTask(text)) {
    return decision(mode, true, "auto-independent-multifile");
  }
  if (isBoundedMultiFileRepair(text)) {
    return decision(mode, true, "auto-bounded-multifile-repair");
  }
  // Feature integration on a real codebase is patch's shape: several small
  // coordinated edits (dispatch entry, import, help text) that land together
  // or not at all. Observed cost of withholding it (self-hosting v5): one
  // one-line replace per model turn for wiring the same seams the seam steer
  // had already identified.
  if (decideSeamSteer(task, { largeRepo }).enabled) {
    return decision(mode, true, "auto-feature-integration");
  }
  return decision(mode, false, "auto-no-high-confidence-signal");
}

export function normalizePatchActionMode(setting) {
  if (setting === true) return "on";
  if (setting === false || setting === null || setting === undefined) return "off";
  const value = String(setting).trim().toLowerCase();
  if (value === "auto") return "auto";
  if (ON_VALUES.has(value)) return "on";
  if (OFF_VALUES.has(value)) return "off";
  throw new TypeError(`invalid patch action mode: ${setting}`);
}

function isMechanicalConsistencyTask(text) {
  const mechanicalChange = /\b(?:rename|renamed|renaming|migrate|migrated|migration|replace)\b/i.test(text)
    || /\b(?:consistently|uniformly)\s+use\b/i.test(text)
    || /\b(?:single|one)\s+(?:correct(?:ly)?[- ]spelled|consistent)\s+(?:name|helper|symbol|term)\b/i.test(text);
  const repositoryScope = /\b(?:whole|entire)\s+(?:codebase|repository|repo|project)\b/i.test(text)
    || /\b(?:across|throughout)\s+(?:the\s+)?(?:codebase|repository|repo|project|multiple files|source files|every (?:module|adapter|file))\b/i.test(text)
    || /\b(?:everywhere|all\s+(?:occurrences|callers|imports|uses|usages|references|files|modules|adapters)|every\s+(?:file|module|adapter))\b/i.test(text);
  return mechanicalChange && repositoryScope;
}

function isIndependentMultiFileTask(text) {
  const independentChanges = /\b(?:two|2|multiple|several)\s+(?:separate|independent|unrelated)\s+(?:bugs?|defects?|issues?|changes?|edits?|fixes?)\b/i.test(text);
  const multipleFiles = /\b(?:different|separate|multiple)\s+(?:source\s+)?files\b/i.test(text)
    || /\bacross\s+(?:different\s+)?(?:source\s+)?files\b/i.test(text);
  return independentChanges && multipleFiles;
}

function isBoundedMultiFileRepair(text) {
  return /(?:\bbugs?\b|\bbug\(s\))[\s\S]{0,180}\bsrc\/[a-z0-9_./-]+\s+and\/or\s+src\/[a-z0-9_./-]+/i.test(text);
}

function decision(mode, enabled, reason) {
  return Object.freeze({ mode, enabled, reason });
}
