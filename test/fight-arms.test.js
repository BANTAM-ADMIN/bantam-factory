// Fight corners must stay launchable. The arms table is the one part of the
// fight that reaches outside the process, so a rename of a bantam flag or a
// moved binary breaks it silently — the lane just dies at 0s and the card
// records a loss that never happened.
//
// A separate file from fight.test.js on purpose: that one is being edited by
// another session, and a new file cannot collide with in-flight work.
import assert from "node:assert/strict";
import test from "node:test";

import { ARMS, buildArmCommand } from "../src/fight.js";
import { parseArgs } from "../src/cli-args.js";

test("every arm builds a command with an executable and arguments", () => {
  for (const name of Object.keys(ARMS)) {
    const c = buildArmCommand(name, { task: "do the thing" });
    assert.ok(c.exe, `${name} has no exe`);
    assert.ok(Array.isArray(c.args), `${name} has no args`);
    assert.ok(["local", "cloud"].includes(ARMS[name].pool), `${name} needs a pool for governor-halt filtering`);
    assert.ok(ARMS[name].corner && ARMS[name].color, `${name} needs a corner label and colour for the page`);
  }
});

test("the task reaches every arm's command line", () => {
  for (const name of Object.keys(ARMS)) {
    const c = buildArmCommand(name, { task: "UNIQUE_TASK_MARKER" });
    const carried = c.args.some((a) => String(a).includes("UNIQUE_TASK_MARKER"))
      || String(c.stdinText ?? "").includes("UNIQUE_TASK_MARKER");
    assert.ok(carried, `${name} drops the task — the lane would run an empty prompt`);
  }
});

test("bantam arms pass flags this build actually parses", () => {
  // A flag that BANTAM no longer accepts does not error loudly in a fight; the
  // lane just fails. Parse each bantam arm's argv the way bin/bantam.js does.
  for (const name of Object.keys(ARMS)) {
    const c = buildArmCommand(name, { task: "T" });
    if (c.exe !== "node") continue;
    const argv = c.args.slice(1); // drop the script path
    if (!argv.length) continue;
    const parsed = parseArgs(argv);
    assert.equal(parsed._[0], "run", `${name} should use headless run mode`);
    assert.equal(parsed.task, "T");
    assert.ok(parsed.autonomous === true, `${name} should run with the unattended gates`);
  }
});

test("the codex corner isolates the harness, not the model", () => {
  // codex-sol runs the raw CLI; bantam-codex runs the SAME model through
  // BANTAM. If they ever drift apart the comparison stops meaning anything.
  const raw = buildArmCommand("codex-sol", { task: "T" });
  const harnessed = buildArmCommand("bantam-codex", { task: "T" });
  const model = "gpt-5.6-sol";
  assert.ok(raw.args.includes(model), "codex-sol must pin its model");
  assert.ok(harnessed.args.includes(model), "bantam-codex must pin the SAME model");
  assert.equal(ARMS["bantam-codex"].pool, "cloud", "it spends the Codex account, so it sits out a governor halt");
});

test("a cloud-only card needs no local model at all", () => {
  const cloud = Object.keys(ARMS).filter((a) => ARMS[a].pool === "cloud");
  assert.ok(cloud.length >= 3, "a fight should be runnable with the GPU cold");
  for (const name of cloud) {
    const c = buildArmCommand(name, { task: "T" });
    const env = JSON.stringify(c.env ?? {});
    assert.doesNotMatch(env, /127\.0\.0\.1:8085/, `${name} points at the local server`);
  }
});
