// "Have you run the thing you built?"
//
// v15 edited the CLI twelve times and never once executed `bantam exec`. It
// crashed on the first invocation — a fact available for the price of one
// shell command, which the model never spent. Claude and Codex both drove
// their new command by hand before calling it done; BANTAM tested the SUITE
// and never the FEATURE.
//
// The task text names the invocation. Extract it, watch whether the model ever
// runs it, and say so plainly.

const INVOCATION_RE = /`([a-z][\w.-]*(?:\.js)?\s+[a-z][\w-]*)[^`]{0,60}`/gi;

// Words that are not a command being built (the verify command, a package
// manager, the test runner).
const NOT_A_DELIVERABLE = /^(npm|npx|node\s+--test|pnpm|yarn|pip|python|go|cargo|git)\b/i;

/** The command the task is asking the model to BUILD, e.g. "bantam exec". */
export function deliverableCommand(task) {
  const text = String(task ?? "");
  for (const m of text.matchAll(INVOCATION_RE)) {
    const candidate = m[1].trim().replace(/\s+/g, " ");
    if (NOT_A_DELIVERABLE.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/** Did this shell command actually invoke it? Tolerates ./bin/x.js and node prefixes. */
export function invokesCommand(shellCommand, deliverable) {
  if (!deliverable) return false;
  const [bin, sub] = deliverable.split(" ");
  const c = String(shellCommand ?? "");
  const binRe = new RegExp(`(^|[\\s/])${escape(bin)}(\\.js)?\\b`, "i");
  if (!binRe.test(c)) return false;
  return sub ? new RegExp(`\\b${escape(sub)}\\b`).test(c) : true;
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function smokeNudge(deliverable, edits) {
  return `\n[smoke] You have made ${edits} edits building \`${deliverable}\` and have never once RUN it. A suite pass is not evidence that the command works — the first invocation is. Run \`${deliverable}\` now (with the flags the task specifies), read its output and its exit code, and fix what you find before doing anything else.`;
}
