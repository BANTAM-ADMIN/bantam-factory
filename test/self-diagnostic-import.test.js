import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticUrl = pathToFileURL(path.join(root, "src", "self-diagnostic.js")).href;

describe("self-diagnostic module boundary", () => {
  it("has no CLI side effects when imported", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(diagnosticUrl)})`],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("still runs when invoked as the entry point", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "self-diagnostic.js"), "--categories", "reliability"],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Self-Diagnostic Report/);
  });
});
