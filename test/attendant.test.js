import test from "node:test";
import assert from "node:assert";
import { makeAttendantState, noteAttendantEvent, buildRunDigest, renderTail, buildAttendantPrompt } from "../src/logic/attendant.js";

function seed() {
  const s = makeAttendantState();
  noteAttendantEvent(s, { type: "action", action: { a: "write_file", p: "tool.py", content: "x" }, reasoning: "drafting the tool" });
  noteAttendantEvent(s, { type: "observation", text: "wrote tool.py (40 lines)" });
  noteAttendantEvent(s, { type: "action", action: { a: "shell", c: "pytest -q" }, reasoning: "run tests" });
  noteAttendantEvent(s, { type: "observation", text: "2 FAILED, 3 passed" });
  noteAttendantEvent(s, { type: "action", action: { a: "replace", p: "tool.py", old: "a", new: "b" }, reasoning: "fix the tie-break" });
  noteAttendantEvent(s, { type: "observation", text: "replaced 1 occurrence" });
  return s;
}

test("events pair into turns; digest counts edits, shells, and error turns", () => {
  const s = seed();
  assert.equal(s.turns.length, 3);
  const d = buildRunDigest(s.turns);
  assert.match(d, /files edited: tool\.py/);
  assert.match(d, /shell commands run: 1/);
  assert.match(d, /errors seen at turn\(s\): 2/);
  assert.match(d, /authoritative for whether anything was since RESOLVED/);
});

test("tail carries the raw recent turns with results", () => {
  const tail = renderTail(seed().turns, 2);
  assert.match(tail, /pytest -q/);
  assert.match(tail, /replaced 1 occurrence/);
  assert.doesNotMatch(tail, /drafting the tool/, "older turns fall outside the tail");
});

test("the prompt frames one honest agent: observer seat + queued steer + task", () => {
  const p = buildAttendantPrompt({ task: "build the tool", turns: seed().turns, question: "any failures?" });
  assert.match(p, /sibling agent/);
  assert.match(p, /ALSO been queued for the working sibling/);
  assert.match(p, /TASK IN PROGRESS: build the tool/);
  assert.match(p, /OPERATOR SAYS: any failures\?/);
  assert.match(p, /STATUS DIGEST/);
  assert.match(p, /RECENT TURNS \(raw, authoritative/);
});

test("write_batch paths and long values are handled without blowing up", () => {
  const s = makeAttendantState();
  noteAttendantEvent(s, { type: "action", action: { a: "write_batch", files: [{ p: "a.js" }, { p: "b.js" }] }, reasoning: "" });
  noteAttendantEvent(s, { type: "observation", text: "x".repeat(5000) });
  const d = buildRunDigest(s.turns);
  assert.match(d, /a\.js, b\.js/);
  assert.ok(renderTail(s.turns).length < 2000, "tail stays bounded");
});

test("frameInjection: user text vs the agent's own voice, unmistakably", async () => {
  const { frameInjection } = await import("../src/logic/attendant.js");
  assert.match(frameInjection("hurry up"), /The user interjected.*hurry up/);
  const f = frameInjection({ kind: "attendant", text: "I told the operator tests are green" });
  assert.match(f, /Your own live voice/);
  assert.match(f, /do not answer the same question again/);
  assert.match(f, /tests are green/);
  assert.doesNotMatch(f, /The user interjected/);
});

test("the prompt carries the handoff contract and optional persona", () => {
  const base = buildAttendantPrompt({ task: "t", turns: seed().turns, question: "q" });
  assert.match(base, /handed to the working sibling at its next turn boundary/);
  assert.doesNotMatch(base, /YOUR VOICE/);
  const voiced = buildAttendantPrompt({ task: "t", turns: seed().turns, question: "q", persona: "cheerful, dry wit" });
  assert.match(voiced, /YOUR VOICE.*cheerful, dry wit/);
  assert.match(voiced, /working sibling keeps its own demeanor/);
});
