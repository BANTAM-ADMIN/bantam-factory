import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_STATUS_LINES = 200;

// The pin answers ONE question: which HARNESS fought. Scope every probe to
// the paths that ARE the harness. Measured (not-fastest audit, 2026-08-25):
// the unscoped pin cost 3,447ms of every run's teardown — inside every filed
// fight wall — walking and fingerprinting the whole checkout, and unrelated
// working-tree churn (a co-resident project's WIP) polluted dirtyHash, so
// "dirty" said nothing about the harness that actually ran.
const HARNESS_PATHSPEC = ["--", "bin", "src", "test", "package.json", "package-lock.json"];

export function captureHarnessState(root = process.cwd()) {
  const repoRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
  const sha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const statusText = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", ...HARNESS_PATHSPEC]);
  const status = statusText.split(/\r?\n/).filter(Boolean);
  const worktreeDiff = git(repoRoot, ["diff", "--binary", "--full-index", "--no-ext-diff", ...HARNESS_PATHSPEC]);
  const stagedDiff = git(repoRoot, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", ...HARNESS_PATHSPEC]);
  const untracked = untrackedFileFingerprints(repoRoot);
  const dirty = status.length > 0;
  const dirtyPayload = {
    status,
    worktreeDiffSha256: sha256(worktreeDiff),
    stagedDiffSha256: sha256(stagedDiff),
    untracked,
  };

  return {
    schema: 1,
    scope: "harness",   // status/diff/untracked probes are pathspec-scoped; sha is whole-repo
    sha,
    dirty,
    dirtyHash: dirty ? sha256(JSON.stringify(dirtyPayload)) : null,
    statusSha256: sha256(statusText),
    worktreeDiffSha256: sha256(worktreeDiff),
    stagedDiffSha256: sha256(stagedDiff),
    untrackedSha256: sha256(JSON.stringify(untracked)),
    status: status.slice(0, MAX_STATUS_LINES),
    statusTruncated: status.length > MAX_STATUS_LINES,
  };
}

export function emptyHarnessState() {
  return {
    schema: 1,
    sha: null,
    dirty: null,
    dirtyHash: null,
    statusSha256: null,
    worktreeDiffSha256: null,
    stagedDiffSha256: null,
    untrackedSha256: null,
    status: [],
    statusTruncated: false,
  };
}

function untrackedFileFingerprints(repoRoot) {
  const raw = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...HARNESS_PATHSPEC]);
  return raw.split("\0")
    .filter(Boolean)
    .sort()
    .map((rel) => {
      const abs = path.join(repoRoot, rel);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        return { path: rel, status: "missing" };
      }
      if (!st.isFile()) return { path: rel, status: "non-file" };
      return {
        path: rel,
        bytes: st.size,
        sha256: sha256(fs.readFileSync(abs)),
      };
    });
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: args.includes("-z") ? "buffer" : "utf8",
    maxBuffer: 50 * 1024 * 1024,
  }).toString("utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
