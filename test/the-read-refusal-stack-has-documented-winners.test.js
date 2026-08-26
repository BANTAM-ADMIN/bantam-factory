// The read-refusal stack, precedence locked: exact-duplicate > panel
// redirect > ledger replay. The gating exists in agent.js by construction
// (each layer consults the ones above it); this sweep pins the CONTRACT so a
// future layer cannot silently reorder the stack — the failure class that
// produced the double-steer (one-steer-speaks-at-a-time.test.js) and twice
// shadowed the panel veto during drafts this session.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

async function run(workspace, outputs, collect) {
  const model = scriptedModel(outputs);
  return runAgent({
    task: "Survey the modules and report.",
    workspace,
    model,
    maxTurns: 8,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: collect,
  });
}

function tagsOf(result) {
  return result.turns
    .map((turn) => String(turn.observation ?? ""))
    .flatMap((obs) => obs.match(/\[(repetition|open_files|ledger)\]/g) ?? []);
}

test("an exact repeat belongs to the duplicate guard, not the panel or ledger", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-stack1-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "a.js"), Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");

  const read = JSON.stringify({ a: "read_file", p: "a.js" });
  const result = await run(workspace, [read, read, JSON.stringify({ a: "respond", text: "a.js exports 40 constants." })]);
  assert.equal(result.responded, true);
  assert.deepEqual(tagsOf(result), ["[repetition]"], "the byte-identical repeat gets the compact turn pointer");
});

test("a broad non-identical re-read of a panel-resident file belongs to the panel redirect", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-stack2-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "a.js"), Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");

  const result = await run(workspace, [
    JSON.stringify({ a: "read_file", p: "a.js" }),
    JSON.stringify({ a: "read_file", p: "a.js", limit: 200 }),   // broad, not byte-identical
    JSON.stringify({ a: "respond", text: "a.js exports 60 constants." }),
  ]);
  assert.equal(result.responded, true);
  assert.deepEqual(tagsOf(result), ["[open_files]"], "the live panel handles the broad variant");
});

test("a covered broad re-read of a file too big for the panel belongs to the ledger", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-stack3-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "b.js"), Array.from({ length: 600 }, (_, i) => `export const w${i} = ${i};`).join("\n") + "\n");

  const result = await run(workspace, [
    JSON.stringify({ a: "read_file", p: "b.js" }),               // bare read: first window
    JSON.stringify({ a: "read_file", p: "b.js" }),               // identical — dupe guard
    JSON.stringify({ a: "search", q: "w599", p: "b.js" }),       // break the identical streak
    JSON.stringify({ a: "read_file", p: "b.js" }),               // covered bare re-read again
    JSON.stringify({ a: "respond", text: "b.js exports 600 constants." }),
  ]);
  assert.equal(result.responded, true);
  const tags = tagsOf(result);
  assert.ok(tags.length >= 1, "covered re-reads of the big file were refused");
  assert.ok(tags.every((tag) => tag === "[repetition]" || tag === "[ledger]"),
    `only duplicate/ledger may claim a partially-resident big file, got ${tags.join(",")}`);
  assert.ok(!tags.includes("[open_files]"),
    "the panel redirect must not promise complete contents it does not hold");
});
