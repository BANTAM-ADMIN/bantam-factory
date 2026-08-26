// Eval integrity guard — stop the model from gaming the hidden verifier.
//
// Every fixture's hidden `verify` is a test command. Nothing in the executor
// stops a model from weakening or deleting the failing assertion in the TEST
// file — and the verifier would then happily report PASS. That would make the
// whole benchmark a lie. This guard snapshots the workspace before the run and,
// after it, fails any fixture whose grader (the test files) was tampered with —
// independent of whether the tests then passed.
//
// A violation names what happened, not the worst thing it could have been:
// modifying or deleting a grader is `*-tampering`, creating a file that never
// existed is `*-injection`. Both fail the run; only one of them is tampering.
//
// A fixture may also declare `editable` (an array of path prefixes). If present,
// ANY change outside those prefixes is a scope violation, not just test tampering.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Files that ARE the grader (test sources) — must be byte-identical before/after a
// run. Runner-config files are handled separately (RUNNER_CONFIG_PATTERNS below).
const TEST_PATTERNS = [
  /(^|\/)tests?\//,          // test/ or tests/ directory
  /(^|\/)__tests__\//,
  /(^|\/)conftest\.py$/,     // pytest fixtures can rewrite test behavior
  /(^|\/)test_[^/]+\.py$/,   // pytest test_*.py anywhere
  /[._]test\.[a-z0-9]+$/i,   // foo.test.js / foo.test.mjs
  /_test\.go$/,              // Go test files
  /\.spec\.[a-z0-9]+$/i,     // foo.spec.ts
  // `node --test` (the default framework) ALSO discovers hyphenated and bare forms — its glob runs
  // foo-test.js, test-foo.js, and a plain test.js. Missing these left real tests unclassified, so
  // scoped verification could report a green over an affected test it never ran.
  /-test\.[cm]?[jt]sx?$/i,          // foo-test.js / foo-test.ts
  /(^|\/)test-[^/]*\.[cm]?[jt]sx?$/i, // test-foo.js
  /(^|\/)test\.[cm]?[jt]sx?$/i,     // bare test.js / test.ts
];

// Unambiguous test-runner configuration can silently remove or rewrite the grader
// without touching a test file. Broader manifests like package.json/pyproject.toml
// are intentionally left to fixture `editable` allowlists because they can be
// legitimate source targets.
const RUNNER_CONFIG_PATTERNS = [
  /(^|\/)pytest\.ini$/i,
  /(^|\/)tox\.ini$/i,
  /(^|\/)jest\.config(\.[a-z0-9]+)?$/i,
  /(^|\/)vitest\.config(\.[a-z0-9]+)?$/i,
];

// Package-manager configuration is part of the test oracle whenever the
// verifier is launched through npm/yarn/pnpm. For example, an injected
// `.npmrc` with `script-shell=/bin/true` turns `npm test` into a zero-exit
// no-op without touching package.json or the tests. Yarn plugins/releases and
// pnpm hook/workspace files are executable or can redirect what gets tested,
// so they belong to the same immutable runner-config boundary.
const PACKAGE_MANAGER_CONFIG_PATTERNS = [
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.yarnrc(?:\.ya?ml)?$/i,
  /(^|\/)\.yarn(?:$|\/(?:plugins|releases)(?:\/|$))/i,
  /(^|\/)\.pnp(?:\.loader)?\.(?:cjs|mjs|js)$/i,
  /(^|\/)yarn\.config\.cjs$/i,
  /(^|\/)\.?pnpmfile\.(?:cjs|mjs|js)$/i,
  /(^|\/)pnpm-workspace\.ya?ml$/i,
];

// Directories and files that test runners generate as a side effect of running
// (bytecode caches, tool caches, coverage). These are NOT the grader and must be
// ignored, or a normal `pytest`/`node --test` run would look like test tampering.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bantam", ".venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".gocache", "coverage", ".nyc_output",
]);
const SKIP_FILE = /\.(pyc|pyo)$|^\.DS_Store$/;

export function isTestPath(rel) {
  const p = rel.split(path.sep).join("/");
  return TEST_PATTERNS.some((re) => re.test(p));
}

export function isRunnerConfigPath(rel) {
  const p = rel.split(path.sep).join("/");
  return RUNNER_CONFIG_PATTERNS.some((re) => re.test(p))
    || isPackageManagerConfigPath(p);
}

export function isPackageManagerConfigPath(rel) {
  const p = rel.split(path.sep).join("/");
  return PACKAGE_MANAGER_CONFIG_PATTERNS.some((re) => re.test(p));
}

export function isGeneratedPath(rel) {
  const p = rel.split(path.sep).join("/");
  const parts = p.split("/");
  return parts.some((part) => SKIP_DIRS.has(part)) || SKIP_FILE.test(parts.at(-1) ?? "");
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Capture authored workspace bytes for transactional shell-scope enforcement.
 * This deliberately uses the same generated/cache exclusions as the post-run
 * integrity guard, while retaining enough information to restore a modified,
 * deleted, or symlink-replaced protected path exactly.
 */
export function snapshotAuthoredState(root, {
  maxFiles = 20_000,
  maxBytes = 128 * 1024 * 1024,
} = {}) {
  const base = path.resolve(root);
  const out = new Map();
  let files = 0;
  let bytes = 0;
  walk(base);
  return out;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (isGeneratedPath(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files++;
      if (files > maxFiles) {
        throw new Error(`shell scope snapshot exceeded its ${maxFiles}-file bound`);
      }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        bytes += Buffer.byteLength(target);
        out.set(rel, { type: "symlink", target });
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full);
        bytes += content.length;
        out.set(rel, {
          type: "file",
          content,
          mode: fs.statSync(full).mode & 0o777,
        });
      }
      if (bytes > maxBytes) {
        throw new Error(`shell scope snapshot exceeded its ${maxBytes}-byte bound`);
      }
    }
  }
}

/**
 * Evaluation-only transactional guard for shell actions. It restores only
 * paths that violate the same immutable policy used by final grading; allowed
 * source changes from the same command remain on disk.
 */
export function createShellScopeGuard(root, spec = {}, bounds = {}) {
  const base = path.resolve(root);
  return {
    capture() {
      return snapshotAuthoredState(base, bounds);
    },
    rollback(before) {
      if (!(before instanceof Map)) {
        throw new TypeError("shell scope rollback requires a captured workspace state");
      }
      const after = snapshotAuthoredState(base, bounds);
      const violations = detectScopeViolations(
        stateSignatures(before),
        stateSignatures(after),
        spec,
      );
      const restored = [];
      for (const violation of violations) {
        restoreStateEntry(base, violation.path, before.get(violation.path));
        restored.push(violation.path);
      }
      const remaining = detectScopeViolations(
        stateSignatures(before),
        stateSignatures(snapshotAuthoredState(base, bounds)),
        spec,
      );
      return {
        clean: remaining.length === 0,
        violations,
        restored,
        remaining,
      };
    },
  };
}

function stateSignatures(state) {
  return new Map([...state].map(([rel, entry]) => [
    rel,
    entry.type === "symlink"
      ? `symlink:${sha(Buffer.from(entry.target, "utf8"))}`
      : sha(entry.content),
  ]));
}

function restoreStateEntry(root, rel, entry) {
  const target = path.resolve(root, rel);
  const prefix = `${root}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error(`refusing to restore path outside workspace: ${rel}`);
  }
  if (!entry) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let current = null;
  try {
    current = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current?.isDirectory() || current?.isSymbolicLink() || entry.type === "symlink") {
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (entry.type === "symlink") {
    fs.symlinkSync(entry.target, target);
  } else {
    fs.writeFileSync(target, entry.content);
    fs.chmodSync(target, entry.mode);
  }
}

// Map of workspace-relative path -> content hash for every file (skips
// vcs/deps and run-generated caches so the guard only sees authored files).
export function snapshotTree(root, { include = null } = {}) {
  const out = new Map();
  const wanted = typeof include === "function" ? include : null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (isGeneratedPath(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (wanted && !wanted(rel)) continue;   // never read what will not be compared
      else if (e.isFile()) {
        try { out.set(rel, sha(fs.readFileSync(full))); }
        catch { /* unreadable — ignore */ }
      } else if (e.isSymbolicLink()) {
        // Hash the link itself rather than following it. Otherwise a shell-created
        // `.npmrc` or test symlink disappears from both the integrity snapshot
        // and the runner-config classifier.
        try { out.set(rel, `symlink:${sha(Buffer.from(fs.readlinkSync(full), "utf8"))}`); }
        catch { /* unreadable — ignore */ }
      }
    }
  };
  walk(root);
  return out;
}

function underEditable(rel, editable) {
  return editable.some((prefix) => {
    const pre = prefix.replace(/\/$/, "");
    return rel === pre || rel.startsWith(pre + "/");
  });
}

/**
 * Why an edit to `rel` would violate this fixture's scope, or null if it is allowed.
 *
 * `detectScopeViolations` grades the workspace AFTER the run, which catches
 * tampering but cannot stop it: the model spends its whole budget building on an
 * edit that has already disqualified the run, and only the scorer ever knows.
 * The two failure modes it reports are not equally culpable — a model that
 * weakens an assertion is gaming the verifier, but the recurring case in
 * practice is a model that finds the public suite too thin and writes a STRONGER
 * one to check its own work (see the 2026-07-16 note below, and a 2026-07-26
 * Gemma 4 gauntlet where four of five failures were 6-test suites written over
 * 1-2 test originals, every one of them passing the hidden contract).
 *
 * Diligence and gaming are indistinguishable to a post-hoc diff, and both are
 * unrecoverable once the run ends. Deciding the same question BEFORE the write
 * lets the harness refuse the edit and say why, which turns a silent
 * disqualification into a course correction. The post-hoc check stays exactly as
 * it was — this only front-runs it.
 *
 * @returns {"grader"|"runner-config"|"out-of-scope"|null}
 */
export function immutableEditReason(rel, spec = {}) {
  if (isTestPath(rel)) return "grader";
  if (isRunnerConfigPath(rel) || isPackageManagerConfigPath(rel)) return "runner-config";
  const editable = Array.isArray(spec.editable) ? spec.editable : null;
  if (editable && !underEditable(rel, editable)) return "out-of-scope";
  return null;
}

/**
 * Compare before/after snapshots and return scope violations.
 * @returns {Array<{path: string, kind: "test-tampering"|"test-injection"|"runner-config-tampering"|"runner-config-injection"|"out-of-scope", change: "added"|"modified"|"deleted"}>}
 */
export function detectScopeViolations(before, after, spec = {}) {
  const editable = Array.isArray(spec.editable) ? spec.editable : null;
  const violations = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const k of keys) {
    const b = before.get(k), a = after.get(k);
    if (b === a) continue; // unchanged
    const change = b === undefined ? "added" : a === undefined ? "deleted" : "modified";
    // A file that did not exist cannot have been tampered with. Creating one is
    // still a violation — `node --test` discovers a bare test.js, so an injected
    // test can green a discovery-based verifier — but "tampering" names a
    // different act, and the verdict is recorded as evidence. On 2026-07-16 a
    // web-broken-page run fixed the real bug, could not reach jsdom offline,
    // wrote a scratch test.js to check its own work, passed the hidden contract
    // 1/1, and was filed as `scope violation (test-tampering): added test.js`.
    if (isTestPath(k)) {
      violations.push({ path: k, kind: change === "added" ? "test-injection" : "test-tampering", change });
    } else if (isRunnerConfigPath(k)) {
      violations.push({
        path: k,
        kind: change === "added" ? "runner-config-injection" : "runner-config-tampering",
        change,
      });
    } else if (editable && !underEditable(k, editable)) {
      violations.push({ path: k, kind: "out-of-scope", change });
    }
  }
  return violations;
}

// Convenience: snapshot -> run -> this, given the live workspace dir + before-map.
export function checkWorkspace(before, workspace, spec = {}) {
  const after = snapshotTree(workspace);
  const violations = detectScopeViolations(before, after, spec);
  return { clean: violations.length === 0, violations };
}

/**
 * Only the violations that mean "the thing grading this run was rewritten".
 *
 * `bantam run --verify <cmd>` is graded by that command, and nothing stopped a
 * model from weakening the assertions it runs — the guard above existed for
 * exactly this but was wired only into the eval path. Demonstrated in three
 * turns on 2026-08-17: a suite asserting `assert.equal(1, 9)` came back
 * `assert.equal(9, 9)` and the run recorded `pass: true`.
 *
 * Modifying or deleting a grader only. Creating a NEW test file is the task in
 * half the local tickets, so injection is deliberately not included: reporting
 * it would cry wolf on the work itself.
 */
export function graderTampering(before, after, { verifyCommand = null } = {}) {
  const found = detectScopeViolations(before, after)
    .filter((v) => v.kind === "test-tampering" || v.kind === "runner-config-tampering");
  // A manifest is not a grader in general — package.json and pyproject.toml are
  // ordinary source, which is why the patterns above leave them to a fixture's
  // `editable` allowlist. But when the verifier is `npm test` the manifest
  // DEFINES what the grade runs, and `bantam run` has no allowlist, so rewriting
  // the script greens the run without touching a test. Only for a verifier that
  // actually invokes it.
  for (const [pattern, manifests] of MANIFEST_VERIFIERS) {
    if (!pattern.test(String(verifyCommand ?? ""))) continue;
    for (const manifest of manifests) {
      const b = before.get(manifest), a = after.get(manifest);
      if (b === undefined || b === a) continue;   // absent, or untouched
      if (found.some((v) => v.path === manifest)) continue;
      found.push({
        path: manifest,
        kind: "runner-config-tampering",
        change: a === undefined ? "deleted" : "modified",
      });
    }
  }
  return found;
}

// verifier shape -> the files that define what it runs
const MANIFEST_VERIFIERS = [
  [/(^|[;&|]\s*)(npm|yarn|pnpm|bun)\s+(run\s+)?\S+/, ["package.json"]],
  [/(^|[;&|]\s*)make(\s|$)/, ["Makefile", "makefile", "GNUmakefile"]],
];


/**
 * Snapshot only the files that decide whether a `--verify` run was graded
 * honestly: test sources, runner configs, and the manifest when the verifier
 * runs one of its scripts.
 *
 * snapshotTree reads every file in the workspace, which at this repository's
 * root is 76,079 files and 4.8 seconds — twice per run, to compare a few hundred
 * of them. The full sweep is right for the eval path, which grades scope across
 * the whole tree; the grader check looks at a slice and should read a slice.
 */
export function graderSnapshot(root, { verifyCommand = null } = {}) {
  const manifests = new Set();
  for (const [pattern, files] of MANIFEST_VERIFIERS) {
    if (pattern.test(String(verifyCommand ?? ""))) for (const f of files) manifests.add(f);
  }
  return snapshotTree(root, {
    include: (rel) => isTestPath(rel) || isRunnerConfigPath(rel) || manifests.has(rel),
  });
}