import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildBenchmarkSuite,
  main,
  parseRunnerArgs,
} from "../src/self-improve-runner.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-improve-runner-"));
  tempDirs.push(workspace);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace, "src", "existing.js"), "export const existing = true;\n");
  return workspace;
}

describe("self-improve runner safety", () => {
  it("validates its cycle budget", () => {
    assert.throws(() => parseRunnerArgs(["--max-cycles", "0"]), /positive integer/);
    assert.throws(() => parseRunnerArgs(["--unknown"]), /unknown argument/);
  });

  it("is plan-only by default and does not create workspace state", async () => {
    const workspace = fixtureWorkspace();
    const before = fs.readFileSync(path.join(workspace, "src", "existing.js"), "utf8");

    const result = await main(["--workspace", workspace, "--max-cycles", "2"]);

    assert.equal(result.mode, "plan");
    assert.equal(result.candidates.length, 2);
    assert.equal(fs.existsSync(path.join(workspace, ".bantam")), false);
    assert.equal(
      fs.readFileSync(path.join(workspace, "src", "existing.js"), "utf8"),
      before,
    );
  });

  it("uses persisted failure evidence to rank the current scan without rewriting it", async () => {
    const workspace = fixtureWorkspace();
    const repeated = [
      "const normalizedValueForStableComparison = String(value).trim().toLowerCase();",
      "const substantiveSegmentsForStableComparison = normalizedValueForStableComparison.split(/\\s+/).filter(Boolean);",
      "return substantiveSegmentsForStableComparison.map((segment) => segment.replace(/[^a-z0-9]/g, '')).join('-');",
    ].join("\n");
    for (const name of ["one", "two", "three"]) {
      fs.writeFileSync(path.join(workspace, "src", `${name}.js`), [
        `export function ${name}(value) {`,
        repeated,
        "}",
        "",
      ].join("\n"));
    }
    const logPath = path.join(workspace, ".bantam-improvements.json");
    fs.writeFileSync(logPath, JSON.stringify([
      { id: "prior-dedupe", area: "code-quality", passed: false },
    ]));
    const before = fs.readFileSync(logPath, "utf8");

    const result = await main(["--workspace", workspace, "--max-cycles", "1"]);

    assert.equal(result.candidates[0].id, "dedupe-patterns");
    assert.equal(result.candidates[0].evidence.areaFailureRate, 1);
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
    assert.equal(fs.existsSync(path.join(workspace, ".bantam")), false);
  });

  it("materializes the tested benchmark implementation instead of a stale template", async () => {
    const workspace = fixtureWorkspace();
    const benchmarkPath = path.join(workspace, "src", "benchmark.js");

    const changes = await buildBenchmarkSuite({}, workspace);
    const { BenchmarkSuite } = await import(`${pathToFileURL(benchmarkPath).href}?test=${Date.now()}`);
    const suite = new BenchmarkSuite();
    suite.add("structured", { value: 1 }, { ok: true }, async () => false);
    const result = await suite.run(suite.benchmarks[0], async () => ({ ok: true }));

    assert.deepEqual(changes, [{ file: benchmarkPath, action: "created" }]);
    assert.equal(result.passed, false);
    assert.match(fs.readFileSync(benchmarkPath, "utf8"), /isDeepStrictEqual/);
    assert.deepEqual(
      await buildBenchmarkSuite({}, workspace),
      [{ file: benchmarkPath, action: "exists" }],
    );
  });

  it("routes coverage gaps to a managed lane instead of the obsolete metrics-test writer", async () => {
    const workspace = fixtureWorkspace();
    for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      fs.writeFileSync(
        path.join(workspace, "src", `${name}.js`),
        `export const ${name} = true;\n`,
      );
    }
    const output = [];
    const originalLog = console.log;
    console.log = (...args) => output.push(args.join(" "));
    let result;
    try {
      result = await main(["--workspace", workspace, "--max-cycles", "30"]);
    } finally {
      console.log = originalLog;
    }

    const coverage = result.candidates.find(candidate => candidate.id === "test-coverage");
    assert.ok(coverage);
    assert.equal(coverage.targets.length, 1);
    assert.ok(output.some(line => line.includes("[test-coverage]") && line.includes("(no builder)")));
    assert.equal(fs.existsSync(path.join(workspace, "test", "metrics.test.js")), false);
  });

  it("does not advertise placeholder split or dedupe writers as implementations", async () => {
    const workspace = fixtureWorkspace();
    const repeated = [
      "const normalizedValueForManagedExtraction = String(value).trim().toLowerCase();",
      "const substantiveSegmentsForManagedExtraction = normalizedValueForManagedExtraction.split(/\\s+/).filter(Boolean);",
      "return substantiveSegmentsForManagedExtraction.map((segment) => segment.replace(/[^a-z0-9]/g, '')).join('-');",
    ].join("\n");
    for (const name of ["one", "two", "three"]) {
      fs.writeFileSync(path.join(workspace, "src", `${name}.js`), [
        `export function ${name}(value) {`,
        repeated,
        "}",
        "",
      ].join("\n"));
    }
    fs.writeFileSync(
      path.join(workspace, "src", "large.js"),
      `${Array.from({ length: 510 }, (_, index) => `// line ${index}`).join("\n")}\n`,
    );
    const output = [];
    const originalLog = console.log;
    console.log = (...args) => output.push(args.join(" "));
    try {
      await main(["--workspace", workspace, "--max-cycles", "30"]);
    } finally {
      console.log = originalLog;
    }

    for (const id of ["dedupe-patterns", "split-large-files"]) {
      assert.ok(output.some(line => line.includes(`[${id}]`) && line.includes("(no builder)")));
    }
  });
});
