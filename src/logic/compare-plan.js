// compare-plan: assemble a user-initiated three/four-way comparison and compile
// its graded results + reference-witness divergences into ONE eyeball-able
// summary. The compiler is pure/injectable; `runCompare` below is the direct
// exploratory driver and gives every executed arm a separate frozen clone.
//
// The subject is always bantam-dev (the harness we are improving). The references
// are the stronger external arms; bantam-regular is the control channel. See
// docs/superpowers/plans/2026-07-18-escalation-and-showcase.md (Phase 1).

import fs from "node:fs";
import { makeScratchDir } from "./scratch-dir.js";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  armPassed, findReferenceDivergence, diffSolutions, witnessReferenceGaps,
} from "./reference-witness.js";
import { runAgent } from "../agent.js";
import { ModelClient } from "../model.js";
import { strictBest } from "./strict-best.js";
import { gradeArm } from "./compare-grader.js";
import { spawnExternalAgent, DEFAULT_EXTERNAL_TIMEOUT_MS, detectBlockedAgent, osSandboxAvailable } from "./external-agent.js";
import { checkWorkspace, isGeneratedPath, snapshotTree } from "../scope-guard.js";

// Winner preference among fully-passing arms: bantam first (a bantam win is the
// goal), then the references, then the control.
const WINNER_ORDER = ["bantam-codex", "bantam-dev", "claude-code", "codex", "bantam-regular"];
const ARM_ROLES = {
  // The claim this project exists to prove: the SAME Codex model, once driven
  // through the harness and once on its own. Anything else confounds the harness
  // with the model it happens to be driving.
  "bantam-codex": "subject",
  "bantam-dev": "subject",
  "bantam-regular": "control",
  "claude-code": "reference",
  codex: "reference",
};

// A codex arm that names no model would silently fall back to the local server,
// turning the head-to-head back into BANTAM+local vs Codex without saying so.
const DEFAULT_COMPARE_CODEX_MODEL = "gpt-5.6-terra";
// Mirrors ModelClient's own Codex default. If the two ever drift, the comparison
// silently becomes a thinking-budget comparison.
const DEFAULT_COMPARE_CODEX_EFFORT = "medium";

/**
 * The model and effort the bare-Codex arm must run, given the subject's spec.
 *
 * Exported because the whole validity of `bantam compare` rests on these two
 * matching the bantam-codex arm, and a claim that load-bearing needs a test that
 * fails when it stops being true.
 */
export function externalCodexSettings(spec) {
  const options = compareModelOptions(spec);
  return {
    model: options.model || DEFAULT_COMPARE_CODEX_MODEL,
    effort: options.codexEffort || DEFAULT_COMPARE_CODEX_EFFORT,
  };
}

/**
 * Model options for one compare arm.
 * Accepts a bare string (legacy per-arm `model` override) or a spec object
 * `{ codex, model, effort }`.
 */
export function compareModelOptions(spec) {
  if (typeof spec === "string") return { model: spec };
  if (!spec || typeof spec !== "object") return {};
  if (!spec.codex) return spec.model ? { model: spec.model } : {};
  return {
    codex: true,
    model: spec.model || DEFAULT_COMPARE_CODEX_MODEL,
    ...(spec.effort ? { codexEffort: spec.effort } : {}),
  };
}

// Default CLI commands per external arm
const ARM_COMMANDS = {
  "codex": "codex",
  "claude-code": "claude",
};

/** The compare request: the four arms with their roles, subject = bantam-dev. */
export function buildComparePlan({ task, editable = [] }) {
  return {
    task,
    editable,
    required: Object.keys(ARM_ROLES),
    arms: Object.entries(ARM_ROLES).map(([id, role]) => ({ id, role })),
  };
}

/** One graded arm row, tolerant of the scope.violations number-or-array shape. */
function armRow(id, result, editable) {
  const c = result?.contract ?? {};
  const v = result?.scope?.violations;
  const scopeClean = v == null || (Array.isArray(v) ? v.length === 0 : v === 0);
  return {
    id,
    role: ARM_ROLES[id] ?? "arm",
    pass: armPassed(result),
    // An arm that never attempted the task is a MISSING OBSERVATION, not a loss.
    // Without this the summary printed "FAIL" and crowned a winner over a
    // competitor the harness itself had prevented from starting.
    blocked: Boolean(result?.blocked),
    // Did this arm run at ALL? An absent result is not a defeat. `bantam compare`
    // is routinely invoked with a subset of arms, and every unselected arm arrived
    // here as pass:false -- so a solo run of one arm scored itself against four
    // phantom losers and printed a win. Absent is not zero.
    ran: result != null,
    // The tie line tells the reader to separate the arms on wall clock. It has to
    // be printed for that to be possible: the first head-to-head tied 4/4 on
    // correctness and differed 97s vs 196s, and only the correctness half was
    // in the table.
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
    blockedReason: result?.blockedReason ?? null,
    public: Boolean(result?.public?.pass),
    contract: { passed: c.passed ?? 0, tests: c.tests ?? 0 },
    scope: {
      editable: [...editable],
      clean: scopeClean,
      violations: Array.isArray(v) ? v.length : v ?? 0,
    },
  };
}

/**
 * Compile graded results + final trees into one summary.
 * @param {{task, editable, results:{[arm]:result}, trees:{[arm]:files}}} in
 * @returns {{task, arms:[row], winner, tied, divergences}}
 */
export function compileCompareSummary({ task, editable = [], results = {}, trees = {} }) {
  const editableScope = normalizeEditable(editable);
  const arms = Object.keys(ARM_ROLES).map((id) => armRow(id, results[id], editableScope));
  // A tie is not a win.
  //
  // This used to be `WINNER_ORDER.find(a => a.pass)` against a hardcoded order with
  // bantam-codex FIRST -- so whenever BANTAM passed, BANTAM "won", even if every
  // other arm passed identically. The first real head-to-head (2026-08-01,
  // adapter-migration) had bantam-codex and bare codex both at 4/4 on the hidden
  // contract, and the summary printed "Winner: bantam-codex".
  //
  // The comparison built to prove this project's value was reporting a win on a
  // draw. That is the most consequential form of the failure this codebase spent
  // the day finding: an instrument returning a confident answer where the honest
  // one is "no difference".
  //
  // A winner now requires being STRICTLY BEST on the graded contract. Equal scores
  // are reported as a tie, and WINNER_ORDER is used only to order the tied names.
  // Contenders are arms that RAN and were not blocked. An arm that ran and lost is
  // real competition and must count as such -- only an arm that produced no
  // observation at all is excluded.
  const contenders = arms.filter((a) => a.ran && !a.blocked);
  // A ran arm always has a score: its graded contract ratio, or failing that, what
  // the public verify said. Failing the public tests IS a measurement, so it is a
  // legitimate 0 rather than an absence.
  const scoreOf = (a) => (a.contract?.tests ? a.contract.passed / a.contract.tests : (a.pass ? 1 : 0));
  // Shared with delegate-comparison.js: unmeasured never competes, a tie is not a
  // win, and one contender is not a comparison. Written once so the two tools
  // cannot drift apart on the rule again.
  const best = strictBest(contenders, scoreOf, { direction: "max" });
  // Being ahead of the field is not enough to be crowned -- the winner still has to
  // have actually passed. Otherwise "least wrong" would print as a victory.
  const winner = best.winner?.pass ? best.winner.id : null;
  // WINNER_ORDER survives for exactly one job now: ordering the names of a draw.
  const tied = WINNER_ORDER.filter((id) => best.tied.some((a) => a.id === id));

  // Divergences: only when the subject (bantam-dev) failed and a reference passed.
  const divergence = findReferenceDivergence({
    bantam: results["bantam-dev"],
    "claude-code": results["claude-code"],
    codex: results.codex,
  });
  let divergences = [];
  if (divergence) {
    const diffs = diffSolutions({
      bantamFiles: trees["bantam-dev"] ?? {},
      referenceFiles: trees[divergence.referenceArm] ?? {},
      editable: editableScope,
    });
    divergences = witnessReferenceGaps({ referenceArm: divergence.referenceArm, diffs });
  }
  return { task, editable: editableScope, arms, winner, tied, divergences };
}

/**
 * Check if a CLI tool is available.
 */
function toolAvailable(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an external CLI agent (codex or claude-code) on a task.
 * @param {string} armId - arm identifier ("codex" or "claude-code")
 * @param {string} task - the task prompt
 * @param {string} workspace - workspace directory
 * @param {string} [verifyCmd] - verification command to run after the agent
 * @returns {Promise<{public:{pass:boolean}, contract:{passed:number, tests:number}, scope:{violations:?}, files:{}}}>
 */
/**
 * Which codex sandbox level can actually start here?
 *
 * workspace-write is correct and preferred. It needs bubblewrap, which needs a
 * network namespace, which needs CAP_NET_ADMIN. Where that is unavailable every
 * model-generated command fails before execution and the arm looks slow and wrong
 * rather than blocked.
 */
function codexSandboxMode() {
  const probe = osSandboxAvailable();
  return probe.available ? "workspace-write" : "danger-full-access";
}

async function runExternalArm(armId, task, workspace, verifyCmd, editable = [], modelSpec = null) {
  const cmd = ARM_COMMANDS[armId];
  if (!cmd || !toolAvailable(cmd)) {
    return {
      public: { pass: false, detail: `${armId} CLI not found: ${cmd}` },
      contract: { passed: 0, tests: 0 },
      scope: { editable: [...editable], violations: [] },
      files: {},
    };
  }

  const snapshot = snapshotTree(workspace);
  const startMs = Date.now();

  // Run the agent non-interactively
  const agentCmd = armId === "codex" ? "codex" : "claude";
  const { model: externalCodexModel, effort: externalCodexEffort } = externalCodexSettings(modelSpec);
  // `codex exec` defaults to a READ-ONLY sandbox. Without workspace-write the
  // competitor cannot edit a single file and reports 0 on any hidden contract --
  // measured 2026-07-31, where a bare-Codex arm returned "I'm blocked by the
  // workspace's read-only sandbox ... no files were modified" and scored 0/4
  // against a BANTAM arm's 4/4. That is a comparison the harness rigged, not one
  // the subject won, and rendering it would have discredited every honest number
  // beside it. Scoped to the arm's own cloned workspace, not the machine.
  // codex sandboxes model commands with bubblewrap. Where bwrap cannot create a
  // network namespace -- a container, a CI runner, anything without CAP_NET_ADMIN --
  // every write fails and the competitor scores zero while appearing to have tried.
  // Measured 2026-07-31: exactly that produced a clean 4/4-to-0/4 "win" for BANTAM
  // that was purely an artifact of the environment.
  //
  // The fallback grants the competitor MORE access than workspace-write, not less.
  // That direction matters: it can only help the competitor, so it cannot
  // manufacture a flattering result for the subject. A comparison whose bias runs
  // against the thing being sold is one you can publish.
  const sandbox = armId === "codex" ? codexSandboxMode() : null;
  if (sandbox === "danger-full-access") {
    console.log("  ⚠️  bubblewrap unavailable here; running the codex arm with");
    console.log("     --sandbox danger-full-access so it can attempt the task at all.");
    console.log("     This gives the COMPETITOR more access than normal, never the subject.");
  }
  // PIN THE MODEL AND THE EFFORT.
  //
  // This arm used to spawn a bare `codex exec` with no --model and no effort
  // setting, so it ran whatever ~/.codex/config.toml happened to default to. On
  // this machine that is gpt-5.6-SOL, while the bantam-codex arm is pinned to
  // gpt-5.6-TERRA. Five head-to-heads (2026-08-01) were run and reported that way
  // before anyone checked: every one of them compared two different models and
  // called the difference a harness effect.
  //
  // The claim this file exists to test is stated at the top of it -- "the SAME
  // Codex model, once driven by BANTAM and once bare". An unpinned competitor
  // cannot test that claim, and worse, it silently answers a different question
  // in language that sounds like the right one.
  const args = armId === "codex"
    ? ["exec", "--skip-git-repo-check",
       "--model", externalCodexModel,
       "-c", `model_reasoning_effort="${externalCodexEffort}"`,
       "--sandbox", sandbox, task]
    : buildClaudeExternalArgs(task);

  // Uses the TESTED helper rather than a private copy. Both existed for a while:
  // spawnExternalAgent was written with stdin closed and a bounded run, imported
  // here, and then never called -- the inline spawn below was patched instead. So
  // the code under test was dead and the code in production was an untested
  // duplicate of it. The unused import is what gave that away.
  const run = await spawnExternalAgent(agentCmd, args, {
    cwd: workspace,
    env: { ...process.env, HOME: os.homedir() },
    timeoutMs: DEFAULT_EXTERNAL_TIMEOUT_MS,
  });

  const files = collectWorkspaceFiles(workspace);

  // An arm that reported it could not START never attempted the task. Scoring
  // that as a loss manufactures a win for the subject.
  const blocked = detectBlockedAgent({ stdout: run.stdout, stderr: run.stderr });

  const publicResult = { pass: run.code === 0 };
  if (verifyCmd) {
    try {
      execSync(verifyCmd, { cwd: workspace, stdio: "pipe" });
      publicResult.pass = true;
    } catch {
      publicResult.pass = false;
    }
  }
  const scope = checkWorkspace(snapshot, workspace, editable.length ? { editable } : {});

  return {
    public: publicResult,
    contract: { passed: publicResult.pass ? 1 : 0, tests: 1 },
    scope: { editable: [...editable], violations: scope.violations },
    files,
    durationMs: Date.now() - startMs,
    // Surfaced so a reader of the comparison can tell "tried and failed" from
    // "never got to try". Without it the two are indistinguishable in the table.
    blocked: blocked.blocked,
    blockedReason: blocked.reason,
    // A bounded run that hit its limit is a missing observation, not a loss.
    timedOut: run.timedOut,
    stdout: run.stdout.slice(0, 2000),
    stderr: run.stderr.slice(0, 1000),
    // Retain the complete external-agent stream for trajectory inspection. The
    // bounded excerpts above remain convenient summary fields.
    transcript: {
      format: armId === "claude-code" ? "claude-stream-json" : "codex-text",
      stdout: run.stdout,
      stderr: run.stderr,
    },
  };
}

export function buildClaudeExternalArgs(task) {
  if (typeof task !== "string" || !task.trim()) throw new TypeError("Claude comparison task must be non-empty");
  return ["--print", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--no-session-persistence",
    "--disable-slash-commands", "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "acceptEdits", task.trim()];
}

/**
 * Run bantam (dev or regular) on a task.
 * @param {string} armId - "bantam-dev" or "bantam-regular"
 * @param {string} task - the task prompt
 * @param {string} workspace - workspace directory
 * @param {string} [verifyCmd] - verification command
 * @param {string} [model] - model override for bantam-regular
 * @returns {Promise<{public:{pass:boolean}, contract:{passed:number, tests:number}, scope:{violations:?}, files:{}}}>
 */
async function runBantamArm(armId, task, workspace, verifyCmd, model, editable = []) {
  const snapshot = snapshotTree(workspace);
  const startMs = Date.now();

  // Create model client
  const options = compareModelOptions(model);
  const modelClient = Object.keys(options).length ? new ModelClient(options) : new ModelClient();

  const result = await runAgent({
    task,
    workspace,
    model: modelClient,
    maxTurns: 15,
    verificationScript: verifyCmd || null,
    onEvent: () => {},
  });

  // Collect final files
  const files = collectWorkspaceFiles(workspace);
  const scope = checkWorkspace(snapshot, workspace, editable.length ? { editable } : {});
  const publicPass = verifyCmd
    ? result.verification?.status === "pass"
    : Boolean(result.reachedDone);

  return {
    public: { pass: publicPass },
    contract: { passed: publicPass ? 1 : 0, tests: 1 },
    scope: { editable: [...editable], violations: scope.violations },
    files,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Format the compare summary as a human-readable report.
 */
export function formatSummary(summary) {
  const lines = [];
  lines.push("\n=== Compare Results ===");
  lines.push(`Task: ${summary.task}`);
  lines.push(`Editable scope: ${summary.editable.length ? summary.editable.join(", ") : "(unrestricted)"}`);
  lines.push("");

  let blockedArms = 0;
  for (const arm of summary.arms) {
    if (arm.blocked) {
      blockedArms += 1;
      lines.push(`⚠️  ${arm.id} (${arm.role}): BLOCKED — never attempted the task`);
      lines.push(`   ${arm.blockedReason ?? "the arm reported it could not start"}`);
      lines.push("   Not scored. A competitor that could not start is a missing observation, not a loss.");
      continue;
    }
    // An arm that was not selected for this run did not lose it. `--only
    // bantam-codex,codex` still printed the other three as "❌ FAIL, Contract 0/0",
    // which reads as three defeats the harness never staged.
    if (!arm.ran) {
      lines.push(`·  ${arm.id} (${arm.role}): not run`);
      continue;
    }
    const icon = arm.pass ? "✅" : "❌";
    const status = arm.pass ? "PASS" : "FAIL";
    lines.push(`${icon} ${arm.id} (${arm.role}): ${status}`);
    const secs = arm.durationMs == null ? "unmeasured" : `${(arm.durationMs / 1000).toFixed(0)}s`;
    lines.push(`   Public: ${arm.public ? "pass" : "fail"}, Contract: ${arm.contract.passed}/${arm.contract.tests}, Scope violations: ${arm.scope.violations}, Wall: ${secs}`);
  }

  lines.push("");
  // A win over an arm that never ran is not a win. Declaring one is the single
  // failure mode that would discredit every honest number beside it.
  const contested = summary.arms.filter((a) => a.ran && !a.blocked && a.role !== "subject").length;
  if (blockedArms && !contested) {
    lines.push("NO COMPARISON: every reference arm was blocked before it could attempt the task.");
    lines.push("The subject's result stands on its own and beats nothing.");
  } else if (summary.winner) {
    lines.push(`🏆 Winner: ${summary.winner}${blockedArms ? `  (${blockedArms} arm(s) blocked and unscored)` : ""}`);
  } else if (summary.tied?.length) {
    lines.push(`= TIE: ${summary.tied.join(", ")} scored identically on the hidden contract.`);
    lines.push("  No arm is better on correctness — a draw is not a win for anyone.");
    const timed = summary.arms.filter((a) => summary.tied.includes(a.id) && a.durationMs != null);
    if (timed.length > 1) {
      const fastest = timed.reduce((a, b) => (a.durationMs <= b.durationMs ? a : b));
      const slowest = timed.reduce((a, b) => (a.durationMs >= b.durationMs ? a : b));
      const ratio = slowest.durationMs / Math.max(1, fastest.durationMs);
      lines.push(`  They differ on wall clock: ${fastest.id} ${(fastest.durationMs / 1000).toFixed(0)}s`
        + ` vs ${slowest.id} ${(slowest.durationMs / 1000).toFixed(0)}s (${ratio.toFixed(1)}x).`);
      lines.push("  That is a single run on a single task. It is a lead, not a finding.");
    }
  } else if (summary.arms.some((a) => a.ran && a.pass)) {
    // Refusing to crown an uncontested arm must not turn into denying it passed.
    // Observed on retry-consolidation: bantam-codex passed 5/5 alone and the
    // summary read "No arm fully passed."
    const solo = summary.arms.filter((a) => a.ran && a.pass).map((a) => a.id).join(", ");
    lines.push(`${solo}: PASSED, uncontested — no other arm ran, so there is nothing to compare against.`);
  } else {
    lines.push("No arm fully passed.");
  }

  if (summary.divergences?.length) {
    lines.push("");
    lines.push("Divergences (bantam failed, reference passed):" );
    for (const d of summary.divergences) {
      lines.push(`  - ${d}`);
    }
  }

  return lines.join("\n");
}

/**
 * Main entry point: run a four-arm comparison.
 * @param {object} opts
 * @param {string} opts.task - the task prompt
 * @param {string} [opts.config] - path to config JSON
 * @param {string} [opts.out] - output directory
 * @param {string[]} [opts.only] - run only these arms
 * @param {boolean} [opts.dryRun] - dry-run mode
 * @param {boolean} [opts.allowUnsafe] - allow competitor CLI calls
 * @param {string} [opts.verify] - verification command
 * @param {string} [opts.workspace] - source workspace cloned into an immutable baseline
 * @param {string[]} [opts.editable] - editable path prefixes carried into grading/summary
 * @param {Function} [opts.runArm] - injectable arm runner for hermetic callers/tests
 */
export async function runCompare({
  task,
  config,
  out,
  only,
  dryRun = false,
  allowUnsafe = false,
  verify,
  workspace: sourceWorkspace = process.cwd(),
  editable = null,
  runArm = null,
  // A contract the arms cannot see. Without one, compare grades every arm on the
  // VISIBLE verify command and two arms that both make it green are
  // indistinguishable -- the weak-oracle failure this codebase keeps rediscovering.
  grader = null,
} = {}) {
  // Load config overrides if provided
  let armOverrides = {};
  let configuredEditable = [];
  if (config && fs.existsSync(config)) {
    const parsedConfig = JSON.parse(fs.readFileSync(config, "utf8"));
    armOverrides = parsedConfig?.arms && !Array.isArray(parsedConfig.arms)
      ? parsedConfig.arms
      : parsedConfig;
    configuredEditable = Array.isArray(parsedConfig?.editable) ? parsedConfig.editable : [];
  }
  const editableScope = normalizeEditable(editable ?? configuredEditable);

  // Determine which arms to run
  const allArms = Object.keys(ARM_ROLES);
  const armsToRun = only && only.length > 0 ? only.filter((a) => allArms.includes(a)) : allArms;

  if (dryRun) {
    console.log(`\nDry-run: would run ${armsToRun.length} arms for task: "${task}"`);
    for (const arm of armsToRun) {
      const role = ARM_ROLES[arm];
      const available = arm === "codex" || arm === "claude-code"
        ? toolAvailable(ARM_COMMANDS[arm])
        : true;
      console.log(`  ${arm} (${role}): ${available ? "available" : "not found"}`);
    }
    return buildComparePlan({ task, editable: editableScope });
  }

  const source = path.resolve(sourceWorkspace);
  let sourceStat;
  try { sourceStat = fs.statSync(source); } catch { /* handled below */ }
  if (!sourceStat?.isDirectory()) throw new Error(`comparison workspace is not a directory: ${source}`);
  assertNoSymlinks(source);

  // Freeze one baseline before creating output beneath a source workspace. Every
  // arm is copied from this directory, never from another arm's final tree.
  const outDir = out || path.join(process.cwd(), "compare-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const comparisonRoot = makeScratchDir("bantam-compare-");
  const baseline = path.join(comparisonRoot, "baseline");
  cloneWorkspace(source, baseline);
  const baselineSnapshot = snapshotTree(baseline);
  fs.mkdirSync(outDir, { recursive: true });
  const results = {};
  const trees = {};

  try {
    for (const armId of armsToRun) {
      const role = ARM_ROLES[armId];
      console.log(`\nRunning arm: ${armId} (${role})...`);

      // Skip external arms if not allowed
      if (armId === "codex" || armId === "claude-code") {
        if (!allowUnsafe) {
          console.log(`  Skipping (competitor CLI not allowed without --allow-unsafe-competitors)`);
          continue;
        }
      }

      const armWorkspace = path.join(comparisonRoot, "arms", armId);
      fs.mkdirSync(path.dirname(armWorkspace), { recursive: true });
      cloneWorkspace(baseline, armWorkspace);
      assertSameSnapshot(
        baselineSnapshot,
        snapshotTree(armWorkspace),
        `arm ${armId} did not start from the immutable comparison baseline`,
      );

      let result;
      // bantam-codex defaults to driving Codex even with no config file, so the
      // comparison the project cares about works out of the box.
      const armConfig = armOverrides[armId]
        ?? (armId === "bantam-codex" ? { codex: true } : undefined);
      const modelOverride = armConfig;
      if (typeof runArm === "function") {
        result = await runArm({
          armId,
          role,
          task,
          workspace: armWorkspace,
          verify,
          model: modelOverride,
          editable: [...editableScope],
        });
      } else if (armId === "codex" || armId === "claude-code") {
        // Pass the SUBJECT's spec, not this arm's. The bare-Codex arm has to run
        // the same model the bantam-codex arm runs or the comparison measures the
        // wrong thing -- see externalCodexSettings.
        const subjectSpec = armOverrides["bantam-codex"] ?? { codex: true };
        result = await runExternalArm(armId, task, armWorkspace, verify, editableScope, subjectSpec);
      } else {
        result = await runBantamArm(
          armId,
          task,
          armWorkspace,
          verify,
          modelOverride,
          editableScope,
        );
      }

      if (!result || typeof result !== "object") {
        throw new Error(`comparison arm ${armId} returned no result`);
      }
      assertNoSymlinks(armWorkspace);
      const independentScope = checkWorkspace(
        baselineSnapshot,
        armWorkspace,
        editableScope.length ? { editable: editableScope } : {},
      );
      const files = collectWorkspaceFiles(armWorkspace);
      // Hidden-contract grading replaces the visible-verify stand-in. Left alone
      // when no grader is configured, so existing callers keep their behaviour.
      const graded = grader ? gradeArm(armWorkspace, grader) : null;
      if (graded?.available) {
        result = {
          ...result,
          contract: { passed: graded.passed, tests: graded.tests, failures: graded.failures },
        };
      }
      result = {
        ...result,
        scope: {
          editable: [...editableScope],
          clean: independentScope.clean,
          violations: independentScope.violations,
        },
        files,
      };
      results[armId] = result;
      trees[armId] = files;

      const pass = armPassed(result);
      console.log(result.blocked
        ? `  ⚠️  BLOCKED — never attempted the task (${result.blockedReason}) (${result.durationMs}ms)`
        : `  ${pass ? "✅ PASS" : "❌ FAIL"} (${result.durationMs}ms)`);

      // Save individual result
      const resultPath = path.join(outDir, `${armId}-result.json`);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

      assertSameSnapshot(
        baselineSnapshot,
        snapshotTree(baseline),
        `immutable comparison baseline changed while running ${armId}`,
      );
    }

    // Compile summary
    const summary = compileCompareSummary({
      task,
      editable: editableScope,
      results,
      trees,
    });

    // Save summary
    const summaryPath = path.join(outDir, "summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Print report
    console.log(formatSummary(summary));
    console.log(`\nResults saved to: ${outDir}`);

    return { outDir, summary, results };
  } finally {
    fs.rmSync(comparisonRoot, { recursive: true, force: true });
  }
}

function normalizeEditable(editable) {
  if (!Array.isArray(editable)) throw new TypeError("editable scope must be an array");
  const normalized = editable.map((entry) => String(entry).replaceAll("\\", "/").replace(/^\.\//, ""));
  if (normalized.some((entry) => !entry || path.posix.isAbsolute(entry)
      || entry.split("/").some((part) => part === ".."))) {
    throw new TypeError("editable scope entries must be non-empty workspace-relative paths");
  }
  return [...new Set(normalized)];
}

function cloneWorkspace(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: (entry) => path.basename(entry) !== ".git",
  });
}

function assertNoSymlinks(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.name === ".git" || isGeneratedPath(relative)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`comparison source contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
}

function collectWorkspaceFiles(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.name === ".git" || isGeneratedPath(relative)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`comparison source contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[relative] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

function assertSameSnapshot(expected, actual, message) {
  if (expected.size !== actual.size) throw new Error(message);
  for (const [file, hash] of expected) {
    if (actual.get(file) !== hash) throw new Error(message);
  }
}
