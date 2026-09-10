// Char-budgeted history windowing. The turn-count cap alone is unbounded in
// bytes: on a large repo each turn can carry a 100-line read observation, and
// the self-hosting v5 run reached a 69k-token prompt by turn 58 — deep into
// the range where a small model's action discipline degrades (its four
// grammar-invalid outputs arrived exactly there). The newest causal turn is
// always kept; older contiguous turns fit only while the hard budget permits.

import { clipText as clipObservation } from "./clip.js";
import { verificationWorkflowPromptText } from "./contract-audit-phase.js";
import { trustedReviewEvidenceEnd } from "./run-continuation.js";

export function latestTrustedReviewIndex(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (trustedReviewEvidenceEnd(turns[i]) !== null) return i;
  }
  return -1;
}

function pinnedIndices(list, { pinHead = false, pinLatestReview = true } = {}) {
  const pins = new Set(pinHead && list.length ? [0] : []);
  const review = pinLatestReview ? latestTrustedReviewIndex(list) : -1;
  if (review >= 0) pins.add(review);
  return pins;
}

function retainedIndices(length, start, pins) {
  return [...pins].filter(i => i < start).sort((a, b) => a - b)
    .concat(Array.from({ length: length - start }, (_, i) => start + i));
}

const SOURCE_HEADER = /(?:^|\n)(?:#\s+)?([A-Za-z0-9_.@+/-]+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql))\s+\((?:current,\s*)?(\d+)\s+lines(?:,\s*showing\s+(\d+)-(\d+))?\):?\n/gim;
// Prompt-only provenance: a budgeted view must not permanently erase the source
// needed to repair a pointer after the final renderer clips its target. This
// non-enumerable field is neither saved evidence nor an extra prompt block.
export const RAW_SOURCE_OBSERVATION = Symbol("bantam.rawSourceObservation");
const CLIPPED_LINE = /(?:\.\.\.|…)\s*\[[^\]\n]*(?:chars|characters)[^\]\n]*clipped[^\]\n]*\]/;

// Dependencies of a rendered source view, not new source evidence. Frozen
// fragments may retain these pointers after the history window evicts an
// origin, so the renderer must validate them before reusing those bytes.
export function sourcePointerOrigins(observation) {
  return new Set([...String(observation ?? "").matchAll(
    /\[source range [^\]\n]+:L\d+(?:-L\d+)? unchanged from turn (\d+); omitted\]/g,
  )].map((match) => Number(match[1])));
}

function historyView(turn, observation) {
  if (observation === turn.observation) return turn;
  const view = { ...turn, observation };
  const raw = turn[RAW_SOURCE_OBSERVATION] ?? turn.observation;
  SOURCE_HEADER.lastIndex = 0;
  const containsSource = SOURCE_HEADER.test(raw);
  SOURCE_HEADER.lastIndex = 0;
  if (containsSource) Object.defineProperty(view, RAW_SOURCE_OBSERVATION, { value: raw });
  return view;
}

// A fixed character budget cannot know the window the server actually serves.
// Compacting far below it wastes the window twice over: the unused remainder is
// never used, and every eviction rebases the prompt prefix, so the server
// re-prefills each surviving turn instead of reusing its slot cache. Derive the
// budget from the advertised window, keep real headroom for the non-history
// prompt and the response, and never exceed the size where a small model's
// action discipline degrades. An explicit operator override always wins, and an
// unknown window keeps the previously documented constants.
export const HISTORY_CHARS_PER_TOKEN = 4;
export const HISTORY_MAX_HISTORY_TOKENS = 44000;
export const HISTORY_MIN_CHAR_BUDGET = 4000;
const HISTORY_WINDOW_SHARE = { extension: 0.6, panel: 0.125 };

export function historyCharBudget({ contextTokens, extensionTrajectory = false, codexBacked = false, override } = {}) {
  const explicit = Number(override);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const context = Number(contextTokens);
  if (!Number.isInteger(context) || context <= 0) return extensionTrajectory ? 120000 : 36000;
  const share = HISTORY_WINDOW_SHARE[extensionTrajectory ? "extension" : "panel"];
  // The 44K ceiling is a local-worker discipline limit, not a frontier model's
  // context limit. A Codex worker uses its advertised window with the same
  // prompt/response headroom; unknown windows keep the conservative fallback.
  const tokens = codexBacked ? Math.floor(context * share)
    : Math.min(Math.floor(context * share), HISTORY_MAX_HISTORY_TOKENS);
  return Math.max(HISTORY_MIN_CHAR_BUDGET, tokens * HISTORY_CHARS_PER_TOKEN);
}

export function budgetTurns(turns, { charBudget = 36000, readObservationMaxChars = 4000, ...opts } = {}) {
  return selectBudgetWindow(turns, { charBudget, readObservationMaxChars, ...opts }).window;
}

function selectBudgetWindow(turns, { charBudget = 36000, readObservationMaxChars = 4000, ...opts } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) return { window: [], start: 0 };
  const limit = Math.max(0, Number.isFinite(Number(charBudget)) ? Math.floor(Number(charBudget)) : 36000);
  // Pick a window against fully-compacted sizes first, then recompact ONLY the
  // surviving window. Compaction pointers always name an EARLIER turn, so a
  // window compacted with fresh dedup maps cannot point outside itself — the
  // full-list compaction could, telling the model evidence "remains at turn N"
  // after the budget evicted turn N. Window sizes only grow versus the
  // full-list estimate (fewer dedup hits), so slide forward until it fits.
  const pins = pinnedIndices(list, opts);
  let start = firstKeptIndex(compactHistory(list), limit, { pins, readObservationMaxChars });
  for (;;) {
    const indices = retainedIndices(list.length, start, pins);
    const window = compactHistory(indices.map(i => list[i]));
    let total = 0;
    for (const turn of window) total += turnSize(turn, readObservationMaxChars);
    if (total <= limit || indices.every(i => pins.has(i) || i === list.length - 1)) {
      // Leading anchors belong to the window independently of its suffix. In
      // particular, a second build containing only anchors plus the newest
      // oversized turn must not move the suffix boundary back to the head.
      while (start < list.length - 1 && pins.has(start)) start++;
      return { window, start };
    }
    start += 1;
  }
}

// Extension-only hysteresis. Keep one retained boundary while new evidence
// fits; at hard overflow leave room for subsequent turns instead of sliding
// the prefix on every request. Views still use the existing pointer-safe
// compactor, and evidence objects are never changed. Rebuild callers retain
// budgetTurns' existing stateless behavior.
export function createHistoryWindow({ charBudget = 120000, pinHead = true,
  pinLatestReview = true, retainRatio = 2 / 3, onRebase = null, readObservationMaxChars = 4000 } = {}) {
  if (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio >= 1) {
    throw new Error("history retainRatio must be between zero and one");
  }
  let limit = Math.max(0, Number.isFinite(Number(charBudget)) ? Math.floor(Number(charBudget)) : 120000);
  let target = Math.floor(limit * retainRatio);
  let origin = null, cutoff = null, previousNewest = null, previousLength = 0;
  let previousChars = 0, previousKeyKind = null, lastOverflow = null;
  function historyWindow(turns) {
    const list = Array.isArray(turns) ? turns : [];
    if (!list.length) {
      origin = cutoff = previousNewest = previousKeyKind = lastOverflow = null;
      previousLength = previousChars = 0;
      return [];
    }
    const ids = list.map(turn => turn?.i);
    let realCount = 0;
    while (realCount < ids.length && Number.isSafeInteger(ids[realCount]) && ids[realCount] >= 0
        && (!realCount || ids[realCount] > ids[realCount - 1])) realCount++;
    // repairObs/WRAP_UP_NOTE are transient unnumbered trailing context, not a
    // different transcript or a new real turn. Their appearance/removal must
    // not reset the cutoff and reintroduce already-evicted history.
    const hasIds = realCount > 0 && ids.slice(realCount).every(id => id == null);
    const keyKind = hasIds ? "turn-id" : "position";
    const keys = hasIds ? ids.map((id, i) => i < realCount ? id : ids[realCount - 1] + i - realCount + 1)
      : list.map((_, i) => i);
    const first = list[0];
    const identity = JSON.stringify([keyKind, first?.i ?? null, first?.rawOutput ?? null,
      first?.parsedAction ?? first?.action ?? null, first?.observation ?? null]);
    const newest = hasIds ? ids[realCount - 1] : keys.at(-1), oldCutoff = cutoff;
    const realLength = hasIds ? realCount : list.length;
    const reset = origin !== null && (identity !== origin || keyKind !== previousKeyKind)
      ? "origin-changed" : origin !== null && (newest < previousNewest || realLength < previousLength)
        ? "rewind" : null;
    if (reset) { cutoff = null; lastOverflow = null; }
    origin = identity;
    let start = cutoff === null ? 0 : keys.findIndex(key => key >= cutoff);
    if (start < 0) start = list.length - 1;
    const pins = pinnedIndices(list, { pinHead, pinLatestReview });
    const selectedIndices = retainedIndices(list.length, start, pins);
    const retained = selectedIndices.map(i => list[i]);
    let window = compactHistory(retained);
    const beforeChars = window.reduce((total, turn) => total + turnSize(turn, readObservationMaxChars), 0);
    let afterChars = beforeChars, overflow = false;
    if (beforeChars > limit) {
      overflow = true;
      const selected = selectBudgetWindow(retained, { charBudget: target, pinHead, pinLatestReview, readObservationMaxChars });
      window = selected.window;
      // Keep the contiguous suffix boundary separate from mandatory anchors.
      // A review can be anywhere in the old history; counting it as tail would
      // resurrect evicted turns or move the cutoff backwards on every request.
      start = selectedIndices[selected.start];
      if (hasIds && realCount < list.length && start >= realCount) {
        // Keep the latest actual causal turn as well as its transient steer.
        // The cutoff always names real evidence, never a synthetic position
        // that could later be reused by the next worker turn.
        start = realCount - 1;
        window = compactHistory(retainedIndices(list.length, start, pins).map(i => list[i]));
      }
      cutoff = keys[start];
      afterChars = window.reduce((total, turn) => total + turnSize(turn, readObservationMaxChars), 0);
    }
    const signature = overflow ? `${newest}:${cutoff}:${afterChars}` : null;
    if (typeof onRebase === "function" && (reset || (overflow && signature !== lastOverflow))) {
      onRebase({ reason: reset ?? "overflow", overflow, keyKind,
        cutoffBefore: oldCutoff, cutoffAfter: cutoff,
        hardCharBudget: limit, targetCharBudget: target, beforeChars, afterChars,
        previousChars, retainedTurns: window.length, newest,
        // The pinned origin/newest causal turn are mandatory, as in budgetTurns.
        oversizedRequiredTurns: afterChars > limit });
    }
    previousNewest = newest; previousLength = realLength;
    previousKeyKind = keyKind; previousChars = afterChars;
    lastOverflow = signature;
    return window;
  }
  historyWindow.setBudget = next => {
    if (!Number.isSafeInteger(next) || next <= 0) throw new Error('history budget must be a positive integer');
    limit = next;
    target = Math.floor(limit * retainRatio);
    // Keep the retained boundary. Learning more capacity must not resurrect
    // previously evicted turns and rewrite an otherwise unchanged prefix.
  };
  return historyWindow;
}

function firstKeptIndex(compacted, limit, { pins = new Set(), readObservationMaxChars = 4000 } = {}) {
  // pinHead: never evict turn 0. The first turn is the task's own grounding (the
  // spec read, the repo map) and the least droppable bytes in the run; evicting
  // it both blinds the model and rewrites the prompt right after the system
  // block, which resets the slot cache to the head checkpoint. Price it first so
  // the window behind it is budgeted against what is left.
  let total = [...pins].reduce((size, i) => size + turnSize(compacted[i], readObservationMaxChars), 0);
  for (let i = compacted.length - 1; i >= 0; i -= 1) {
    if (pins.has(i)) continue;
    const size = turnSize(compacted[i], readObservationMaxChars);
    // Always retain the newest causal turn, even under a nonsensical zero-byte
    // setting. Beyond that, the configured budget is hard: a six-turn floor
    // formerly allowed six large edit bodies to blow straight past it.
    if (i < compacted.length - 1 && total + size > limit) return i + 1;
    total += size;
  }
  return 0;
}

// Prompt history is a view over evidence, not the evidence store itself. An
// entire byte-identical observation is safe to replace with a pointer; an
// identical line in a DIFFERENT observation is not (two files can share an
// import or two commands can share an error line with different provenance).
// The raw artifact/journal remains untouched.
export function compactHistory(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const firstSeen = new Map();
  const sourceLines = new Map();
  const shellMetadata = new Map();
  // The set of turn numbers actually present in THIS call's list -- i.e. the
  // window. budgetTurns (round 1, Task 3) recompacts only the surviving
  // window via compactHistory(list.slice(start)), so any pointer this
  // function generates from an in-list map (firstSeen, sourceLines,
  // shellMetadata below) can never point outside it. The repetition branch
  // below is the one exception: its "turn M" is lifted from TEXT that
  // src/repetition.js wrote live, at execution time, long before this
  // compaction pass -- so M is not guaranteed to be a member of this list.
  const windowTurnNumbers = new Set(
    list.map((turn, index) => (turn && typeof turn === "object" && Number.isInteger(turn.i) ? turn.i + 1 : index + 1)),
  );
  // The NEWEST duplicate notice keeps its full text; older ones compact to a
  // pointer. The compacted form preserves the fact ("not executed, result is at
  // turn N") but discards the actionable half RepetitionGuard wrote — "reading
  // it again cannot reveal anything new … do something different: a different
  // line range, a different search, or a `map` query". This pass runs on EVERY
  // prompt build, not only under budget pressure, so a model that just tripped
  // the guard never saw its correction. Ticket B (2026-08-16): 27 read_file
  // actions, repeated dedup hits, and the steer compacted away each time.
  // Only the newest survives, and only while its origin turn is still in the
  // window — otherwise "remains at turn N" would be false.
  let newestRepetition = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const observation = list[i]?.observation;
    if (typeof observation === "string" && observation.startsWith("[repetition] Deduplicated")) {
      const prior = /already ran (?:this exact|every op in this) (?:action|shell command) on turn (\d+)/i.exec(observation)?.[1];
      if (prior && windowTurnNumbers.has(Number(prior))) newestRepetition = i;
      break;
    }
  }
  return list.map((turn, index) => {
    if (index === newestRepetition) return turn;
    if (!turn || typeof turn !== "object" || typeof turn.observation !== "string") return turn;
    // Operator feedback is a resumable input. Do not replace quoted source or
    // an identical review with a pointer to an older, evictable observation.
    if (trustedReviewEvidenceEnd(turn) !== null) return turn;
    const turnNumber = Number.isInteger(turn.i) ? turn.i + 1 : index + 1;
    let observation = turn.observation;
    // Older artifacts predate RepetitionGuard's compact-pointer contract and
    // embedded the full prior read/test output after this header. The action
    // was explicitly not executed, so none of those copied bytes are a new
    // observation. Keep the causal fact and its provenance turn only.
    if (observation.startsWith("[repetition] Deduplicated")) {
      const prior = /already ran (?:this exact|every op in this) (?:action|shell command) on turn (\d+)/i.exec(observation)?.[1];
      if (prior && !windowTurnNumbers.has(Number(prior))) {
        // The origin turn has been evicted from this window by budgetTurns.
        // "Remains at turn N" would now be false (CLAUDE.md principle 2: say
        // only true things) -- the duplicate genuinely was not executed, but
        // its evidence is no longer anywhere in this prompt. State that
        // truthfully and hand the model its correction.
        return {
          ...turn,
          observation: `[turn ${turnNumber}: duplicate action not executed at the time; the original result `
            + `from turn ${prior} has since left this window. Re-run the action if the result is needed now.]`,
        };
      }
      return {
        ...turn,
        observation: prior
          ? `[turn ${turnNumber}: duplicate action not executed; unchanged result remains at turn ${prior}]`
          : `[turn ${turnNumber}: duplicate action not executed; unchanged prior result remains in history]`,
      };
    }
    observation = compactSourceRanges(observation, sourceLines, turnNumber);
    observation = compactShellMetadata(observation, shellMetadata, turnNumber);
    const origin = firstSeen.get(observation);
    if (origin !== undefined) {
      return historyView(turn, `[history compacted at turn ${turnNumber}: exact observation remains at turn ${origin}]`);
    }
    firstSeen.set(observation, turnNumber);
    // Budget estimation uses the ordinary observation cap. The prompt renderer
    // repeats this accounting against its exact delivered (possibly annotated,
    // scrubbed or frozen) view before emitting any source pointer.
    recordDeliveredSourceLines(clipObservation(observation), sourceLines, turnNumber);
    return historyView(turn, observation);
  });
}

// Executor shell observations repeat stable transport metadata on every call.
// Keep it once and point back to its provenance; command/output/exit evidence is
// never touched, so two commands producing the same failure remain visible.
function compactShellMetadata(observation, priorLines, turnNumber) {
  const text = String(observation ?? "");
  if (!text.startsWith("$ ")) return text;
  const lines = text.split("\n");
  const kept = [];
  const omitted = [];
  let insertion = null;
  for (const line of lines) {
    const label = /^(cwd|sandbox|model):\s/.exec(line)?.[1];
    if (!label) {
      kept.push(line);
      continue;
    }
    const prior = priorLines.get(line);
    if (prior !== undefined) {
      if (insertion === null) insertion = kept.length;
      omitted.push(`${label}@turn ${prior}`);
      continue;
    }
    priorLines.set(line, turnNumber);
    kept.push(line);
  }
  if (!omitted.length) return text;
  kept.splice(insertion, 0, `[shell metadata unchanged: ${omitted.join(", ")}]`);
  return kept.join("\n");
}

// Compact only provenance-equivalent source lines: same normalized path, same
// numbered line, and same bytes. A mutation between reads does not invalidate
// an identical line—the later executed read is itself proof that those bytes
// survived. Distinct files that share an import remain untouched. Partially
// overlapping reads keep every new line and point at each covered range.
export function compactSourceRanges(observation, sourceLines, turnNumber) {
  const text = String(observation ?? "");
  const matches = [...text.matchAll(SOURCE_HEADER)];
  SOURCE_HEADER.lastIndex = 0;
  if (!matches.length) return text;

  let output = "";
  let cursor = 0;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const headerStart = match.index;
    const bodyStart = headerStart + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? text.length;
    output += text.slice(cursor, bodyStart);
    const path = normalizeSourcePath(match[1]);
    const known = sourceLines.get(path) ?? new Map();
    const lines = text.slice(bodyStart, bodyEnd).match(/[^\n]*(?:\n|$)/g) ?? [];
    let duplicate = null;

    const flushDuplicate = () => {
      if (!duplicate) return;
      const range = duplicate.start === duplicate.end
        ? `L${duplicate.start}`
        : `L${duplicate.start}-L${duplicate.end}`;
      output += `[source range ${path}:${range} unchanged from turn ${duplicate.origin}; omitted]\n`;
      duplicate = null;
    };

    for (const line of lines) {
      const numbered = /^(\d+)\t(.*?)(\n?)$/.exec(line);
      if (!numbered) {
        flushDuplicate();
        output += line;
        continue;
      }
      const lineNumber = Number(numbered[1]);
      const value = numbered[2];
      const prior = known.get(lineNumber);
      if (prior?.value === value) {
        if (duplicate && duplicate.end + 1 === lineNumber && duplicate.origin === prior.turn) {
          duplicate.end = lineNumber;
        } else {
          flushDuplicate();
          duplicate = { start: lineNumber, end: lineNumber, origin: prior.turn };
        }
      } else {
        flushDuplicate();
        output += line;
      }
    }
    flushDuplicate();
    cursor = bodyEnd;
  }
  output += text.slice(cursor);
  return output;
}

// Only literal, complete source lines in the delivered observation can become
// pointer targets. A clipping gap may cross a file header: after a gap, discard
// numbered tail lines until another complete header establishes their owner.
// Likewise the line immediately before a gap may have been cut mid-byte. Source
// pointers themselves never establish a new origin (no pointer-to-pointer).
export function recordDeliveredSourceLines(observation, sourceLines, turnNumber) {
  const text = String(observation ?? "");
  const matches = [...text.matchAll(SOURCE_HEADER)];
  SOURCE_HEADER.lastIndex = 0;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index], sourcePath = normalizeSourcePath(match[1]);
    const from = Number(match[3] ?? 1), to = Number(match[4] ?? match[2]);
    const lines = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).split("\n");
    const known = sourceLines.get(sourcePath) ?? new Map();
    for (let at = 0; at < lines.length; at++) {
      if (CLIPPED_LINE.test(lines[at])) break;
      if (at + 1 >= lines.length || CLIPPED_LINE.test(lines[at + 1])) continue;
      const numbered = /^(\d+)\t(.*)$/.exec(lines[at]);
      if (!numbered) continue;
      const number = Number(numbered[1]);
      if (number < from || number > to) continue;
      const value = numbered[2], prior = known.get(number);
      if (prior?.value !== value) known.set(number, { value, turn: turnNumber });
    }
    sourceLines.set(sourcePath, known);
  }
}

function normalizeSourcePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/app\//, "");
}

function turnSize(turn, readObservationMaxChars = 4000) {
  if (!turn || typeof turn !== "object") return 0;
  // Use the same bounded validator/formatter as prompt.js: malformed or
  // oversized state renders nothing, and never requires serializing unchecked
  // metadata here. Valid current-state blocks are outside OBS_MAX, not budget.
  const workflow = verificationWorkflowPromptText(turn.verificationWorkflow);
  // buildPrompt replays the parsed action and bounded source/command views;
  // raw model output and private reasoning are evidence-only fields. Price the
  // intermediate replay view, not arbitrary raw artifact fields. This is not
  // an exact bound on final prompt bytes: annotation-aware/frozen rendering may
  // restore a source range whose apparent origin was clipped. That rescue
  // remains inside the configured final observation cap; system/context blocks and
  // previously frozen fragments are also accounted separately by the caller.
  const action = turn.action ?? turn.parsedAction ?? null;
  const reviewEnd = trustedReviewEvidenceEnd(turn);
  const observationChars = reviewEnd !== null
    ? reviewEnd + clipObservation(turn.observation.slice(reviewEnd), 4000).length
    : clipObservation(turn.observation, action?.a === "read_file" || action?.a === "inspect"
      ? Math.max(4000, Math.min(24000, Number(readObservationMaxChars) || 4000)) : 4000).length;
  return (action ? JSON.stringify(action).length : 0)
    + observationChars
    + (typeof turn.promptPrelude === "string" && turn.promptPrelude ? clipObservation(turn.promptPrelude).length + 96 : 0)
    + (Array.isArray(turn.promptAttempts) ? turn.promptAttempts.reduce((size, attempt) => size
      + (typeof attempt?.rawOutput === "string" && typeof attempt?.observation === "string"
        ? attempt.rawOutput.length + clipObservation(attempt.observation).length + 128 : 0), 0) : 0)
    // Trusted context is outside observation clipping, not outside the history
    // budget. Metadata pricing is conservative relative to its prompt wrapper.
    + (Array.isArray(turn.contextUpdates) ? JSON.stringify(turn.contextUpdates).length + 300 : 0)
    // Collection advice is delivered whole after observation clipping. Charge
    // its full render cap conservatively, including its separate chat wrapper.
    + (turn.contractStateAudit?.focus === "collection-preconditions" && turn.contractStateAudit.status === "report" ? 8100 : 0)
    + (turn.contractAssertion?.schema === "bantam.contract-assertion.v1" ? 4300 : 0)
    + (workflow ? workflow.length + 96 : 0)
    + 96; // ChatML/observation wrapper overhead.
}
