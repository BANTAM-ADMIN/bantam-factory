import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { missingOutputsObjection, requiredOutputPaths } from "../src/logic/missing-outputs.js";
import { DONE_GATES } from "../src/done-gates.js";

// Self-contained excerpts of the observed card-2 failure, not an import of
// scored tests/candidates. The contract is to implement storage on invocation,
// not to leave a literal parameter-named snapshot in the development tree.
const SNAPSHOT_CONTRACT = `Extend the local CLI with:
node bin/repobrief.js snapshot --name NAME [--repo PATH]

Store each snapshot durably at \`.repobrief/snapshots/NAME.json\` as {name, treeDigest, files}. Create metadata directories as necessary. A successful \`snapshot\` prints that same parseable JSON shape on stdout and exits 0.`;

test("runtime snapshot contract does not demand a literal parameter artifact", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-runtime-output-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const name of ["NAME", "name", "release", "Current"]) {
    const task = SNAPSHOT_CONTRACT.replaceAll("NAME", name);
    assert.deepEqual(requiredOutputPaths(task), []);
    assert.equal(missingOutputsObjection([], 0, { task, workspace }), null);
    assert.equal(DONE_GATES.find((gate) => gate.name === "missing_outputs")
      .evaluate({ task, workspace, turns: [], count: () => 0 }), null);
  }
});

test("explicit runtime actors and invocation clauses do not become static output obligations", () => {
  for (const task of [
    "Build a CLI that must write .cache/latest.json when invoked.",
    "Implement a function that should save results/report.json.",
    "Implement a constructor that will create state/initial.json.",
    "The service must write these files:\n- logs/current.json\n- logs/archive.json",
    "When invoked, save the current data to state/current.json.",
    "Upon startup the handler should create cache/state.json.",
  ]) assert.deepEqual(requiredOutputPaths(task), [], task);
});

test("mixed software tasks retain explicit source, sample, and final-output requests", () => {
  const cases = [
    ["Write a script at tool.js. The script should save data/report.json. Also create README.md.",
      ["tool.js", "README.md"]],
    ["Create a CLI in bin/tool.js that must write results/output.json. Also write a sample to examples/sample.json.",
      ["bin/tool.js", "examples/sample.json"]],
    [SNAPSHOT_CONTRACT + "\n\nFor the handoff, save a real snapshot to examples/handoff.json before finishing.",
      ["examples/handoff.json"]],
    [SNAPSHOT_CONTRACT + " Also write README.md.", ["README.md"]],
    ["Build a local command-line tool.\n\nSave the results to these files:\n- report.json\n- summary.txt",
      ["report.json", "summary.txt"]],
    ["Write the final result to .repobrief/snapshots/NAME.json.", [".repobrief/snapshots/NAME.json"]],
    ["Run the CLI and save its output to report.json.", ["report.json"]],
    ["Build a CLI, but you must write handoff.md before finishing.", ["handoff.md"]],
    ["Build a CLI to write state/output.json when invoked, and also write README.md before finishing.", ["README.md"]],
    ["Build a CLI to write state/output.json when invoked; also write README.md before finishing.", ["README.md"]],
    [SNAPSHOT_CONTRACT.replace(" as {name, treeDigest, files}.", ", and also write README.md before finishing."), ["README.md"]],
    ["Save these files:\n- results.csv\n\n- input.json is supplied for analysis.", ["results.csv"]],
  ];
  for (const [task, expected] of cases) assert.deepEqual(requiredOutputPaths(task), expected, task);
});

test("runtime suppression leaves explicit missing/empty/untouched output gates strong", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-explicit-output-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const task = SNAPSHOT_CONTRACT + "\n\nSave the final handoff summary to result.json.";
  const opts = { task, workspace, runStartedAt: Date.now() };
  const output = path.join(workspace, "result.json");
  assert.match(missingOutputsObjection([], 0, opts), /result.json \(missing\)/);
  fs.writeFileSync(output, "");
  assert.match(missingOutputsObjection([], 0, opts), /result.json \(empty\)/);
  fs.writeFileSync(output, "{}");
  const old = (Date.now() - 86_400_000) / 1000;
  fs.utimesSync(output, old, old);
  assert.match(missingOutputsObjection([], 0, opts), /result.json \(untouched/);
  fs.writeFileSync(output, "{\"ready\":true}");
  assert.equal(missingOutputsObjection([], 0, opts), null);
});
