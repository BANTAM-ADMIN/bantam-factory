// Live vision smoke — runs ONLY when the local server reports a vision
// projector (tools/serve-vision.sh). Unit coverage for the vision module
// lives in codex-vision.test.js with fakes; this is the one test that proves
// the real mmproj path end-to-end: /props detection and a real description
// of a real asset. Note: shares the single model slot — a concurrent belt
// generation queues ahead of it, so the timeout is generous.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectVision, describeImage } from "../src/logic/vision.js";
import { visionSkipReason } from "./helpers/env-guards.js";

const _visionSkip = visionSkipReason();
const ENDPOINT = process.env.BANTAM_VISION_ENDPOINT || "http://127.0.0.1:8085";

test("the server reports its vision modality", { skip: _visionSkip }, () => {
  assert.equal(detectVision(ENDPOINT), true);
});

test("the mmproj path describes a real image end-to-end", { skip: _visionSkip }, () => {
  const asset = path.resolve("creative-suite/assets/dispatch-card.png");
  const text = describeImage(ENDPOINT, asset, { timeoutSec: 180, maxTokens: 300 });
  assert.equal(typeof text, "string");
  assert.ok(text.trim().length > 10, `description too short: ${JSON.stringify(text)}`);
});
