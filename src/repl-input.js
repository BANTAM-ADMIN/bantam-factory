// Who owns the next entered line in the interactive REPL, and what an approval
// answer means.
//
// A network/install approval prompt must take the next line — including an empty
// Enter, which is the bracketed default. Before this was explicit, the prompt
// used `rl.question` while the REPL's own "line" handler was also listening: the
// answer was consumed as a mid-run steer, an empty Enter answered nothing, and
// the run sat paused on a prompt the operator could not clear (operator
// hand-test, 2026-09-11: "it didn't give me a chance to approve").

/** @returns {{kind: "answer"|"empty"|"line", value: string}} */
export function routeInputLine(line, { awaitingAnswer = false } = {}) {
  const value = String(line ?? "").trim();
  if (awaitingAnswer) return { kind: "answer", value };
  if (!value) return { kind: "empty" };
  return { kind: "line", value };
}

/**
 * Map an approval answer to the executor's decision vocabulary. An empty answer
 * (bare Enter) is the bracketed default: decline. Anything unrecognized declines
 * too, so a typo never silently grants network.
 */
export function parseNetworkApproval(answer) {
  const t = String(answer ?? "").trim().toLowerCase();
  if (["a", "all", "always", "session"].includes(t)) return "allow-session";
  if (["y", "yes", "once"].includes(t)) return "allow-once";
  return "deny";
}
