// Conservative intent classification for multi-run orchestration.
//
// Advisory requests are allowed to inspect and answer, but never mutate or run
// shell commands. Everything ambiguous remains implementation-mode so this
// classifier cannot silently suppress an ordinary coding request.

import {
  ALL_ACTION_VERBS,
  READ_ONLY_ACTION_VERBS,
} from "./action-protocol.js";

const MUTATION = "(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)";
const IMPERATIVE_MUTATION = [
  new RegExp(`^(?:please\\s+)?${MUTATION}\\b`, "i"),
  new RegExp(`\\b(?:please|can you|could you|would you|i want you to|go ahead and|now|let(?:'s| us))\\s+${MUTATION}\\b`, "i"),
  new RegExp(`\\b(?:and|then)\\s+(?:then\\s+)?${MUTATION}\\b`, "i"),
  // A build request often starts with reconnaissance ("Read the brief, create
  // index.html..."). An explicit deliverable must outrank incidental wording
  // such as "inspect" later in the same task.
  /\b(?:build|implement|create|write)\s+(?:an?\s+|the\s+)?(?:index\.html|file|page|website|implementation|feature|module)\b/i,
  /\b(?:make|apply|commit)\s+(?:the|these|those|some|any)?\s*(?:changes?|edits?|fix(?:es)?)\b/i,
  /\b(?:do it|go nuts|ship it)\b/i,
];

const ADVISORY = [
  /^\s*(?:what|why|how|is|are|should|could|can|do|does|where|when|which|who)\b/i,
  /^\s*(?:inspect|audit|examine|eyeball)\b/i,
  /\b(?:give|show|tell)\s+me\b.{0,100}\b(?:suggestions?|recommendations?|thoughts?|advice|assessment|analysis|overview|explanation)\b/i,
  /\b(?:identify|find)\b.{0,80}\b(?:issue|risk|concern|problem|weakness|opportunit(?:y|ies))\b/i,
  /\b(?:suggestions?|recommendations?|thoughts?|advice|assessment|analy[sz]e|explain|review|inspect|audit|examine|eyeball|take (?:a )?look|look (?:at|over|through))\b/i,
  /\b(?:highest|most)\s+[-\w ]{0,40}\b(?:value|impact|priority)\b/i,
];

// Advisory policy is derived from the canonical complete protocol, not a
// manually maintained list or merely the base schema. New verbs fail closed:
// only primitive reads plus the explicitly safe composite/answer/query verbs
// remain available. The agent intersects this complete runtime-deny list with
// each turn's enabled schema verbs before grammar construction, while retaining
// the full list for execution-time enforcement.
const ADVISORY_ALLOWED_ACTIONS = new Set([
  ...READ_ONLY_ACTION_VERBS,
  "inspect",
  "respond",
  "query",
]);
export const ADVISORY_EXCLUDED_ACTIONS = Object.freeze(
  ALL_ACTION_VERBS.filter((verb) => !ADVISORY_ALLOWED_ACTIONS.has(verb)),
);

export function classifyTaskIntent(task) {
  const text = String(task ?? "").trim();
  if (!text) throw new TypeError("task is required");
  if (/^(?:do not|don't)\b/i.test(text)) return "implementation";
  if (IMPERATIVE_MUTATION.some((pattern) => pattern.test(text))) return "implementation";
  if (ADVISORY.some((pattern) => pattern.test(text))) return "advisory";
  return "implementation";
}
