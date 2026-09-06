import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";

test("live Docker rejects writable-only test proof, then accepts a temporary-directory repair", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1"
    ? "set BANTAM_LIVE_SANDBOX_TEST=1 to exercise the installed Docker sandbox" : false,
  timeout: 45000,
}, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-live-verifier-parity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "test"));
  const supplied = {
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }) + "\n",
    "value.js": "export function value() { return 7; }\n",
    "test/public.test.js": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "../value.js";',
      'test("supplied value behavior", () => assert.equal(value(), 7));',
      "",
    ].join("\n"),
  };
  for (const [relative, content] of Object.entries(supplied)) {
    fs.writeFileSync(path.join(workspace, relative), content);
  }
  const addedTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'import { value } from "../value.js";',
    'test("value survives a file round trip", () => {',
    '  const fixtureRoot = process.cwd();',
    '  const directory = fs.mkdtempSync(path.join(fixtureRoot, "value-fixture-"));',
    '  try {',
    '    const fixture = path.join(directory, "value.txt");',
    '    fs.writeFileSync(fixture, String(value()));',
    '    assert.equal(fs.readFileSync(fixture, "utf8"), "7");',
    '  } finally {',
    '    fs.rmSync(directory, { recursive: true, force: true });',
    '  }',
    '});',
    "",
  ].join("\n");
  const actions = [
    { a: "write_file", p: "test/extra.test.js", content: addedTest },
    { a: "shell", c: "npm test" },
    { a: "done", summary: "Added the file round-trip check." },
    { a: "replace", p: "test/extra.test.js", old: "const fixtureRoot = process.cwd();", new: "const fixtureRoot = os.tmpdir();" },
    { a: "shell", c: "npm test" },
    { a: "done", summary: "The file round-trip check now uses writable temporary storage." },
  ];
  const prompts = [];
  const result = await runAgent({
    workspace,
    task: "Add a file round-trip test for value(). Do not modify value.js, package.json or existing public tests. You may add tests.",
    model: { assistantPrefill: "", async complete(prompt) {
      prompts.push(prompt);
      assert.ok(actions.length > 0, "unexpected extra worker call");
      return { content: JSON.stringify(actions.shift()), tokens: 1, timings: {}, stoppedEos: true, stoppedLimit: false };
    } },
    maxTurns: 6, interactive: true, useGrammar: false, grounding: false,
    shellSandbox: "docker", shellNetwork: false,
    verificationScript: "npm test", verificationWorkspaceReadOnly: true,
    completionAudit: false, stateAudit: "off", contractStateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
  });

  assert.equal(result.turns.length, 6);
  assert.equal(result.turns[0].editApplied, true);
  assert.equal(result.turns[1].verificationEvidence.status, "pass");
  assert.equal(result.turns[1].verificationEvidence.workspaceReadOnly, false);
  assert.equal(result.turns[2].verificationEvidence.status, "fail");
  assert.equal(result.turns[2].verificationEvidence.workspaceReadOnly, true);
  assert.match(result.turns[2].observation, /read-only check did not pass/);
  assert.match(result.turns[2].observation, /EROFS/);
  assert.match(prompts[3], /EROFS/, "the worker sees the actual read-only failure before repairing");
  assert.equal(result.turns[3].editApplied, true);
  assert.equal(result.turns[4].verificationEvidence.status, "pass");
  assert.equal(result.turns[4].verificationEvidence.workspaceReadOnly, false);
  assert.equal(result.turns[5].verificationEvidence.status, "pass");
  assert.equal(result.turns[5].verificationEvidence.workspaceReadOnly, true);
  assert.equal(result.done, true);
  assert.equal(result.verification.status, "pass");
  assert.equal(result.verification.workspaceReadOnly, true);
  assert.match(prompts[0], /entire source workspace READ-ONLY/);
  for (const [relative, content] of Object.entries(supplied)) {
    assert.equal(fs.readFileSync(path.join(workspace, relative), "utf8"), content, `${relative} remains unchanged`);
  }
  assert.equal(fs.readFileSync(path.join(workspace, "test/extra.test.js"), "utf8"),
    addedTest.replace("const fixtureRoot = process.cwd();", "const fixtureRoot = os.tmpdir();"));
  assert.ok(!fs.readdirSync(workspace).some(name => name.startsWith("value-fixture-")));
});
