// Operator profile — standing preferences, loaded once per session.
//
// Mined from 1,500 of the operator's real sessions (benches/collab): the same
// instructions restated across hundreds of sessions because agents forget —
// TDD in 120 distinct sessions, stay-in-this-directory in 91, document-as-you-
// go in 64, show-me-it-working in 52. A preference the human has said a
// hundred times belongs in context by default, not in their next message.
//
// The profile is a plain file the operator owns and edits:
//   ~/.bantam/profile.md   (or BANTAM_PROFILE=path, or BANTAM_PROFILE=0 off)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PROFILE_CHARS = 1500;

export function loadOperatorProfile({ env = process.env, home = os.homedir() } = {}) {
  const setting = env.BANTAM_PROFILE;
  if (setting === "0" || setting === "false" || setting === "off") return null;
  const file = setting && setting !== "1" ? setting : path.join(home, ".bantam", "profile.md");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return null;
    return { file, text: text.length > MAX_PROFILE_CHARS ? `${text.slice(0, MAX_PROFILE_CHARS)}\n…` : text };
  } catch {
    return null;   // no profile is a fine state, not an error
  }
}
