import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent, deliveredReadRange, panelRenderedRanges, packetCoversRange } from "../src/agent.js";
import { buildPrompt, clipKeepingControllerAnnotation } from "../src/prompt.js";
import { completionAuditReanchor, COMPLETION_AUDIT_MARKER } from "../src/completion-audit.js";
import { peerFunctionFooter } from "../src/edit-context.js";

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-source-delivery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function model(actions) {
  const prompts = [];
  return { prompts, assistantPrefill: "", actTemperature: null,
    async complete(prompt) {
      prompts.push(String(prompt));
      return { content: JSON.stringify(actions.shift() ?? { a: "respond", text: "Finished." }),
        tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    } };
}

test("extension WS0 serves missing clipped helper bytes and exact/wobbled rereads", async (t) => {
  const previous = process.env.BANTAM_EXTENSION_WORKING_SET;
  process.env.BANTAM_EXTENSION_WORKING_SET = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.BANTAM_EXTENSION_WORKING_SET;
    else process.env.BANTAM_EXTENSION_WORKING_SET = previous;
  });
  const dir = workspace(t);
  const lines = Array.from({ length: 100 }, (_, i) => `// line ${i + 1} ${"padding ".repeat(9)}`);
  lines[69] = "export const HELPERS_BODY_WAS_MISSING = true;";
  fs.writeFileSync(path.join(dir, "helpers.js"), lines.join("\n"));
  fs.writeFileSync(path.join(dir, "other.js"), "export const other = 1;\n".repeat(50));
  const read = { a: "read_file", p: "helpers.js", start: 65, limit: 12 };
  const scripted = model([
    { a: "inspect", ops: [{ a: "read_file", p: "helpers.js" }, { a: "read_file", p: "other.js" }] },
    read, read, { ...read, start: 66, limit: 10 }, { a: "respond", text: "Inspected." },
  ]);
  const result = await runAgent({ task: "Inspect helpers.js and other.js.", workspace: dir, model: scripted,
    maxTurns: 6, interactive: true, useGrammar: false, grounding: false,
    verificationPolicy: "after_edit", shellSandbox: "host", promptTrajectory: "extension" });
  assert.doesNotMatch(scripted.prompts[1], /HELPERS_BODY_WAS_MISSING/);
  assert.ok(scripted.prompts.every((prompt) => !prompt.includes("<open_files>\n")));
  for (const turn of result.turns.slice(1, 4)) {
    assert.match(turn.observation, /HELPERS_BODY_WAS_MISSING/);
    assert.doesNotMatch(turn.observation, /Not re-read|Deduplicated/);
  }
  assert.match(scripted.prompts[2], /HELPERS_BODY_WAS_MISSING/);
  for (let i = 1; i < scripted.prompts.length; i += 1) {
    assert.ok(scripted.prompts[i].startsWith(scripted.prompts[i - 1]), `prefix ${i} remains stable`);
  }
});

test("read delivery counts surviving numbered bytes, never promised or clipped ranges", () => {
  const op = { a: "read_file", p: "helpers.js", start: 65, limit: 10 };
  assert.equal(deliveredReadRange(op, "helpers.js (97 lines, showing 65-74):\n... [100 chars clipped] ..."), null);
  assert.deepEqual(deliveredReadRange(op,
    "helpers.js (97 lines, showing 65-74):\n65\tcomplete\n66\tpartial\n... [100 chars clipped] ...\n74\ttail\n"),
  { start: 65, end: 65, total: 97 });
  const separate = "helpers.js (97 lines, showing 1-2):\n1\ta\n2\tb\n"
    + "helpers.js (97 lines, showing 65-66):\n65\tc\n66\td\n";
  assert.deepEqual(deliveredReadRange(op, separate), { start: 65, end: 66, total: 97 });
  assert.equal(deliveredReadRange({ ...op, start: 70 }, separate), null);
});

test("resume does not restore header-only coverage as delivered source", async (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "helpers.js"), "export const CURRENT_RESUMED_BYTES = true;\n");
  const read = { a: "read_file", p: "helpers.js" };
  const scripted = model([read, { a: "respond", text: "Read." }]);
  const result = await runAgent({ task: "Inspect helpers.js.", workspace: dir, model: scripted,
    resumeTurns: [{ i: 0, action: read, parsedAction: read,
      observation: "helpers.js (2 lines, showing 1-2):\n... [2000 chars clipped] ..." }],
    maxTurns: 4, interactive: true, useGrammar: false, grounding: false,
    verificationPolicy: "after_edit", shellSandbox: "host", promptTrajectory: "extension" });
  assert.match(result.turns[1].observation, /CURRENT_RESUMED_BYTES/);
  assert.doesNotMatch(result.turns[1].observation, /Not re-read|Deduplicated/);
});

test("panel-skipped inspect ops do not fabricate paging or shuffle deliveries", async (t) => {
  const dir = workspace(t);
  for (const name of ["a", "b"]) {
    fs.writeFileSync(path.join(dir, `${name}.js`),
      Array.from({ length: 500 }, (_, i) => `export const ${name}${i} = ${i};`).join("\n") + "\n");
  }
  for (const name of ["c", "d"]) fs.writeFileSync(path.join(dir, `${name}.js`), "export const tiny = 1;\n");
  const read = (p) => ({ a: "read_file", p, limit: 60 });
  const scripted = model([
    { a: "inspect", ops: [read("a.js"), read("b.js")] },
    { a: "inspect", ops: [read("a.js"), read("b.js"), read("c.js")] },
    { a: "inspect", ops: [read("a.js"), read("b.js"), read("d.js")] },
    { a: "respond", text: "Inspected." },
  ]);
  const result = await runAgent({ task: "Survey modules.", workspace: dir, model: scripted,
    maxTurns: 6, interactive: true, useGrammar: false, grounding: false,
    verificationPolicy: "after_edit", shellSandbox: "host", promptTrajectory: "rebuild" });
  assert.equal(result.metrics.ledgerPartialOpsSkipped, 4);
  assert.equal(result.metrics.pagingSteers ?? 0, 0);
  assert.equal(result.metrics.inspectShuffleSteers ?? 0, 0);
});

test("render receipt sees post-clipping bytes and never a compiled-only extension panel", () => {
  const receipts = [];
  const source = Array.from({ length: 100 }, (_, i) => `${i + 1}\t${"x".repeat(80)}`).join("\n");
  const turn = { i: 0, action: { a: "read_file", p: "helpers.js" },
    observation: `helpers.js (100 lines, showing 1-100):\n${source}\nEOF` };
  const prompt = buildPrompt({ task: "Inspect.", env: "", turns: [turn], extensionTrajectory: true,
    openFilesText: "# helpers.js (current, 100 lines)\n" + source,
    onRenderedObservation: (...receipt) => receipts.push(receipt) });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0][2], "");
  assert.ok(prompt.includes(receipts[0][1]));
  assert.ok(deliveredReadRange(turn.action, receipts[0][1]).end < 100);
});

test("partial source lines never qualify as resident panel ranges", () => {
  const packet = "# a.js (current, 4 lines)\n1\twhole\n2\tlong… (+900 chars — read_file to page)\n3\twhole\n4\thalf\n… (panel truncated at 100 bytes — use read_file)";
  const entry = panelRenderedRanges(packet).get("a.js");
  assert.deepEqual(entry.ranges, [[1, 1], [3, 3]]);
  assert.equal(packetCoversRange(entry.ranges, 1, 4), false);
});

test("the bounded post-green audit survives actual extension clipping and frozen replay", () => {
  const task = "Implement each contract item. ".repeat(500);
  const audit = completionAuditReanchor(task, COMPLETION_AUDIT_MARKER);
  const observation = "replaced 1 occurrence\n[peer] bounded source\n[auto-verify] Tests PASS.\n"
    + "test output\n".repeat(500) + "[guidance]\n" + task + "\n\n" + audit;
  assert.ok(audit.length < 700);
  assert.ok(clipKeepingControllerAnnotation(observation).includes(audit));
  const turn = { i: 0, action: { a: "replace", p: "a.js", old: "a", new: "b" }, observation };
  const renderCache = new Map();
  const first = buildPrompt({ task, env: "", turns: [turn], extensionTrajectory: true, renderCache });
  const second = buildPrompt({ task, env: "", turns: [turn, { i: 1, action: { a: "list_dir", p: "." }, observation: "a.js" }],
    extensionTrajectory: true, renderCache });
  assert.ok(first.includes(audit));
  assert.ok(second.startsWith(first));
  assert.doesNotMatch(audit, /<open_files>|Exact assignment:/);
});

function peerGround(files) {
  return { db: { query: () => [["resourceCount"]] },
    factIndex: { records: new Map(Object.entries(files).map(([file, source]) => [file, { source }])) } };
}

test("peer context reads current bytes and never quotes the edited function as elsewhere", () => {
  const old = "function main() {\n  return resourceCount + OLD_MARKER;\n}\n";
  const current = "function main() {\n  return resourceCount + NEW_MARKER;\n}\n";
  const action = { a: "replace", p: "a.js", old: "return resourceCount + OLD_MARKER;", new: "return resourceCount + NEW_MARKER;" };
  assert.equal(peerFunctionFooter({ ground: peerGround({ "a.js": old }), action, editedFile: "a.js",
    seen: new Set(), readSource: () => current }), "");
  const footer = peerFunctionFooter({ ground: peerGround({ "a.js": old, "b.js": "function peer() {\n  return resourceCount + STALE_PEER;\n}\n" }),
    action, editedFile: "a.js", seen: new Set(),
    readSource: (file) => file === "a.js" ? current : "function peer() {\n  return resourceCount + CURRENT_PEER;\n}\n" });
  assert.match(footer, /CURRENT_PEER/);
  assert.doesNotMatch(footer, /STALE_PEER|OLD_MARKER|NEW_MARKER|`main`/);
});

test("peer context preserves genuine same-file peers and fails closed without current source", () => {
  const source = "function main() {\n  return resourceCount + 2;\n}\nfunction other() {\n  return resourceCount + 3;\n}\n";
  const args = { ground: peerGround({ "a.js": source }),
    action: { a: "replace", p: "a.js", old: "return resourceCount + 1;", new: "return resourceCount + 2;" },
    editedFile: "a.js", seen: new Set() };
  assert.match(peerFunctionFooter({ ...args, readSource: () => source }), /`other`/);
  assert.equal(peerFunctionFooter({ ...args, seen: new Set() }), "");
  assert.equal(peerFunctionFooter({ ...args, seen: new Set(), readSource: () => { throw Error("missing"); } }), "");
});

test("a helper-plus-parser replacement excludes both edited functions, not an untouched peer", () => {
  const old = "function parser() {\n  return resourceCount + STALE_MARKER;\n}\n";
  const replacement = "function helper() {\n  return resourceCount + 1;\n}\n"
    + "function parser() {\n  return resourceCount + 2;\n}\n";
  const untouched = "function independent() {\n  return resourceCount + CURRENT_PEER;\n}\n";
  const source = replacement + untouched;
  const footer = peerFunctionFooter({
    ground: peerGround({ "a.js": old + untouched }),
    action: { a: "replace", p: "a.js", old, new: replacement },
    editedFile: "a.js", seen: new Set(), readSource: () => source,
  });
  assert.match(footer, /— `independent`/);
  assert.match(footer, /CURRENT_PEER/);
  assert.doesNotMatch(footer, /— `(?:helper|parser)`|STALE_MARKER/);
});

test("a replacement starting inside one function excludes every function crossed by its span", () => {
  const prefix = "function first() {\n  ";
  const replacement = "return resourceCount + NEW_FIRST;\n}\nfunction second() {\n  return resourceCount + NEW_SECOND;\n}\n";
  const old = replacement.replace("NEW_FIRST", "OLD_FIRST").replace("NEW_SECOND", "OLD_SECOND");
  const untouched = "function independent() {\n  return resourceCount + CURRENT_PEER;\n}\n";
  const source = prefix + replacement + untouched;
  const footer = peerFunctionFooter({
    ground: peerGround({ "a.js": prefix + old + untouched }),
    action: { a: "replace", p: "a.js", old, new: replacement },
    editedFile: "a.js", seen: new Set(), readSource: () => source,
  });
  assert.match(footer, /— `independent`/);
  assert.doesNotMatch(footer, /— `(?:first|second)`|OLD_FIRST|OLD_SECOND/);
});
