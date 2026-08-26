import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { RepositoryGovernanceCell } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-delta-sensor-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 7;\n");
  fs.writeFileSync(path.join(root, "src", "api.js"), "import { core } from './core.js';\nexport const api = core;\n");
  fs.writeFileSync(path.join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\nvoid api;\n");
  return root;
}

const governance = { requirement: "requirement:stable-core", component: "src/core.js", test: "test/api.test.js", authority: "authority:release-board", fingerprint: "current" };

describe("attested repository delta receiving dock", () => {
  it("refreshes one named record, preserves quiet wickets, and detects real changed bytes", () => {
    const root = fixture(), cell = new RepositoryGovernanceCell({ root });
    const first = cell.cycleDelta({ delta: { cursor: "watch:1", previousCursor: null, changedPaths: ["src/core.js"] }, governance });
    assert.equal(first.source.sensor.mode, "full-audit");
    assert.equal(first.source.sensor.refreshed.length, 3);

    const before = cell.bus.basis();
    const quiet = cell.cycleDelta({ delta: { cursor: "watch:2", previousCursor: "watch:1", changedPaths: ["src/core.js"] }, governance });
    assert.equal(quiet.source.sensor.mode, "changed-files-noop");
    assert.deepEqual(quiet.source.sensor.refreshed, ["src/core.js"]);
    assert.equal(quiet.source.operationCount, 0);
    assert.deepEqual(cell.bus.basis(), before);

    fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 8;\n");
    const changed = cell.cycleDelta({ delta: { cursor: "watch:3", previousCursor: "watch:2", changedPaths: ["src/core.js"] } });
    assert.notEqual(changed.source.fingerprint, first.source.fingerprint);
    assert.equal(changed.source.sensor.refreshed.length, 1);
    assert.deepEqual(changed.evaluations["release-control"].conclusions.map((row) => row.predicate).sort(), ["release_blocked_stale_authority", "release_blocked_stale_evidence"]);
  });

  it("refuses cursor gaps before touching the Fact Bus", () => {
    const cell = new RepositoryGovernanceCell({ root: fixture() });
    cell.cycleDelta({ delta: { cursor: "watch:10", previousCursor: null, changedPaths: ["src/core.js"] }, governance });
    const basis = cell.bus.basis();
    assert.throws(() => cell.cycleDelta({ delta: { cursor: "watch:12", previousCursor: "watch:11", changedPaths: ["src/core.js"] } }), /cursor discontinuity/);
    assert.deepEqual(cell.bus.basis(), basis);
  });

  it("uses a conservative full audit when graph configuration or deleted source changes", () => {
    const root = fixture(), cell = new RepositoryGovernanceCell({ root });
    const first = cell.cycleDelta({ delta: { cursor: "watch:a", previousCursor: null, changedPaths: ["src/core.js"] }, governance });
    fs.writeFileSync(path.join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    const control = cell.cycleDelta({ delta: { cursor: "watch:b", previousCursor: "watch:a", changedPaths: ["jsconfig.json"] } });
    assert.equal(control.source.sensor.mode, "full-audit");
    assert.equal(control.source.sensor.conservativeFallback, true);
    assert.notEqual(control.source.fingerprint, first.source.fingerprint);

    fs.rmSync(path.join(root, "src", "api.js"));
    const removed = cell.cycleDelta({ delta: { cursor: "watch:c", previousCursor: "watch:b", changedPaths: ["src/api.js"] } });
    assert.deepEqual(removed.source.sensor.removed, ["src/api.js"]);
    assert.equal(removed.source.sensor.conservativeFallback, true);
    assert.equal(cell.bus.view("accepted").has("src/api.js", "repo/file", true), false);
  });
});
