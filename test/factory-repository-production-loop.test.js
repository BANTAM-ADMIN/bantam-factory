import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { renderRepositoryProductionFilm, RepositoryGovernanceCell, RepositoryProductionLoop } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-production-loop-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 7;\n");
  fs.writeFileSync(path.join(root, "src", "api.js"), "import { core } from './core.js';\nexport const api = core;\n");
  fs.writeFileSync(path.join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\nvoid api;\n");
  return root;
}

const governance = { requirement: "requirement:stable-core", component: "src/core.js", test: "test/api.test.js", authority: "authority:release-board", fingerprint: "current" };
const focus = { paths: ["src/core.js"], requirements: [governance.requirement] };
const passingVerifier = async (_root, command) => ({ command, pass: true, status: "pass", exitCode: 0, durationMs: 12, detail: "1 test passed" });

function staleLine(verifier = passingVerifier) {
  const root = fixture(), cell = new RepositoryGovernanceCell({ root });
  cell.cycle({ changedPaths: ["src/core.js"], governance });
  fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 8;\n");
  cell.cycle({ changedPaths: ["src/core.js"] });
  const loop = new RepositoryProductionLoop({ cell, task: "Restore governed release evidence", focus, verifier });
  return { root, cell, loop };
}

describe("repository closed production loop", () => {
  it("turns a blocked exocortex button into measured evidence, explicit approval, and a reopened wicket", async () => {
    const { cell, loop } = staleLine();
    const blocked = loop.packet();
    assert.equal(blocked.summary.releaseDisposition, "blocked");

    const verified = await loop.dispatch({ packet: blocked, operation: "refresh-evidence" });
    assert.equal(verified.measurement.pass, true);
    assert.equal(verified.evidenceReceiptIds.length, 1);
    assert.equal(verified.disposition, "blocked", "test worker cannot manufacture release approval");
    assert.deepEqual(verified.packet.andons.filter((row) => row.severity === "critical").map((row) => row.code), ["stale-authority"]);
    assert.equal(cell.bus.view("telemetry").has(verified.measurement.artifactId, "measurement/status", "pass"), true);
    assert.equal(cell.bus.view("accepted").has(verified.measurement.artifactId, "measurement/status", "pass"), false, "raw telemetry never crosses into accepted facts");

    const authority = await loop.dispatch({
      packet: verified.packet,
      operation: "request-approval",
      approval: { grant: "release.approve", by: governance.authority, evidenceRef: "review:release-board:article-42" },
    });
    assert.ok(authority.approvalReceiptId);
    assert.equal(authority.disposition, "ready-for-authority-review");
    assert.equal(authority.packet.buttons.some((row) => row.operation === "request-release-decision"), true);
    assert.equal(loop.dispatches.length, 2);
    const film = renderRepositoryProductionFilm({ frames: [
      { label: "verified", projection: verified.projection, packet: verified.packet, dispatch: verified },
      { label: "approved", projection: authority.projection, packet: authority.packet, dispatch: authority },
    ] });
    assert.match(film, /BANTAM REPOSITORY TIME MACHINE/);
    assert.match(film, /historical frames cannot be used as current capabilities/);
    assert.match(film, new RegExp(authority.dispatchId));
  });

  it("contains failed verification without admitting evidence", async () => {
    const { cell, loop } = staleLine(async (_root, command) => ({ command, pass: false, status: "fail", exitCode: 1, durationMs: 8, detail: "assertion failed" }));
    const result = await loop.dispatch({ packet: loop.packet(), operation: "run-verification" });
    assert.equal(result.measurement.status, "fail");
    assert.deepEqual(result.evidenceReceiptIds, []);
    assert.equal(result.disposition, "blocked");
    assert.equal(result.packet.andons.some((row) => row.code === "stale-evidence"), true);
    assert.equal(cell.bus.view("telemetry").has(result.measurement.artifactId, "measurement/status", "fail"), true);
  });

  it("refuses stale packets and authority-shaped input that lacks a real approval grant", async () => {
    const { root, loop } = staleLine();
    const old = loop.packet();
    fs.writeFileSync(path.join(root, "src", "core.js"), "export const core = 9;\n");
    await assert.rejects(() => loop.dispatch({ packet: old, operation: "refresh-evidence" }), /shift packet is stale/);

    const current = loop.packet();
    await assert.rejects(() => loop.dispatch({ packet: current, operation: "request-approval", approval: { grant: "release.approve", by: "worker:codex", evidenceRef: "self-approved" } }), /explicit release\.approve grant/);
  });
});
