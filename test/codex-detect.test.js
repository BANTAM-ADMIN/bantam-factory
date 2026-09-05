import assert from "node:assert/strict";
import test from "node:test";

import { detectCodex, describeCodex } from "../src/logic/codex-detect.js";

// The first-run image offer is only made when a signed-in Codex is actually
// present. These pin the probe so a missing binary, a signed-out CLI, and a
// probe that throws all read as "not detected" — never as a crash on the
// first screen.

const installed = () => "/usr/local/bin/codex";

test("installed and signed in via `codex login status` (ChatGPT)", () => {
  const c = detectCodex({
    which: installed, version: () => "codex-cli 0.149.0",
    loginStatus: () => ({ ok: true, stdout: "Logged in using ChatGPT\n" }),
  });
  assert.deepEqual([c.installed, c.signedIn, c.method, c.source], [true, true, "chatgpt", "login-status"]);
  assert.equal(c.version, "codex-cli 0.149.0");
  assert.match(describeCodex(c), /installed and signed in \(ChatGPT plan\)/);
});

test("installed but signed out: login status says so, and the auth file is empty", () => {
  const c = detectCodex({
    which: installed,
    loginStatus: () => ({ ok: false, stdout: "Not logged in\n" }),
    readAuth: () => ({}),
  });
  assert.deepEqual([c.installed, c.signedIn, c.method], [true, false, null]);
  assert.match(describeCodex(c), /not signed in/);
});

test("'Not logged in' is not mistaken for 'Logged in'", () => {
  const c = detectCodex({ which: installed, loginStatus: () => ({ ok: true, stdout: "Not logged in" }) });
  assert.equal(c.signedIn, false);
});

test("not installed: nothing else is probed", () => {
  let probed = false;
  const c = detectCodex({ which: () => null, loginStatus: () => { probed = true; return { ok: true, stdout: "Logged in" }; } });
  assert.equal(c.installed, false);
  assert.equal(c.signedIn, false);
  assert.equal(probed, false, "login status must not be spawned for a missing binary");
  assert.match(describeCodex(c), /not installed/);
});

test("the auth file is the fallback when login status is unavailable", () => {
  const c = detectCodex({
    which: installed,
    loginStatus: () => { throw new Error("old codex: no such subcommand"); },
    readAuth: () => ({ auth_mode: "chatgpt", tokens: { access_token: "x" } }),
  });
  assert.deepEqual([c.signedIn, c.method, c.source], [true, "chatgpt", "auth-file"]);
  const k = detectCodex({ which: installed, loginStatus: () => null, readAuth: () => ({ OPENAI_API_KEY: "sk-…" }) });
  assert.deepEqual([k.signedIn, k.method], [true, "apikey"]);
  assert.match(describeCodex(k), /API key/);
});

test("every probe may throw and the result is still a plain 'not detected'", () => {
  const boom = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => detectCodex({ which: boom, version: boom, loginStatus: boom, readAuth: boom }));
  const c = detectCodex({ which: installed, version: boom, loginStatus: boom, readAuth: boom });
  assert.deepEqual([c.installed, c.signedIn, c.version], [true, false, null]);
});
