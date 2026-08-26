// Test-runner mismatch steer (pipe-guard family: detection, not advice).
//
// SWE-bench v1 forensics (2026-08-15): agents invoking pytest on django went
// 0/3 with cleanly-applying blind patches — django's suite only runs under
// tests/runtests.py, and nothing in the harness delivered that fact. This
// steer reads the repo's own layout, recognizes the failure signature of a
// wrong-runner invocation, and appends the working invocation to the
// observation. Fires only on failed runs, only when the repo's real runner is
// unambiguous, at most twice per run. BANTAM_RUNNER_STEER=0 disables.
import fs from "node:fs";
import path from "node:path";

export const RUNNER_STEER_MARKER = "[test-runner]";
const MAX_STEERS = 2;

const MISMATCH_SIGNATURE = /ImproperlyConfigured|Requested setting|no tests ran|No module named ['"]?pytest|Traceback[\s\S]*django|couldn't import Django|Unknown label|ModuleNotFoundError: No module named ['"]?django/i;

export function detectRepoRunner(workspace) {
  const has = (p) => {
    try { return fs.statSync(path.join(workspace, p)).isFile(); } catch { return false; }
  };
  if (has("tests/runtests.py")) {
    return {
      kind: "django-runtests",
      invocation: "python tests/runtests.py <app_label.TestModule> -v 1 --parallel 1",
      example: "python tests/runtests.py auth_tests.test_forms -v 1 --parallel 1",
    };
  }
  if (has("bin/test")) {
    return {
      kind: "sympy-bintest",
      invocation: "python bin/test <path/to/test_file.py>",
      example: "python bin/test sympy/core/tests/test_basic.py",
    };
  }
  if (has("pytest.ini") || has("tox.ini") || has("setup.cfg") || has("pyproject.toml")) {
    return { kind: "pytest", invocation: "python -m pytest <path> -x -q", example: null };
  }
  return { kind: "unknown", invocation: null, example: null };
}

export function runnerMismatchSteer({
  command,
  observation,
  exitCode,
  workspace,
  priorSteers = 0,
  env = process.env,
} = {}) {
  if (/^(0|false|no|off)$/i.test(String(env.BANTAM_RUNNER_STEER ?? ""))) return null;
  if (priorSteers >= MAX_STEERS) return null;
  if (!exitCode) return null;                                   // success is never steered
  const c = String(command ?? "");
  if (!/\bpytest\b/.test(c)) return null;                       // only misdirected pytest for now
  if (!MISMATCH_SIGNATURE.test(String(observation ?? ""))) return null;
  const runner = detectRepoRunner(workspace);
  if (runner.kind === "pytest" || runner.kind === "unknown") return null;
  const example = runner.example ? ` (for example: ${runner.example})` : "";
  return `${RUNNER_STEER_MARKER} This repository's test suite does not run under pytest. `
    + `Use its own runner: \`${runner.invocation}\`${example}. `
    + `Rerun your focused test with that invocation before relying on any result.`;
}
