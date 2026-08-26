// `generate_image` exists and works with a LOCAL task model — Codex is used only
// as a brokered image worker. But it was reachable ONLY by remembering to set
// BANTAM_CODEX_IMAGE=1 before launch: no REPL command, no memory of the choice,
// nothing in the picker or the modes line. The capability was built and the
// button was hidden.
//
// It differs from every other mode in one way that matters: turning it on
// spends the signed-in Codex account. So it persists like the others (a session
// toggle that dies with the session is why :stream was made sticky), but it is
// announced LOUDLY at startup, because a remembered "on" that nobody can see is
// how quota gets spent by accident.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveImageMode, describeImageMode } from "../src/logic/session-modes.js";

test("off by default: a capability that spends money is not on because it exists", () => {
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

test("when on, the description names the cost — not just the state", () => {
  assert.match(describeImageMode(true), /Codex/);
  assert.match(describeImageMode(true), /quota|spend|account/i, "a remembered ON must show what it costs");
  assert.doesNotMatch(describeImageMode(false), /quota|spend/i);
});
