import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { LaneStore } from "../src/lane-store.js";
import {
  buildImplementationTask,
  parseSelfImproveRequest,
  runManagedVerifier,
  runGovernedSelfImprove,
} from "../src/self-improve-controller.js";

const temporary = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-controller-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "bantam",
    private: true,
    type: "module",
    bin: { bantam: "bin/bantam.js" },
    scripts: { test: "node --test test/*.test.js" },
  }));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, ".gitignore"), ".bantam/\nnode_modules/\n");
  fs.writeFileSync(path.join(root, "bin", "bantam.js"), "export const harness = true;\n");
  fs.writeFileSync(path.join(root, "bin", "bantam.js"), "export const installedHarness = true;\n");
  fs.writeFileSync(path.join(root, "bin", "run-dev.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(root, "src", "agent.js"), "export const agent = true;\n");
  fs.writeFileSync(path.join(root, "src", "self-improve.js"), "export const scanner = true;\n");
  fs.writeFileSync(path.join(root, "src", "existing.js"), "export const existing = true;\n");
  fs.writeFileSync(path.join(root, "test", "existing.test.js"), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'test("existing", () => assert.equal(1, 1));',
    "",
  ].join("\n"));
  return root;
}

function green({ passed = 1 } = {}) {
  return {
    status: "pass",
    exitCode: 0,
    tests: { passed, failed: 0 },
    output: `# tests ${passed}\n# pass ${passed}\n# fail 0\n`,
  };
}

function implementCompletion({ workspace: lane }) {
  fs.writeFileSync(path.join(lane, "src", "dependency-impact.js"), [
    "export function completionConfidence({ testsPassed = false } = {}) {",
    "  return testsPassed ? 1 : 0;",
    "}",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { completionConfidence } from "../src/dependency-impact.js";',
    'test("requires tests", () => assert.equal(completionConfidence({ testsPassed: true }), 1));',
    "",
  ].join("\n"));
  return {
    done: true,
    reachedDone: true,
    verification: green({ passed: 2 }),
    metrics: { turns: 4, invalid: 0, protocolViolations: 0 },
    summary: "implemented completion confidence",
  };
}

function implementCoverage({ workspace: lane, candidate }) {
  const target = candidate.targets[0];
  const stem = path.posix.basename(target, path.posix.extname(target));
  fs.writeFileSync(path.join(lane, "test", `${stem}.test.js`), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    `import * as subject from "../src/${target}";`,
    `test("${stem} imports", () => assert.equal(typeof subject, "object"));`,
    "",
  ].join("\n"));
  return {
    done: true,
    reachedDone: true,
    verification: green({ passed: 2 }),
    metrics: { turns: 2, invalid: 0, protocolViolations: 0 },
    summary: `added direct coverage for ${target}`,
  };
}

function seedDedupeCandidate(root, names = ["one", "two", "three"]) {
  const repeated = [
    "const normalizedValueForManagedExtraction = String(value).trim().toLowerCase();",
    "const substantiveSegmentsForManagedExtraction = normalizedValueForManagedExtraction.split(/\\s+/).filter(Boolean);",
    "return substantiveSegmentsForManagedExtraction.map((segment) => segment.replace(/[^a-z0-9]/g, '')).join('-');",
  ].join("\n");
  for (const name of names) {
    fs.writeFileSync(path.join(root, "src", `${name}.js`), [
      `export function ${name}(value) {`,
      repeated,
      "}",
      "",
    ].join("\n"));
  }
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("governed self-improvement controller", () => {
  it("gives teacher implementations an explicit, bounded source-scope contract", () => {
    const task = buildImplementationTask({
      candidate: {
        id: "teacher-test-oracle",
        area: "teacher-collaboration",
        problem: "visible tests miss contract edges",
        proposal: "add one task-general oracle",
        source: "teacher-collaboration",
        promotionEligible: false,
        targets: ["src/done-gates.js", "src/agent.js"],
        evidence: { adversarialTests: [] },
      },
      verifier: "npm test",
      operatorRequest: "",
    });

    assert.match(task, /ONLY existing source files you may edit/);
    assert.match(task, /edit only the frozen source targets/);
    assert.match(task, /at most one small helper imported by an edited target/);
    assert.match(task, /within six read\/query actions/);
    assert.doesNotMatch(task, /implement outside frozen targets/i);
  });

  it("recognizes deliberate front-end requests without hijacking questions", () => {
    assert.equal(
      parseSelfImproveRequest("Lets do a little self improvement. Take a look at your codebase.").apply,
      true,
    );
    assert.equal(parseSelfImproveRequest(":self-improve plan").planOnly, true);
    assert.equal(parseSelfImproveRequest(":self-improve --help").help, true);
    assert.match(
      parseSelfImproveRequest(":self-improve --candidate").error,
      /requires an id/,
    );
    assert.match(
      parseSelfImproveRequest(":self-improve --mystery").error,
      /unknown .* option/,
    );
    assert.equal(parseSelfImproveRequest("What is self-improvement?"), null);
    assert.equal(parseSelfImproveRequest("Why not self improve?"), null);
    assert.equal(parseSelfImproveRequest("Should we do a self improvement run?"), null);
    assert.equal(parseSelfImproveRequest("Can you self improve?"), null);
    assert.equal(parseSelfImproveRequest("Do self-improvement runs change regular?"), null);
    assert.equal(parseSelfImproveRequest("Please explain self-improvement."), null);
    assert.equal(parseSelfImproveRequest("Please tell me about self improvement."), null);
    assert.equal(parseSelfImproveRequest("Please help me understand self improvement."), null);
    assert.equal(parseSelfImproveRequest("I want you to explain self improvement."), null);
    assert.equal(parseSelfImproveRequest("Go ahead and tell me about self improvement."), null);
    assert.equal(parseSelfImproveRequest("Do discuss self improvement."), null);
    assert.equal(parseSelfImproveRequest("Run through how self improvement works."), null);
    assert.equal(parseSelfImproveRequest("Do not self improve."), null);
    assert.equal(parseSelfImproveRequest("Let's not self-improve."), null);
    assert.equal(parseSelfImproveRequest("Do self-improvement runs change regular"), null);
    assert.equal(parseSelfImproveRequest("Self-improvement seems to be working well."), null);
    assert.equal(parseSelfImproveRequest("I want you to self improve.").apply, true);
    assert.equal(parseSelfImproveRequest("I need you to self improve.").apply, true);
    assert.equal(parseSelfImproveRequest("Go self improve.").apply, true);
    assert.equal(parseSelfImproveRequest("Please self-improve.").apply, true);
    assert.equal(parseSelfImproveRequest("Please run self improvement.").apply, true);
    assert.equal(parseSelfImproveRequest("Improve the error message"), null);
  });

  it("keeps planning read-only", async () => {
    const root = workspace();
    const before = fs.readdirSync(root).sort();
    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "dependency-impact",
      planOnly: true,
    });

    assert.equal(result.mode, "plan");
    assert.equal(result.selected.id, "dependency-impact");
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("rejects an unrelated workspace before creating controller state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-unrelated-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"not-bantam","type":"module"}\n');

    await assert.rejects(
      runGovernedSelfImprove({ workspace: root, planOnly: true, env: {} }),
      /exact Bantam development checkout/i,
    );
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("allows read-only child planning but rejects recursive managed entry", async () => {
    const root = workspace();
    const plan = await runGovernedSelfImprove({
      workspace: root,
      planOnly: true,
      env: { BANTAM_SELF_IMPROVE_CHILD: "1" },
    });
    assert.equal(plan.mode, "plan");
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async () => green(),
        env: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      }),
      /recursive self-improvement is not allowed/i,
    );
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("refuses symlinked controller state before reading or writing through it", async () => {
    const root = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-outside-"));
    temporary.push(outside);
    fs.symlinkSync(outside, path.join(root, ".bantam"), "dir");

    await assert.rejects(
      runGovernedSelfImprove({ workspace: root, planOnly: true, env: {} }),
      /refuses symlink path component/i,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("refuses a nested state-home symlink before creating controller state", async () => {
    const root = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-state-outside-"));
    temporary.push(outside);
    fs.symlinkSync(outside, path.join(root, "state-link"), "dir");

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        stateHome: path.join(root, "state-link"),
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async () => green(),
        env: {},
      }),
      /state home refuses symlink path component/i,
    );
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("treats a fresh partially initialized lock as active", async () => {
    const root = workspace();
    const controllerRoot = path.join(root, ".bantam", "self-improve");
    fs.mkdirSync(controllerRoot, { recursive: true });
    const lock = path.join(controllerRoot, "controller.lock");
    fs.writeFileSync(lock, "");

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async () => green(),
        env: {},
      }),
      /another self-improvement controller is active.*initialized/i,
    );
    assert.equal(fs.readFileSync(lock, "utf8"), "");
    assert.equal(fs.existsSync(path.join(root, "src", "dependency-impact.js")), false);
  });

  it("stages a filename-gated mechanism without deploying an orphan module", async () => {
    const root = workspace();
    const original = fs.readFileSync(path.join(root, "src", "existing.js"), "utf8");
    const calls = [];
    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "dependency-impact",
      verificationScript: "npm test",
      implement: async (context) => {
        assert.notEqual(context.workspace, root);
        assert.equal(fs.readFileSync(path.join(root, "src", "existing.js"), "utf8"), original);
        return implementCompletion(context);
      },
      verify: async (target, _script, { phase }) => {
        calls.push({ target, phase });
        return green({ passed: phase === "candidate-snapshot" ? 2 : 1 });
      },
      env: {},
    });

    assert.equal(result.status, "staged");
    assert.equal(result.applied, false);
    assert.equal(result.restartRequired, false);
    assert.equal(result.promotionEligible, false);
    assert.match(result.promotionBlocker, /production integration.*behavioral lift/i);
    assert.equal(fs.existsSync(path.join(root, "src", "dependency-impact.js")), false);
    assert.equal(fs.existsSync(path.join(root, "test", "completion-confidence.test.js")), false);
    assert.deepEqual(calls.map(({ phase }) => phase), [
      "baseline",
      "candidate-snapshot",
      "protected-baseline-suite",
    ]);
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("dev").versionRef, result.candidateVersionRef);
    assert.notEqual(store.readChannel("regular").versionRef, result.candidateVersionRef);
    assert.equal(store.blobs.getJson(result.evidenceRef).kind, "bantam.self-improvement-evidence");
    const attempts = JSON.parse(fs.readFileSync(
      path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
      "utf8",
    ));
    assert.equal(attempts.at(-1).phase, "staged");
  });

  it("rejects unrelated source, deletion, documentation, and launcher collateral before checkpoint", async () => {
    const cases = [
      {
        label: "unrelated source modification",
        mutate(lane) {
          fs.appendFileSync(path.join(lane, "src", "existing.js"), "// collateral\n");
        },
        expected: /candidate scope rejected modified src\/existing\.js/,
      },
      {
        label: "unrelated source deletion",
        mutate(lane) {
          fs.rmSync(path.join(lane, "src", "existing.js"));
        },
        expected: /candidate scope rejected deleted src\/existing\.js/,
      },
      {
        label: "documentation injection",
        mutate(lane) {
          fs.mkdirSync(path.join(lane, "docs"));
          fs.writeFileSync(path.join(lane, "docs", "surprise.md"), "unrelated\n");
        },
        expected: /candidate scope rejected added docs\/surprise\.md/,
      },
      {
        label: "launcher modification",
        mutate(lane) {
          fs.appendFileSync(path.join(lane, "bin", "run-dev.sh"), "exit 0\n");
        },
        expected: /candidate scope rejected modified bin\/run-dev\.sh/,
      },
      {
        label: "root generated-looking payload",
        mutate(lane) {
          fs.mkdirSync(path.join(lane, "coverage"));
          fs.writeFileSync(path.join(lane, "coverage", "payload.js"), "export const payload = true;\n");
        },
        expected: /candidate scope rejected added coverage\/payload\.js/,
      },
      {
        label: "nested generated-looking payload",
        mutate(lane) {
          fs.mkdirSync(path.join(lane, "src", "coverage"));
          fs.writeFileSync(
            path.join(lane, "src", "coverage", "payload.js"),
            "export const payload = true;\n",
          );
        },
        expected: /candidate scope rejected added src\/coverage\/payload\.js/,
      },
      {
        label: "existing test weakening",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "existing.test.js"), [
            'import "../src/dependency-impact.js";',
            'import { test } from "node:test";',
            'test("dummy", () => {});',
            "",
          ].join("\n"));
        },
        expected: /existing verifier tests are immutable/,
      },
      {
        label: "skipped focused test evidence",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import "../src/dependency-impact.js";',
            'test.skip("not evidence", () => assert.equal(1, 1));',
            "",
          ].join("\n"));
        },
        expected: /focused test contains skipped or todo-only evidence/,
      },
      {
        label: "top-level assertion outside an empty test",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import "../src/dependency-impact.js";',
            'test("empty", () => {});',
            "assert.equal(1, 1);",
            "",
          ].join("\n"));
        },
        expected: /enabled case without a direct assertion in its callback/,
      },
      {
        label: "locally defined fake test registrar",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import assert from "node:assert/strict";',
            'import "../src/dependency-impact.js";',
            "const test = () => {};",
            'test("fake", () => assert.equal(1, 1));',
            "",
          ].join("\n"));
        },
        expected: /focused test defines no executable test case/,
      },
      {
        label: "locally defined fake expect assertion",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import { test } from "node:test";',
            'import "../src/dependency-impact.js";',
            "const expect = () => {};",
            'test("fake", () => expect(1));',
            "",
          ].join("\n"));
        },
        expected: /enabled case without a direct assertion in its callback/,
      },
      {
        label: "block shadows trusted test registrar",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import "../src/dependency-impact.js";',
            "{",
            "  const test = () => {};",
            '  test("fake", () => assert.ok(true));',
            "}",
            "",
          ].join("\n"));
        },
        expected: /shadows trusted test or assertion binding: test/,
      },
      {
        label: "block shadows trusted assertion binding",
        mutate(lane) {
          fs.writeFileSync(path.join(lane, "test", "completion-confidence.test.js"), [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import "../src/dependency-impact.js";',
            "{",
            "  const assert = { ok() {} };",
            '  test("fake", () => assert.ok(true));',
            "}",
            "",
          ].join("\n"));
        },
        expected: /shadows trusted test or assertion binding: assert/,
      },
    ];

    for (const scenario of cases) {
      const root = workspace();
      const existing = fs.readFileSync(path.join(root, "src", "existing.js"), "utf8");
      const launcher = fs.readFileSync(path.join(root, "bin", "run-dev.sh"), "utf8");
      const phases = [];
      await assert.rejects(
        runGovernedSelfImprove({
          workspace: root,
          candidateId: "dependency-impact",
          verificationScript: "npm test",
          implement: async (context) => {
            const result = implementCompletion(context);
            scenario.mutate(context.workspace);
            return result;
          },
          verify: async (_target, _script, { phase }) => {
            phases.push(phase);
            return green({ passed: phase === "baseline" ? 1 : 2 });
          },
          env: {},
        }),
        scenario.expected,
        scenario.label,
      );
      assert.deepEqual(phases, ["baseline"], scenario.label);
      assert.equal(
        fs.readFileSync(path.join(root, "src", "existing.js"), "utf8"),
        existing,
        scenario.label,
      );
      assert.equal(
        fs.readFileSync(path.join(root, "bin", "run-dev.sh"), "utf8"),
        launcher,
        scenario.label,
      );
      assert.equal(fs.existsSync(path.join(root, "docs")), false, scenario.label);
      assert.equal(fs.existsSync(path.join(root, "coverage")), false, scenario.label);
      assert.equal(
        fs.existsSync(path.join(root, "src", "dependency-impact.js")),
        false,
        scenario.label,
      );
    }
  });

  it("rejects test-shaped evidence that the configured verifier will not discover", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async ({ workspace: lane }) => {
          fs.writeFileSync(
            path.join(lane, "src", "dependency-impact.js"),
            "export const completionConfidence = true;\n",
          );
          fs.writeFileSync(
            path.join(lane, "test", "evidence.txt"),
            'import "../src/dependency-impact.js";\n',
          );
          return {
            done: true,
            reachedDone: true,
            verification: green(),
            metrics: { turns: 1 },
          };
        },
        verify: async (_target, _script, { phase }) => green({
          passed: phase === "candidate-snapshot" ? 2 : 1,
        }),
        env: {},
      }),
      /candidate scope rejected added test\/evidence\.txt|requires at least one focused test/,
    );
    assert.equal(fs.existsSync(path.join(root, "test", "evidence.txt")), false);
  });

  it("permits bounded target edits, one connected extraction helper, and a focused test", async () => {
    const root = workspace();
    seedDedupeCandidate(root);
    const phases = [];

    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "dedupe-patterns",
      verificationScript: "npm test",
      implement: async ({ workspace: lane }) => {
        fs.writeFileSync(path.join(lane, "src", "managed-extraction.js"), [
          "export function managedExtraction(value) {",
          "  const normalized = String(value).trim().toLowerCase();",
          "  const segments = normalized.split(/\\s+/).filter(Boolean);",
          "  return segments.map((segment) => segment.replace(/[^a-z0-9]/g, '')).join('-');",
          "}",
          "",
        ].join("\n"));
        for (const name of ["one", "two", "three"]) {
          fs.writeFileSync(path.join(lane, "src", `${name}.js`), [
            'import { managedExtraction } from "./managed-extraction.js";',
            `export const ${name} = (value) => managedExtraction(value);`,
            "",
          ].join("\n"));
        }
        fs.writeFileSync(path.join(lane, "test", "managed-extraction.test.js"), [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          'import { managedExtraction } from "../src/managed-extraction.js";',
          'test("normalizes", () => assert.equal(managedExtraction(" A B "), "a-b"));',
          "",
        ].join("\n"));
        return {
          done: true,
          reachedDone: true,
          verification: green({ passed: 2 }),
          metrics: { turns: 5, invalid: 0, protocolViolations: 0 },
          summary: "extracted one shared helper",
        };
      },
      verify: async (_target, _script, { phase }) => {
        phases.push(phase);
        return green({
          passed: ["candidate-snapshot", "deployed-live"].includes(phase) ? 2 : 1,
        });
      },
      env: {},
    });

    assert.equal(result.status, "promoted");
    assert.deepEqual(phases, [
      "baseline",
      "candidate-snapshot",
      "protected-baseline-suite",
      "deployed-live",
    ]);
    assert.equal(fs.existsSync(path.join(root, "src", "managed-extraction.js")), true);
    assert.equal(fs.existsSync(path.join(root, "test", "managed-extraction.test.js")), true);
  });

  it("preserves ignored ambient reports that are intentionally absent from the lane", async () => {
    const root = workspace();
    fs.appendFileSync(path.join(root, ".gitignore"), "/.bantam-improvements.json\n");
    const report = '{"summary":"local-only"}\n';
    fs.writeFileSync(path.join(root, ".bantam-improvements.json"), report);

    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "dependency-impact",
      verificationScript: "npm test",
      implement: async (context) => implementCompletion(context),
      verify: async (_target, _script, { phase }) => green({
        passed: phase === "candidate-snapshot" ? 2 : 1,
      }),
      env: {},
    });

    assert.equal(result.status, "staged");
    assert.equal(
      fs.readFileSync(path.join(root, ".bantam-improvements.json"), "utf8"),
      report,
    );
  });

  it("attests a protected evaluation nested beneath a Git-ignored .bantam directory", async () => {
    const root = workspace();
    execFileSync("git", ["init", "--quiet"], { cwd: root });

    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "dependency-impact",
      verificationScript: "npm test",
      implement: async (context) => implementCompletion(context),
      verify: async (_target, _script, { phase }) => green({
        passed: phase === "candidate-snapshot" ? 2 : 1,
      }),
      env: {},
    });

    assert.equal(result.status, "staged");
    assert.equal(fs.existsSync(path.join(root, "src", "dependency-impact.js")), false);
    const attempts = JSON.parse(fs.readFileSync(
      path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
      "utf8",
    ));
    assert.equal(attempts.at(-1).phase, "staged");
  });

  it("rejects a candidate that exceeds its frozen target path budget", async () => {
    const root = workspace();
    const names = ["one", "two", "three", "four", "five"];
    seedDedupeCandidate(root, names);
    const phases = [];

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dedupe-patterns",
        verificationScript: "npm test",
        implement: async ({ workspace: lane }) => {
          for (const name of names) {
            fs.writeFileSync(
              path.join(lane, "src", `${name}.js`),
              `export const ${name} = ${JSON.stringify(name)};\n`,
            );
          }
          fs.writeFileSync(path.join(lane, "test", "one.test.js"), [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import { one } from "../src/one.js";',
            'test("one", () => assert.equal(one, "one"));',
            "",
          ].join("\n"));
          return {
            done: true,
            reachedDone: true,
            verification: green({ passed: 2 }),
            metrics: { turns: 5, invalid: 0, protocolViolations: 0 },
          };
        },
        verify: async (_target, _script, { phase }) => {
          phases.push(phase);
          return green({ passed: phase === "baseline" ? 1 : 2 });
        },
        env: {},
      }),
      /candidate scope exceeded target change budget \(5\/4\)/,
    );

    assert.deepEqual(phases, ["baseline"]);
    assert.match(fs.readFileSync(path.join(root, "src", "one.js"), "utf8"), /normalizedValue/);
  });

  it("rejects a no-op implementation without moving channels or live source", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async () => ({
          done: true,
          reachedDone: true,
          verification: green(),
          metrics: {},
        }),
        verify: async (_target, _script, { phase }) => green({
          passed: phase === "candidate-snapshot" ? 2 : 1,
        }),
        env: {},
      }),
      /no captured workspace change/,
    );

    assert.equal(fs.existsSync(path.join(root, "src", "dependency-impact.js")), false);
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular").versionRef, store.readChannel("dev").versionRef);
    const attempts = JSON.parse(fs.readFileSync(
      path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
      "utf8",
    ));
    assert.equal(attempts.at(-1).phase, "failed");
  });

  it("rolls back exact live bytes and dev when a post-apply controller step fails", async () => {
    const root = workspace();
    for (const [name, value] of [["alpha", 1], ["beta", 2], ["gamma", 3]]) {
      fs.writeFileSync(path.join(root, "src", `${name}.js`), `export const ${name} = ${value};\n`);
    }
    const before = fs.readFileSync(path.join(root, "src", "existing.js"), "utf8");
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "test-coverage",
        verificationScript: "npm test",
        implement: async (context) => implementCoverage(context),
        verify: async (_target, _script, { phase }) => green({
          passed: phase === "candidate-snapshot" ? 2 : 1,
        }),
        afterDeploy: async () => {
          throw new Error("forced post-apply controller failure");
        },
        env: {},
      }),
      /forced post-apply controller failure/,
    );

    assert.equal(fs.readFileSync(path.join(root, "src", "existing.js"), "utf8"), before);
    assert.equal(
      fs.readdirSync(path.join(root, "test")).filter((name) => name !== "existing.test.js").length,
      0,
    );
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular").versionRef, store.readChannel("dev").versionRef);
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
        "utf8",
      )).at(-1).phase,
      "failed",
    );
  });

  it("verifies the deployed live checkout and rolls it back before promotion on failure", async () => {
    const root = workspace();
    for (const [name, value] of [["alpha", 1], ["beta", 2], ["gamma", 3]]) {
      fs.writeFileSync(path.join(root, "src", `${name}.js`), `export const ${name} = ${value};\n`);
    }
    const phases = [];

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "test-coverage",
        verificationScript: "npm test",
        implement: async (context) => implementCoverage(context),
        verify: async (target, _script, { phase }) => {
          phases.push({ phase, target });
          if (phase === "deployed-live") {
            return {
              status: "fail",
              exitCode: 1,
              tests: { passed: 1, failed: 1 },
              output: "not ok 2 - only fails from the deployed checkout",
            };
          }
          return green({
            passed: phase === "candidate-snapshot" ? 2 : 1,
          });
        },
        env: {},
      }),
      /deployed live verification is not green/,
    );

    assert.deepEqual(phases.map(({ phase }) => phase), [
      "baseline",
      "candidate-snapshot",
      "protected-baseline-suite",
      "deployed-live",
    ]);
    assert.equal(phases.at(-1).target, root);
    assert.deepEqual(fs.readdirSync(path.join(root, "test")), ["existing.test.js"]);
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular").versionRef, store.readChannel("dev").versionRef);
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
        "utf8",
      )).at(-1).phase,
      "failed",
    );
  });

  it("requires test-coverage to add an executed passing test, not just an import", async () => {
    const root = workspace();
    for (const [name, value] of [["alpha", 1], ["beta", 2], ["gamma", 3]]) {
      fs.writeFileSync(path.join(root, "src", `${name}.js`), `export const ${name} = ${value};\n`);
    }
    const phases = [];

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "test-coverage",
        verificationScript: "npm test",
        implement: async (context) => implementCoverage(context),
        verify: async (_target, _script, { phase }) => {
          phases.push(phase);
          return green({ passed: 1 });
        },
        env: {},
      }),
      /immutable candidate added no executed passing test/,
    );

    assert.deepEqual(phases, [
      "baseline",
      "candidate-snapshot",
      "protected-baseline-suite",
    ]);
    assert.deepEqual(fs.readdirSync(path.join(root, "test")), ["existing.test.js"]);
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular").versionRef, store.readChannel("dev").versionRef);
  });

  it("rejects dependency changes even when the implementation reports green", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => {
          const result = implementCompletion(context);
          fs.writeFileSync(path.join(context.workspace, "package.json"), '{"type":"module","dependencies":{"x":"1"}}\n');
          return result;
        },
        verify: async () => green(),
        env: {},
      }),
      /cannot change dependency manifest/,
    );
    assert.doesNotMatch(fs.readFileSync(path.join(root, "package.json"), "utf8"), /dependencies/);
  });

  it("does not initialize or advance channels when the observed baseline is red", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async () => ({
          status: "fail",
          exitCode: 1,
          tests: { passed: 0, failed: 1 },
          output: "not ok 1",
        }),
        env: {},
      }),
      /baseline verification is not green/,
    );

    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular"), null);
    assert.equal(store.readChannel("dev"), null);
  });

  it("runs baseline verification in a disposable materialization, never the live checkout", async () => {
    const root = workspace();
    const before = fs.readFileSync(path.join(root, "src", "existing.js"), "utf8");
    let evaluated = null;

    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async (target, _script, { phase }) => {
          if (phase === "baseline") {
            evaluated = target;
            fs.appendFileSync(path.join(target, "src", "existing.js"), "// verifier mutation\n");
          }
          return green();
        },
        env: {},
      }),
      /baseline verifier changed its immutable evaluation tree/,
    );

    assert.notEqual(evaluated, root);
    assert.equal(fs.readFileSync(path.join(root, "src", "existing.js"), "utf8"), before);
  });

  it("rejects a green exit without positive test-count evidence", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async () => ({ status: "pass", exitCode: 0, tests: null, output: "looks good" }),
        env: {},
      }),
      /did not report trustworthy test counts/,
    );
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular"), null);
    assert.equal(store.readChannel("dev"), null);
  });

  it("rejects capture-policy gaming before checkpointing a candidate", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => {
          const result = implementCompletion(context);
          fs.appendFileSync(path.join(context.workspace, ".gitignore"), "src/dependency-impact.js\n");
          return result;
        },
        verify: async () => green({ passed: 2 }),
        env: {},
      }),
      /cannot change capture policy/,
    );
    assert.equal(fs.existsSync(path.join(root, "src", "dependency-impact.js")), false);
  });

  it("rejects an injected npm script-shell bypass before checkpoint or promotion", async () => {
    const root = workspace();
    const phases = [];
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => {
          const result = implementCompletion(context);
          fs.writeFileSync(
            path.join(context.workspace, ".npmrc"),
            "script-shell=/bin/true\n",
          );
          return result;
        },
        verify: async (_target, _script, { phase }) => {
          phases.push(phase);
          return green({ passed: 2 });
        },
        env: {},
      }),
      /cannot change package-manager execution config.*\.npmrc/,
    );

    assert.deepEqual(phases, ["baseline"]);
    assert.equal(fs.existsSync(path.join(root, ".npmrc")), false);
    const store = new LaneStore(path.join(root, ".bantam", "state"));
    assert.equal(store.readChannel("regular").versionRef, store.readChannel("dev").versionRef);
  });

  it("rejects an immutable candidate verifier that changes evaluated source", async () => {
    const root = workspace();
    await assert.rejects(
      runGovernedSelfImprove({
        workspace: root,
        candidateId: "dependency-impact",
        verificationScript: "npm test",
        implement: async (context) => implementCompletion(context),
        verify: async (target, _script, { phase }) => {
          if (phase === "candidate-snapshot") {
            fs.appendFileSync(path.join(target, "src", "existing.js"), "// verifier mutation\n");
          }
          return green({ passed: phase === "baseline" ? 1 : 2 });
        },
        env: {},
      }),
      /candidate verifier changed the immutable evaluation tree/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "src", "existing.js"), "utf8"),
      "export const existing = true;\n",
    );
  });

  it("parses real Node TAP counts for the managed verifier", async () => {
    const root = workspace();
    const result = await runManagedVerifier(root, "node --test test/*.test.js", {
      shellSandbox: "host",
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(result.tests, { passed: 1, failed: 0 });
  });

  it("prefers canonical TAP totals over incidental success glyphs", async () => {
    const root = workspace();
    const result = await runManagedVerifier(
      root,
      "printf '✓ incidental reporter glyph\\n# tests 807\\n# pass 807\\n# fail 0\\n'",
      { shellSandbox: "host" },
    );
    assert.equal(result.status, "pass");
    assert.deepEqual(result.tests, { passed: 807, failed: 0 });
  });
});
