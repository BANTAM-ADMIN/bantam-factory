// The approval prompt used to be unanswerable: `rl.question` and the REPL's own
// "line" handler both consumed the line (so an answer became a mid-run steer),
// a bare Enter was dropped before it could take the bracketed default, and the
// 250 ms working-prompt repaint painted over the query. These pin the two pure
// pieces of the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { routeInputLine, parseNetworkApproval } from "../src/repl-input.js";

test("an in-flight approval prompt owns the next line, including an empty Enter", () => {
  assert.deepEqual(routeInputLine("y", { awaitingAnswer: true }), { kind: "answer", value: "y" });
  assert.deepEqual(routeInputLine("", { awaitingAnswer: true }), { kind: "answer", value: "" });
  assert.deepEqual(routeInputLine("   ", { awaitingAnswer: true }), { kind: "answer", value: "" });
  assert.deepEqual(routeInputLine("  a  ", { awaitingAnswer: true }), { kind: "answer", value: "a" });
});

test("with no prompt, an empty line stays empty and typed text stays a request/steer", () => {
  assert.deepEqual(routeInputLine(""), { kind: "empty" });
  assert.deepEqual(routeInputLine("   "), { kind: "empty" });
  assert.deepEqual(routeInputLine("fix the bug"), { kind: "line", value: "fix the bug" });
});

test("bare Enter declines; only explicit yes/always grant network", () => {
  for (const denied of ["", "   ", "n", "no", "nope", "maybe", "yess"]) {
    assert.equal(parseNetworkApproval(denied), "deny", `${JSON.stringify(denied)} must decline`);
  }
  for (const once of ["y", "Y", "yes", " once "]) {
    assert.equal(parseNetworkApproval(once), "allow-once", `${JSON.stringify(once)} grants once`);
  }
  for (const session of ["a", "A", "all", "always", "session"]) {
    assert.equal(parseNetworkApproval(session), "allow-session", `${JSON.stringify(session)} grants the session`);
  }
});
