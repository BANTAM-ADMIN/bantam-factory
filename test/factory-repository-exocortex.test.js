import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { compileRepositoryShiftPacket, renderRepositoryExocortex, RepositoryGovernanceCell } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-exocortex-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 7;\n");
  fs.writeFileSync(path.join(root, "src", "api.js"), "import { core } from './core.js';\nexport const api = core;\n");
  fs.writeFileSync(path.join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\nvoid api;\n");
  return root;
}

const governance = {
  requirement: "requirement:stable-core",
  component: "src/core.js",
  test: "test/api.test.js",
  authority: "authority:release-board",
  fingerprint: "current",
};

function packet(cell, options = {}) {
  return compileRepositoryShiftPacket({
    task: "Safely assess and verify the core change",
    bus: cell.bus,
    registry: cell.registry,
    cell: cell.cell,
    focus: { paths: ["src/core.js"], requirements: [governance.requirement] },
    ...options,
  });
}

describe("repository worker exocortex", () => {
  it("compiles stored semantic computation into a bounded ready-state shift packet", () => {
    const cell = new RepositoryGovernanceCell({ root: fixture() });
    const cycle = cell.cycle({ changedPaths: ["src/core.js"], governance });
    const result = packet(cell);

    assert.equal(result.chassis.repositoryFingerprint, cycle.source.fingerprint);
    assert.equal(result.summary.releaseDisposition, "ready-for-authority-review");
    assert.ok(result.products.some((row) => row.predicate === "release_ready"));
    assert.ok(result.buttons.some((row) => row.operation === "run-verification"));
    assert.ok(result.buttons.some((row) => row.operation === "request-release-decision"));
    assert.equal(result.buttons.every((row) => row.authority === "propose-only"), true);
    assert.match(result.briefing, /STOP: Do not treat release_ready as deployment authority/);
    assert.ok(result.estimatedTokens > 0);
    assert.equal(Object.isFrozen(result.products[0]), true);
  });

  it("turns stale proof into explicit worker buttons and honors the context fixture", () => {
    const root = fixture(), cell = new RepositoryGovernanceCell({ root });
    cell.cycle({ changedPaths: ["src/core.js"], governance });
    fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 8;\n");
    cell.cycle({ changedPaths: ["src/core.js"] });
    const result = packet(cell, { limits: { maxProducts: 3, maxDependenciesPerProduct: 2 } });

    assert.equal(result.summary.releaseDisposition, "blocked");
    assert.equal(result.products.length, 3);
    assert.ok(result.omissions.count > 0);
    assert.deepEqual(result.andons.filter((row) => row.severity === "critical").map((row) => row.code).sort(), ["stale-authority", "stale-evidence"]);
    assert.ok(result.buttons.some((row) => row.operation === "refresh-evidence"));
    assert.ok(result.buttons.some((row) => row.operation === "request-approval"));
    assert.equal(result.buttons.some((row) => row.operation === "request-release-decision"), false);
    assert.equal(result.products.every((row) => row.dependencies.length <= 2), true);
  });

  it("has stable identity when the chassis and task are unchanged", () => {
    const cell = new RepositoryGovernanceCell({ root: fixture() });
    cell.cycle({ changedPaths: ["src/core.js"], governance });
    const first = packet(cell);
    cell.cycle({ changedPaths: ["src/core.js"], governance });
    const second = packet(cell);
    assert.equal(second.packetId, first.packetId);
    assert.equal(second.briefing, first.briefing);
  });

  it("renders the exact backend cell and packet as a safe interactive floor", () => {
    const cell = new RepositoryGovernanceCell({ root: fixture() });
    const cycle = cell.cycle({ changedPaths: ["src/core.js"], governance });
    const result = packet(cell);
    const html = renderRepositoryExocortex({ projection: cycle.projection, packet: result });
    assert.match(html, /Living Repository Twin/);
    assert.match(html, /release-control/);
    assert.match(html, /OBSERVE \+ PROPOSE ONLY/);
    assert.match(html, new RegExp(result.packetId));
    assert.equal((html.match(/id="factory-data"/g) ?? []).length, 1);
  });
});
