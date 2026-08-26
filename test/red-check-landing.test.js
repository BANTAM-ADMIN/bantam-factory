// Landing-window contradiction (fair-bantam, 2026-08-18): the harness said
// "land now" while the worker held a visible SyntaxError; it obeyed and
// shipped a false done. Two properties pin the fix: a steered (never-executed)
// retry must not launder the red, and the red must survive for the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverableRunOutcome } from "../src/logic/runlog.js";
import { unresolvedEvidenceObjection } from "../src/logic/evidence-guard.js";

const CMD = 'python3 -c "import ast; ast.parse(open(\'gguf-scope\').read())" && python3 gguf-scope fixtures/m.gguf; echo "exit=$?"';
const RED = 'exit 0\nexit=1\n[stderr]\nTraceback (most recent call last):\n  File "<unknown>", line 415\nSyntaxError: expected \':\'';
const STEER = "[repetition] Deduplicated — not stale. You already ran this exact shell command on turn 55";

test("a steered retry never enters the deliverable channel", () => {
  assert.equal(deliverableRunOutcome({ a: "shell", c: CMD }, STEER, { editedNames: new Set(["gguf-scope"]) }), null);
});

test("fair-bantam regression: red check + laundering retry still blocks done", () => {
  const turns = [
    { action: { a: "write_file", p: "gguf-scope" }, observation: "wrote 500 bytes" },
    { action: { a: "shell", c: CMD }, observation: RED },
    { action: { a: "shell", c: CMD }, observation: STEER },
  ];
  const msg = unresolvedEvidenceObjection(turns, 0);
  assert.ok(msg, "the red run must remain unresolved");
  assert.match(msg, /your own last check/);
});

test("a traceback is a hard failure even with a swallowed exit code", () => {
  const obs = "exit 0\n[stderr]\nTraceback (most recent call last):\nSyntaxError: expected ':'";
  assert.equal(deliverableRunOutcome({ a: "shell", c: "python3 tool.py" }, obs), "fail");
});
