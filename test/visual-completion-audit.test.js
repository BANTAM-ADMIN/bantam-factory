import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import {
  completionAuditHint,
  lexicalContractAuditEnabled,
  lexicalContractAuditMessage,
  taskRequiresVisualAltAudit,
} from "../src/completion-audit.js";

const greenTurn = {
  action: { a: "shell", c: "npm test" },
  observation: "exit 0\n# tests 1\n# pass 1\n# fail 0\n",
};

const visualTask = [
  "Inspect assets/scene.png with view_image, then build index.html.",
  "Use the supplied image as hero artwork and include a concise image alt description grounded in visible facts.",
].join(" ");

test("visual alt audit activates only for task-grounded image inspection work", () => {
  assert.equal(taskRequiresVisualAltAudit(visualTask), true);
  assert.equal(taskRequiresVisualAltAudit("Build index.html with accessible alt text."), false);
  assert.equal(taskRequiresVisualAltAudit("Inspect scene.png with view_image and describe it."), false);
});

test("post-green visual work receives the concise image-evidence audit", () => {
  const hint = completionAuditHint({
    enabled: true,
    workspaceChanged: true,
    emitted: false,
    turn: greenTurn,
    task: visualTask,
    visualAudit: true,
  });
  assert.match(hint, /Compare every authored image alt description with the earlier `view_image` observation/);
  assert.match(hint, /distinctive foreground subject and distinctive sky or background elements/);
  assert.doesNotMatch(hint, /sparse collection slots|shared wrapper object/);
});

test("ordinary code tasks retain the established completion audit", () => {
  const hint = completionAuditHint({
    enabled: true,
    workspaceChanged: true,
    emitted: false,
    turn: greenTurn,
    task: "Fix the parser and run npm test.",
    visualAudit: true,
  });
  assert.match(hint, /sparse collection slots/);
  assert.doesNotMatch(hint, /earlier `view_image` observation/);
});

test("visual audit remains opt-in while the paired experiment is pending", () => {
  const hint = completionAuditHint({
    enabled: true,
    workspaceChanged: true,
    emitted: false,
    turn: greenTurn,
    task: visualTask,
    visualAudit: false,
  });
  assert.match(hint, /sparse collection slots/);
  assert.doesNotMatch(hint, /visual-alt-audit/);
});

test("lexical contract audit is task-grounded and independently opt-in", () => {
  const task = "Accept a trimmed, case-insensitive token or an unsigned decimal-integer string.";
  const message = lexicalContractAuditMessage(task);
  assert.match(message, /\[lexical-contract-audit\]/);
  assert.match(message, /surrounding whitespace remains valid/);
  assert.match(message, /mixed case remains valid/);
  assert.match(message, /leading-zero forms such as "007"/);

  const hint = completionAuditHint({
    enabled: true,
    workspaceChanged: true,
    emitted: false,
    turn: greenTurn,
    task,
    lexicalAudit: false,
  });
  assert.doesNotMatch(hint, /\[lexical-contract-audit\]/);
  assert.equal(lexicalContractAuditMessage("Fix the parser and run npm test."), "");
});

test("proven lexical audit defaults on with an explicit rollback", () => {
  assert.equal(lexicalContractAuditEnabled(undefined), true);
  assert.equal(lexicalContractAuditEnabled("1"), true);
  assert.equal(lexicalContractAuditEnabled("0"), false);
});

test("lexical contract audit does not invent unnamed string-language clauses", () => {
  const message = lexicalContractAuditMessage("Accept a case-insensitive mode string.");
  assert.match(message, /mixed case remains valid/);
  assert.doesNotMatch(message, /surrounding whitespace|leading-zero/);

  const canonical = lexicalContractAuditMessage(
    "Accept an unsigned decimal-integer string in canonical decimal representation.",
  );
  assert.doesNotMatch(canonical, /leading-zero/);
});

test("trusted auto-verification reaches the completion audit", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-visual-auto-verify-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const outputs = [
    { a: "write_file", p: "index.html", content: "<img src=\"scene.png\" alt=\"A garden.\">" },
    { a: "write_file", p: "app.js", content: "console.log('ready');" },
    { a: "write_file", p: "styles.css", content: "img { max-width: 100%; }" },
    { a: "write_file", p: "notes.txt", content: "ready" },
    {
      a: "replace",
      p: "index.html",
      old: "alt=\"A garden.\"",
      new: "alt=\"A gardener beneath a crescent moon.\"",
    },
    { a: "done", summary: "Implemented and verified." },
  ];
  let call = 0;
  const model = {
    codex: false,
    endpoint: null,
    metadata: () => ({ runtime: "test", model: "scripted" }),
    async complete() {
      return {
        content: JSON.stringify(outputs[Math.min(call++, outputs.length - 1)]),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };

  const result = await runAgent({
    task: `${visualTask} Accept a trimmed, case-insensitive label.`,
    workspace,
    model,
    maxTurns: 7,
    preGate: false,
    grounding: false,
    shellSandbox: "host",
    verificationScript: "node -e \"process.exit(0)\"",
    autoVerifyBlindEdits: 4,
    completionAudit: true,
    visualCompletionAudit: true,
    lexicalContractAudit: true,
  });

  assert.equal(result.metrics.autoVerifies, 1);
  assert.equal(result.metrics.completionAuditHints, 1);
  assert.equal(result.metrics.visualCompletionAuditHints, 1);
  assert.equal(result.metrics.visualCompletionAuditRevisions, 1);
  assert.equal(result.metrics.lexicalContractAuditHints, 1);
  assert.match(result.turns[3].observation, /\[visual-alt-audit\]/);
  assert.match(result.turns[3].observation, /\[lexical-contract-audit\]/);
  assert.equal(result.turns[3].scopedVerify.verdict, "pass");
});
