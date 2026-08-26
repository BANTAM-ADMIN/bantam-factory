import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { reconstructCodexPromptDelivery, CodexAppServer } from "../src/codex-transport.js";
import { ModelClient } from "../src/model.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.js", import.meta.url),
);

test("ModelClient rebuilds a long-running delta thread after the app-server process dies", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-codex-recovery-"));
  const exitMarker = path.join(stateDir, "exit-once");
  const runtime = new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    model: "gpt-5.6-sol",
    effort: "high",
    timeoutMs: 2000,
    threadMode: "run",
    promptMode: "delta",
  });
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    codexEffort: "high",
    codexThreadMode: "run",
    codexPromptMode: "delta",
    retries: 1,
    timeoutMs: 2000,
  });
  client.codexRuntime = runtime;
  t.after(() => {
    client.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const token = client.beginAgentRun();
  const stable = "stable long-horizon canonical instructions\n".repeat(300);
  const accepted = [];
  for (let turn = 1; turn <= 8; turn++) {
    accepted.push(await client.complete(`${stable}accepted observation ${turn}`));
  }

  const originalThread = accepted[0].codexThread.threadId;
  assert.ok(accepted.every((result) => result.codexThread.threadId === originalThread));
  assert.equal(accepted[0].codexPromptDelivery.mode, "full");
  assert.ok(accepted.slice(1).every((result) => result.codexPromptDelivery.mode === "delta"));

  const recoveryPrompt = `${stable}accepted observation 9\nBANTAM_FAKE_EXIT_ONCE=${exitMarker}`;
  const recovered = await client.complete(recoveryPrompt);
  const recoveryRecord = client.requestLog().at(-1);

  assert.equal(fs.existsSync(exitMarker), true);
  assert.equal(recoveryRecord.attempts.length, 2);
  assert.equal(recoveryRecord.attempts[0].status, "error");
  assert.match(recoveryRecord.attempts[0].error.message, /Codex app-server exited \(86\)/);
  assert.equal(recoveryRecord.attempts[1].status, "ok");
  assert.notEqual(recovered.codexThread.threadId, originalThread);
  assert.equal(recovered.codexThread.threadReused, false);
  assert.equal(recovered.codexPromptDelivery.mode, "full");
  assert.equal(recovered.codexPromptDelivery.canonicalChars, recoveryPrompt.length);
  assert.equal(recovered.codexPromptDelivery.deliveredChars, recoveryPrompt.length);

  const continuationPrompt = `${stable}accepted observation 10 after recovery`;
  const continued = await client.complete(continuationPrompt);
  assert.equal(continued.codexThread.threadId, recovered.codexThread.threadId);
  assert.equal(continued.codexThread.threadReused, true);
  assert.equal(continued.codexPromptDelivery.mode, "delta");
  assert.equal(
    reconstructCodexPromptDelivery(
      recoveryPrompt,
      continued.codexPromptDelivery.deliveredText,
    ),
    continuationPrompt,
  );
  assert.equal(client.endAgentRun(token), true);
});
