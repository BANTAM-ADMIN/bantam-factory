import { test } from "node:test";
import assert from "node:assert/strict";

// Verify :sandbox command parsing logic (same as implemented in bin/bantam.js)
function parseSandboxCommand(request) {
  const match = request.match(/^:sandbox\b/i);
  if (!match) return null;
  const arg = request.replace(/^:sandbox\b\s*/i, "").trim().toLowerCase();
  if (arg === "on") return { mode: "docker" };
  if (arg === "off") return { mode: "host" };
  if (arg) return { usage: true };
  return { status: true };
}

test(":sandbox on sets docker mode", () => {
  const result = parseSandboxCommand(":sandbox on");
  assert.equal(result.mode, "docker");
});

test(":sandbox off sets host mode", () => {
  const result = parseSandboxCommand(":sandbox off");
  assert.equal(result.mode, "host");
});

test(":sandbox with no arg shows status", () => {
  const result = parseSandboxCommand(":sandbox");
  assert.equal(result.status, true);
});

test(":sandbox with bad arg shows usage", () => {
  const result = parseSandboxCommand(":sandbox maybe");
  assert.equal(result.usage, true);
});

test(":sandbox is case-insensitive", () => {
  assert.equal(parseSandboxCommand(":SANDBOX ON").mode, "docker");
  assert.equal(parseSandboxCommand(":Sandbox Off").mode, "host");
});
