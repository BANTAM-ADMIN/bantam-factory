import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Executor } from "../src/executor.js";
import { runAgent } from "../src/agent.js";
import { runShellProcess } from "../src/executor.js";
import { composeInstructionGuards } from "../src/instruction-guard.js";

const before = 'export function report(xs) {\n  const out = [...xs];\n  out.sort();\n  return out;\n}\n';
const after = 'export function report(xs) {\n  const out = [...xs];\n  return out;\n}\nfunction cli() { console.log("ready"); }\n';
const preserved = before + 'function cli() { console.log("ready"); }\n';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-edit-preserve-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.mjs"), before);
  return { workspace, executor: new Executor(workspace, { shellSandbox: "host" }) };
}

for (const action of [
  { a: "replace", p: "source.mjs", old: before, new: after },
  { a: "replace", p: "source.mjs", old: before, new: after, line: 1 },
  { a: "edit_lines", p: "source.mjs", start: 1, end: 6, new: after },
  { a: "write_file", p: "source.mjs", content: after },
  { a: "patch", edits: [{ p: "source.mjs", old: before, new: after }] },
  { a: "write_batch", files: [{ p: "source.mjs", content: after }] },
]) test(`${action.a}${action.line ? " at line" : ""}: additive deletion is reviewed before mutation, identical retry can confirm`, async t => {
  const { workspace, executor } = fixture(t);
  const first = await executor.execute(action);
  assert.equal(first.editOutcome.applied, false);
  assert.equal(first.editOutcome.reason, "confirmation_required");
  assert.match(first.observation, /edit-preservation/);
  assert.match(first.observation, /out\.sort/);
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), before);
  assert.equal(first.editOutcome.preservationReviews[0].decision, "review-required");
  const second = await executor.execute(action);
  assert.equal(second.editOutcome.applied, true, second.observation);
  assert.equal(second.editOutcome.preservationReviews[0].decision, "confirmed");
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), after);
});

test("correcting the proposal preserves previous behavior without an extra confirmation", async t => {
  const { workspace, executor } = fixture(t);
  await executor.execute({ a: "write_file", p: "source.mjs", content: after });
  const result = await executor.execute({ a: "write_file", p: "source.mjs", content: preserved });
  assert.equal(result.editOutcome.applied, true);
  assert.equal(result.editOutcome.preservationReviews, undefined);
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), preserved);
});

test("two-file write transaction retains earlier confirmation until all files can commit", async t => {
  const { workspace, executor } = fixture(t);
  fs.writeFileSync(path.join(workspace, "second.mjs"), before);
  const action = { a: "write_batch", files: [
    { p: "source.mjs", content: after }, { p: "second.mjs", content: after },
  ] };
  for (let i = 0; i < 2; i++) {
    const result = await executor.execute(action);
    assert.equal(result.editOutcome.applied, false);
    for (const file of ["source.mjs", "second.mjs"]) assert.equal(fs.readFileSync(path.join(workspace, file), "utf8"), before);
  }
  const result = await executor.execute(action);
  assert.equal(result.editOutcome.applied, true, result.observation);
  for (const file of ["source.mjs", "second.mjs"]) assert.equal(fs.readFileSync(path.join(workspace, file), "utf8"), after);
});

test("confirmation is bound to exact before and after bytes", async t => {
  const { executor } = fixture(t);
  await executor.execute({ a: "write_file", p: "source.mjs", content: after });
  const result = await executor.execute({ a: "write_file", p: "source.mjs", content: after.replace("ready", "changed") });
  assert.equal(result.editOutcome.applied, false);
  assert.equal(result.editOutcome.preservationReviews[0].decision, "review-required");
});

test("live Docker protects existing tests while permitting a new test file", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1", timeout: 20000,
}, async t => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  const supplied = path.join(workspace, "test", "public.test.js");
  fs.writeFileSync(supplied, "// supplied test\n");
  const { protectedExistingTests } = composeInstructionGuards({ workspace,
    instruction: "Do not modify existing public tests. You may add tests." });
  const result = await runShellProcess(workspace,
    'node -e \'const f=require("fs"); let denied=false; try { f.appendFileSync("test/public.test.js","changed"); } catch(e) { if(e.code!=="EROFS")throw e; denied=true; } if(!denied)process.exit(1); f.writeFileSync("test/new.test.js","// new test\\n");\'',
    { shellSandbox: "docker", shellNetwork: false, readOnlyWorkspacePaths: protectedExistingTests, timeoutMs: 15000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(supplied, "utf8"), "// supplied test\n");
  assert.equal(fs.readFileSync(path.join(workspace, "test/new.test.js"), "utf8"), "// new test\n");
});

test("live agent receives concrete removal evidence and persists the review decision", async t => {
  const { workspace } = fixture(t), calls = [], events = [];
  const actions = [
    { a: "write_file", p: "source.mjs", content: after },
    { a: "write_file", p: "source.mjs", content: preserved },
    { a: "respond", text: "Added the CLI while preserving existing behavior." },
  ];
  const result = await runAgent({ workspace, task: "Add a CLI to source.mjs while preserving its existing behavior.",
    model: { assistantPrefill: "", async complete(prompt) {
      calls.push(prompt);
      return { content: JSON.stringify(actions.shift() ?? { a: "done", summary: "Added CLI." }), tokens: 1, timings: {} };
    } }, maxTurns: 4, interactive: true, grounding: false, shellSandbox: "host",
    completionAudit: false, verificationPolicy: "after_edit", onEvent: event => events.push(event),
  });
  assert.match(calls[1], /edit-preservation/);
  assert.match(calls[1], /out\.sort/);
  assert.equal(result.turns[0].editApplied, false);
  assert.equal(result.turns[0].editOutcome.preservationReviews[0].decision, "review-required");
  assert.ok(events.some(event => event.type === "edit_preservation_review"));
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), preserved);
});
