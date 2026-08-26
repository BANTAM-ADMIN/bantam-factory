// Run a competitor CLI agent to completion, or give up on it honestly.
//
// `bantam compare` spawned external arms with `stdio: ["pipe", "pipe", "pipe"]`
// and never wrote to or closed that stdin pipe. `codex exec` waits on stdin, so
// the arm blocked forever: measured 2026-07-31, a bare-Codex arm sat for FIFTY
// MINUTES having consumed 0.0 seconds of CPU while the BANTAM arm beside it
// finished the same task in 101 seconds.
//
// That failure is worse than a crash. It looks like the competitor is slow, and a
// head-to-head rendered from it would have reported a ~30x speed advantage that
// was entirely an artifact of our own spawn options. A benchmark that flatters
// the subject through a plumbing bug is not evidence.
//
// So: stdin is closed, every run is bounded, and a run that hits the bound is
// reported as TIMED OUT rather than as a loss.

import { spawn, execFileSync } from "node:child_process";

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, timeoutMs?:number}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number}>}
 */
export function spawnExternalAgent(cmd, args, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env,
      // stdin CLOSED, not an open pipe nobody writes to. An agent CLI that reads
      // stdin otherwise waits forever and looks merely slow.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startMs });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // SIGKILL rather than SIGTERM: an agent CLI that is wedged on input is not
      // going to handle a polite signal.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, Math.max(1, timeoutMs));
    // Never hold the process open just to enforce a bound.
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

// Did the competitor report that it could not START, rather than trying and
// failing? Measured 2026-07-31: a bare-Codex arm returned "I'm blocked by the
// workspace's read-only sandbox ... no files were modified" and was scored 0/4
// against a BANTAM arm's 4/4. The harness had that sentence in captured stdout
// and never looked at it.
//
// An arm that never got to attempt the task is a MISSING OBSERVATION, exactly
// like a run killed by the wall clock. Scoring it as a loss manufactures a win
// for the subject, which is the one failure mode that would discredit every
// honest number in the same table.
const BLOCKED_PATTERNS = [
  /\bread-only sandbox\b/i,
  /\bsandbox\b[^.]{0,80}\b(?:denied|blocked|not permitted|failed)\b/i,
  /\bbwrap\b[^\n]*\b(?:not permitted|failed)\b/i,
  /\bpermission denied\b[^\n]{0,60}\bwrite\b/i,
  // "No source, test, or package files were changed" -- the list between "no"
  // and "files" varies, so anchor on the two ends rather than the literal phrase.
  /\bno\b[^.\n]{0,60}\bfiles?\b[^.\n]{0,40}\bwere (?:changed|modified)\b/i,
  /\bcould(?:n't| not) (?:modify|write to) the workspace\b/i,
];

/**
 * @param {{stdout?:string, stderr?:string}} output
 * @returns {{blocked:boolean, reason:string|null}}
 */
export function detectBlockedAgent({ stdout = "", stderr = "" } = {}) {
  const text = `${stdout}\n${stderr}`;
  for (const pattern of BLOCKED_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) return { blocked: true, reason: hit[0].trim().slice(0, 160) };
  }
  return { blocked: false, reason: null };
}

// Can the OS sandbox the competitor CLI relies on actually start here?
//
// `codex exec` sandboxes model-generated commands with bubblewrap, which needs a
// network namespace, which needs CAP_NET_ADMIN. In a container or a restricted
// shell every command fails with "bwrap: loopback: Failed RTM_NEWADDR: Operation
// not permitted" -- so the competitor never edits a file and scores zero while
// looking like it tried. Measured 2026-07-31: that produced a clean 4/4-to-0/4
// "win" for BANTAM that was entirely an artifact of the environment.
//
// Probing once and saying so beats either silently failing or silently weakening
// the sandbox.
export function osSandboxAvailable(execFile = execFileSync) {
  try {
    execFile("bwrap", ["--dev-bind", "/", "/", "--unshare-net", "true"], {
      stdio: "pipe",
      timeout: 15_000,
    });
    return { available: true, reason: null };
  } catch (error) {
    const detail = `${error?.stderr ?? ""}${error?.message ?? ""}`.trim().slice(0, 160);
    return { available: false, reason: detail || "bwrap probe failed" };
  }
}
