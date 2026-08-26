import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BANTAM_SELF_HOST_MARKERS,
  deriveSelfImprovementCandidates,
  isBantamSelfHostWorkspace,
  isObservableSelfHostWork,
  loadSelfObservations,
  observeCompletedSelfHostRun,
  recordSelfObservation,
  SELF_OBSERVATION_LIMIT,
  SELF_OBSERVATION_PATH,
  summarizeSelfObservation,
} from "../src/self-observation.js";

const temporary = new Set();
const STAMP = "2026-07-23T12:00:00.000Z";

afterEach(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
  temporary.clear();
});

describe("Bantam self-host recognition", () => {
  it("requires the exact regular marker files and package identity", () => {
    const root = selfHostWorkspace();

    assert.equal(isBantamSelfHostWorkspace(root), true);

    fs.unlinkSync(path.join(root, "src", "agent.js"));
    assert.equal(isBantamSelfHostWorkspace(root), false);

    write(root, "src/agent.js", "export {};\n");
    writePackage(root, { name: "not-bantam" });
    assert.equal(isBantamSelfHostWorkspace(root), false);
  });

  it("does not accept a symlink in place of a marker", () => {
    const root = selfHostWorkspace();
    const marker = path.join(root, "bin", "run-dev.sh");
    const target = path.join(root, "not-the-local-launcher.sh");
    fs.unlinkSync(marker);
    fs.writeFileSync(target, "#!/bin/sh\n");
    fs.symlinkSync(target, marker);

    assert.equal(isBantamSelfHostWorkspace(root), false);
  });

  it("exports the stable marker list used by the recognizer", () => {
    assert.deepEqual(BANTAM_SELF_HOST_MARKERS, [
      "package.json",
      "bin/run-dev.sh",
      "bin/bantam.js",
      "src/agent.js",
      "src/self-improve.js",
    ]);
    assert.equal(Object.isFrozen(BANTAM_SELF_HOST_MARKERS), true);
  });
});

describe("self-observation summarization", () => {
  it("records operational evidence but excludes greetings and read-only explanations", () => {
    assert.equal(isObservableSelfHostWork(null), false);
    assert.equal(isObservableSelfHostWork({
      responded: true,
      metrics: { actions: { respond: 1 } },
    }), false);
    assert.equal(isObservableSelfHostWork({
      reachedDone: true,
      metrics: { actions: { read_file: 2, search: 1, done: 1 } },
    }), false);
    assert.equal(isObservableSelfHostWork({
      reachedDone: true,
      metrics: { actions: { replace: 1 } },
    }), true);
    assert.equal(isObservableSelfHostWork({
      metrics: { invalid: 1, actions: {} },
    }), true);
    assert.equal(isObservableSelfHostWork({
      turns: [{ sourceEditedByShell: true, shellChangedPaths: ["src/example.js"] }],
      metrics: { actions: { shell: 1 } },
    }), true);
    assert.equal(isObservableSelfHostWork({
      verification: { status: "fail" },
      metrics: { actions: {} },
    }), true);
  });

  it("retains bounded outcome counters and hashes the task without retaining raw text", () => {
    const secret = "Fix the SECRET customer task and never persist this text";
    const result = {
      finalStatus: "fail",
      interrupted: true,
      blocked: { operation: "install", message: secret },
      summary: secret,
      turns: [{ prompt: secret, reasoning: secret, observation: secret }],
      rejectedOutputs: [{ rawOutput: secret }],
      verification: {
        status: "fail",
        detail: secret,
        exitCode: 7,
        signal: "SIGTERM",
        timedOut: false,
      },
      metrics: {
        turns: 42,
        invalid: 2,
        protocolViolations: 3,
        duplicateActionRejections: 4,
        duplicateShellRejections: 5,
        repeatEscapeMasks: 6,
        noOpEdits: 7,
        durationMs: 1234.9,
        actions: {
          read_file: 8,
          replace: 9,
          "raw secret action": 100,
          negative: -1,
        },
        replaceFailures: {
          total: 3,
          oldNotFound: 1,
          ambiguous: 1,
          lineStale: 1,
          other: 0,
        },
        patchFailures: {
          total: 2,
          oldNotFound: 1,
          ambiguous: 0,
          overlap: 1,
          other: 0,
        },
        fileOperationFailures: {
          total: 1,
          delete_file: 1,
          move_file: 0,
          other: 0,
        },
      },
    };

    const summary = summarizeSelfObservation({ task: secret, result, recordedAt: STAMP });

    assert.equal(summary.taskSha256, digest(secret));
    assert.equal(summary.recordedAt, STAMP);
    assert.deepEqual(summary.result, {
      status: "interrupted",
      verification: {
        attempted: true,
        status: "fail",
        exitCode: 7,
        timedOut: false,
        bufferExceeded: false,
        aborted: false,
        signaled: true,
        flaky: false,
      },
      interrupted: true,
      blocked: true,
    });
    assert.deepEqual(summary.metrics.actions, { read_file: 8, replace: 9 });
    assert.equal(summary.metrics.durationMs, 1234);
    assert.equal(summary.metrics.editFailures.total, 6);
    assert.deepEqual(summary.metrics.editFailures.replace, result.metrics.replaceFailures);
    assert.deepEqual(summary.metrics.editFailures.patch, result.metrics.patchFailures);
    assert.deepEqual(
      summary.metrics.editFailures.fileOperations,
      result.metrics.fileOperationFailures,
    );
    assert.equal(JSON.stringify(summary).includes(secret), false);
    for (const forbidden of [
      "task",
      "summary",
      "turns",
      "prompt",
      "detail",
      "message",
      "rejectedOutputs",
    ]) {
      assert.equal(Object.hasOwn(summary, forbidden), false);
    }
  });

  it("accepts completed artifact shape without persisting artifact prose", () => {
    const summary = summarizeSelfObservation({
      task: "artifact task",
      recordedAt: STAMP,
      result: {
        kind: "bantam-run",
        result: {
          status: "pass",
          interrupted: false,
          blocked: null,
          verifyDetail: "large raw verifier output",
          exitCode: 0,
        },
        metrics: {
          turns: 4,
          totalMs: 90,
          actions: { patch: 2 },
          replaceFailures: {},
          patchFailures: { oldNotFound: 1 },
          fileOperationFailures: {},
        },
      },
    });

    assert.equal(summary.result.status, "pass");
    assert.equal(summary.result.verification.status, "pass");
    assert.equal(summary.result.verification.attempted, true);
    assert.equal(summary.result.verification.exitCode, 0);
    assert.equal(summary.metrics.durationMs, 90);
    assert.equal(summary.metrics.editFailures.patch.total, 1);
    assert.equal(JSON.stringify(summary).includes("large raw verifier output"), false);
  });

  it("rejects missing task or run metrics instead of inventing evidence", () => {
    assert.throws(
      () => summarizeSelfObservation({ task: "", result: { metrics: {} } }),
      /task must be a non-empty string/,
    );
    assert.throws(
      () => summarizeSelfObservation({ task: "task", result: {} }),
      /must contain metrics/,
    );
  });
});

describe("completed-run observation routing", () => {
  it("records external-project work in the launcher checkout, never the task workspace", () => {
    const launcherRoot = selfHostWorkspace();
    const taskRoot = tempDir("bantam-external-task-workspace-");
    write(taskRoot, "src/customer-project.js", "export const external = true;\n");
    const input = runInput("repair the external project", {
      actions: { replace: 1 },
    });

    const recorded = observeCompletedSelfHostRun({
      launcherWorkspace: launcherRoot,
      taskWorkspace: taskRoot,
      task: input.task,
      result: input.result,
    });

    assert.equal(recorded.taskSha256, digest(input.task));
    assert.equal(loadSelfObservations(launcherRoot).length, 1);
    assert.equal(
      fs.existsSync(path.join(launcherRoot, SELF_OBSERVATION_PATH)),
      true,
    );
    assert.equal(fs.existsSync(path.join(taskRoot, ".bantam")), false);
    assert.equal(
      fs.readFileSync(path.join(taskRoot, "src", "customer-project.js"), "utf8"),
      "export const external = true;\n",
    );
  });

  it("preserves self-host routing when the task and launcher checkout are the same", () => {
    const root = selfHostWorkspace();
    const input = runInput("improve Bantam itself", {
      actions: { patch: 1 },
    });

    const recorded = observeCompletedSelfHostRun({
      launcherWorkspace: root,
      taskWorkspace: root,
      task: input.task,
      result: input.result,
    });

    assert.equal(recorded.taskSha256, digest(input.task));
    assert.equal(loadSelfObservations(root).length, 1);
  });

  it("does not record read-only runs in either workspace", () => {
    const launcherRoot = selfHostWorkspace();
    const taskRoot = tempDir("bantam-read-only-task-workspace-");
    const input = runInput("explain the external project", {
      actions: { read_file: 2, done: 1 },
    });

    assert.equal(observeCompletedSelfHostRun({
      launcherWorkspace: launcherRoot,
      taskWorkspace: taskRoot,
      task: input.task,
      result: {
        ...input.result,
        verification: undefined,
      },
    }), null);
    assert.deepEqual(loadSelfObservations(launcherRoot), []);
    assert.equal(fs.existsSync(path.join(taskRoot, ".bantam")), false);
  });
});

describe("atomic bounded self-observation store", () => {
  it("records only in a recognized self-host workspace and loads a detached snapshot", () => {
    const root = selfHostWorkspace();
    const input = runInput("first task", { turns: 3 });

    assert.deepEqual(loadSelfObservations(root), []);
    const recorded = recordSelfObservation(root, input);
    input.result.metrics.turns = 999;

    const loaded = loadSelfObservations(root);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].metrics.turns, 3);
    assert.deepEqual(loaded[0], recorded);
    assert.equal(
      fs.existsSync(path.join(root, SELF_OBSERVATION_PATH)),
      true,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(root, ".bantam")).filter((name) => name.endsWith(".tmp")),
      [],
    );

    loaded[0].metrics.turns = 88;
    assert.equal(loadSelfObservations(root)[0].metrics.turns, 3);
  });

  it("serializes concurrent writers without losing observations", async () => {
    const root = selfHostWorkspace();
    const barrier = path.join(root, "release-concurrent-writers");
    const stateRoot = path.join(root, ".bantam");
    const staleLock = path.join(stateRoot, "self-observations.lock");
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(staleLock, JSON.stringify({
      schema: 1,
      kind: "bantam-self-observations",
      pid: 2_000_000_000,
      token: "stale-observation-owner",
      acquiredAt: "2000-01-01T00:00:00.000Z",
    }));
    fs.utimesSync(staleLock, new Date(0), new Date(0));
    // A recovery-mutex pathname can survive a killed process; kernel flock
    // ownership cannot, so this file must never wedge future recovery.
    fs.writeFileSync(`${staleLock}.recovery`, "abandoned recovery guard\n");
    const moduleUrl = pathToFileURL(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/self-observation.js"),
    ).href;
    const childSource = `
      import fs from "node:fs";
      import { recordSelfObservation } from ${JSON.stringify(moduleUrl)};
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.env.BANTAM_TEST_BARRIER)) {
        Atomics.wait(sleeper, 0, 0, 5);
      }
      recordSelfObservation(process.env.BANTAM_TEST_ROOT, {
        task: \`concurrent task \${process.env.BANTAM_TEST_ID}\`,
        result: {
          reachedDone: true,
          verification: { status: "pass", exitCode: 0 },
          metrics: {
            turns: 1,
            actions: { replace: 1 },
            replaceFailures: {},
            patchFailures: {},
            fileOperationFailures: {},
          },
        },
      });
    `;
    const writers = Array.from({ length: 8 }, (_, index) => (
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "--eval", childSource],
          {
            env: {
              ...process.env,
              BANTAM_TEST_BARRIER: barrier,
              BANTAM_TEST_ROOT: root,
              BANTAM_TEST_ID: String(index),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) resolve();
          else reject(new Error(`concurrent writer exited ${code ?? signal}: ${stderr}`));
        });
      })
    ));

    fs.writeFileSync(barrier, "go\n");
    await Promise.all(writers);

    const loaded = loadSelfObservations(root);
    assert.equal(loaded.length, writers.length);
    assert.equal(new Set(loaded.map(({ taskSha256 }) => taskSha256)).size, writers.length);
    assert.equal(
      fs.existsSync(path.join(root, ".bantam", "self-observations.lock")),
      false,
    );
  });

  it("refuses to create telemetry in an unrelated workspace", () => {
    const root = tempDir("bantam-self-observation-unrelated-");

    assert.throws(
      () => recordSelfObservation(root, runInput("task")),
      /requires a Bantam self-host workspace/,
    );
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("refuses a symlinked state parent without touching the external directory", () => {
    const root = selfHostWorkspace();
    const outside = tempDir("bantam-self-observation-outside-");
    fs.symlinkSync(outside, path.join(root, ".bantam"), "dir");

    assert.throws(
      () => loadSelfObservations(root),
      /refuses non-directory or symlinked state root/i,
    );
    assert.throws(
      () => recordSelfObservation(root, runInput("task")),
      /refuses non-directory or symlinked state root/i,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("fails closed on malformed or schema-expanded state without replacing it", () => {
    const root = selfHostWorkspace();
    const store = path.join(root, SELF_OBSERVATION_PATH);
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, "{ this is not JSON");
    const malformed = fs.readFileSync(store, "utf8");

    assert.throws(() => loadSelfObservations(root), /store is corrupt/);
    assert.throws(
      () => recordSelfObservation(root, runInput("new task")),
      /store is corrupt/,
    );
    assert.equal(fs.readFileSync(store, "utf8"), malformed);

    const expanded = summarizeSelfObservation(runInput("old task"));
    expanded.rawPrompt = "must not survive";
    fs.writeFileSync(store, JSON.stringify([expanded]));
    assert.throws(() => loadSelfObservations(root), /fields do not match schema/);
  });

  it("migrates legacy rows while conservatively distinguishing absent verification", () => {
    const root = selfHostWorkspace();
    const store = path.join(root, SELF_OBSERVATION_PATH);
    const legacy = summarizeSelfObservation({
      task: "legacy unverified task",
      recordedAt: STAMP,
      result: {
        metrics: {
          turns: 1,
          invalid: 1,
          actions: {},
          replaceFailures: {},
          patchFailures: {},
          fileOperationFailures: {},
        },
      },
    });
    legacy.schema = 1;
    delete legacy.result.verification.attempted;
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify([legacy]));

    const [loaded] = loadSelfObservations(root);
    assert.equal(loaded.schema, 2);
    assert.equal(loaded.result.verification.status, "unverified");
    assert.equal(loaded.result.verification.attempted, false);
  });

  it("retains only the newest 200 observations", () => {
    const root = selfHostWorkspace();
    const store = path.join(root, SELF_OBSERVATION_PATH);
    const existing = Array.from({ length: SELF_OBSERVATION_LIMIT }, (_, index) => (
      summarizeSelfObservation(runInput(`old task ${index}`, { turns: index }))
    ));
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(existing));

    recordSelfObservation(root, runInput("newest task", { turns: 999 }));

    const loaded = loadSelfObservations(root);
    assert.equal(loaded.length, SELF_OBSERVATION_LIMIT);
    assert.equal(loaded.some((row) => row.taskSha256 === digest("old task 0")), false);
    assert.equal(loaded[0].taskSha256, digest("old task 1"));
    assert.equal(loaded.at(-1).taskSha256, digest("newest task"));
    assert.equal(loaded.at(-1).metrics.turns, 999);
  });

  it("rejects an over-limit store as corruption instead of truncating it silently", () => {
    const root = selfHostWorkspace();
    const store = path.join(root, SELF_OBSERVATION_PATH);
    const observation = summarizeSelfObservation(runInput("same task"));
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
      JSON.stringify(Array.from({ length: SELF_OBSERVATION_LIMIT + 1 }, () => observation)),
    );

    assert.throws(() => loadSelfObservations(root), /exceeds 200/);
  });
});

describe("repeated-evidence improvement candidates", () => {
  it("emits no candidate from a single affected run", () => {
    const rows = [observedRun("one", {
      verification: "fail",
      turns: 100,
      invalid: 4,
      replaceFailures: 3,
      duplicateActionRejections: 2,
    })];

    assert.deepEqual(deriveSelfImprovementCandidates(rows), []);
  });

  it("does not diagnose verifier reliability when no verifier was attempted", () => {
    const rows = ["one", "two"].map((task) => summarizeSelfObservation({
      task,
      recordedAt: STAMP,
      result: {
        metrics: {
          turns: 1,
          invalid: 1,
          actions: {},
          replaceFailures: {},
          patchFailures: {},
          fileOperationFailures: {},
        },
      },
    }));

    assert.deepEqual(
      deriveSelfImprovementCandidates(rows).map(({ id }) => id),
      ["observed-protocol-invalids"],
    );
    assert.equal(rows.every((row) => row.result.verification.attempted === false), true);
  });

  it("derives concrete merge-compatible candidates and ranks them deterministically", () => {
    const rows = [
      observedRun("first", {
        verification: "fail",
        turns: 50,
        invalid: 1,
        replaceFailures: 2,
        duplicateActionRejections: 2,
      }),
      observedRun("second", {
        verification: "unverified",
        turns: 31,
        protocolViolations: 2,
        patchFailures: 1,
        repeatEscapeMasks: 1,
        noOpEdits: 1,
      }),
      observedRun("third", {
        verification: "pass",
        turns: 10,
      }),
    ];

    const candidates = deriveSelfImprovementCandidates(rows);

    assert.deepEqual(candidates.map(({ id }) => id), [
      "observed-verifier-reliability",
      "observed-edit-retries",
      "observed-protocol-invalids",
      "observed-excessive-turns",
      "observed-repeat-waste",
    ]);
    for (const candidate of candidates) {
      assert.deepEqual(
        Object.keys(candidate),
        ["id", "area", "problem", "proposal", "targets", "occurrences", "effort", "impact", "evidence"],
      );
      assert.ok(candidate.targets.length > 0);
      assert.equal(candidate.evidence.affectedRuns, 2);
      assert.equal(candidate.evidence.totalRuns, 3);
      assert.equal(candidate.evidence.affectedRate, 2 / 3);
      assert.equal(candidate.evidence.taskSha256.length, 2);
    }

    const verifier = candidates[0];
    assert.equal(verifier.occurrences, 2);
    assert.deepEqual(verifier.evidence.counts, { failed: 1, unverified: 1 });

    const edits = candidates.find(({ id }) => id === "observed-edit-retries");
    assert.equal(edits.occurrences, 3);
    assert.deepEqual(edits.evidence.counts, {
      replace: 2,
      patch: 1,
      fileOperations: 0,
    });

    const turns = candidates.find(({ id }) => id === "observed-excessive-turns");
    assert.equal(turns.occurrences, 21);
    assert.equal(turns.evidence.threshold, 30);
  });

  it("honors a configured turn threshold and validates persisted observations", () => {
    const rows = [
      observedRun("first", { verification: "pass", turns: 11 }),
      observedRun("second", { verification: "pass", turns: 12 }),
    ];

    assert.deepEqual(
      deriveSelfImprovementCandidates(rows).map(({ id }) => id),
      [],
    );
    assert.deepEqual(
      deriveSelfImprovementCandidates(rows, { excessiveTurns: 10 }).map(({ id }) => id),
      ["observed-excessive-turns"],
    );
    assert.throws(
      () => deriveSelfImprovementCandidates(rows, { excessiveTurns: 0 }),
      /positive integer/,
    );

    const corrupt = structuredClone(rows[0]);
    corrupt.task = "raw task text";
    assert.throws(
      () => deriveSelfImprovementCandidates([corrupt, rows[1]]),
      /fields do not match schema/,
    );
  });
});

function selfHostWorkspace() {
  const root = tempDir("bantam-self-observation-host-");
  writePackage(root);
  for (const marker of BANTAM_SELF_HOST_MARKERS) {
    if (marker === "package.json") continue;
    write(root, marker, marker === "bin/run-dev.sh" ? "#!/bin/sh\n" : "export {};\n");
  }
  return root;
}

function writePackage(root, overrides = {}) {
  write(root, "package.json", `${JSON.stringify({
    name: "bantam",
    private: true,
    type: "module",
    bin: { bantam: "bin/bantam.js" },
    ...overrides,
  })}\n`);
}

function runInput(task, metrics = {}) {
  return {
    task,
    recordedAt: STAMP,
    result: {
      reachedDone: true,
      verification: { status: "pass", exitCode: 0 },
      interrupted: false,
      blocked: null,
      metrics: {
        turns: 1,
        actions: {},
        replaceFailures: {},
        patchFailures: {},
        fileOperationFailures: {},
        ...metrics,
      },
    },
  };
}

function observedRun(task, {
  verification = "pass",
  turns = 1,
  invalid = 0,
  protocolViolations = 0,
  replaceFailures = 0,
  patchFailures = 0,
  fileOperationFailures = 0,
  duplicateActionRejections = 0,
  duplicateShellRejections = 0,
  repeatEscapeMasks = 0,
  noOpEdits = 0,
} = {}) {
  return summarizeSelfObservation({
    task,
    recordedAt: STAMP,
    result: {
      verification: {
        status: verification,
        exitCode: verification === "pass" ? 0 : verification === "fail" ? 1 : null,
      },
      metrics: {
        turns,
        invalid,
        protocolViolations,
        duplicateActionRejections,
        duplicateShellRejections,
        repeatEscapeMasks,
        noOpEdits,
        actions: {},
        replaceFailures: { total: replaceFailures },
        patchFailures: { total: patchFailures },
        fileOperationFailures: { total: fileOperationFailures },
      },
    },
  });
}

function write(root, relative, contents) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(root);
  return root;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
