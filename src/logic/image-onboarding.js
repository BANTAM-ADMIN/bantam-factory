// image-onboarding.js — the one-time offer to use Codex for images.
//
// The capability (`:image`, `:eyes codex`) was built, persisted, and shown on
// the modes line — and still nobody with a Codex plan discovered it, because
// nothing ever ASKED. This asks once, on the first interactive launch where a
// signed-in Codex is present, defaults to No, records the answer, and never
// asks again. Changing your mind later is the existing `:image` / `:eyes`.
//
// Pure: the decision, the prompt text, and the outcome are all functions of
// their inputs. bin/bantam.js wires the readline and the settings file.

import { describeCodex } from "./codex-detect.js";

export const ONBOARDING_KEY = "imageOnboarding";

/**
 * Should the offer be made? Cheap checks first; the Codex probe (which spawns
 * a process) runs only if they all pass — pass `codex` as a function for that.
 *
 *   settings     the loaded ~/.bantam/settings.json
 *   imageSource  resolveImageMode().source — "default" | "remembered" | "BANTAM_CODEX_IMAGE"
 *   env          process.env
 *   tty          interactive session with a person who can answer
 *   codex        detectCodex() result, or a thunk returning one
 *
 * The env var cannot be read directly here: bin/bantam.js writes the resolved
 * mode BACK into BANTAM_CODEX_IMAGE at startup (it is the transport to the
 * agent), so by the time the REPL runs it is always set. The resolved SOURCE is
 * the honest signal — only "default" means nobody has chosen yet.
 */
export function shouldOfferImageOnboarding({ settings = {}, imageSource = "default", env = {}, tty = false, codex } = {}) {
  if (!tty) return false;                                        // nobody to answer; never a silent yes
  if (imageSource !== "default") return false;                   // env var or remembered setting already chose
  if (env.BANTAM_NO_ONBOARDING === "1") return false;
  if (settings[ONBOARDING_KEY]) return false;                    // asked before, either answer
  if (typeof settings.imageMode === "boolean") return false;     // they already set :image by hand
  const c = typeof codex === "function" ? codex() : codex;
  return Boolean(c?.installed && c?.signedIn);
}

/** The question. Names the cost, that it is asked once, and both escapes. */
export function imageOnboardingPrompt(codex) {
  return [
    `  ✦ ${describeCodex(codex)}.`,
    "    Let BANTAM use it for images — generating them (generate_image) and reading",
    "    them (eyes)? Included with your plan — no per-image charge. Asked once.",
    "    Change any time:  :image on|off   ·   :eyes auto|local|codex",
    "  use Codex for images? [y/N]: ",
  ].join("\n");
}

/**
 * Turn an answer into what to apply and what to remember.
 * Yes → image on + eyes codex. No (or anything else) → image off, remembered as
 * an explicit choice so the offer is not repeated.
 */
export function imageOnboardingDecision(answer, codex, now = new Date()) {
  const yes = /^y(es)?$/i.test(String(answer ?? "").trim());
  return {
    imageMode: yes,
    imageProvider: yes ? "codex" : null,
    record: {
      answer: yes ? "yes" : "no",
      at: now.toISOString(),
      codex: codex?.version ?? null,
      method: codex?.method ?? null,
    },
  };
}
