// Char-budgeted history windowing. The turn-count cap alone is unbounded in
// bytes: on a large repo each turn can carry a 100-line read observation, and
// the self-hosting v5 run reached a 69k-token prompt by turn 58 — deep into
// the range where a small model's action discipline degrades (its four
// grammar-invalid outputs arrived exactly there). The newest causal turn is
// always kept; older contiguous turns fit only while the hard budget permits.

import { clipText as clipObservation } from "./clip.js";

const SOURCE_HEADER = /(?:^|\n)(?:#\s+)?([A-Za-z0-9_.@+/-]+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql))\s+\((?:current,\s*)?(\d+)\s+lines(?:,\s*showing\s+(\d+)-(\d+))?\):?\n/gim;

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
      return {
        ...turn,
        observation: `[history compacted at turn ${turnNumber}: exact observation remains at turn ${origin}]`,
      };
    }
    firstSeen.set(observation, turnNumber);
    return observation === turn.observation ? turn : { ...turn, observation };
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
function compactSourceRanges(observation, sourceLines, turnNumber) {
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
    const additions = [];
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
      additions.push([lineNumber, { value, turn: prior?.value === value ? prior.turn : turnNumber }]);
    }
    flushDuplicate();
    for (const [lineNumber, value] of additions) known.set(lineNumber, value);
    sourceLines.set(path, known);
    cursor = bodyEnd;
  }
  output += text.slice(cursor);
  return output;
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
  // same representation instead of over/under-counting whichever artifact
  // generation happened to supply.
  const action = turn.action ?? turn.parsedAction ?? null;
  return (action ? JSON.stringify(action).length : 0)
    + clipObservation(turn.observation).length
    + 96; // ChatML/observation wrapper overhead.
}
