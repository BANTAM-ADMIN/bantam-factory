import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { benchmarkModule, report, runBenchmarks } from "../src/self-benchmark.js";

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-benchmark-"));
  tempDirs.push(directory);
  return directory;
}

describe("safe self benchmark", () => {
  it("parses exports without executing module side effects", async () => {
    const directory = fixture();
    const sentinel = path.join(directory, "executed.txt");
    const moduleFile = path.join(directory, "sample.js");
    fs.writeFileSync(
      moduleFile,
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(sentinel)}, "unsafe");`,
        "export const alpha = 1;",
        "export default alpha;",
        "",
      ].join("\n"),
    );

    const result = await benchmarkModule(moduleFile);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.details.exported, ["alpha", "default"]);
    assert.equal(result.details.executed, false);
    assert.equal(fs.existsSync(sentinel), false);
  });

  it("reports syntax errors without importing the module", async () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "good.js"), "export const ok = true;\n");
    fs.writeFileSync(path.join(directory, "bad.js"), "export const = ;\n");

    const benchmark = await runBenchmarks(directory);

    assert.equal(benchmark.summary.total, 2);
    assert.equal(benchmark.summary.ok, 1);
    assert.equal(benchmark.summary.errors, 1);
    assert.match(report(benchmark), /1 errors/);
  });
});
