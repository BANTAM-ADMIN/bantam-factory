// Local eyes first (operator order, 2026-08-18): codex mode silently routed
// screenshots to the Codex account even with a local projector serving.
// Local mmproj wins by default; codex only by explicit preference, or as the
// fallback when no projector is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickImageProvider } from "../src/logic/tools.js";

test("local wins by default when both are available", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: undefined }), "local");
});
test("explicit codex preference routes to codex", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: "codex" }), "codex");
});
test("codex is the fallback only when no local projector exists", () => {
  assert.equal(pickImageProvider({ localVision: false, codexVision: true, preference: undefined }), "codex");
});
test("explicit local preference never falls back to codex", () => {
  assert.equal(pickImageProvider({ localVision: false, codexVision: true, preference: "local" }), null);
});
test("codex preference degrades to local when codex is absent", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: false, preference: "codex" }), "local");
});
