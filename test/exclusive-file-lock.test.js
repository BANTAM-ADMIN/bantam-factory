import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { acquireExclusiveFileLock } from "../src/exclusive-file-lock.js";

const temporary = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("exclusive file lock", () => {
  it("admits one owner and releases only its own token", () => {
    const root = tempRoot();
    const file = path.join(root, "controller.lock");
    const owner = acquireExclusiveFileLock(file);

    assert.throws(
      () => acquireExclusiveFileLock(file),
      (error) => error?.code === "ELOCKED",
    );
    assert.equal(owner.release(), true);
    assert.equal(owner.release(), false);
    assert.equal(fs.existsSync(file), false);
  });

  it("recovers a dead stale owner even when a recovery pathname survived a crash", () => {
    const root = tempRoot();
    const file = path.join(root, "controller.lock");
    fs.writeFileSync(file, `${JSON.stringify({
      schema: 1,
      kind: "test-stale-lock",
      pid: 2_000_000_000,
      token: "dead-owner",
      acquiredAt: "2000-01-01T00:00:00.000Z",
    })}\n`);
    fs.utimesSync(file, new Date(0), new Date(0));
    fs.writeFileSync(`${file}.recovery`, "left by a killed recovery process\n");

    const owner = acquireExclusiveFileLock(file, {
      staleAfterMs: 0,
      initializeGraceMs: 0,
    });

    assert.notEqual(owner.token, "dead-owner");
    assert.equal(owner.release(), true);
  });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-exclusive-lock-"));
  temporary.push(root);
  return root;
}
