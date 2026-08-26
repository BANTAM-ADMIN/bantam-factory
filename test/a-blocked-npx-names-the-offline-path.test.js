// The typewriter replay built for 55 turns, then stalled on a blocked
// `npm exec` — when the tool it wanted almost certainly sat in
// ./node_modules/.bin and would have run with no network at all. The block
// message said how to get networking; it never said the tool was probably
// already on disk. Context at the point of failure: an exec-style block now
// leads with the offline path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOfflineInstall } from "../src/offline-install.js";

test("a blocked npx/npm-exec leads with the node_modules/.bin fallback", () => {
  for (const cmd of ["npx tsc --noEmit", "npm exec vite build"]) {
    const c = classifyOfflineInstall(cmd);
    assert.ok(c?.blocked, `${cmd} is blocked in the no-network sandbox`);
    assert.match(c.message, /node_modules\/\.bin/, "the offline path is named");
    assert.match(c.message, /--offline --no-install/, "and the npm-native offline form");
  }
});

test("a blocked plain install does not get the exec fallback", () => {
  const c = classifyOfflineInstall("npm install lodash");
  assert.ok(c?.blocked);
  assert.doesNotMatch(c.message, /node_modules\/\.bin/, "installs genuinely need the network or a preinstall");
});

test("an exec block is a retryable observation, not a terminal block", async () => {
  const { Executor } = await import("../src/executor.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-execblock-"));
  const exec = new Executor(ws, { shellSandbox: "docker", shellNetwork: false });
  const r = await exec.execute({ a: "shell", c: "npx tsc --noEmit" });
  assert.match(r.observation, /node_modules\/\.bin/, "the retry path is in the observation");
  assert.equal(r.blocked, undefined, "the run continues — the model can act on the hint");
  const install = await exec.execute({ a: "shell", c: "npm install lodash" });
  assert.ok(install.blocked, "an install stays terminal: only the operator can add the network");
});
