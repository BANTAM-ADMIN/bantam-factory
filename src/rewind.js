// Rewind a run to ANY turn with the EXACT workspace prepped from that point.
//
// bantam already rewinds the DIALOGUE (`--resume-run <artifact> --through-turn N`).
// The missing half was the WORKSPACE at turn N. The trajectory records every edit
// (write_file content in full, replace old->new), so replaying edits with i <= N
// reconstructs the file state at turn N losslessly — no per-turn snapshots to
// store, and it works for any point in the run. Combine the two and you can jump
// to just before the model went wrong, change one thing, and continue.

/**
 * Reconstruct the workspace file contents as they stood AFTER turn `throughTurn`,
 * by replaying the edit actions in order. Pure; returns { path: content }.
 * Only files the model itself wrote/edited appear here (task inputs like weights
 * are not in the trajectory and are provided by the environment on resume).
 */
export function reconstructWorkspaceAt(artifact, throughTurn = Infinity) {
  const files = new Map();
  const turns = (artifact?.turns ?? [])
    .filter((t) => Number.isFinite(t?.i) && t.i <= throughTurn)
    .sort((a, b) => a.i - b.i);
  for (const t of turns) {
    const a = t.parsedAction ?? {};
    const p = a.p;
    if (a.a === "write_file" && typeof p === "string") {
      files.set(p, a.content ?? "");
    } else if (a.a === "replace" && typeof p === "string" && files.has(p)) {
      // Match bantam's own replace: first occurrence of `old` -> `new`. If `old`
      // is absent (the model's NO_CHANGE case), the file is left untouched.
      const cur = files.get(p);
      if (typeof a.old === "string" && a.old.length && cur.includes(a.old)) {
        files.set(p, cur.replace(a.old, a.new ?? ""));
      }
    }
    // Note: shell heredoc/redirect writes are not replayed here — tasks that build
    // their deliverable via `write_file`/`replace` (the norm) reconstruct exactly;
    // a task that writes source via shell would need those observations parsed too.
  }
  return Object.fromEntries(files);
}

/** One-line-per-turn index for picking a rewind point. */
export function summarizeTurns(artifact) {
  return (artifact?.turns ?? []).map((t) => {
    const a = t.parsedAction ?? {};
    const kind = a.a ?? a.kind ?? "?";
    const target = a.p ?? "";
    const detail = a.c ?? a.old ?? "";
    const obs = typeof t.observation === "string" ? t.observation : "";
    const ok = /error|fail|no_change|exit [1-9]|segmentation|139/i.test(obs) ? "✗" : " ";
    return {
      i: t.i,
      kind,
      target,
      ok,
      note: String(detail).replace(/\s+/g, " ").slice(0, 60),
      obs: obs.replace(/\s+/g, " ").slice(0, 70),
    };
  });
}

/**
 * Build a rewind plan: the reconstructed files at turn N and the exact command to
 * continue from there. Does not touch disk — the caller writes `files` into a
 * workspace and runs `command`.
 */
export function rewindPlan(artifact, throughTurn, { artifactPath = "<run.json>", workspace = "<workspace>" } = {}) {
  const files = reconstructWorkspaceAt(artifact, throughTurn);
  const command =
    `bantam run --resume-run ${artifactPath} --through-turn ${throughTurn} `
    + `--workspace ${workspace} --task "<original task>"`;
  return {
    throughTurn,
    files,
    fileCount: Object.keys(files).length,
    runId: artifact?.runId ?? null,
    totalTurns: (artifact?.turns ?? []).length,
    command,
  };
}
