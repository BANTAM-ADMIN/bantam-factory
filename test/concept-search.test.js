import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildConceptIndex,
  conceptTokens,
  conceptTool,
  searchConceptIndex,
} from "../src/logic/concept-search.js";
import {
  buildGrounding,
  markGroundingStale,
  refreshGrounding,
} from "../src/logic/grounding.js";
import { buildToolRegistry } from "../src/logic/tools.js";

const created = [];
const originalNoMap = process.env.BANTAM_NO_MAP;

function workspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-concept-search-"));
  created.push(root);
  fs.mkdirSync(path.join(root, "src"));
  const files = {
    "recovery.js": [
      "/** Roll back a failed task and retry after an exception. */",
      "export function recoverFailedTask(error) {",
      "  rollback(error);",
      "  return retry(error);",
      "}",
      "",
    ].join("\n"),
    "input.js": [
      "/** Validate user input payload before command dispatch. */",
      "export function validateUserPayload(payload) {",
      "  if (!payload.name) throw new Error('invalid input');",
      "  return payload;",
      "}",
      "",
    ].join("\n"),
    "config.js": [
      "/** Read runtime configuration from environment variables. */",
      "export function loadRuntimeSettings(env) {",
      "  return { port: env.PORT };",
      "}",
      "",
    ].join("\n"),
    "worker.js": [
      "import { recoverFailedTask } from './recovery.js';",
      "/** Handles job failure and delegates recovery. */",
      "export function handleWorkerError(error) {",
      "  return recoverFailedTask(error);",
      "}",
      "",
    ].join("\n"),
    "math.js": [
      "export function calculateInvoiceTotal(items) {",
      "  return items.reduce((sum, item) => sum + item.price, 0);",
      "}",
      "",
    ].join("\n"),
  };
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "src", name), source);
  }
  return root;
}

afterEach(() => {
  if (originalNoMap === undefined) delete process.env.BANTAM_NO_MAP;
  else process.env.BANTAM_NO_MAP = originalNoMap;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe("deterministic concept retrieval", () => {
  it("normalizes camel/snake morphology and concept vocabulary", () => {
    assert.deepEqual(
      conceptTokens("loadRuntimeSettings validates_user_inputs"),
      ["read", "runtime", "config", "validate", "user", "input"],
    );
  });

  it("ranks meaningful chunks for the three target questions", () => {
    const ground = buildGrounding(workspaceFixture());
    const tool = conceptTool(ground, { limit: 4 });

    const recovery = tool.answer("error recovery");
    assert.match(recovery, /^Concept matches for "error recovery"/);
    assert.match(recovery, /1\. src\/recovery\.js:\d+-\d+ — recoverFailedTask \[function\]/);
    assert.match(recovery, /linked match/);
    assert.doesNotMatch(recovery.split("\n").slice(0, 4).join("\n"), /math\.js/);

    const validation = tool.answer("validate user input");
    assert.match(validation, /1\. src\/input\.js:\d+-\d+ — validateUserPayload \[function\]/);
    assert.match(validation, /matched validate, user, input/);

    const configuration = tool.answer("read configuration");
    assert.match(configuration, /1\. src\/config\.js:\d+-\d+ — loadRuntimeSettings \[function\]/);
    assert.match(configuration, /matched read, config/);
  });

  it("is deterministic, bounded, and exposes structured search results", () => {
    const ground = buildGrounding(workspaceFixture());
    const index = buildConceptIndex(ground);
    const first = searchConceptIndex(index, ground, "error recovery", { limit: 3 });
    const second = searchConceptIndex(index, ground, "error recovery", { limit: 3 });

    assert.equal(first.length, 3);
    assert.deepEqual(
      first.map((row) => [row.chunk.file, row.chunk.name, row.chunk.line, row.score]),
      second.map((row) => [row.chunk.file, row.chunk.name, row.chunk.line, row.score]),
    );
    assert.ok(index.chunks.length <= 6000);
    assert.ok(conceptTool(ground, { limit: 3 }).answer("error recovery").length <= 8000);
  });

  it("fails closed while grounding is stale and rebuilds after atomic refresh", () => {
    const workspace = workspaceFixture();
    const ground = buildGrounding(workspace);
    const tool = conceptTool(ground, { limit: 3 });
    assert.match(tool.answer("read configuration"), /src\/config\.js/);

    markGroundingStale(ground, ["src/config.js"]);
    assert.match(tool.answer("read configuration"), /^\[concept\] index is stale/);

    fs.rmSync(path.join(workspace, "src", "config.js"));
    fs.writeFileSync(
      path.join(workspace, "src", "runtime-options.js"),
      [
        "/** Read configuration options for the running service. */",
        "export function resolveServiceOptions(environment) {",
        "  return { port: environment.PORT };",
        "}",
        "",
      ].join("\n"),
    );
    const refreshed = refreshGrounding(ground, ["src/config.js", "src/runtime-options.js"]);
    assert.equal(refreshed.ok, true);

    const current = tool.answer("read configuration");
    assert.match(current, /1\. src\/runtime-options\.js:\d+-\d+ — resolveServiceOptions \[function\]/);
    assert.doesNotMatch(current, /src\/config\.js/);
  });

  it("registers and routes concept queries through the normal tool socket", () => {
    process.env.BANTAM_NO_MAP = "1";
    const ground = buildGrounding(workspaceFixture());
    const registry = buildToolRegistry(ground);

    assert.ok(registry.get("concept"));
    assert.match(registry.describe(), /concept: find behavior by meaning/);
    assert.match(
      registry.answer("concept validate user input"),
      /1\. src\/input\.js:\d+-\d+ — validateUserPayload \[function\]/,
    );
    assert.equal(registry.lastTool, "concept");
  });
});
