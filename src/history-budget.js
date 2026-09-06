// Char-budgeted history windowing. The turn-count cap alone is unbounded in
// bytes: on a large repo each turn can carry a 100-line read observation, and
// the self-hosting v5 run reached a 69k-token prompt by turn 58 — deep into
// the range where a small model's action discipline degrades (its four
// grammar-invalid outputs arrived exactly there). The newest causal turn is
// always kept; older contiguous turns fit only while the hard budget permits.

import { clipText as clipObservation } from "./clip.js";

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

export function budgetTurns(turns, { charBudget = 36000, ...opts } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) return [];
  const limit = Math.max(0, Number.isFinite(Number(charBudget)) ? Math.floor(Number(charBudget)) : 36000);
  // Pick a window against fully-compacted sizes first, then recompact ONLY the
  // surviving window. Compaction pointers always name an EARLIER turn, so a
  // window compacted with fresh dedup maps cannot point outside itself — the
  // full-list compaction could, telling the model evidence "remains at turn N"
  // after the budget evicted turn N. Window sizes only grow versus the
  // full-list estimate (fewer dedup hits), so slide forward until it fits.
  const pinHead = Boolean(opts.pinHead);
  let start = firstKeptIndex(compactHistory(list), limit, { pinHead });
  for (;;) {
    const body = list.slice(start);
    const window = compactHistory(pinHead && start > 0 ? [list[0], ...body] : body);
    let total = 0;
    for (const turn of window) total += turnSize(turn);
    if (total <= limit || window.length <= (pinHead ? 2 : 1)) return window;
    start += 1;
  }
}

function firstKeptIndex(compacted, limit, { pinHead = false } = {}) {
  // pinHead: never evict turn 0. The first turn is the task's own grounding (the
  // spec read, the repo map) and the least droppable bytes in the run; evicting
  // it both blinds the model and rewrites the prompt right after the system
  // block, which resets the slot cache to the head checkpoint. Price it first so
  // the window behind it is budgeted against what is left.
  let total = pinHead && compacted.length > 1 ? turnSize(compacted[0]) : 0;
  const floor = pinHead && compacted.length > 1 ? 1 : 0;
  for (let i = compacted.length - 1; i >= floor; i -= 1) {
    const size = turnSize(compacted[i]);
    // Always retain the newest causal turn, even under a nonsensical zero-byte
    // setting. Beyond that, the configured budget is hard: a six-turn floor
    // formerly allowed six large edit bodies to blow straight past it.
    if (i < compacted.length - 1 && total + size > limit) return i + 1;
    total += size;
  }
  return floor;
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

function turnSize(turn) {
  if (!turn || typeof turn !== "object") return 0;
  // buildPrompt replays the parsed action and clips each observation to 4K;
  // raw model output and private reasoning are evidence-only fields. Price the
  // intermediate replay view, not arbitrary raw artifact fields. This is not
  // an exact bound on final prompt bytes: annotation-aware/frozen rendering may
  // restore a source range whose apparent origin was clipped. That rescue
  // remains inside the same final 4K observation cap; system/context blocks and
  // previously frozen fragments are also accounted separately by the caller.
  const action = turn.action ?? turn.parsedAction ?? null;
  return (action ? JSON.stringify(action).length : 0)
    + clipObservation(turn.observation).length
    // Trusted context is outside observation clipping, not outside the history
    // budget. Metadata pricing is conservative relative to its prompt wrapper.
    + (Array.isArray(turn.contextUpdates) ? JSON.stringify(turn.contextUpdates).length + 300 : 0)
    // Collection advice is delivered whole after observation clipping. Charge
    // its full render cap conservatively, including its separate chat wrapper.
    + (turn.contractStateAudit?.focus === "collection-preconditions" && turn.contractStateAudit.status === "report" ? 8100 : 0)
    + (turn.contractAssertion?.schema === "bantam.contract-assertion.v1" ? 4300 : 0)
    + 96; // ChatML/observation wrapper overhead.
}
