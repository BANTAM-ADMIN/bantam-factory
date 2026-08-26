// "Audit what the model was HANDED" is the operator's standing rule — and it
// was impossible for chat: headless `bantam run --save-run` writes
// .bantam/runs/<stamp>.json, but a chat request left NO artifact (2026-08-17:
// the cellui head-to-head had to be graded by parsing a console log). Every
// chat request now writes the same style of evidence artifact by default.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beginChatEvidence } from "../src/chat-evidence.js";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "bantam-chat-ev-"));

test("a chat request writes a complete run artifact", () => {
  const workspace = ws();
  const model = {};
  const evidence = beginChatEvidence({ workspace, request: "make it full screen", index: 2, model });
  assert.ok(evidence, "evidence collection is on by default");
  evidence.note({ type: "action", action: { a: "read_file", p: "index.html" } });
  evidence.note({ type: "observation", observation: "1\t<html>" });
  const dest = evidence.finalize({ done: true, summary: "stretched the layout" });
  assert.ok(dest.startsWith(path.join(workspace, ".bantam", "runs") + path.sep), "artifact lives in the workspace's runs dir");
  const body = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(body.kind, "bantam-chat-run");
  assert.equal(body.partial, false);
  assert.equal(body.request, "make it full screen");
  assert.equal(body.requestIndex, 2);
  assert.equal(body.turnCount, 1);
  assert.equal(body.turns[0].parsedAction.p, "index.html");
  assert.equal(body.summary, "stretched the layout");
  assert.equal(body.disposition, "done", "runAgent's flags map to a single legible disposition");
  assert.equal(model.onRequestRecord, null, "the request-record hook is detached after finalize");
});

test("model request records are captured while the run is live", () => {
  const workspace = ws();
  const model = {};
  const evidence = beginChatEvidence({ workspace, request: "r", index: 0, model });
  assert.equal(typeof model.onRequestRecord, "function", "the exact-request hook is attached");
  model.onRequestRecord({ phase: "response", record: { index: 0, status: "ok", request: { prompt: "PROMPT BYTES" } } });
  const dest = evidence.finalize(null, new Error("boom"));
  const body = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(body.modelCalls.length, 1, "the prompt handed to the model is in the artifact");
  assert.equal(body.modelCalls[0].request.prompt, "PROMPT BYTES");
  assert.equal(body.error, "boom");
  assert.notEqual(typeof model.onRequestRecord, "function", "finalize detaches the hook");
});

test("a failed artifact write never breaks the session", () => {
  // A regular file as the "workspace" makes every mkdir under it fail FAST with
  // ENOTDIR. (Not /proc: recursive mkdirSync can block indefinitely there on
  // this kernel — see the RunCheckpoint constructor comment.)
  const fileAsDir = path.join(ws(), "not-a-dir");
  fs.writeFileSync(fileAsDir, "");
  const evidence = beginChatEvidence({ workspace: fileAsDir, request: "r", index: 0, model: {} });
  assert.doesNotThrow(() => evidence.finalize({ disposition: "done" }));
});

test("BANTAM_CHAT_RUNS=0 opts out", () => {
  assert.equal(beginChatEvidence({ workspace: ws(), request: "r", index: 0, model: {}, enabled: false }), null);
});
