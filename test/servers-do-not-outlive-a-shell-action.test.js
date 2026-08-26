// The cellui head-to-head (2026-08-17) replayed a real Codex ask — "load this
// front-end UI up on port 8018" — through bantam. The CSS conversion matched
// Codex's fix file-for-file, but the run burned turns relaunching an http
// server that kept "dying": each shell action is a fresh `docker run --rm`
// container, so no background process can survive to the next action, and
// setsid/nohup — correct Unix physics everywhere else — are lies here.
//
// The model was reasoning correctly from a world model the prompt never
// corrected. The fix is context: when shell actions are sandboxed, the prompt
// states the real physics and the useful idiom (verify in the SAME action,
// hand the user the run-it-yourself command for anything persistent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/prompt.js";

test("a sandboxed run is told that processes do not survive the action", () => {
  const p = systemPrompt({ sandboxedShell: true });
  assert.match(p, /fresh, isolated sandbox/i);
  assert.match(p, /do NOT survive/i);
  assert.match(p, /same action/i, "the prompt teaches the start-and-verify-in-one-action idiom");
  assert.match(p, /command to run it themselves/i, "persistent services are handed to the user, not relaunched");
});

test("sandboxed physics are the default, matching the executor's default", () => {
  assert.match(systemPrompt(), /do NOT survive/i);
});

test("a host-shell run is not taught false physics", () => {
  const p = systemPrompt({ sandboxedShell: false });
  assert.doesNotMatch(p, /do NOT survive/i);
  assert.doesNotMatch(p, /fresh, isolated sandbox/i);
});
