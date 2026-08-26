// Which eyes look at an image was decidable only by exporting
// BANTAM_IMAGE_PROVIDER before launch. The routing rule already existed and was
// already right (local mmproj wins by default; codex only when asked or when no
// projector is loaded) — but the operator could not change their mind without
// restarting, and nothing showed which was in force.
//
// It matters more than a preference: vision-ground.js records that on a
// machine-rendered board the local projector returned the exact position about
// one time in six. Choosing eyes is a correctness decision.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveImageProvider, describeImageProvider } from "../src/logic/session-modes.js";
import { pickImageProvider } from "../src/logic/tools.js";

test("auto is the default and defers to the existing routing rule", () => {
  const r = resolveImageProvider({});
  assert.equal(r.provider, "auto");
  assert.match(r.source, /default/);
});

test("the environment variable still wins over a remembered choice", () => {
  assert.deepEqual(resolveImageProvider({ env: "codex", saved: "local" }),
    { provider: "codex", source: "BANTAM_IMAGE_PROVIDER" });
});

test("a remembered choice survives and says so", () => {
  assert.deepEqual(resolveImageProvider({ saved: "codex" }), { provider: "codex", source: "remembered" });
});

test("nonsense falls back to auto rather than silently picking one", () => {
  assert.equal(resolveImageProvider({ saved: "eyeballs" }).provider, "auto");
  assert.equal(resolveImageProvider({ env: "  " }).provider, "auto");
});

test("auto maps to no preference, preserving the measured routing exactly", () => {
  // auto must NOT be passed through as a literal preference: pickImageProvider
  // treats an unknown string as "no preference", but relying on that would be
  // an accident. Assert the contract both ways.
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: undefined }), "local");
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: "codex" }), "codex");
  assert.equal(pickImageProvider({ localVision: false, codexVision: true, preference: undefined }), "codex");
  assert.equal(pickImageProvider({ localVision: true, codexVision: false, preference: "codex" }), "local",
    "asking for codex without codex must not disable vision entirely");
});

test("the description says which eyes, and why it might matter", () => {
  assert.match(describeImageProvider("local"), /local/i);
  assert.match(describeImageProvider("codex"), /Codex/);
  assert.match(describeImageProvider("auto"), /local/i);
});
