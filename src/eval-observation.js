// Remove evaluator-only volatility from the observation fed back to the model.
// Full artifacts retain the original observation separately.

export function normalizeEvalObservation(value, { workspace = null } = {}) {
  let text = String(value ?? "");
  if (workspace) text = text.split(String(workspace)).join("<workspace>");
  text = text.replace(/^cwd: .*$/gm, "cwd: <workspace>");
  // Node's TAP reporter has emitted both `duration_ms: 12.3` and
  // `# duration_ms 12.3` across versions. Either spelling is evaluator noise,
  // and leaving the colonless form live made same-seed A/B prompts diverge.
  text = text.replace(/(\bduration_ms:?\s*)\d+(?:\.\d+)?/g, "$1<elapsed>");
  text = text.replace(/(test output digest: preserved tail, clipped )\d+( chars total)/g, "$1<count>$2");
  return text;
}
