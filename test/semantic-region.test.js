import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  analyzeRegion,
  matchesRegion,
} = require("../creative-suite/grader/semantic-region.cjs");

const moonrootCopySafe = {
  anyOf: [
    { horizontal: ["center"] },
    { horizontal: ["right"], quality: ["open"], notVertical: ["upper"] },
  ],
};

test("semantic region normalization accepts equivalent valid visual placements", () => {
  for (const phrase of [
    "central sky",
    "open central sky",
    "upper-center-left sky",
    "upper middle",
    "mid-right open sky",
    "open area right of center",
    "unobstructed right-side region",
  ]) {
    assert.equal(matchesRegion(phrase, moonrootCopySafe), true, phrase);
  }
});

test("semantic region policy rejects nearby but obstructed placements", () => {
  for (const phrase of [
    "lower-left corner",
    "upper-right sky",
    "open upper-right sky",
    "left side",
    "bottom edge",
  ]) {
    assert.equal(matchesRegion(phrase, moonrootCopySafe), false, phrase);
  }
});

test("semantic region tokenization uses concepts rather than substring accidents", () => {
  assert.deepEqual(analyzeRegion("copyright notice").horizontal, []);
  assert.deepEqual(analyzeRegion("leftward open negative-space area"), {
    text: "leftward open negative-space area",
    horizontal: ["left"],
    vertical: [],
    quality: ["open"],
    surface: ["space"],
  });
});
