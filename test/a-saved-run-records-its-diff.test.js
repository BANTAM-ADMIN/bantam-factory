import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { prepareDiffBaseline, captureFinalDiff } from "../src/diff.js";

// Every artifact from `bantam run --save-run` carried `finalDiff: null`. The
// machinery exists and works on a workspace with no git in it — prepareDiffBaseline
// inits a throwaway repo and commits a baseline — but the run path never called
// it, so the single most useful record of what a run PRODUCED was absent from
// every stored artifact.
//
// It cost real work twice on 2026-08-17: diagnosing tb29 and tb30 meant
// reconstructing the change from edit actions and reading the live workspace,
// which only worked because those workspaces happened to still exist on disk.
//
// The one thing this must never do is commit to a repository someone cares
// about. `bantam run` points at a real working tree as often as a scratch copy.

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-diff-"));
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a workspace with no git gets a baseline and a readable diff", (t) => {
  const dir = scratch(t);
  assert.equal(prepareDiffBaseline(dir, { skipIfRepo: true }).status, "prepared");
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(dir, "added.js"), "export const extra = true;\n");
  const diff = captureFinalDiff(dir);
  assert.equal(diff.status, "captured", JSON.stringify(diff));
  assert.match(diff.text, /-export const value = 1/, "the change is legible");
  assert.match(diff.text, /\+export const value = 2/);
  assert.match(diff.text, /added\.js/, "and a new file is in it");
});

test("an existing repository is never committed to", (t) => {
  const dir = scratch(t);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.name=T", "-c", "user.email=t@e.invalid", "commit", "--allow-empty", "--no-gpg-sign", "-qm", "theirs");
  const before = git("rev-parse", "HEAD").trim();
  const log = git("log", "--oneline").trim().split("\n").length;

  const result = prepareDiffBaseline(dir, { skipIfRepo: true });
  assert.equal(result.status, "skipped", JSON.stringify(result));
  assert.equal(git("rev-parse", "HEAD").trim(), before, "HEAD must not move");
  assert.equal(git("log", "--oneline").trim().split("\n").length, log, "no commit added");
});

test("a diff is still captured against the repository's own HEAD", (t) => {
  const dir = scratch(t);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=T", "-c", "user.email=t@e.invalid", "commit", "--no-gpg-sign", "-qm", "theirs");
  prepareDiffBaseline(dir, { skipIfRepo: true });
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 3;\n");
  const diff = captureFinalDiff(dir);
  assert.equal(diff.status, "captured", JSON.stringify(diff));
  assert.match(diff.text, /\+export const value = 3/, "skipping the baseline does not cost the diff");
});

test("without the opt-in the old behaviour is unchanged", (t) => {
  // codex-delegate and trio-session prepare baselines on pristine copies and
  // must keep committing them.
  const dir = scratch(t);
  assert.equal(prepareDiffBaseline(dir).status, "prepared");
});

// Sequential runs on one workspace: run 1 creates the throwaway baseline repo,
// and skipIfRepo then made every later run diff against the ORIGINAL seed — so
// request 4 of the workday replay carried a finalDiff showing joblog.js as a
// new 273-line file when that run had made no edits at all. Per-run attribution
// is the point of the field.
//
// The baseline advances only in a repo WE created, identified by the
// __bantam_baseline__ marker commit. A user's own repository keeps the
// untouched guarantee proven by the tests above.
test("sequential runs each diff against their own start", (t) => {
  const dir = scratch(t);
  assert.equal(prepareDiffBaseline(dir, { skipIfRepo: true }).status, "prepared");
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 2;\n");
  assert.match(captureFinalDiff(dir).text, /value = 2/, "run 1 sees its change");

  // run 2 begins: same call the run path makes
  const second = prepareDiffBaseline(dir, { skipIfRepo: true });
  assert.equal(second.status, "prepared", `ours should advance: ${JSON.stringify(second)}`);
  const clean = captureFinalDiff(dir);
  assert.ok(!/value = 2/.test(clean.text ?? ""), "run 1's change is baseline now");
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 3;\n");
  const diff2 = captureFinalDiff(dir);
  assert.match(diff2.text, /-export const value = 2/, "run 2 diffs against run 1's end");
  assert.match(diff2.text, /\+export const value = 3/);
});
