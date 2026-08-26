import assert from "node:assert/strict";
import test from "node:test";

import { artifactVerificationGateRejection } from "../src/progress-awareness.js";

// The workday refactor request says "capture the current output somewhere so
// you can prove behaviour still matches afterwards." The first budget-aware run
// did exactly that — `node joblog.js > baseline_output.txt` — and the artifact
// gate classified the capture as THE DELIVERABLE, then rejected the model's
// `read_file baseline_output.txt` as "avoiding validating the draft artifact"
// four times, and TERMINATED a healthy run at turn 11 of 45 with zero edits
// made. Three earlier passes of the same request never tripped it, for a
// one-character reason: they wrote their captures to /tmp.
//
// For a plain-text artifact, reading the file IS the check — the same
// permission document artifacts have had all along (isDocumentArtifactRead /
// review actions). This extends read-as-validation to any KNOWN artifact, so
// the gate stops rejecting the very act it demands.

test("reading the produced artifact satisfies the gate", () => {
  const r = artifactVerificationGateRejection(
    { a: "read_file", p: "baseline_output.txt" },
    { needsVerification: true, turnsSinceArtifact: 3, knownArtifacts: ["baseline_output.txt"] },
  );
  assert.equal(r, null, `a read of the artifact is a check of the artifact: ${r}`);
});

test("cat of the produced artifact satisfies it too", () => {
  const r = artifactVerificationGateRejection(
    { a: "shell", c: "cat baseline_output.txt" },
    { needsVerification: true, turnsSinceArtifact: 3, knownArtifacts: ["baseline_output.txt"] },
  );
  assert.equal(r, null, String(r));
});

test("unrelated reconnaissance is still gated", () => {
  const r = artifactVerificationGateRejection(
    { a: "read_file", p: "src/other.js" },
    { needsVerification: true, turnsSinceArtifact: 3, knownArtifacts: ["baseline_output.txt"] },
  );
  assert.match(String(r ?? ""), /Artifact verification gate/, "the gate still gates");
});

// The read-as-validation fix above was not enough. The next arm of the same
// A/B captured six baselines, then began the ACTUAL refactor — write_file
// src/args.js, src/log.js, src/status.js, src/progress.js — and the gate
// rejected each one as "avoiding validating the draft artifact" and terminated
// at turn 15 with the real work blocked.
//
// Root: arming. Any likely-artifact file the RUN creates put the run into
// artifact-verification mode, but the gate exists for tasks whose deliverable
// IS an output artifact — and those tasks name it. A task that names no
// artifact must never arm the gate over a scratch capture the model invented.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";

const model = (lines) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: lines.shift() ?? JSON.stringify({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

test("a code task with no named artifact never arms the gate over a capture", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-arm-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}');
  fs.writeFileSync(path.join(dir, "tool.js"), "console.log('x');\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await runAgent({
    task: "Refactor tool.js into modules. Capture the current output first so behaviour is provably unchanged.",
    workspace: dir,
    model: model([
      JSON.stringify({ a: "shell", c: "node tool.js > baseline_output.txt 2>&1; echo exit=$?" }),
      JSON.stringify({ a: "write_file", p: "src/core.js", content: "export const x = 1;\n" }),
      JSON.stringify({ a: "write_file", p: "src/cli.js", content: "export const y = 2;\n" }),
      JSON.stringify({ a: "done", summary: "split" }),
    ]),
    maxTurns: 7,
    useGrammar: false,
    shellSandbox: "host",
  });
  const gated = r.turns.filter((x) => /Artifact verification gate/.test(String(x.observation ?? "")));
  assert.equal(gated.length, 0, `the refactor must not be blocked: turns ${gated.map((x) => x.i).join(",")}`);
  assert.ok(fs.existsSync(path.join(dir, "src/core.js")), "the real work landed");
});

test("a task that NAMES its artifact still arms the gate", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-arm2-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}');
  fs.writeFileSync(path.join(dir, "data.txt"), "1\n2\n3\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await runAgent({
    task: "Produce results.csv summarising data.txt.",
    workspace: dir,
    model: model([
      JSON.stringify({ a: "shell", c: "echo 'n,1' > results.csv" }),
      JSON.stringify({ a: "read_file", p: "data.txt" }),
      JSON.stringify({ a: "read_file", p: "data.txt" }),
      JSON.stringify({ a: "read_file", p: "data.txt" }),
      JSON.stringify({ a: "done", summary: "made csv" }),
    ]),
    maxTurns: 8,
    useGrammar: false,
    shellSandbox: "host",
  });
  const gated = r.turns.filter((x) => /Artifact verification gate/.test(String(x.observation ?? "")));
  assert.ok(gated.length > 0, "unrelated reconnaissance after producing the NAMED artifact is still gated");
});
