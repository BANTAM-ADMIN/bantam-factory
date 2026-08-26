import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lexicalSmokeWorkspace, formatLexicalSmoke } from "../src/logic/lexical-smoke.js";

// The recorded specimen (adapter-migration, local 27B, 2026-07-30): the task
// named a case-insensitive language, the model wrote a case-SENSITIVE compare,
// declared done, and the hidden grader failed 4/4. The advisory lexical audit
// had already fired at turn 6 and was ignored for four turns.
const ADAPTER_TASK = 'parseEnabled accepts booleans or trimmed case-insensitive "true"/"false" strings.';

const CASE_SENSITIVE_ENABLED = `export function parseEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    throw new TypeError("parseEnabled accepts booleans or trimmed case-insensitive true/false strings");
  }
  throw new TypeError("parseEnabled accepts booleans or trimmed case-insensitive true/false strings");
}
`;

const CORRECT_ENABLED = `export function parseEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  throw new TypeError("parseEnabled accepts booleans or case-insensitive true/false strings");
}
`;

function workspaceWith(source) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lexical-smoke-"));
  // Nested exactly like the real fixture: modules under src/adapters/, not root.
  fs.mkdirSync(path.join(ws, "src", "adapters"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(ws, "src", "adapters", "enabled.js"), source);
  return ws;
}

test("catches a case-sensitive compare when the task named a case-insensitive language", async (t) => {
  const ws = workspaceWith(CASE_SENSITIVE_ENABLED);
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const findings = await lexicalSmokeWorkspace(ws, ADAPTER_TASK);

  const hit = findings.find((f) => f.fn === "parseEnabled");
  assert.ok(hit, `expected a parseEnabled finding, got ${JSON.stringify(findings)}`);
  assert.equal(hit.language, "case-insensitive");
  // The accepted spelling works; only the mixed-case variant throws.
  assert.equal(hit.accepted, "true");
  assert.match(String(hit.variant), /^(TRUE|True)$/);
  assert.match(hit.error, /TypeError|accepts booleans/i);
});

test("stays silent when the same code is correct", async (t) => {
  const ws = workspaceWith(CORRECT_ENABLED);
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const findings = await lexicalSmokeWorkspace(ws, ADAPTER_TASK);

  assert.deepEqual(findings, []);
});

test("stays silent when the task never names the language", async (t) => {
  const ws = workspaceWith(CASE_SENSITIVE_ENABLED);
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  // Same buggy code, but nothing in the task makes mixed case valid.
  const findings = await lexicalSmokeWorkspace(ws, 'parseEnabled accepts "true"/"false" strings.');

  assert.deepEqual(findings, []);
});

// The fixture's STARTING code is silently-wrong rather than throwing:
// `value === true || value === "true"` returns false for "TRUE". A named
// case-insensitive language is an oracle -- the variant must produce the SAME
// result as the accepted spelling -- so this is catchable without guessing.
const SILENTLY_WRONG_ENABLED = `export function parseEnabled(value) {
  return value === true || value === "true";
}
`;

test("catches a silently-wrong narrowing, not just a throwing one", async (t) => {
  const ws = workspaceWith(SILENTLY_WRONG_ENABLED);
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const findings = await lexicalSmokeWorkspace(ws, ADAPTER_TASK);

  const hit = findings.find((f) => f.fn === "parseEnabled" && f.accepted === "true");
  assert.ok(hit, `expected a silent-mismatch finding, got ${JSON.stringify(findings)}`);
  assert.equal(hit.language, "case-insensitive");
  assert.equal(hit.variant, "TRUE");
  assert.match(hit.error, /returned false.*expected true|differs/i);
});

// False-positive guard. A multi-contract task names case-insensitivity for ONE
// function; every other exported function still legitimately preserves case.
// Applying the language globally would false-bounce correct code -- the exact
// failure mode edge-smoke's 58-solution audit narrowed against.
const MIXED_ADAPTERS = `export function parseEnabled(value) {
  const t = String(value).trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  throw new TypeError("bad");
}
export function normalizeId(value) {
  if (typeof value !== "string") throw new TypeError("bad");
  const t = value.trim();
  if (!t) throw new TypeError("bad");
  return t;
}
`;

test("scopes a named language to the function its clause names", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lexical-smoke-fp-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "src", "adapters"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(ws, "src", "adapters", "all.js"), MIXED_ADAPTERS);

  const task = 'normalizeId accepts only a string and trims it. '
    + 'parseEnabled accepts booleans or trimmed case-insensitive "true"/"false" strings.';
  const findings = await lexicalSmokeWorkspace(ws, task);

  // normalizeId("TRUE") -> "TRUE" differs from normalizeId("true") -> "true",
  // but nothing made normalizeId case-insensitive. It must not be reported.
  assert.deepEqual(findings.filter((f) => f.fn === "normalizeId"), []);
  assert.deepEqual(findings, []);
});

test("formats findings as a done-gate bounce carrying the exact failing call", () => {
  const text = formatLexicalSmoke([
    { fn: "parseEnabled", language: "case-insensitive", accepted: "true", variant: "TRUE", error: "TypeError: nope" },
  ]);

  assert.match(text, /\[lexical-smoke\]/);
  assert.match(text, /parseEnabled\("TRUE"\)/);
  assert.match(text, /case-insensitive/);
  assert.equal(formatLexicalSmoke([]), "");
});
