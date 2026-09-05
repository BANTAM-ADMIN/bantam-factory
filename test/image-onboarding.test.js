import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_KEY, shouldOfferImageOnboarding, imageOnboardingPrompt, imageOnboardingDecision,
} from "../src/logic/image-onboarding.js";

// The offer is made once, only to a person, only when a signed-in Codex is
// there, and never over a choice already made. Each row below was a way the
// question could have become an annoyance or a silent yes.

const signedIn = { installed: true, signedIn: true, version: "codex-cli 0.149.0", method: "chatgpt" };
const clear = { settings: {}, env: {}, tty: true, codex: signedIn };

test("a fresh interactive session with a signed-in Codex gets the offer", () => {
  assert.equal(shouldOfferImageOnboarding(clear), true);
});

test("no TTY: never asked, and never a silent yes", () => {
  assert.equal(shouldOfferImageOnboarding({ ...clear, tty: false }), false);
});

test("a scripted run that set BANTAM_CODEX_IMAGE has already chosen — judged by the resolved source", () => {
  // The raw env var is useless here: startup writes the resolved mode back into
  // it as the transport to the agent, so it is ALWAYS set by the time the REPL
  // runs. The first demo of this feature never asked for exactly that reason.
  assert.equal(shouldOfferImageOnboarding({ ...clear, imageSource: "BANTAM_CODEX_IMAGE" }), false);
  assert.equal(shouldOfferImageOnboarding({ ...clear, imageSource: "remembered" }), false);
  assert.equal(shouldOfferImageOnboarding({ ...clear, imageSource: "default", env: { BANTAM_CODEX_IMAGE: "0" } }), true,
    "the transport value must not be mistaken for a choice");
});

test("asked before — either answer — is never asked again", () => {
  for (const answer of ["yes", "no"]) {
    const settings = { [ONBOARDING_KEY]: { answer, at: "2026-09-05T00:00:00Z" } };
    assert.equal(shouldOfferImageOnboarding({ ...clear, settings }), false, answer);
  }
});

test("a hand-set :image is a choice; the offer does not second-guess it", () => {
  assert.equal(shouldOfferImageOnboarding({ ...clear, settings: { imageMode: false } }), false);
  assert.equal(shouldOfferImageOnboarding({ ...clear, settings: { imageMode: true } }), false);
});

test("Codex missing or signed out: no offer, and nothing recorded to block a later one", () => {
  assert.equal(shouldOfferImageOnboarding({ ...clear, codex: { installed: false, signedIn: false } }), false);
  assert.equal(shouldOfferImageOnboarding({ ...clear, codex: { installed: true, signedIn: false } }), false);
});

test("the Codex probe is lazy: it is not spawned when a cheap check already says no", () => {
  let probed = 0;
  const codex = () => { probed++; return signedIn; };
  shouldOfferImageOnboarding({ ...clear, tty: false, codex });
  shouldOfferImageOnboarding({ ...clear, settings: { [ONBOARDING_KEY]: { answer: "no" } }, codex });
  assert.equal(probed, 0, "no process should be spawned for a session that cannot be asked");
  shouldOfferImageOnboarding({ ...clear, codex });
  assert.equal(probed, 1);
});

test("the prompt names the version, the cost, that it is asked once, and both escapes", () => {
  const p = imageOnboardingPrompt(signedIn);
  assert.match(p, /Codex codex-cli 0\.149\.0 is installed and signed in \(ChatGPT plan\)/);
  assert.match(p, /no per-image charge/);
  assert.match(p, /asked once/i);
  assert.match(p, /:image on\|off/);
  assert.match(p, /:eyes auto\|local\|codex/);
  assert.match(p, /\[y\/N\]: $/, "default is No");
});

test("yes turns image on and points the eyes at Codex; no turns image off — both are recorded", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const y = imageOnboardingDecision("y", signedIn, now);
  assert.deepEqual([y.imageMode, y.imageProvider], [true, "codex"]);
  assert.deepEqual(y.record, { answer: "yes", at: "2026-09-05T12:00:00.000Z", codex: "codex-cli 0.149.0", method: "chatgpt" });
  for (const a of ["", "n", "no", "maybe", undefined]) {
    const d = imageOnboardingDecision(a, signedIn, now);
    assert.deepEqual([d.imageMode, d.imageProvider, d.record.answer], [false, null, "no"], JSON.stringify(a));
  }
});
