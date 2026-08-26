import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAppServer } from "../src/codex-transport.js";
import { ModelClient } from "../src/model.js";
import {
  codexImageTool,
  imageHeartbeatMs,
  imageWorkerTimeouts,
} from "../src/logic/codex-image.js";
import {
  codexViewImageTool,
  imagePixelFactsEnabled,
  inspectPng,
  viewImageTool,
} from "../src/logic/vision.js";
import { runPreviewSync } from "../src/logic/preview.js";
import { chromiumSkipReason } from "./helpers/env-guards.js";

const _chromiumSkip = chromiumSkipReason();

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-vision-server.cjs", import.meta.url),
);

test("Codex visual broker attaches a validated localImage input on an isolated turn", async (t) => {
  const runtime = new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 2000,
    controlTimeoutMs: 1000,
    idleTimeoutMs: 1000,
  });
  t.after(() => runtime.close());

  const image = path.resolve("creative-suite/assets/dispatch-card.png");
  const result = await runtime.describeImage(image, "Count the diamonds.", {
    model: "gpt-5.6-terra",
    effort: "medium",
    detail: "high",
  });

  assert.match(result.content, /saw high image/);
  assert.match(result.content, /dispatch-card\.png/);
  assert.match(result.content, /Count the diamonds/);
  assert.equal(result.usage.provider, "codex");
  assert.equal(result.usage.requests, 1);
  assert.equal(result.codexThread.threadMode, "ephemeral");
});

test("Codex completion rejects unsupported visual input types", async (t) => {
  const runtime = new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 2000,
    controlTimeoutMs: 1000,
    idleTimeoutMs: 1000,
  });
  t.after(() => runtime.close());

  await assert.rejects(
    runtime.complete("unsafe", { inputItems: [{ type: "file", path: "/tmp/x" }] }),
    /unsupported Codex input item type/,
  );
});

test("Codex view_image outcome retains causal usage and failure semantics", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-view-usage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.copyFileSync(
    path.resolve("creative-suite/assets/dispatch-card.png"),
    path.join(workspace, "card.png"),
  );
  const recorded = [];
  const tool = codexViewImageTool(workspace, {
    model: "gpt-5.6-terra",
    effort: "medium",
    runtimeFactory: () => ({
      async describeImage() {
        return {
          content: "Three diamonds and NIGHT FERRY.",
          usage: {
            provider: "codex",
            model: "gpt-5.6-terra",
            requests: 1,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheHitTokens: 0,
            cacheMissTokens: 100,
            reasoningTokens: 3,
            costUsd: 0,
            codexRequests: 1,
          },
        };
      },
      close() {},
    }),
    onExternalUsage(usage, meta) { recorded.push({ usage, meta }); },
  });

  assert.match(await tool.answer("view_image card.png"), /Three diamonds/);
  assert.equal(tool.lastOutcome.status, "pass");
  assert.equal(tool.lastOutcome.usageSource, "supplied_image_vision");
  assert.equal(tool.lastOutcome.usage.inputTokens, 100);
  assert.equal(recorded[0].meta.source, "supplied_image_vision");

  assert.match(await tool.answer("view_image missing.png"), /no image/);
  assert.equal(tool.lastOutcome.status, "failed");
  assert.equal(tool.lastOutcome.failures[0].kind, "image_missing");
});

test("local view_image uses the same pass and failure outcome semantics", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-local-view-outcome-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.copyFileSync(
    path.resolve("creative-suite/assets/dispatch-card.png"),
    path.join(workspace, "card.png"),
  );
  const tool = viewImageTool(workspace, "http://unused.invalid", {
    describe: () => "Visible ferry card.",
  });

  assert.match(tool.answer("view_image card.png"), /Visible ferry card/);
  assert.equal(tool.lastOutcome.status, "pass");
  assert.equal(tool.lastOutcome.path, "card.png");

  assert.match(tool.answer("view_image missing.png"), /no image/);
  assert.equal(tool.lastOutcome.status, "failed");
  assert.equal(tool.lastOutcome.failures[0].kind, "image_missing");

  assert.match(tool.answer("view_image notes.txt"), /not an image/);
  assert.equal(tool.lastOutcome.status, "failed");
  assert.equal(tool.lastOutcome.failures[0].kind, "unsupported_image");
});

test("Codex image generation forwards operator cancellation to the transport", async (t) => {
  const runtime = new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 2000,
    controlTimeoutMs: 1000,
    idleTimeoutMs: 1000,
  });
  t.after(() => runtime.close());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runtime.generateImage("cancel before generation", { signal: controller.signal }),
    (error) => error?.code === "aborted",
  );
});

test("PNG inspection supplies exact deterministic dimensions and palette", () => {
  const facts = inspectPng(path.resolve("creative-suite/assets/dispatch-card.png"));
  assert.deepEqual([facts.width, facts.height], [1200, 800]);
  const colors = facts.dominantColors.map((item) => item.hex);
  assert.ok(colors.includes("#37d6c0"));
  assert.ok(colors.includes("#ed4e87"));
  assert.equal(imagePixelFactsEnabled({}), true);
  assert.equal(imagePixelFactsEnabled({ BANTAM_IMAGE_PIXEL_FACTS: "off" }), false);
});

test("Codex image workers use generation-sized timeouts and account sidecar usage", { skip: _chromiumSkip }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-image-tool-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const options = [];
  const usage = [];
  const source = path.resolve("creative-suite/assets/dispatch-card.png");
  const tool = codexImageTool(workspace, {
    env: {
      BANTAM_CODEX_IMAGE_TIMEOUT_MS: "345678",
      BANTAM_CODEX_IMAGE_IDLE_TIMEOUT_MS: "234567",
    },
    runtimeFactory(opts) {
      options.push(opts);
      return {
        async generateImage() {
          return {
            savedPath: source,
            usage: { provider: "codex", model: opts.model, requests: 1, codexRequests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          };
        },
        close() {},
      };
    },
    onExternalUsage(entry, meta) { usage.push({ entry, meta }); },
  });

  const answer = await tool.answer("generate_image a test card");
  assert.match(answer, /1\/1 image completed/);
  assert.equal(options[0].timeoutMs, 345678);
  assert.equal(options[0].idleTimeoutMs, 234567);
  assert.equal(usage.length, 1);
  assert.equal(tool.lastOutcome.status, "pass");
  assert.equal(tool.lastOutcome.usageSource, "image_generation");
  assert.equal(tool.lastOutcome.usage.inputTokens, 10);
  assert.equal(tool.lastOutcome.artifacts.length, 3);
  const manifestPath = path.join(
    workspace,
    tool.lastOutcome.artifacts.find((item) => item.endsWith(".json")),
  );
  const contactSheetPath = path.join(
    workspace,
    tool.lastOutcome.artifacts.find((item) => item.endsWith(".html")),
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.variants.length, 1);
  assert.deepEqual(
    [manifest.variants[0].width, manifest.variants[0].height],
    [1200, 800],
  );
  assert.match(manifest.variants[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.variants[0].path, tool.lastOutcome.artifacts[0]);
  const preview = runPreviewSync(workspace, path.relative(workspace, contactSheetPath));
  assert.equal(preview.ok, true);
  assert.equal(preview.previewStatus, "pass");
  assert.deepEqual(
    [preview.pageErrors.length, preview.resourceErrors.length, preview.rejections.length],
    [0, 0, 0],
  );
  assert.deepEqual(imageWorkerTimeouts({}), { timeoutMs: 720000, idleTimeoutMs: 600000 });
});

test("Codex image tool distinguishes total failure from partial success", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-image-outcomes-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.resolve("creative-suite/assets/dispatch-card.png");

  const failed = codexImageTool(workspace, {
    env: {},
    runtimeFactory() {
      return {
        async generateImage() { throw new Error("injected provider outage"); },
        close() {},
      };
    },
  });
  const failedAnswer = await failed.answer("generate_image outage probe --variants=2");
  assert.match(failedAnswer, /0\/2 images completed/);
  assert.equal(failed.lastOutcome.status, "blocked");
  assert.equal(failed.lastOutcome.blocked.terminal, true);
  assert.match(failed.lastOutcome.blocked.reason, /injected provider outage/);
  assert.equal(failed.lastOutcome.failures[0].kind, "provider_failure");

  let worker = 0;
  const partial = codexImageTool(workspace, {
    env: {},
    runtimeFactory() {
      const current = worker++;
      return {
        async generateImage() {
          if (current === 1) throw new Error("injected second-worker failure");
          return { savedPath: source };
        },
        close() {},
      };
    },
  });
  const partialAnswer = await partial.answer("generate_image partial probe --variants=2");
  assert.match(partialAnswer, /1\/2 images completed/);
  assert.equal(partial.lastOutcome.status, "partial");
  assert.equal(partial.lastOutcome.completed, 1);
  assert.equal(partial.lastOutcome.failures[0].kind, "provider_failure");
});

test("Codex image generation emits bounded progress heartbeats and stops its timer", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-image-heartbeat-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.resolve("creative-suite/assets/dispatch-card.png");
  const events = [];
  const tool = codexImageTool(workspace, {
    env: { BANTAM_CODEX_IMAGE_HEARTBEAT_MS: "10" },
    onEvent(event) { events.push(event); },
    runtimeFactory() {
      return {
        async generateImage() {
          await new Promise((resolve) => setTimeout(resolve, 36));
          return { savedPath: source };
        },
        close() {},
      };
    },
  });

  await tool.answer("generate_image heartbeat probe");
  const heartbeatsAtCompletion = events.filter(
    (event) => event.type === "image_generation_heartbeat",
  );
  assert.ok(heartbeatsAtCompletion.length >= 2);
  assert.equal(heartbeatsAtCompletion.at(-1).completed, 0);
  assert.equal(tool.lastOutcome.heartbeats, heartbeatsAtCompletion.length);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    events.filter((event) => event.type === "image_generation_heartbeat").length,
    heartbeatsAtCompletion.length,
    "heartbeat timer must stop after generation settles",
  );
  assert.equal(imageHeartbeatMs({}), 30000);
});

test("Codex image worker outcomes preserve cancellation and timeout provenance", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-image-provenance-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const controller = new AbortController();
  const cancelled = codexImageTool(workspace, {
    env: { BANTAM_CODEX_IMAGE_HEARTBEAT_MS: "5" },
    signal: controller.signal,
    runtimeFactory() {
      return {
        generateImage(_prompt, { signal }) {
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("model request interrupted");
              error.code = "aborted";
              reject(error);
            }, { once: true });
          });
        },
        close() {},
      };
    },
  });
  const cancelledRun = cancelled.answer("generate_image cancellation probe");
  setTimeout(() => controller.abort(), 14);
  await cancelledRun;
  assert.equal(cancelled.lastOutcome.status, "blocked");
  assert.equal(cancelled.lastOutcome.failures[0].kind, "operator_cancelled");
  assert.equal(cancelled.lastOutcome.failures[0].code, "aborted");

  for (const [timeoutKind, expected] of [["idle", "idle_timeout"], ["hard", "hard_timeout"]]) {
    const timedOut = codexImageTool(workspace, {
      env: {},
      runtimeFactory() {
        return {
          async generateImage() {
            const error = new Error(`Codex app-server ${timeoutKind} timeout`);
            error.code = "model_timeout";
            error.timeoutKind = timeoutKind;
            throw error;
          },
          close() {},
        };
      },
    });
    await timedOut.answer(`generate_image ${timeoutKind} timeout probe`);
    assert.equal(timedOut.lastOutcome.failures[0].kind, expected);
    assert.equal(timedOut.lastOutcome.failures[0].timeoutKind, timeoutKind);
  }
});

test("ModelClient includes external Codex tool usage in cumulative totals", () => {
  const model = new ModelClient({ codex: true, model: "gpt-5.6-terra" });
  model.recordExternalUsage({
    provider: "codex",
    model: "gpt-5.6-terra",
    requests: 1,
    codexRequests: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    reasoningTokens: 3,
  }, { tool: "view_image" });
  assert.deepEqual(model.usageSummary(), {
    requests: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 3,
    costUsd: 0,
    codexRequests: 1,
  });
  assert.equal(model.externalUsageHistory[0].tool, "view_image");
  assert.equal(model.externalUsageHistory[0].source, "supplied_image_vision");
  assert.deepEqual(model.usageBreakdownSummary(), {
    supplied_image_vision: {
      requests: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      reasoningTokens: 3,
      costUsd: 0,
      codexRequests: 1,
    },
  });
});

test("source-attributed usage reconciles exactly with legacy cumulative totals", () => {
  const model = new ModelClient({ codex: true, model: "gpt-5.6-terra" });
  model._recordUsage({
    usage: {
      requests: 2,
      codexRequests: 2,
      inputTokens: 70,
      outputTokens: 8,
      totalTokens: 78,
      cacheHitTokens: 40,
      cacheMissTokens: 30,
      reasoningTokens: 2,
      costUsd: 0,
    },
  });
  model.recordExternalUsage({
    requests: 1,
    codexRequests: 1,
    inputTokens: 30,
    outputTokens: 4,
    totalTokens: 34,
    cacheHitTokens: 10,
    cacheMissTokens: 20,
    reasoningTokens: 1,
    costUsd: 0,
  }, { tool: "generate_image", source: "image_generation" });

  const totals = model.usageSummary();
  const breakdown = model.usageBreakdownSummary();
  for (const field of Object.keys(totals)) {
    const attributed = Object.values(breakdown)
      .reduce((sum, usage) => sum + Number(usage[field] ?? 0), 0);
    assert.equal(attributed, totals[field], `${field} must reconcile`);
  }
  assert.equal(breakdown.action_generation.requests, 2);
  assert.equal(breakdown.image_generation.requests, 1);

  model.resetUsage();
  assert.deepEqual(model.usageBreakdownSummary(), {});
});
