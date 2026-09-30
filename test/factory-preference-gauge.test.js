import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideJevAdaptive, findPalettePreference, paletteFeatures, palettePreferenceChoice } from "../src/factory.js";

// A user who rates dark, muted palettes high and bright, saturated ones low.
const dark = (n) => [`#1${n}1${n}1${n}`, "#202830", "#303030", "#28201c", "#101418"];
const bright = (n) => [`#ff${n}0${n}0`, "#00e0ff", "#ffe000", "#ff00c8", "#40ff40"];
const history = [
  { colors: dark(0), rating: 5 }, { colors: dark(2), rating: 5 }, { colors: dark(4), rating: 4 }, { colors: dark(6), rating: 4 },
  { colors: bright(1), rating: 1 }, { colors: bright(3), rating: 1 }, { colors: bright(5), rating: 2 }, { colors: bright(7), rating: 2 },
];
const question = { type: "choice", instructions: "Which palette would this user rate more highly?", criteria: { A: bright(9), B: dark(8) } };

describe("factory palette preference gauge", () => {
  it("computes perceptual features: black is dark and grey is unsaturated", () => {
    const black = paletteFeatures(["#000000", "#000000", "#000000", "#000000", "#000000"]);
    const white = paletteFeatures(["#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff"]);
    assert.ok(Math.abs(black[0]) < 1e-6 && Math.abs(white[0] - 100) < 0.01, "CIELAB lightness spans 0..100");
    assert.ok(paletteFeatures(["#808080", "#808080", "#808080", "#808080", "#808080"])[5] < 1, "grey has no chroma");
  });

  it("recognises a rated palette history with two candidate palettes, and nothing else", () => {
    assert.ok(findPalettePreference({ history }, question));
    assert.equal(findPalettePreference({ history: [] }, question), null);
    assert.equal(findPalettePreference({ history }, { type: "choice", criteria: { A: "yes", B: "no" } }), null);
    assert.equal(findPalettePreference("text", question), null);
  });

  it("releases the palette closest to the user's taste when all five fits agree", () => {
    const choice = palettePreferenceChoice({ history }, question);
    assert.equal(choice.applies, true);
    assert.equal(choice.key, "B");
    assert.equal(choice.scores.length, 5);
  });

  it("adaptive: a unanimous preference answers without a model read", async () => {
    const reader = { compileLabels: async () => { throw new Error("the model must not be asked"); } };
    const { answers, evidence } = await decideJevAdaptive({ reader, pool: [], state: { history }, questions: { preference: question }, preferenceGauge: true });
    assert.equal(answers.preference.choice, "B");
    assert.equal(evidence.preference[0].step, "preference");
  });
});
