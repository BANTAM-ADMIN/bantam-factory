// `generate_image` exists and works with a LOCAL task model — Codex is used only
// as a brokered image worker. But it was reachable ONLY by remembering to set
// BANTAM_CODEX_IMAGE=1 before launch: no REPL command, no memory of the choice,
// nothing in the picker or the modes line. The capability was built and the
// button was hidden.
//
// It differs from every other mode in one way that matters: turning it on
// sends prompts through the signed-in Codex account — included with the plan,
// no per-image charge, but still data leaving the machine. So it persists like
// the others (a session toggle that dies with the session is why :stream was
// made sticky), but it is announced at startup, because a remembered "on" that
// nobody can see is how prompts leave the machine by accident.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveImageMode, describeImageMode } from "../src/logic/session-modes.js";

test("off by default: a capability that reaches an external account is not on because it exists", () => {
  const r = resolveImageMode({});
  assert.equal(r.on, false);
  assert.match(r.source, /default/);
});

test("the environment variable still wins, so scripted runs are unchanged", () => {
  assert.deepEqual(resolveImageMode({ env: "1" }), { on: true, source: "BANTAM_CODEX_IMAGE" });
  assert.deepEqual(resolveImageMode({ env: "0", saved: true }), { on: false, source: "BANTAM_CODEX_IMAGE" });
});

test("a remembered choice survives, and says it was remembered", () => {
  assert.deepEqual(resolveImageMode({ saved: true }), { on: true, source: "remembered" });
  assert.deepEqual(resolveImageMode({ saved: false }), { on: false, source: "remembered" });
});

test("when on, the description names where it runs — not just the state", () => {
  // Not a cost: image generation is included with the plan. What a remembered ON
  // must still make visible is that prompts go to an external account.
  assert.match(describeImageMode(true), /Codex plan/);
  assert.match(describeImageMode(true), /no per-image charge/, "say plainly that it is not metered");
  assert.doesNotMatch(describeImageMode(false), /plan|charge/i);
});
