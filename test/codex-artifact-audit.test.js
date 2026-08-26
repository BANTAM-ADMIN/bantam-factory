import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditCodexArtifactFile,
  auditCodexPromptDelivery,
} from "../src/codex-artifact-audit.js";
import { buildCodexPromptDelivery } from "../src/codex-transport.js";

test("Codex artifact audit reconstructs a full base and exact delta calls", () => {
  const artifact = exactArtifact();
  const report = auditCodexPromptDelivery(artifact);

  assert.deepEqual(report, {
    status: "pass",
    codex: true,
    calls: 2,
    auditedCalls: 2,
    exactCalls: 2,
    fullCalls: 1,
    deltaCalls: 1,
    uniqueThreads: 1,
    failures: [],
  });
});

test("Codex artifact audit detects canonical, wire, and reuse tampering", () => {
  const canonicalTamper = structuredClone(exactArtifact());
  const body = JSON.parse(canonicalTamper.modelCalls[1].request.body);
  body.prompt += "tampered";
  canonicalTamper.modelCalls[1].request.body = JSON.stringify(body);
  const canonicalReport = auditCodexPromptDelivery(canonicalTamper);
  assert.equal(canonicalReport.status, "fail");
  assert.ok(canonicalReport.failures.some((failure) => failure.code === "request_sha256"));
  assert.ok(canonicalReport.failures.some((failure) => failure.code === "reconstruction"));

  const wireTamper = structuredClone(exactArtifact());
  wireTamper.modelCalls[1].response.normalized.codexPromptDelivery.deliveredText += "tampered";
  const wireReport = auditCodexPromptDelivery(wireTamper);
  assert.equal(wireReport.status, "fail");
  assert.ok(wireReport.failures.some((failure) => failure.code === "delivered_sha256"));

  const reuseTamper = structuredClone(exactArtifact());
  reuseTamper.modelCalls[1].response.normalized.codexThread.threadReused = false;
  const reuseReport = auditCodexPromptDelivery(reuseTamper);
  assert.ok(reuseReport.failures.some((failure) => failure.code === "thread_reuse"));
});

test("Codex artifact audit fails closed on missing evidence and ignores local artifacts", () => {
  const missing = exactArtifact();
  delete missing.modelCalls[0].response.normalized.codexPromptDelivery;
  const failed = auditCodexPromptDelivery(missing);
  assert.equal(failed.status, "fail");
  assert.ok(failed.failures.some((failure) => failure.code === "delivery_evidence"));

  assert.equal(auditCodexPromptDelivery({
    model: { metadata: { runtime: "local" } },
    modelCalls: [],
  }).status, "not-applicable");
});

test("Codex artifact audit reads evidence from disk without model access", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-codex-audit-"));
  try {
    const file = path.join(directory, "run.json");
    fs.writeFileSync(file, JSON.stringify(exactArtifact()));
    const report = auditCodexArtifactFile(file);
    assert.equal(report.file, file);
    assert.equal(report.status, "pass");
    assert.equal(report.exactCalls, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex artifact audit optionally exposes bounded per-call efficiency diagnostics", () => {
  const report = auditCodexPromptDelivery(exactArtifact(), { includeCalls: true });
  assert.equal(report.callAudits.length, 2);
  assert.deepEqual(report.callAudits[0], {
    callIndex: 0,
    exact: true,
    failureCodes: [],
    threadId: "thread-1",
    threadReused: false,
    mode: "full",
    canonicalChars: 5886,
    deliveredChars: 5886,
    savedChars: 0,
    savedRatio: 0,
    inputTokens: 1000,
    cacheHitTokens: 800,
    cacheMissTokens: 200,
    outputTokens: 40,
    reasoningTokens: 5,
    durationMs: 1250,
  });
  assert.equal(report.callAudits[1].mode, "delta");
  assert.ok(report.callAudits[1].savedRatio > 0);
  assert.equal(Object.isFrozen(report.callAudits), true);
  assert.equal(Object.isFrozen(report.callAudits[0].failureCodes), true);
});

function exactArtifact() {
  const base = `${"stable-prefix\n".repeat(420)}turn 1`;
  const canonical = `${base}\nturn 2 observation`;
  const full = buildCodexPromptDelivery(base, { mode: "full" });
  const delta = buildCodexPromptDelivery(canonical, { mode: "delta", basePrompt: base });
  assert.equal(delta.evidence.mode, "delta");
  return {
    model: { metadata: { runtime: "codex" } },
    modelCalls: [
      call(0, base, full, false),
      call(1, canonical, delta, true),
    ],
  };
}

function call(index, canonical, delivery, reused) {
  return {
    index,
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: "2026-07-26T00:00:01.250Z",
    request: {
      body: JSON.stringify({ prompt: canonical }),
      promptSha256: sha256(canonical),
    },
    response: {
      normalized: {
        usage: {
          provider: "codex",
          inputTokens: 1000 + index,
          cacheHitTokens: 800,
          cacheMissTokens: 200 + index,
          outputTokens: 40,
          reasoningTokens: 5,
        },
        codexThread: {
          threadId: "thread-1",
          threadMode: "run",
          threadReused: reused,
        },
        codexPromptDelivery: delivery.evidence,
      },
    },
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
