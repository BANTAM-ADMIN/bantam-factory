// Feature-integration steering. Observed failure (2026-07-13 self-hosting
// run): asked to add a subcommand to its own 15k-line CLI, the model read the
// main file front-to-back in 200-line keyholes, wrote the new module before
// locating the dispatch seams, then spent 60+ turns wiring blind. The cloud
// arms both located the seams FIRST by symbol search and landed the wiring in
// a handful of edits. This steer names that method up front on tasks that
// look like feature-integration on a codebase big enough for it to matter.

const FEATURE_VERB = /\b(add|implement|build|create|introduce|wire|extend|support)\b/i;
const INTEGRATION_TARGET = /\b(sub)?command\b|\bcli\b|\bmode\b|\bflag\b|\bendpoint\b|\bfeature\b|\bapi\b|\btool\b|\baction\b|\boption\b/i;

export function decideSeamSteer(task, { largeRepo = false } = {}) {
  if (!largeRepo) return { enabled: false, reason: "small-repo" };
  const text = String(task ?? "").replace(/\s+/g, " ");
  if (!FEATURE_VERB.test(text) || !INTEGRATION_TARGET.test(text)) {
    return { enabled: false, reason: "no-integration-signal" };
  }
  return { enabled: true, reason: "feature-integration-on-large-repo" };
}

export const SEAM_STEER_TIP = `\nTip: this task adds a feature to an existing codebase. Before creating any new file, find the integration seams BY SYMBOL: search for where existing commands/exports/options are registered (the dispatch table, the arg parser, the help text), read exactly those regions, and list every place the new feature must touch. New code that is not wired into those seams cannot pass; wiring found late costs many edits.`;
