// Two probe-hygiene steers from the 7R film synthesis.
//
// importDontRetype: bantam-r1 spent ~20 turns re-SIMULATING its generator in
// python -c payloads that re-typed the algorithm — evidence about the
// retyped copy, not the workspace. When an inline payload defines functions
// and the run has been editing source files, steer: import the real module.
//
// greenfieldBuildShape: every fast maze lane shared one opening — author the
// complete implementation in ONE write, the complete suite in ONE write,
// one representation shared end to end (the suite imports the
// implementation's own constants), verify when the seam is complete.
const INLINE_EXEC_RE = /\b(?:python3?\s+-c|node\s+(?:-e|--eval))\b/;

export function importDontRetypeSteer(command, { editedSourceFiles = 0, priorSteers = 0 } = {}) {
  if (priorSteers >= 2) return null;
  const c = String(command ?? "");
  if (!INLINE_EXEC_RE.test(c)) return null;
  if (!/\bdef\s+\w+|\bfunction\s+\w+/.test(c)) return null;
  if (!editedSourceFiles) return null;
  return "[probe-discipline] This probe re-TYPES definitions inline instead of importing the module you have "
    + "been editing. A retyped copy is evidence about the copy, not the workspace — the two diverge from the "
    + "first edit. Import the real module (e.g. `python -c \"import mod; ...\"`) so the probe tests the bytes "
    + "that the suite will judge.";
}

export function greenfieldBuildShapeNote(task, workspaceFiles = []) {
  const t = String(task ?? "");
  const m = t.match(/\bwrite\s+([A-Za-z_][\w.-]*\.(?:py|js|mjs|ts))\b/i);
  if (!m) return null;
  if (workspaceFiles.some((f) => String(f).endsWith(m[1]))) return null;
  return "[build-shape] Greenfield build. The measured winning shape: orient at most once, then author the "
    + "COMPLETE implementation file in ONE write, then the COMPLETE test suite in ONE write. Choose the data "
    + "representation once and share it end to end — have the suite import the implementation's own "
    + "constants/structures so subject and oracle cannot silently diverge. Verify with the full suite only "
    + "when the seam is complete; repair surgically from the verdict; re-verify. Fragment turns pay full "
    + "context cost and buy nothing.";
}

// Card 1 (Quiet Line) F2: the corner probed astral content via
// decode(encode(...)) — and round-trip identity is a TAUTOLOGY for encoder
// bugs, since an unescaped run decodes back verbatim. The probe printed
// green over a broken codec and the lane sealed MISS. When an inline probe
// composes a function with its inverse, say so.
const INVERSE_PAIRS = [
  [/\bdecode\s*\(\s*encode\s*\(/, "decode(encode(...))"],
  [/\bencode\s*\(\s*decode\s*\(/, "encode(decode(...))"],
  [/\bparse\s*\(\s*(?:serialize|stringify)\s*\(/, "parse(serialize(...))"],
  [/\b(?:serialize|stringify)\s*\(\s*parse\s*\(/, "serialize(parse(...))"],
];
export function selfInverseProbeSteer(command, { priorSteers = 0 } = {}) {
  if (priorSteers >= 1) return null;
  const c = String(command ?? "");
  if (!/\b(?:python3?\s+-c|node\s+(?:-e|--eval))\b/.test(c)) return null;
  const hit = INVERSE_PAIRS.find(([re]) => re.test(c));
  if (!hit) return null;
  return `[probe-discipline] ${hit[1]} is a TAUTOLOGY as a gauge: a broken encoder usually round-trips its own `
    + `output perfectly, so this probe can print green over the exact bug you are hunting. Assert the encoded form `
    + `itself against an expected literal you derive by hand from the contract's grammar — one worked case per `
    + `pinned clause beats any number of round-trips.`;
}

// Card 23 (Quiet Line): 2 of 6 bantam misses were ONE family — the contract
// pinned "code points", the implementation indexed s[i] UTF-16 units, astral
// runs split — and the would-fire ledger proved no armed steer covered it.
// When the task text pins code-point semantics and a written source file
// indexes code units, say so once.
const CODE_POINT_TASK_RE = /code ?points?|astral|surrogate|emoji/i;
const CODE_UNIT_RE = /\.charAt\(|\.charCodeAt\(|\bs\[[a-z]\]|\[i\s*\+\s*n\]/;
const CODE_POINT_OK_RE = /\[\.\.\.|codePointAt|fromCodePoint|Intl\.Segmenter|for\s*\(\s*const\s+\w+\s+of\s/;
export function unicodeUnitGauge(task, writtenContent, { priorSteers = 0 } = {}) {
  if (priorSteers >= 1) return null;
  if (!CODE_POINT_TASK_RE.test(String(task ?? ""))) return null;
  const c = String(writtenContent ?? "");
  if (!CODE_UNIT_RE.test(c)) return null;
  if (CODE_POINT_OK_RE.test(c)) return null;
  return "[probe-discipline] The contract pins CODE POINTS, but this code indexes UTF-16 code units "
    + "(s[i]/charAt/charCodeAt) — an astral character is TWO units and will split. Iterate with [...s] or "
    + "for..of (both walk code points), or use codePointAt; then assert one astral case byte-exact.";
}

// Card 4 (tableburn) T1: bantam computed the CRC table correctly in probes,
// then hand-TRANSCRIBED literals into the file — entry 1 landed as 0x2042
// where 0x1021 belonged, costing two rewrite cycles. Transcription is the
// write-side twin of retyping: when the task pins a generating formula and a
// write emits a long literal numeric table, say so.
const FORMULA_CONTEXT_RE = /formula|polynomial|generated|derive[sd]? from|regenerat/i;
const HEX_LITERAL_RE = /0x[0-9A-Fa-f]{2,8}\b/g;
export function shipTheGeneratorSteer(task, writtenContent, { priorSteers = 0, minLiterals = 48 } = {}) {
  if (priorSteers >= 1) return null;
  if (!FORMULA_CONTEXT_RE.test(String(task ?? ""))) return null;
  const c = String(writtenContent ?? "");
  const literals = (c.match(HEX_LITERAL_RE) ?? []).length + (c.match(/(?<![\w.])\d{3,5}(?=\s*,)/g) ?? []).length;
  if (literals < minLiterals) return null;
  if (/for\s*\(|while\s*\(/.test(c) && /<<|\^|%|\*/.test(c)) return null; // a computing loop is present
  return "[probe-discipline] This write TRANSCRIBES a long literal table whose values the task says come from a "
    + "formula. Transcription re-introduces exactly the corruption class you are fixing — one slipped digit and "
    + "the table is wrong again. Ship the COMPUTATION instead: write the small generator implementing the "
    + "documented formula and build the table at load (or emit the file FROM a script you run), then verify.";
}

// The enumerate-the-contract note (27B sweep, 2026-08-26: three films in one
// night). rowquery's header EXPLICITLY listed `>= <= != > < =`; two fast
// draws implemented the memorable subset and their self-suites skipped the
// same entries (sealed holdout: "!= and <= operators"). slugline's trailing-
// separator rule met the same fate. The failure is not misreading — it is
// sampling an enumerable list instead of walking it. Fires once, at turn 0,
// only when the task hands over an explicit contract to honor.
export const CONTRACT_TASK_RE = /full contract|every clause|honou?r every|header comment .{0,40}contract|spec (?:pins|is the (?:full )?contract)|exact grammar|documented (?:rules|operators|format|contract)|contract exactly/i;

export function enumerateContractNote(task) {
  if (!CONTRACT_TASK_RE.test(String(task ?? ""))) return null;
  // v2 (A/B verdict, 2026-08-26): v1 asked for checklist coverage in "code
  // and tests" and moved only the code — both note-fired misses implemented
  // every operator and tested none of the rare ones, so an upstream
  // tokenization bug (greedy \S+ backtracking splitting "city!=Oslo" at "=")
  // sailed through. TESTS-FIRST is the enforcement: an untested item is an
  // unwalked item, and only the oracle can catch a subtle mis-parse.
  return "[enumerate-the-contract] This task hands you an explicit contract (a spec, header comment, or rule "
    + "list), and contracts ENUMERATE: operators, separators, error cases, format rules. Do this IN ORDER: "
    + "(1) read the contract and write out every listed item; (2) write your TEST FILE FIRST with at least one "
    + "case per item — every operator, every rule, every error case, including the unglamorous ones (`!=`, `<=`, "
    + "a trailing separator, an empty input); (3) only then implement, and run the suite. A checklist that only "
    + "reaches the implementation proves nothing — a subtle parsing bug passes every case you didn't test. "
    + "Before `done`: one test per contract item, all green.";
}
