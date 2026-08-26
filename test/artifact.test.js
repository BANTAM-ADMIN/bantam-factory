import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  appendLedgerRow,
  buildArtifact,
  buildLedgerRow,
  fetchModelId,
  makeRunId,
  makeStamp,
  saveArtifact,
} from "../src/artifact.js";

const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-artifact-"));
  tempDirs.push(directory);
  return directory;
}

function baseInput(overrides = {}) {
  return {
    runId: "run-2026-07-23T12-00-00-000Z-abcdef",
    stamp: "2026-07-23T12-00-00-000Z",
    fixture: "artifact-fixture",
    task: "Preserve exact evidence",
    model: {
      endpoint: "http://127.0.0.1:8080",
      profileName: "dev",
      temperature: 0.2,
      actTemperature: 0.1,
      topP: 0.95,
      topK: 40,
      seed: 17,
      nPredict: 2048,
      stop: ["</s>"],
      completionIndex: 9,
    },
    modelId: "model.gguf",
    result: {
      turns: [],
      rejectedOutputs: [],
      warnings: [],
      verification: {
        status: "pass",
        detail: "verified",
        exitCode: 0,
      },
      finalStatus: "pass",
      reachedDone: true,
      metrics: {},
    },
    ...overrides,
  };
}

describe("artifact construction", () => {
  it("preserves bounded terminal model-failure evidence", () => {
    const artifact = buildArtifact(baseInput({
      result: {
        ...baseInput().result,
        reachedDone: false,
        modelFailure: {
          message: "Codex turn was inactive for 100ms",
          code: "model_timeout",
          provider: "codex",
          timeoutKind: "idle",
          retryable: false,
          stack: "must not persist",
        },
      },
    }));

    assert.deepEqual(artifact.result.modelFailure, {
      message: "Codex turn was inactive for 100ms",
      code: "model_timeout",
      provider: "codex",
      timeoutKind: "idle",
      retryable: false,
    });
  });

  it("normalizes public fields and provenance without retaining mutable run references", () => {
    const parsedAction = { a: "write", p: "answer.txt", content: "original" };
    const modelRequest = { prompt: "original prompt" };
    const stateAudit = { pending: true, deferralsUsed: 1, evidence: null };
    const actions = { write: 1 };
    const finalDiff = { status: "captured", sha256: "abc", text: "original diff" };
    const input = baseInput({
      model: {
        ...baseInput().model,
        metadata() {
          return {
            endpoint: this.endpoint,
            profile: this.profileName,
            completionIndex: this.completionIndex,
            sampling: { temperature: this.temperature, top_p: this.topP },
          };
        },
        requestLog() {
          return [{
            request: { prompt: "recorded" },
            response: {
              content: "ok",
              normalized: {
                codexThread: {
                  threadId: "thread-1",
                  threadMode: "run",
                  threadReused: false,
                  threadRebaseReason: "periodic",
                },
                codexPromptDelivery: {
                  mode: "delta",
                  rebaseReason: "periodic",
                  canonicalChars: 100,
                  deliveredChars: 40,
                  savedChars: 60,
                },
              },
            },
          }];
        },
      },
      result: {
        turns: [{
          i: 3,
          reasoning: "reason",
          rawOutput: '{"a":"write"}',
          parsedAction,
          observation: "wrote file",
          modelRequest,
          shellChangedPaths: ["answer.txt"],
          stateAudit,
        }],
        rejectedOutputs: [{ turn: 2, attempt: 1, rawOutput: "bad", error: "invalid" }],
        warnings: [{ gate: "scope", message: "warning" }],
        verification: { status: "pass", detail: "verified", exitCode: 0 },
        contractVerification: {
          status: "pass",
          pass: true,
          tests: 2,
          passed: 2,
          failed: 0,
          exitCode: 0,
        },
        finalStatus: "pass",
        reachedDone: true,
        metrics: {
          turns: 4,
          modelRequests: 6,
          auxiliaryModelRequests: 2,
          modelRequestsPerTurn: 1.5,
          tokens: 21,
          durationMs: 32,
          actions,
          stateAuditEngagements: 2,
          stateAuditDoneDeferrals: 1,
          scopeMismatchNotices: 1,
          embeddedBaselineRecognitions: 2,
          successfulShellReplaySlims: 3,
          successfulShellReplayOmittedChars: 4096,
          replaceFailures: { total: 1, oldNotFound: 1 },
          patchActionPolicy: { mode: "native", enabled: true, reason: "available" },
        },
      },
      finalDiff,
      harnessGit: {
        schema: 1,
        sha: "deadbeef",
        dirty: true,
        dirtyHash: "dirty",
        status: [" M src/a.js"],
        ignoredExtra: "drop me",
      },
      experiment: {
        id: "exp-1",
        name: "artifact experiment",
        arm: "candidate",
        round: 2,
        sequence: 4,
        seed: 31,
        ignoredExtra: "drop me",
      },
      continuation: { parentRunId: "run-parent", turn: 4 },
    });

    const artifact = buildArtifact(input);

    parsedAction.content = "mutated";
    modelRequest.prompt = "mutated";
    stateAudit.pending = false;
    actions.write = 99;
    finalDiff.text = "mutated";

    assert.equal(artifact.schema, 2);
    assert.equal(artifact.kind, "bantam-run");
    assert.equal(artifact.result.pass, true);
    assert.equal(artifact.result.contract.status, "pass");
    assert.equal(artifact.turns[0].parsedAction.content, "original");
    assert.equal(artifact.turns[0].modelRequest.prompt, "original prompt");
    assert.equal(artifact.turns[0].stateAudit.pending, true);
    assert.equal(artifact.metrics.actions.write, 1);
    assert.equal(artifact.metrics.modelRequests, 6);
    assert.equal(artifact.metrics.auxiliaryModelRequests, 2);
    assert.equal(artifact.metrics.modelRequestsPerTurn, 1.5);
    assert.equal(artifact.metrics.stateAuditEngagements, 2);
    assert.equal(artifact.metrics.stateAuditDoneDeferrals, 1);
    assert.equal(artifact.metrics.scopeMismatchNotices, 1);
    assert.equal(artifact.metrics.embeddedBaselineRecognitions, 2);
    assert.equal(artifact.metrics.successfulShellReplaySlims, 3);
    assert.equal(artifact.metrics.successfulShellReplayOmittedChars, 4096);
    assert.equal(artifact.finalDiff.text, "original diff");
    assert.deepEqual(artifact.harnessGit.status, [" M src/a.js"]);
    assert.equal("ignoredExtra" in artifact.harnessGit, false);
    assert.equal(artifact.experiment.arm, "candidate");
    assert.equal("ignoredExtra" in artifact.experiment, false);
    assert.deepEqual(artifact.continuation, { parentRunId: "run-parent", turn: 4 });
    assert.equal(artifact.modelCalls.length, 1);
    assert.equal(artifact.modelCalls[0].promptTelemetry.chars, "recorded".length);
    assert.equal(artifact.modelCalls[0].promptTelemetry.comparison, null);
    assert.equal(artifact.metrics.promptChurn.callsWithPrompt, 1);
    assert.equal(artifact.metrics.promptChurn.totalChars, "recorded".length);
    assert.equal(artifact.metrics.codexPromptIntegrity.status, "fail");
    assert.ok(artifact.metrics.codexPromptIntegrity.failures.length > 0);
    assert.deepEqual(artifact.metrics.codexThreads, {
      mode: "run",
      calls: 1,
      uniqueThreads: 1,
      reusedCalls: 0,
      rebasedCalls: 1,
      terminalRebasedCalls: 1,
      postRebaseCalls: 0,
      rebaseCallIndices: [1],
      rebaseReasons: { periodic: 1 },
    });
    assert.deepEqual(artifact.metrics.codexPromptDelivery, {
      calls: 1,
      fullCalls: 0,
      deltaCalls: 1,
      fallbackCalls: 0,
      rebaseCalls: 1,
      canonicalChars: 100,
      deliveredChars: 40,
      savedChars: 60,
      savedRatio: 0.6,
      minDeltaSavedRatio: 0.6,
      lowSavingsDeltaCalls: 0,
    });
    assert.match(artifact.model.fingerprint, /^[a-f0-9]{64}$/);
  });

  it("uses a canonical model fingerprint and excludes resumable call position", () => {
    const first = buildArtifact(baseInput({
      model: {
        ...baseInput().model,
        metadata: () => ({
          endpoint: "local",
          completionIndex: 1,
          sampling: { temperature: 0.2, top_p: 0.95 },
        }),
      },
    }));
    const second = buildArtifact(baseInput({
      model: {
        ...baseInput().model,
        metadata: () => ({
          sampling: { top_p: 0.95, temperature: 0.2 },
          completionIndex: 999,
          endpoint: "local",
        }),
      },
    }));

    assert.equal(first.model.fingerprint, second.model.fingerprint);
  });

  it("falls back to public model fields when custom metadata is not serializable", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const artifact = buildArtifact(baseInput({
      model: {
        ...baseInput().model,
        metadata: () => cyclic,
      },
    }));

    assert.equal(artifact.model.metadata.endpoint, "http://127.0.0.1:8080");
    assert.equal(artifact.model.metadata.profile, "dev");
    assert.match(artifact.model.fingerprint, /^[a-f0-9]{64}$/);
  });

  it("handles absent optional collections but rejects malformed required evidence", () => {
    const artifact = buildArtifact(baseInput({
      fixture: undefined,
      task: 42,
      result: {
        turns: null,
        rejectedOutputs: null,
        warnings: null,
        metrics: null,
      },
    }));

    assert.equal(artifact.fixture, null);
    assert.equal(artifact.task, null);
    assert.deepEqual(artifact.turns, []);
    assert.deepEqual(artifact.rejectedOutputs, []);
    assert.deepEqual(artifact.result.warnings, []);
    assert.equal(artifact.result.status, "unverified");

    assert.throws(
      () => buildArtifact(baseInput({ runId: "" })),
      /runId must be a non-empty string/,
    );
    assert.throws(
      () => buildArtifact(baseInput({ result: null })),
      /result must be an object/,
    );
    assert.throws(
      () => buildArtifact(baseInput({ result: { turns: {} } })),
      /result\.turns must be an array/,
    );
  });
});

describe("artifact persistence and ledger projection", () => {
  it("atomically saves parseable JSON in a new parent directory", () => {
    const directory = fixture();
    const destination = path.join(directory, "nested", "run.json");
    const artifact = buildArtifact(baseInput());

    const written = saveArtifact(destination, artifact);

    assert.equal(written, path.resolve(destination));
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), artifact);
    assert.match(fs.readFileSync(destination, "utf8"), /\n$/);
    assert.deepEqual(
      fs.readdirSync(path.dirname(destination)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("rejects an invalid artifact without replacing existing evidence", () => {
    const directory = fixture();
    const destination = path.join(directory, "run.json");
    fs.writeFileSync(destination, '{"preserved":true}\n');
    const artifact = buildArtifact(baseInput());

    for (const invalid of [
      undefined,
      {},
      { ...artifact, runId: "" },
      { ...artifact, kind: "other" },
      { ...artifact, turns: {} },
      { ...artifact, result: null },
      { ...artifact, metrics: null },
      { ...artifact, toJSON: () => ({}) },
    ]) {
      assert.throws(
        () => saveArtifact(destination, invalid),
        /artifact.*must|artifact\.kind/i,
      );
      assert.equal(fs.readFileSync(destination, "utf8"), '{"preserved":true}\n');
    }
  });

  it("projects normalized ledger provenance and appends one JSON object per line", () => {
    const directory = fixture();
    const ledgerPath = path.join(directory, "nested", "ledger.jsonl");
    const artifact = buildArtifact(baseInput({
      harnessGit: null,
      experiment: { id: "exp-2", arm: "regular", round: 1, sequence: 2, seed: 3 },
    }));
    const row = buildLedgerRow({ artifact, artifactPath: "runs/run.json" });

    assert.equal(row.runId, artifact.runId);
    assert.equal(row.status, "pass");
    assert.equal(row.harnessGitSha, null);
    assert.equal(row.harnessGitDirty, null);
    assert.equal(row.experimentId, "exp-2");
    assert.equal(row.experimentArm, "regular");

    appendLedgerRow(ledgerPath, row);
    appendLedgerRow(ledgerPath, { ...row, runId: "run-second" });

    const lines = fs.readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).runId, artifact.runId);
    assert.equal(JSON.parse(lines[1]).runId, "run-second");

    const before = fs.readFileSync(ledgerPath, "utf8");
    for (const invalid of [
      undefined,
      {},
      { ...row, runId: "" },
      { ...row, schema: 2 },
      { ...row, artifactPath: "" },
      { ...row, toJSON: () => ({}) },
    ]) {
      assert.throws(
        () => appendLedgerRow(ledgerPath, invalid),
        /ledger row.*must/i,
      );
      assert.equal(fs.readFileSync(ledgerPath, "utf8"), before);
    }

    assert.throws(
      () => buildLedgerRow({ artifact: {}, artifactPath: "runs/run.json" }),
      /artifact\.runId must be a non-empty string/,
    );
    assert.throws(
      () => buildLedgerRow({ artifact, artifactPath: "" }),
      /artifactPath must be a non-empty string/,
    );
  });

  it("refuses ledger symlinks without modifying their targets", () => {
    const directory = fixture();
    const target = path.join(directory, "target.jsonl");
    const ledgerPath = path.join(directory, "ledger.jsonl");
    const artifact = buildArtifact(baseInput());
    const row = buildLedgerRow({ artifact, artifactPath: "runs/run.json" });
    fs.writeFileSync(target, '{"preserved":true}\n');
    fs.symlinkSync(target, ledgerPath);

    assert.throws(
      () => appendLedgerRow(ledgerPath, row),
      /ELOOP|symbolic link|regular file/i,
    );
    assert.equal(fs.readFileSync(target, "utf8"), '{"preserved":true}\n');
    assert.equal(fs.readlinkSync(ledgerPath), target);
  });
});

describe("artifact identifiers and model discovery", () => {
  it("creates filesystem-safe stamps and collision-resistant run ids", () => {
    const stamp = makeStamp(new Date("2026-07-23T12:34:56.789Z"));
    const runId = makeRunId(stamp);

    assert.equal(stamp, "2026-07-23T12-34-56-789Z");
    assert.match(runId, /^run-2026-07-23T12-34-56-789Z-[a-f0-9]{6}$/);
  });

  it("discovers a served model id and returns null for malformed responses", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "served-model.gguf" }] }));
        return;
      }
      if (request.url === "/malformed/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end("{not-json");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}`;

    assert.equal(await fetchModelId(`${endpoint}/`), "served-model.gguf");
    assert.equal(await fetchModelId(`${endpoint}/malformed`), null);
    assert.equal(await fetchModelId(`${endpoint}/missing`), null);
    assert.equal(await fetchModelId("not a valid endpoint", 20), null);
  });
});
