import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Executor } from "../src/executor.js";
import { WorkspaceCoherenceTracker } from "../src/workspace-coherence.js";
import { missingOutputsObjection, requiredOutputPaths } from "../src/logic/missing-outputs.js";

// TB2 rstan-to-pystan (2026-08-21). The task lists four outputs by absolute path
// under "Save the results to these files:". The run ran
// `ls -la /app/alpha_est.csv …`, saw nothing, and called done three times with
// 100 of its 120 minutes unspent. The grader's first assertion is that those
// files exist. verify-outputs says exactly this as advice and was in the rule set.

const RSTAN = `Save the results to these files:
   - '/app/alpha_est.csv': posterior mean of alpha parameter
   - '/app/sigma_est.csv': posterior mean of sigma parameter`;

test("the obligation comes from the task's own output sentence, not from classification", () => {
  assert.deepEqual(requiredOutputPaths(RSTAN), ["/app/alpha_est.csv", "/app/sigma_est.csv"]);
  // A path the task merely HANDS you is not a deliverable.
  assert.deepEqual(
    requiredOutputPaths("You are given datasets /app/train_X.csv and a R script /app/gp_rstan.R."),
    [],
  );
  // Scoped to the sentence with the verb: tune-mjcf names its input and its
  // output in one line, and only the output is owed.
  assert.deepEqual(
    requiredOutputPaths("The initial model is at /app/model_ref.xml and should remain unchanged. "
      + "Tuned mjcf should be saved as /app/model.xml."),
    ["/app/model.xml"],
  );
  assert.deepEqual(requiredOutputPaths("Refactor the parser so the tests pass."), []);
});

test("done is refused while a named output is missing or empty, and allowed once written", () => {
  const ws = fs.mkdtempSync("/tmp/missing-out-");
  try {
    const done = [{ action: { a: "done", summary: "finished the conversion" } }];
    const opts = { task: RSTAN, workspace: ws };

    const objection = missingOutputsObjection(done, 0, opts);
    assert.ok(objection, "missing outputs must block");
    assert.match(objection, /alpha_est\.csv \(missing\)/);

    // In the arena the workspace IS /app, so the workspace-relative form is the
    // same file. Writing it there satisfies the obligation.
    fs.writeFileSync(path.join(ws, "alpha_est.csv"), "1.09\n");
    fs.writeFileSync(path.join(ws, "sigma_est.csv"), "");
    const stillBad = missingOutputsObjection(done, 0, opts);
    assert.ok(stillBad, "an EMPTY file is not a deliverable either");
    assert.match(stillBad, /sigma_est\.csv \(empty\)/);
    assert.doesNotMatch(stillBad, /alpha_est\.csv/, "the satisfied one must not be listed");

    fs.writeFileSync(path.join(ws, "sigma_est.csv"), "0.134\n");
    assert.equal(missingOutputsObjection(done, 0, opts), null, "all present and non-empty");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("bounded, and silent on tasks that name no output", () => {
  const ws = fs.mkdtempSync("/tmp/missing-out2-");
  try {
    const done = [{ action: { a: "done", summary: "x" } }];
    assert.equal(missingOutputsObjection(done, 2, { task: RSTAN, workspace: ws }), null, "must let go");
    assert.equal(
      missingOutputsObjection(done, 0, { task: "Refactor the parser.", workspace: ws }),
      null,
      "no named output, no obligation",
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("SEAM: the real done-gate chain carries it, last", async () => {
  const { DONE_GATES } = await import("../src/done-gates.js");
  const names = DONE_GATES.map((g) => g.name);
  assert.ok(names.includes("missing_outputs"), "must be registered");
  assert.equal(names[names.length - 1], "missing_outputs",
    "it is a backstop: every gate above names a CAUSE, this names the symptom");
});


// query-optimize (2026-08-21). The grader reads /app/my-sql-query.sql; the image
// SHIPS that path as a stub; the run was developing in sol.sql. The file exists
// and is non-empty, so an existence check passes while the deliverable was never
// written at all. A required output older than the run asked to produce it is
// not a deliverable.
test("a provided stub the run never rewrote is not a deliverable", () => {
  const ws = fs.mkdtempSync("/tmp/missing-out3-");
  try {
    const task = "Write your optimized query to /app/my-sql-query.sql";
    const done = [{ action: { a: "done", summary: "optimized the query" } }];
    const file = path.join(ws, "my-sql-query.sql");

    fs.writeFileSync(file, "SELECT 1;\n");
    const yesterday = (Date.now() - 86_400_000) / 1000;
    fs.utimesSync(file, yesterday, yesterday);
    const runStartedAt = Date.now();

    const objection = missingOutputsObjection(done, 0, { task, workspace: ws, runStartedAt });
    assert.ok(objection, "an untouched stub must not satisfy the task");
    assert.match(objection, /untouched/);

    fs.writeFileSync(file, "SELECT optimized;\n");
    assert.equal(
      missingOutputsObjection(done, 0, { task, workspace: ws, runStartedAt }),
      null,
      "once the run writes it, it counts",
    );

    // Callers that supply no start time keep the old existence-only behaviour:
    // a false "untouched" is worse than a missed one.
    assert.equal(missingOutputsObjection(done, 0, { task, workspace: ws }), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});


// Every one of these is a real instruction from the catalog, and every one was a
// FALSE POSITIVE at some point while this extractor was being tightened. A false
// "you did not write it" costs a correct run two rejections, so the obligation
// has to come only from a sentence that genuinely asks for a file.
test("real catalog instructions extract exactly their deliverables", () => {
  const cases = [
    // "I have saved it in /app/my-sql-query.sql" describes the INPUT to optimize;
    // "Please save your solution in the file /app/sol.sql" is the ask.
    ["Please save your solution in the file /app/sol.sql. This file must contain no comments.\n"
      + "I implemented a sql query but it is not optimized. I have saved it in /app/my-sql-query.sql.",
      ["/app/sol.sql"]],
    // "a desired output plasmid" is biology, not a file; only the titled file is owed.
    ["The file titled sequences.fasta contains the sequence for a circular input plasmid, "
      + "and a desired output plasmid. The output fasta file should be titled primers.fasta.",
      ["primers.fasta"]],
    // A period inside "e.g." is not a sentence end.
    ['To provide the final answer, write the integer number of tokens without spaces or commas '
      + '(e.g. "1000000") to the file /app/answer.txt.', ["/app/answer.txt"]],
    // The example model name is not a path to create.
    ["Please provide the name in organization/model_name format (e.g. BAAI/bge-small-en-v1.5) "
      + "of the best embedding model. Write the name to /app/result.txt.", ["/app/result.txt"]],
  ];
  for (const [task, expected] of cases) {
    assert.deepEqual(requiredOutputPaths(task), expected, task.slice(0, 60));
  }
});

test("resume credits a successful typed edit only while its same-turn fingerprint matches current bytes", async t => {
  const workspace = fs.mkdtempSync("/tmp/missing-output-resume-");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "result.js");
  const action = { a: "write_file", p: "result.js", content: "export const result = 1;\n" };
  const result = await new Executor(workspace).execute(action);
  assert.equal(result.editOutcome.applied, true);
  const tracker = new WorkspaceCoherenceTracker(workspace); tracker.refresh("result.js");
  const turn = JSON.parse(JSON.stringify({ parsedAction: action, editApplied: true,
    editOutcome: result.editOutcome, workspaceCoherence: { fingerprints: tracker.snapshot(), pendingPaths: [] } }));
  const old = new Date(Date.now() - 86400000); fs.utimesSync(file, old, old);
  const options = { workspace, task: "Write result.js", runStartedAt: Date.now() };
  assert.equal(missingOutputsObjection([turn], 0, options), null, "resumed clock must not erase recorded authorship");
  assert.match(missingOutputsObjection([], 0, options), /untouched/, "the same preexisting file without recorded work is still uncredited");

  for (const mutate of [
    row => { delete row.editOutcome; },
    row => { row.editOutcome.applied = false; },
    row => { row.editOutcome.reason = "syntax_invalid"; },
    row => { row.editApplied = false; },
    row => { row.editOutcome.paths = ["other.js"]; },
    row => { row.editOutcome.invalidated = true; },
    row => { row.shellScopeRollback = { violations: ["result.js"] }; },
    row => { row.controllerStop = { kind: "progress-gate" }; },
    row => { delete row.workspaceCoherence; },
    row => { row.workspaceCoherence.fingerprints["result.js"] = "file:33188:24:not-a-hash"; },
  ]) {
    const row = structuredClone(turn); mutate(row);
    assert.match(missingOutputsObjection([row], 0, options), /untouched/, mutate.toString());
  }
  assert.match(missingOutputsObjection([{ parsedAction: action, observation: "wrote result.js", editApplied: true,
    workspaceCoherence: turn.workspaceCoherence }], 0, options), /untouched/, "action, prose and read snapshot cannot assert authorship");
  const noFingerprint = structuredClone(turn); delete noFingerprint.workspaceCoherence;
  assert.match(missingOutputsObjection([noFingerprint, { workspaceCoherence: turn.workspaceCoherence }], 0, options), /untouched/,
    "a later read fingerprint does not bind bytes to an earlier successful edit");

  fs.writeFileSync(file, "export const result = 2;\n"); fs.utimesSync(file, old, old);
  assert.match(missingOutputsObjection([turn], 0, options), /untouched/, "same-length externally changed bytes do not match");
  fs.writeFileSync(file, action.content); fs.chmodSync(file, 0o600); fs.utimesSync(file, old, old);
  assert.match(missingOutputsObjection([turn], 0, options), /untouched/, "changed mode is not the recorded fingerprint");
  fs.chmodSync(file, 0o644);
  assert.match(missingOutputsObjection([turn, { shellChangedPaths: ["result.js"] }], 0, options), /untouched/);
  assert.match(missingOutputsObjection([turn, { workspaceCoherence: { pendingPaths: ["result.js"] } }], 0, options), /untouched/);
  assert.match(missingOutputsObjection([turn, { editOutcome: { applied: true, reason: "applied", paths: ["result.js"] } }], 0, options), /untouched/,
    "a later applied edit with unknown bytes cannot fall back to older proof");
  fs.writeFileSync(file, "");
  assert.match(missingOutputsObjection([turn], 0, options), /empty/, "authorship never waives empty content");
  fs.unlinkSync(file);
  assert.match(missingOutputsObjection([turn], 0, options), /missing/, "authorship never waives missing content");
});

test("resume authorship never credits a symlink as the recorded regular-file output", t => {
  const workspace = fs.mkdtempSync("/tmp/missing-output-resume-path-");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const target = path.join(workspace, "target.js"), output = path.join(workspace, "result.js");
  const content = "export const value = 1;\n";
  fs.writeFileSync(target, content); fs.symlinkSync("target.js", output);
  const old = new Date(Date.now() - 86400000); fs.utimesSync(target, old, old);
  const stat = fs.statSync(target);
  const turn = { editOutcome: { applied: true, reason: "applied", paths: ["result.js"] },
    workspaceCoherence: { fingerprints: { "result.js": `file:${stat.mode}:${stat.size}:${crypto.createHash("sha256").update(content).digest("hex")}` } } };
  assert.match(missingOutputsObjection([turn], 0, { workspace, task: "Write result.js", runStartedAt: Date.now() }), /untouched/);
});
