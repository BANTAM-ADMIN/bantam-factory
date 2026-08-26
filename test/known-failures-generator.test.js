import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const kf = require("../tools/known-failures.cjs");

// The done-gates read .bantam/known-failures.json (loadKnownFailures in
// src/done-guard.js: a top-level `failures` array of strings, substring-matched
// against `not ok` test names). This test proves the generator that writes it:
// the TAP parser and the --check comparison, driven by a fake test command
// instead of the real suite.

const TAP = [
  "TAP version 13",
  "# Subtest: a passing test",
  "ok 1 - a passing test",
  "# Subtest: the inherited red",
  "not ok 2 - the inherited red",
  "  ---",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "# Subtest: a brand new regression",
  "not ok 3 - a brand new regression",
  "  ---",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "1..3",
  "# tests 3",
  "# pass 1",
  "# fail 2",
].join("\n");

test("parseNotOkNames pulls only the `not ok N - name` lines, deduped", () => {
  assert.deepEqual(kf.parseNotOkNames(TAP), ["the inherited red", "a brand new regression"]);
});

test("parseNotOkNames tolerates nesting, annotations, and empty output", () => {
  assert.deepEqual(
    kf.parseNotOkNames("  not ok 7 - nested subtest # todo\nok 8 - fine\nnot ok 7 - nested subtest"),
    ["nested subtest"],
  );
  assert.deepEqual(kf.parseNotOkNames(""), []);
  assert.deepEqual(kf.parseNotOkNames(null), []);
});

test("checkFailures splits new failures from retired manifest entries", () => {
  const r = kf.checkFailures(["the inherited red", "a brand new regression"], ["the inherited red", "an old red that now passes"]);
  assert.deepEqual(r.newFailures, ["a brand new regression"]);
  assert.deepEqual(r.retired, ["an old red that now passes"]);
});

test("checkFailures matches manifest entries by substring either way", () => {
  // manifest holds a short token; the failing name is the long test name
  const r = kf.checkFailures(["factory claims command"], ["factory claims"]);
  assert.deepEqual(r.newFailures, []);
  assert.deepEqual(r.retired, []);
});

test("checkFailures on a clean run retires every manifest entry", () => {
  const r = kf.checkFailures([], ["the inherited red"]);
  assert.deepEqual(r.newFailures, []);
  assert.deepEqual(r.retired, ["the inherited red"]);
});

// End-to-end with a FAKE test command: a tiny script that prints TAP and
// exits 1, so --write and --check exercise the real spawn + parse + manifest
// path without running the workspace suite. The TAP goes in a file (not an
// inline `node -e` string) so the fake command stays a single-quoted shell
// token that survives being JSON-quoted into the outer spawn.
function fakeCmd(t, dir, name, tapText) {
  const script = path.join(dir, name);
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(tapText)});\nprocess.exit(1);\n`);
  return `node ${JSON.stringify(script)}`;
}

test("--write records the failing names, date, and command; --check then agrees", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tools", "known-failures.cjs");
  const cmd = fakeCmd(t, dir, "fake1.js", TAP);

  const w = kf.runCommand(`cd ${JSON.stringify(dir)} && node ${JSON.stringify(tool)} --write --cmd ${JSON.stringify(cmd)}`);
  assert.equal(w.status, 0, `--write should succeed: ${w.output}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".bantam", "known-failures.json"), "utf8"));
  assert.deepEqual(manifest.failures, ["the inherited red", "a brand new regression"]);
  assert.equal(manifest.command, cmd);
  assert.match(manifest.recorded, /^\d{4}-\d{2}-\d{2}$/, "a recorded date is written");
  assert.match(w.output, /wrote \.bantam\/known-failures\.json/, "it prints what it wrote");

  // same reds still failing → no new, no retired, exit 0
  const c = kf.runCommand(`cd ${JSON.stringify(dir)} && node ${JSON.stringify(tool)} --check --cmd ${JSON.stringify(cmd)}`);
  assert.equal(c.status, 0, `--check on an unchanged baseline exits 0: ${c.output}`);
  assert.match(c.output, /nothing new, nothing retired/);

  // a NEW red appears → reported and exit 1
  const TAP2 = TAP + "\nnot ok 4 - a second regression\n";
  const c2 = kf.runCommand(`cd ${JSON.stringify(dir)} && node ${JSON.stringify(tool)} --check --cmd ${JSON.stringify(fakeCmd(t, dir, "fake2.js", TAP2))}`);
  assert.equal(c2.status, 1, `--check with a new failure exits 1: ${c2.output}`);
  assert.match(c2.output, /NEW failures/);
  assert.match(c2.output, /a second regression/);

  // a manifest red heals → flagged for retirement, still exit 0 (no NEW failures)
  const TAP3 = "ok 1 - a passing test\n";
  const c3 = kf.runCommand(`cd ${JSON.stringify(dir)} && node ${JSON.stringify(tool)} --check --cmd ${JSON.stringify(fakeCmd(t, dir, "fake3.js", TAP3))}`);
  assert.equal(c3.status, 0, `--check with only healed reds exits 0: ${c3.output}`);
  assert.match(c3.output, /candidates for retirement/);
  assert.match(c3.output, /the inherited red/);
});
