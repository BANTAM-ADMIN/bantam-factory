import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { LaneStore } from "../src/lane-store.js";
import {
  formatGovernedSelfImproveResult,
  runGovernedSelfImprove,
} from "../src/self-improve-controller.js";
import { recordSelfObservation } from "../src/self-observation.js";

const temporary = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("runtime-derived self-improvement candidates", () => {
  it("surfaces repeated runtime evidence as an explicit build-only plan", async () => {
    const root = selfHostWorkspace();
    recordProtocolInvalid(root, "first affected task");
    recordProtocolInvalid(root, "second affected task");
    const observationState = fs.readFileSync(
      path.join(root, ".bantam", "self-observations.json"),
      "utf8",
    );

    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "observed-protocol-invalids",
      planOnly: true,
      env: {},
    });

    assert.equal(result.status, "planned");
    assert.equal(result.selected.source, "runtime-observation");
    assert.equal(result.selected.promotionEligible, false);
    assert.equal(result.selected.lanePolicy, "build-only");
    assert.equal(result.selected.evidence.affectedRuns, 2);
    assert.match(formatGovernedSelfImproveResult(result), /build-only/i);
    assert.equal(fs.existsSync(path.join(root, ".bantam", "state")), false);
    assert.equal(fs.existsSync(path.join(root, ".bantam", "self-improve")), false);
    assert.equal(
      fs.readFileSync(path.join(root, ".bantam", "self-observations.json"), "utf8"),
      observationState,
    );
  });

  it("builds and tests in isolation but stages on dev even when apply was requested", async () => {
    const root = selfHostWorkspace();
    recordProtocolInvalid(root, "first affected task");
    recordProtocolInvalid(root, "second affected task");
    const verificationPhases = [];
    let deployed = false;

    const result = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "observed-protocol-invalids",
      verificationScript: "npm test",
      apply: true,
      implement: async (context) => {
        assert.notEqual(context.workspace, root);
        assert.equal(context.candidate.source, "runtime-observation");
        assert.equal(context.candidate.promotionEligible, false);
        assert.equal(context.candidate.lanePolicy, "build-only");
        assert.match(context.task, /build-only/i);
        fs.writeFileSync(
          path.join(context.workspace, "src", "protocol-repair.js"),
          "export const protocolRepair = true;\n",
        );
        fs.writeFileSync(
          path.join(context.workspace, "test", "protocol-repair.test.js"),
          [
            'import assert from "node:assert/strict";',
            'import { test } from "node:test";',
            'import { protocolRepair } from "../src/protocol-repair.js";',
            'test("protocol repair", () => assert.equal(protocolRepair, true));',
            "",
          ].join("\n"),
        );
        return {
          done: true,
          reachedDone: true,
          verification: green({ passed: 2 }),
          metrics: { turns: 3, invalid: 0, protocolViolations: 0 },
          summary: "built a protocol repair candidate",
        };
      },
      verify: async (_target, _script, { phase }) => {
        verificationPhases.push(phase);
        return green({ passed: phase === "candidate-snapshot" ? 2 : 1 });
      },
      afterDeploy: async () => {
        deployed = true;
      },
      env: {},
    });

    assert.equal(result.status, "staged");
    assert.equal(result.applied, false);
    assert.equal(result.restartRequired, false);
    assert.equal(result.promotionEligible, false);
    assert.equal(deployed, false);
    assert.deepEqual(verificationPhases, [
      "baseline",
      "candidate-snapshot",
      "protected-baseline-suite",
    ]);
    assert.equal(fs.existsSync(path.join(root, "src", "protocol-repair.js")), false);
    assert.equal(fs.existsSync(path.join(root, "test", "protocol-repair.test.js")), false);

    const store = new LaneStore(path.join(root, ".bantam", "state"));
    const regular = store.readChannel("regular");
    const dev = store.readChannel("dev");
    assert.notEqual(dev.versionRef, regular.versionRef);
    assert.equal(dev.versionRef, result.candidateVersionRef);
    assert.notEqual(regular.versionRef, result.candidateVersionRef);

    const materialized = tempDir("bantam-runtime-candidate-");
    store.materializeHarnessVersion(result.candidateVersionRef, materialized);
    assert.equal(fs.existsSync(path.join(materialized, "src", "protocol-repair.js")), true);
    assert.equal(fs.existsSync(path.join(materialized, "test", "protocol-repair.test.js")), true);

    const evidence = store.blobs.getJson(result.evidenceRef);
    assert.equal(evidence.candidate.promotionEligible, false);
    assert.equal(evidence.candidate.lanePolicy, "build-only");
    assert.equal(evidence.metric.measured, false);
    assert.equal(evidence.metric.improved, null);
    assert.match(evidence.metric.reason, /preregistered paired behavioral benchmark/i);

    const attempts = JSON.parse(fs.readFileSync(
      path.join(root, ".bantam", "self-improve", "self-improve-attempts.json"),
      "utf8",
    ));
    assert.equal(attempts.at(-1).phase, "staged");
    assert.equal(attempts.at(-1).apply, false);
    assert.equal(attempts.at(-1).requestedApply, true);
    assert.match(formatGovernedSelfImproveResult(result), /not promotion evidence/i);

    const reused = await runGovernedSelfImprove({
      workspace: root,
      candidateId: "observed-protocol-invalids",
      verificationScript: "npm test",
      apply: true,
      implement: async () => {
        throw new Error("an identical staged candidate must not be rebuilt");
      },
      verify: async () => {
        throw new Error("an identical staged candidate must not be reverified");
      },
      env: {},
    });
    assert.equal(reused.status, "staged");
    assert.equal(reused.reused, true);
    assert.equal(reused.candidateVersionRef, result.candidateVersionRef);
    assert.equal(reused.evidenceRef, result.evidenceRef);
    assert.match(formatGovernedSelfImproveResult(reused), /reused without rebuilding/i);
  });

  it("advances default runs past an already verified build-only candidate", async () => {
    const root = selfHostWorkspace();
    const built = [];
    const implement = async (context) => {
      built.push(context.candidate.id);
      const target = context.candidate.targets[0];
      const sourcePath = path.join(context.workspace, "src", target);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "export const improvementProbe = true;\n");
      fs.writeFileSync(
        path.join(context.workspace, "test", `${context.candidate.id}.test.js`),
        [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          `import { improvementProbe } from "../src/${target}";`,
          'test("improvement probe", () => assert.equal(improvementProbe, true));',
          "",
        ].join("\n"),
      );
      return {
        done: true,
        reachedDone: true,
        verification: green({ passed: 2 }),
        metrics: { turns: 2, invalid: 0, protocolViolations: 0 },
        summary: "built one bounded candidate",
      };
    };
    const verify = async (_target, _script, { phase }) => (
      green({ passed: phase === "candidate-snapshot" ? 2 : 1 })
    );

    const first = await runGovernedSelfImprove({
      workspace: root,
      verificationScript: "npm test",
      implement,
      verify,
      env: {},
    });
    const second = await runGovernedSelfImprove({
      workspace: root,
      verificationScript: "npm test",
      implement,
      verify,
      env: {},
    });

    assert.equal(first.status, "staged");
    assert.equal(second.status, "staged");
    assert.notEqual(second.selected.id, first.selected.id);
    assert.deepEqual(built, [first.selected.id, second.selected.id]);
  });
});

function selfHostWorkspace() {
  const root = tempDir("bantam-runtime-self-improve-");
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
  fs.writeFileSync(path.join(root, "bin", "run-dev.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(root, "bin", "bantam.js"), "export const cli = true;\n");
  fs.writeFileSync(path.join(root, "src", "agent.js"), "export const agent = true;\n");
  fs.writeFileSync(path.join(root, "src", "self-improve.js"), "export const improve = true;\n");
  fs.writeFileSync(path.join(root, "src", "existing.js"), "export const existing = true;\n");
  fs.writeFileSync(path.join(root, "test", "existing.test.js"), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'test("existing", () => assert.equal(1, 1));',
    "",
  ].join("\n"));
  return root;
}

function recordProtocolInvalid(root, task) {
  return recordSelfObservation(root, {
    task,
    recordedAt: new Date().toISOString(),
    result: {
      finalStatus: "pass",
      verification: { status: "pass", exitCode: 0 },
      metrics: {
        turns: 5,
        invalid: 1,
        protocolViolations: 1,
        durationMs: 100,
      },
    },
  });
}

function green({ passed = 1 } = {}) {
  return {
    status: "pass",
    exitCode: 0,
    tests: { passed, failed: 0 },
    output: `# tests ${passed}\n# pass ${passed}\n# fail 0\n`,
  };
}

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}
