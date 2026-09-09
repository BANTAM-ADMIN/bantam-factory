// The landing window's verification is a real test run, so it is the same
// evidence the regression guard acts on. It was never wired into it, which left
// one specific way to lose a run: reach green, edit again in the last turns,
// never re-verify, and end red with a verified-good snapshot sitting unused.
//
// Reproduced from Ornith 35B / range-parser (2026-07-26): green at turn 11, an
// "improvement" at turn 12 moved a hyphen inside a regex capture group and broke
// the only public assertion, turn 13 diagnosed it correctly, budget ran out.
//
// These use a real `node --test` suite rather than a bare exit code, because the
// guard snapshots only when it can parse test COUNTS from the observation.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

const VERIFY = "node --test";

function temporaryWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-landing-revert-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(
    path.join(dir, "target.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("exports good", () => {',
      '  delete require.cache[require.resolve("./target.js")];',
      '  assert.equal(require("./target.js"), "good");',
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "target.js"), "module.exports='bad'");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

const write = (content) => JSON.stringify({ a: "write_file", p: "target.js", content });
const runTests = JSON.stringify({ a: "shell", c: VERIFY });

const base = {
  task: "Make the test suite pass.",
  maxTurns: 3,
  interactive: false,     // the landing window is headless-only
  useGrammar: false,
  grounding: null,
  shellSandbox: "host",
  verificationScript: VERIFY,
};

describe("landing-window regression revert", () => {
  it("restores the best-passing snapshot when the endgame verify fails on unverified edits", async (t) => {
    const workspace = temporaryWorkspace(t);
    const result = await runAgent({
      ...base,
      workspace,
      model: scriptedModel([
        write("module.exports='good'"),
        runTests,                            // green -> snapshot captured here
        write("module.exports='improved'"),  // breaks it, never re-verified
      ]),
    });

    assert.equal(
      fs.readFileSync(path.join(workspace, "target.js"), "utf8"),
      "module.exports='good'",
      "the best-passing snapshot should have been restored",
    );
    assert.equal(result.metrics.landingReverts, 1);
    assert.equal(result.verification.status, "pass");
  });

  it("does not revert when the endgame verify passes", async (t) => {
    const workspace = temporaryWorkspace(t);
    const result = await runAgent({
      ...base,
      workspace,
      model: scriptedModel([
        write("module.exports='good'"),
        runTests,
        JSON.stringify({ a: "done", summary: "done" }),
      ]),
    });

    assert.equal(result.metrics.landingReverts ?? 0, 0);
    assert.equal(result.verification.status, "pass");
  });

  it("does not revert a failing tree the model never got green", async (t) => {
    const workspace = temporaryWorkspace(t);
    // `bestPassed` starts at -1, so a 0/1 failing run is legitimately "best so
    // far" and gets snapshotted. Restoring that at the boundary would discard
    // the model's real work to reinstate something equally broken, so only a
    // fully-green snapshot may be restored. The model's own last bytes must
    // survive untouched.
    const result = await runAgent({
      ...base,
      workspace,
      model: scriptedModel([
        write("module.exports='still-bad'"),
        runTests,
        write("module.exports='also-bad'"),
      ]),
    });

    assert.equal(result.metrics.landingReverts ?? 0, 0);
    const landed = fs.readFileSync(path.join(workspace, "target.js"), "utf8");
    assert.match(
      landed,
      /still-bad|also-bad/,
      "the file must hold one of the model's own writes, not a restored snapshot",
    );
    assert.equal(result.verification.status, "fail");
  });
});


describe('changed assertion baseline', () => {
  for(const route of ['direct','shell']) it(`retains a strengthened test through ${route} edits and landing verification`, async t => {
    const workspace=temporaryWorkspace(t);
    const original=fs.readFileSync(path.join(workspace,'target.test.js'),'utf8')+'\n// retained test\n';
    const stronger=original.replace('"good"','"required"');
    const modify=route==='direct'
      ? {a:'write_file',p:'target.test.js',content:stronger}
      : {a:'shell',c:`node -e 'const fs=require("fs");fs.writeFileSync("target.test.js",${JSON.stringify(stronger)})'`};
    const events=[];
    const result=await runAgent({...base,workspace,maxTurns:5,completionAudit:false,diagnoseStuckTests:false,
      autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
      model:scriptedModel([write("module.exports='good'"),JSON.stringify({a:"write_file",p:"target.test.js",content:original}),runTests,JSON.stringify(modify),runTests]),
      onEvent:e=>events.push(e)});
    assert.equal(fs.readFileSync(path.join(workspace,'target.test.js'),'utf8'),stronger);
    assert.equal(result.verification.status,'fail');
    assert.equal(result.metrics.regressionReverts ?? 0,0);
    assert.equal(result.metrics.landingReverts ?? 0,0);
    assert.ok(events.some(e=>e.type==='regression_baseline_invalidated'));
  });
});
