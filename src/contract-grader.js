import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process-runner.js";
import { clipText } from "./clip.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT = 12_000;

export function findContractGrader(fixtureDir) {
  // Absolute: the grader is spawned with cwd set to the CANDIDATE WORKSPACE, so a relative fixture
  // path (e.g. `bantam eval fixtures/foo`) made node resolve the grader inside the temp workspace —
  // "Could not find …" — and the run was recorded as contract-fail (tests null/0) even when the
  // candidate was correct. Resolve against the invoking process's cwd instead.
  if (typeof fixtureDir !== "string" || !fixtureDir) return null;
  try {
    const grader = path.resolve(fixtureDir, "grader", "contract.test.cjs");
    const stat = fs.lstatSync(grader);
    return stat.isFile() && !stat.isSymbolicLink() ? grader : null;
  } catch {
    return null;
  }
}

/**
 * Run a model-hidden Node contract suite against the final candidate workspace.
 *
 * Uses runProcess (detached process group + kill(-pid) on timeout) rather than raw spawnSync: a
 * contract grader is `node --test`, which SPAWNS the candidate CLI as a grandchild. spawnSync's
 * timeout only signals the direct child, so a candidate that infinite-loops (e.g. a template engine
 * that hangs on an unclosed block) was orphaned and pegged a CPU core indefinitely after the grader
 * "timed out" — observed live 2026-07-20 (two render.js loops surviving 9–12h). runProcess SIGKILLs
 * the whole group, so the grandchild dies with the grader.
 */
export async function runContractGrader({
  fixtureDir,
  workspace,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
} = {}) {
  const grader = findContractGrader(fixtureDir);
  if (!grader) return null;

  const started = Date.now();
  const env = { ...process.env, CANDIDATE_ROOT: workspace };
  delete env.NODE_TEST_CONTEXT;
  const run = await runProcess(process.execPath, ["--test", grader], {
    cwd: workspace,
    env,
    timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = [run.stdout, run.stderr].filter(Boolean).join("\n").trim();
  const counts = parseTapCounts(output);
  const status = run.timedOut ? "timeout" : run.error ? "error" : run.code === 0 ? "pass" : "fail";

  return {
    status,
    pass: status === "pass",
    tests: counts.tests,
    passed: counts.passed,
    failed: counts.failed,
    exitCode: run.timedOut ? null : (Number.isInteger(run.code) ? run.code : null),
    signal: run.signal ?? null,
    durationMs: Date.now() - started,
    detail: clipText(output || run.error?.message || `contract grader ${status}`, outputLimit),
  };
}

export function parseTapCounts(output) {
  return {
    tests: tapNumber(output, "tests"),
    passed: tapNumber(output, "pass"),
    failed: tapNumber(output, "fail"),
  };
}

function tapNumber(output, label) {
  const match = new RegExp(`^# ${label} (\\d+)$`, "m").exec(String(output ?? ""));
  return match ? Number(match[1]) : null;
}
