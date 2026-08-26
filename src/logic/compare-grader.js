// Grade a compare arm against a contract the arm could not see.
//
// `bantam compare` reported `contract: { passed: publicResult.pass ? 1 : 0,
// tests: 1 }` -- the VISIBLE verify command, relabelled. Two arms that both make
// the visible suite green are then indistinguishable, however differently they
// actually solved the problem, which is the weak-oracle failure this codebase has
// hit repeatedly: a public suite that gave byte-identical results for a correct
// and a broken implementation, and a benchmark whose grader asserted requirements
// its task never stated.
//
// A head-to-head is only worth rendering if it is graded on something the
// competitors could not optimise against. The gauntlet already works this way --
// a grader outside the model-visible workspace, reached through CANDIDATE_ROOT --
// and compare now does too.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Parse node:test TAP into a pass/total count and the failing test names. */
export function parseTap(output) {
  const text = String(output ?? "");
  const failed = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  const passed = [...text.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  // `# pass N` / `# fail N` are authoritative when present; the ok/not-ok scan is
  // the fallback for runners that omit the summary.
  const passLine = text.match(/^# pass (\d+)$/m);
  const failLine = text.match(/^# fail (\d+)$/m);
  const passedCount = passLine ? Number(passLine[1]) : passed.length;
  const failedCount = failLine ? Number(failLine[1]) : failed.length;
  return {
    passed: passedCount,
    tests: passedCount + failedCount,
    failures: failed,
  };
}

/**
 * Run a hidden grader against an arm's finished workspace.
 *
 * The grader is executed from OUTSIDE the workspace and told where to look via
 * CANDIDATE_ROOT, so nothing it contains is ever visible to the arm.
 *
 * @param {string} workspace  the arm's finished tree
 * @param {string} graderPath a test file, or a directory of them
 * @returns {{passed:number, tests:number, failures:string[], available:boolean}}
 */
export function gradeArm(workspace, graderPath) {
  if (!graderPath || !fs.existsSync(graderPath)) {
    // Absent is not zero. Reporting 0/0 as a contract result would let a missing
    // grader read as a clean sheet for every arm.
    return { passed: 0, tests: 0, failures: [], available: false };
  }
  const files = fs.statSync(graderPath).isDirectory()
    ? fs.readdirSync(graderPath)
      .filter((f) => /\.(?:c?js|mjs)$/.test(f))
      .map((f) => path.join(graderPath, f))
    : [graderPath];
  if (!files.length) return { passed: 0, tests: 0, failures: [], available: false };

  // node:test switches a CHILD runner away from TAP when it detects it is nested,
  // via NODE_TEST_CONTEXT -- so a grader spawned from inside any test runner
  // silently returns 0/0 instead of its real result. Strip the runner's own
  // variables so the grader's output does not depend on who invoked compare.
  const env = { ...process.env, CANDIDATE_ROOT: path.resolve(workspace) };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;

  let out = "";
  try {
    out = execFileSync("node", ["--test", "--test-reporter=tap", ...files], {
      encoding: "utf8",
      stdio: "pipe",
      env,
      timeout: 120_000,
    });
  } catch (error) {
    // A failing grader exits non-zero; its TAP is still the result we want.
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  return { ...parseTap(out), available: true };
}
