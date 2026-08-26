// Final workspace diff capture for eval artifacts.
//
// Eval workspaces are temporary copies, not Git checkouts. To make the final
// mutation auditable, we initialize a throwaway Git repo after copying the
// pristine fixture, commit the baseline locally, then diff the worktree before
// cleanup.

import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const DEFAULT_MAX_DIFF_BYTES = 200_000;

export function prepareDiffBaseline(workspace, { skipIfRepo = false } = {}) {
  // `bantam run` points at a real working tree at least as often as a scratch
  // copy, and this function COMMITS. Callers that hand it a pristine fixture
  // want the baseline unconditionally (codex-delegate, trio-session); a caller
  // that may be looking at someone's repository asks to be skipped instead.
  // captureFinalDiff still works there — it diffs against whatever HEAD is.
  if (skipIfRepo && fs.existsSync(`${workspace}/.git`)) {
    // Ours or theirs? A repo WE made is identified by the marker commit; in
    // that one case, advancing the baseline is safe and makes each sequential
    // run's finalDiff per-run instead of cumulative-since-first-run — the
    // workday replay's request 4 carried a 273-line "new file" diff for a run
    // that made no edits. Anything else stays untouched, as the tests demand.
    let mine = false;
    try {
      mine = runGit(workspace, ["log", "-1", "--format=%s"]).trim() === "__bantam_baseline__";
    } catch { /* unreadable repo — treat as theirs */ }
    if (!mine) return { status: "skipped", reason: "workspace is already a git repository" };
    try {
      runGit(workspace, ["add", "-A"]);
      runGit(workspace, [
        "-c", "user.name=Bantam", "-c", "user.email=bantam@example.invalid",
        "commit", "--allow-empty", "--no-gpg-sign", "-qm", "__bantam_baseline__",
      ]);
      return { status: "prepared" };
    } catch (e) {
      return { status: "unavailable", reason: cleanError(e) };
    }
  }
  try {
    runGit(workspace, ["init", "-q"]);
    fs.appendFileSync(`${workspace}/.git/info/exclude`, [
      "",
      "node_modules/",
      ".pytest_cache/",
      "__pycache__/",
      "*.pyc",
      "coverage/",
      "",
    ].join("\n"));
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, [
      "-c", "user.name=Bantam",
      "-c", "user.email=bantam@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-qm",
      "__bantam_baseline__",
    ]);
    return { status: "prepared" };
  } catch (e) {
    return { status: "unavailable", reason: cleanError(e) };
  }
}

export function captureFinalDiff(workspace, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  if (!fs.existsSync(`${workspace}/.git`)) {
    return { status: "unavailable", reason: "diff baseline was not prepared" };
  }

  try {
    // Intent-to-add makes newly-created files appear in the normal worktree diff.
    runGit(workspace, ["add", "-N", "."]);
    const diff = runGit(workspace, [
      "diff",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD",
      "--",
      ".",
    ]);
    const bytes = Buffer.byteLength(diff, "utf8");
    const truncated = bytes > maxBytes;
    const files = changedFilesFromDiff(diff);
    return {
      format: "git-unified-diff",
      status: "captured",
      truncated,
      bytes,
      sha256: hashText(diff),
      files,
      fileCount: files.length,
      text: truncated ? truncateUtf8(diff, maxBytes) : diff,
    };
  } catch (e) {
    return { status: "unavailable", reason: cleanError(e) };
  }
}

export function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function changedFilesFromDiff(diff) {
  const files = [];
  const seen = new Set();
  for (const line of String(diff ?? "").split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      ?? /^diff --git ("a\/.*") ("b\/.*")$/.exec(line);
    if (!match) continue;
    const file = stripPrefix(unquoteGitPath(match[2]), "b/");
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function runGit(workspace, args) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function truncateUtf8(text, maxBytes) {
  const clipped = Buffer.from(text, "utf8")
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8");
  return `${clipped}\n... (diff truncated)\n`;
}

function cleanError(e) {
  const detail = e.stderr || e.message || String(e);
  return String(detail).trim().split("\n")[0] || "unknown git error";
}

function unquoteGitPath(pathText) {
  if (!pathText.startsWith('"')) return pathText;
  try {
    return JSON.parse(pathText);
  } catch {
    return pathText.slice(1, -1);
  }
}

function stripPrefix(text, prefix) {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
