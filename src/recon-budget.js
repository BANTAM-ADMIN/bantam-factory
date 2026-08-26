// Repo-scaled recon allowances. The interactive recon limit and the
// autonomous progress-nudge threshold were tuned on small fixtures (a handful
// of files), where a long read streak really is a spiral. On a real codebase
// the same thresholds punish legitimate orientation: the 2026-07-13
// self-hosting run was pushed toward editing long before it had located the
// integration seams of a 15k-line CLI. Scale the allowances with source-file
// count — unchanged on fixture-sized repos, roomier on real ones. An explicit
// env override always wins.

export function scaledReconLimit(base, sourceFiles) {
  return scale(base, sourceFiles, { perFiles: 8, maxExtra: 26 });
}

export function scaledProgressNudgeAfter(base, sourceFiles) {
  return scale(base, sourceFiles, { perFiles: 15, maxExtra: 12 });
}

function scale(base, sourceFiles, { perFiles, maxExtra }) {
  const files = Number.isFinite(sourceFiles) ? sourceFiles : 0;
  if (files <= 30) return base; // fixture territory: measured defaults stand
  const extra = Math.min(maxExtra, Math.floor((files - 30) / perFiles));
  return base + extra;
}
