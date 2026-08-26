import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAppServer } from "../src/codex-transport.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.js", import.meta.url),
);

test("the app-server child keeps its auth but never inherits harness or test-runner state", async (t) => {
  const priorProbe = process.env.BANTAM_ENV_PROBE;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.BANTAM_ENV_PROBE = "leak-check";
  process.env.OPENAI_API_KEY = "codex-auth-must-survive";
  t.after(() => {
    if (priorProbe === undefined) delete process.env.BANTAM_ENV_PROBE;
    else process.env.BANTAM_ENV_PROBE = priorProbe;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });

  const codex = new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 2000,
  });
  t.after(() => codex.close());

  const result = await codex.complete("report env", {});
  const seen = JSON.parse(result.content);

  assert.equal(seen.openaiApiKey, "codex-auth-must-survive", "codex env auth must pass through");
  assert.deepEqual(seen.bantamKeys, [], "BANTAM_* harness switches must not leak into the app-server");
  assert.equal(seen.nodeTestContext, null, "the node test-runner IPC marker must not reach the child");
});
