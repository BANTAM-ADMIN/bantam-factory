import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadTrioTeacherArtifacts } from "../src/trio-evidence.js";

const temporary = new Set();

function makeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trio-evidence-"));
  temporary.add(root);
  const turns = [1, 2].map((turn) => {
    const arms = {};
    for (const arm of ["local", "sol", "terra"]) {
      const relative = `runs/${arm}/turn-${turn}.json`;
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        kind: "bantam-run",
        runId: `${arm}-${turn}`,
        modelId: arm,
        task: `Task ${turn}`,
        result: { status: "pass", pass: true },
        turns: [],
      }));
      arms[arm] = { artifactPath: relative };
    }
    return {
      turn,
      completedAt: `2026-07-26T00:0${turn}:00.000Z`,
      arms,
    };
  });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    kind: "bantam-trio-session",
    id: "trio-test",
    turns,
  }));
  return root;
}

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

describe("trio teacher evidence resolver", () => {
  it("selects the latest completed turn and returns Local/Sol/Terra in canonical roles", () => {
    const session = makeSession();
    const loaded = loadTrioTeacherArtifacts(session);

    assert.equal(loaded.sessionId, "trio-test");
    assert.equal(loaded.turn, 2);
    assert.equal(loaded.task, "Task 2");
    assert.equal(loaded.artifacts.local.runId, "local-2");
    assert.equal(loaded.artifacts.sol.runId, "sol-2");
    assert.equal(loaded.artifacts.terra.runId, "terra-2");
  });

  it("selects an explicit completed turn", () => {
    const loaded = loadTrioTeacherArtifacts(makeSession(), { turn: "1" });
    assert.equal(loaded.turn, 1);
    assert.equal(loaded.artifacts.local.runId, "local-1");
  });

  it("rejects escaping and symlinked artifact evidence", () => {
    const session = makeSession();
    const manifestPath = path.join(session, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.turns[1].arms.local.artifactPath = "../outside.json";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadTrioTeacherArtifacts(session), /escapes/);

    const clean = makeSession();
    const target = path.join(clean, "runs/local/turn-2.json");
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(clean, "runs/sol/turn-2.json"), target);
    assert.throws(() => loadTrioTeacherArtifacts(clean), /regular file/);
  });
});
