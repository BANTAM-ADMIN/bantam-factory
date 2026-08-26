// The emergency teacher degrades gracefully and its model is selectable:
// BANTAM_TEACHER_CMD (explicit command) > BANTAM_TEACHER_MODEL (a bridge slug,
// or "self" for the same weights wearing a fresh-context teacher persona) >
// the default CLI — and a dead primary teacher falls back to the persona
// instead of silence. "If all we've got is our 27b, we strap a new persona on
// that 27b and let her rip." (operator, 2026-08-25)

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { teacherFromEnv, askTeacher, makeBridgeTeacher, SELF_TEACHER_PERSONA } from "../src/teacher-assist.js";

test("BANTAM_TEACHER_MODEL=self resolves to the self-persona (no external invoke)", () => {
  const t = teacherFromEnv({ BANTAM_TEACHER: "1", BANTAM_TEACHER_MODEL: "self" });
  assert.equal(t.kind, "self");
  assert.equal(t.invoke, null);
  assert.match(t.source, /self-persona/);
  assert.match(SELF_TEACHER_PERSONA, /did NOT write this code/);
});

test("a bridge slug resolves to a bridge teacher; an explicit CMD still wins", () => {
  const t = teacherFromEnv({ BANTAM_TEACHER: "1", BANTAM_TEACHER_MODEL: "gpt-5.6-sol:high", CODEXAPI_URL: "http://x", CODEXAPI_KEY: "k" });
  assert.equal(t.kind, "bridge");
  assert.equal(typeof t.invoke, "function");
  assert.match(t.source, /bridge:gpt-5\.6-sol:high/);
  const cmd = teacherFromEnv({ BANTAM_TEACHER: "1", BANTAM_TEACHER_MODEL: "self", BANTAM_TEACHER_CMD: "echo hi" });
  assert.equal(cmd.kind, "cli");
});

test("askTeacher falls back to the persona when the primary teacher is dead", async () => {
  const dead = async () => null;
  const persona = async (prompt) => {
    assert.match(prompt, /ROOT CAUSE/);
    return "The refill clamps before adding the elapsed tokens, so partial refills are discarded on every denied take.";
  };
  const cause = await askTeacher({ testName: "t", testSource: "src", implSource: "impl", diff: "x", invoke: dead, fallback: persona });
  assert.match(cause, /refill clamps/);
});

test("makeBridgeTeacher extracts chat content and turns errors into silence", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith("/v1/chat/completions")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Cause: the accumulator resets." } }] }));
    } else { res.statusCode = 500; res.end("no"); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const ok = makeBridgeTeacher("m", { url, key: "k" });
  assert.equal(await ok("p", {}), "Cause: the accumulator resets.");
  const dead = makeBridgeTeacher("m", { url: "http://127.0.0.1:9", key: "k", timeoutMs: 500 });
  assert.equal(await dead("p", {}), null);
  srv.close();
});

test("the teacher comes due by streak OR by turns stuck red (card 7R: 3 suite runs in 111 turns)", async () => {
  const { teacherDue } = await import("../src/teacher-assist.js");
  assert.equal(teacherDue({ streak: 5, teacherAfter: 5 }), true, "the original verification clock still works");
  assert.equal(teacherDue({ streak: 2, teacherAfter: 5, firstRedTurn: 10, turnIndex: 20 }), false, "10 turns red is patience");
  assert.equal(teacherDue({ streak: 2, teacherAfter: 5, firstRedTurn: 10, turnIndex: 34 }), true, "24 turns red is stuck, whatever the streak");
  assert.equal(teacherDue({ streak: 2, teacherAfter: 5, firstRedTurn: null, turnIndex: 99 }), false, "never seen red never fires");
});
