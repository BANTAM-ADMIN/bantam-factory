// A temp directory that cleans itself up when the process exits.
//
// BANTAM leaked 1,306 directories into /tmp over one day's work -- 1,198 of them
// from preview screenshots alone, plus model-preference probes, eval workspaces
// and comparison roots. 49MB, and growing with every run forever.
//
// Deleting at the end of the creating function is not an option: callers read the
// screenshot path AFTER runPreviewSync returns (codex-delegate attaches it as an
// image, preview-review-calibration copies it). The directory has to outlive the
// call and die with the process.
//
// Registered on `exit` rather than a `finally`, because a run killed by the wall
// clock or a capacity error is exactly when scratch accumulates fastest.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pending = new Set();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const sweep = () => {
    for (const dir of pending) {
      // Best effort. A scratch directory that cannot be removed must never
      // change the process's exit status or mask the real error.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    pending.clear();
  };
  // ONLY `exit`, deliberately. run-checkpoint.arm() registers SIGINT/SIGTERM
  // handlers that flush a crash checkpoint and then call process.exit(). Node runs
  // signal handlers in registration order, so a handler here that also exited would
  // race it -- and whichever ran first would terminate the process before the other,
  // silently losing the checkpoint on Ctrl-C.
  //
  // Exiting from any handler still fires `exit`, so the sweep runs after the
  // checkpoint flush rather than instead of it. A process killed with no handler at
  // all skips cleanup, which is exactly the behaviour before this module existed:
  // no regression, and no race with crash recovery.
  process.on("exit", sweep);
}

// Debugging a failed run means reading the workspace it left behind, so cleanup
// has to be escapable. Without this, fixing a leak would have removed the evidence
// trail that found most of today's bugs.
const keepAll = /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_KEEP_SCRATCH ?? ""));

/** mkdtemp that will be removed when this process exits, unless asked to persist. */
export function makeScratchDir(prefix) {
  if (keepAll) return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  install();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  pending.add(dir);
  return dir;
}

/** Drop a directory from cleanup, for a caller that takes ownership of it. */
export function keepScratchDir(dir) {
  pending.delete(dir);
  return dir;
}

/** Visible for tests. */
export function pendingScratchDirs() {
  return [...pending];
}
