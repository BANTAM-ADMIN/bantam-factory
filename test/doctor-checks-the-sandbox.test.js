import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { runChecks } from "../src/doctor.js";

// CI 2026-09-05. `doctor` reported "✔ endpoint reachable → You're set" on a
// machine where every shell action would fail with `exit 125: No such image`.
// It never looked at the sandbox, and the endpoint branch short-circuits the
// rest of the chain, so the one broken link was the one link never checked.
//
// The sandbox runs `docker run --pull never` on purpose — a model-chosen action
// must never reach a registry — so the base image has to be there already.
// Nothing pulls it for you, which makes this a setup step doctor owns.

const base = {
  nodeVersion: "v20.19.4",
  detectEndpoint: async () => "http://localhost:8085",
  loadedModel: async () => "a-model",
  whichLlama: () => null,
  gpuInfo: () => null,
  scanGgufs: () => [],
  listModels: () => [],
};
const sandbox = (r) => r.checks.find((c) => c.name === "sandbox");

test("a missing sandbox image is a failure, with the exact pull command", async () => {
  const r = await runChecks({ ...base,
    sandboxProbe: () => ({ mode: "docker", image: "alpine:3", dockerFound: true, imagePresent: false }) });
  assert.equal(sandbox(r).status, "fail");
  assert.match(sandbox(r).remedy, /docker pull alpine:3/);
  assert.match(sandbox(r).remedy, /--pull never/, "say why it cannot fetch this itself");
});

test("a reachable model does NOT mean ready when the sandbox is broken", async () => {
  // The regression that shipped: the endpoint branch returned ready:true and
  // "You're set" without consulting any other check.
  const r = await runChecks({ ...base,
    sandboxProbe: () => ({ mode: "docker", image: "alpine:3", dockerFound: true, imagePresent: false }) });
  assert.equal(r.ready, false, "a harness that cannot run a command is not ready");
  assert.match(r.nextAction, /shell actions cannot run/);
  assert.doesNotMatch(r.nextAction, /You're set/);
});

test("missing docker is named as the reason, not left as a mystery", async () => {
  const r = await runChecks({ ...base,
    sandboxProbe: () => ({ mode: "docker", image: "alpine:3", dockerFound: false, imagePresent: false }) });
  assert.equal(sandbox(r).status, "fail");
  assert.match(sandbox(r).remedy, /Install Docker/i);
  assert.match(sandbox(r).remedy, /BANTAM_SHELL_SANDBOX=host/);
});

test("host mode is reported as the isolation loss it is", async () => {
  const r = await runChecks({ ...base,
    sandboxProbe: () => ({ mode: "host", image: "alpine:3", dockerFound: false, imagePresent: false }) });
  assert.equal(sandbox(r).status, "warn");
  assert.match(sandbox(r).detail, /no container isolation/);
  assert.equal(r.ready, true, "host mode is a deliberate choice, not a broken setup");
});

test("a healthy sandbox passes and keeps the happy path intact", async () => {
  const r = await runChecks({ ...base,
    sandboxProbe: () => ({ mode: "docker", image: "alpine:3", dockerFound: true, imagePresent: true }) });
  assert.equal(sandbox(r).status, "pass");
  assert.equal(r.ready, true);
  assert.match(r.nextAction, /You're set/);
});

test("every runChecks call site wires the sandbox probe — no drift", () => {
  // There are two call sites in the CLI. The first fix landed in one of them and
  // `bantam doctor` went on reporting nothing, because it runs the other.
  const cli = fs.readFileSync(new URL("../bin/bantam.js", import.meta.url), "utf8");
  // Scan a window after each call opening rather than trying to brace-match: the
  // argument objects contain nested braces that defeat a naive regex.
  const sites = [...cli.matchAll(/runChecks\(\{/g)].map((m) => m.index);
  assert.ok(sites.length >= 2, `expected both call sites, found ${sites.length}`);
  for (const at of sites) {
    const window = cli.slice(at, at + 900);
    assert.match(window, /sandboxProbe/, `a runChecks call site omits sandboxProbe:\n${window.slice(0, 220)}`);
  }
});
