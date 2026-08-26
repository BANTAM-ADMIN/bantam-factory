// Self-diagnosis: witness a bad turn, rewind it, test a context remedy, keep
// the score. The manual loop that produced thirty harness fixes on 2026-07-13/14,
// mechanized — see docs/PRINCIPLES.md.
//
// The principle: when BANTAM makes a bad choice, the cause is almost always the
// context. So the unit of investigation is not "the run" but "the turn", and
// the unit of repair is not "a better model" but "a truer context".

import { ALL_ACTION_VERBS } from "./action-protocol.js";

// ---------------------------------------------------------------------------
// 1. WITNESS — the harness's own distress signals, read back out of a trajectory
// ---------------------------------------------------------------------------

const SIGNALS = [
  {
    kind: "redundant-read",
    test: (obs) => /\[open_files\] Not re-read/.test(obs),
    why: "asked for a file whose current contents were already in the prompt",
  },
  {
    kind: "duplicate-action",
    test: (obs) => /\[repetition\] Deduplicated/.test(obs),
    why: "repeated an action that could not tell it anything new",
  },
  {
    kind: "phantom-replace",
    test: (obs) => /"old" text not found/.test(obs),
    why: "edited against remembered text that no longer matches the file",
  },
  {
    kind: "broken-edit",
    test: (obs) => /\[pre-gate\].*syntax error/.test(obs),
    why: "wrote code that does not parse",
  },
  {
    kind: "fabricated-api",
    test: (obs) => /\[api-check\]/.test(obs),
    why: "called an API that does not exist in the target module",
  },
  {
    kind: "corrupted-oracle",
    test: (obs) => /\[pipe-guard\]|run test commands directly/.test(obs),
    why: "filtered its own test output, hiding the verdict",
  },
  {
    kind: "false-regression",
    test: (obs) => /\[flaky-suite\]/.test(obs),
    why: "was told it regressed when the suite was merely flaky",
  },
  {
    kind: "regression",
    test: (obs) => /\[reverted\]/.test(obs),
    why: "an edit broke working code and was rolled back",
  },
  {
    kind: "paging",
    test: (obs) => /\[paging\]/.test(obs),
    why: "scrolled a large file instead of searching it",
  },
  {
    kind: "failed-action",
    test: (obs) => /^ERROR/m.test(obs),
    why: "the action itself errored",
  },
];

/** Every turn whose observation carries a distress signal, newest last. */
export function witnessProblems(artifact) {
  const turns = artifact?.turns ?? [];
  const problems = [];
  for (const turn of turns) {
    const obs = String(turn.observation ?? "");
    if (!obs) continue;
    for (const signal of SIGNALS) {
      if (signal.test(obs)) {
        problems.push({
          turn: turn.i,
          kind: signal.kind,
          why: signal.why,
          action: turn.parsedAction ?? null,
          replayable: typeof turn.prompt === "string" && turn.prompt.length > 0,
          evidence: obs.slice(0, 200),
        });
        break;   // one classification per turn: the first (most specific) wins
      }
    }
  }
  return problems;
}

/** Which problem kinds dominate this run, and how often each action fails. */
export function summarizeProblems(artifact) {
  const problems = witnessProblems(artifact);
  const turns = artifact?.turns ?? [];
  const byKind = new Map();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);

  const attempts = new Map();   // action verb -> { total, bad }
  const badTurns = new Set(problems.map((p) => p.turn));
  for (const turn of turns) {
    const verb = turn.parsedAction?.a;
    if (!verb) continue;
    const row = attempts.get(verb) ?? { total: 0, bad: 0 };
    row.total += 1;
    if (badTurns.has(turn.i)) row.bad += 1;
    attempts.set(verb, row);
  }
  const actionFailureRate = [...attempts.entries()]
    .map(([verb, row]) => ({ verb, total: row.total, bad: row.bad, rate: row.total ? row.bad / row.total : 0 }))
    .sort((a, b) => b.bad - a.bad);

  return {
    turns: turns.length,
    problemTurns: problems.length,
    problemRate: turns.length ? problems.length / turns.length : 0,
    byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    actionFailureRate,
    replayable: problems.filter((p) => p.replayable).length,
  };
}

// ---------------------------------------------------------------------------
// 2. REMEDIES — candidate context adjustments, per problem kind
// ---------------------------------------------------------------------------

export const CONTEXT_REMEDIES = {
  "redundant-read": [
    'The CURRENT contents of that file are already in <open_files> above, refreshed from disk this turn. Reading it again returns exactly what you can already see. Use that text — copy exact strings from it for a replace — or act.',
    'STOP re-reading files you already have. Your next action must not be a read of a file shown in <open_files>: either edit, run the verification, or answer.',
  ],
  "duplicate-action": [
    'You already ran this exact action and nothing has changed since. Repeating it cannot tell you anything new. Do something different: a DIFFERENT range, a search for the identifier, an edit, or the verification command.',
  ],
  "phantom-replace": [
    'Your "old" text does not match the file. Do not retype it from memory: copy the exact current text out of <open_files> above, or replace a shorter span that you can see verbatim.',
  ],
  paging: [
    'Paging a large file to find one symbol is the slowest option you have. Use the "search" action for the exact identifier (it answers with file:line), or a "query" for the file\'s symbols, then read only that range.',
    'STOP paging this file. Your next action must be a "search" for the identifier you need, not another read.',
  ],
  "fabricated-api": [
    'That import/method does not exist in the target module. Read the module\'s real exports before calling into it, and write only calls you have SEEN in its source.',
  ],
  "corrupted-oracle": [
    'Never filter test output. Run the test command bare: a filter hides the pass/fail verdict (grep exits 1 with no output when nothing matches, so a passing suite looks like a failure).',
  ],
  "false-regression": [
    'The suite is flaky: the previous run of the SAME files reported a higher pass count and you have made no edit since. That drop is not yours. Do not chase it — continue the task.',
  ],
  regression: [
    'Those edits broke working code and were rolled back. Do not repeat that change. Diagnose the failing test first: read its source, then make a DIFFERENT, smaller fix.',
  ],
  "broken-edit": [
    'Your edit does not parse. Read the exact lines around the error in <open_files>, then re-issue a replace whose "old" text you can see verbatim.',
  ],
  "failed-action": [
    'That action failed. Read the error text literally and change what it names — do not re-issue the same action.',
  ],
};

// ---------------------------------------------------------------------------
// 3. SCORE — did the remedy move the model from spinning to working?
// ---------------------------------------------------------------------------

// Recon = the protocol's read-only verbs. action-protocol.js's own
// READ_ONLY_ACTION_VERBS only tags {read_file, list_dir, search} — it omits
// "inspect" and "query", which is correct for its grammar purpose but would
// silently reclassify those two verbs here — so RECON stays an explicit
// literal matching this module's existing intent. PRODUCTIVE is derived from
// the full verb table so a new verb cannot silently classify as "invalid"
// (edit_lines did exactly that: promoted to the protocol, never added here,
// scored as a malformed output by every diagnose A/B).
const RECON = new Set(["read_file", "inspect", "list_dir", "search", "query"]);
const PRODUCTIVE = new Set(ALL_ACTION_VERBS.filter((verb) => !RECON.has(verb)));

/** recon | productive | invalid — the coarse classes that decide whether a run advances. */
export function classifyAction(raw) {
  const text = String(raw ?? "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return "invalid";
  let action;
  try {
    action = JSON.parse(match[0]);
  } catch {
    return "invalid";
  }
  const verb = action?.a;
  if (RECON.has(verb)) return "recon";
  if (PRODUCTIVE.has(verb)) return "productive";
  return "invalid";
}

/**
 * Compare baseline replays against remedy replays of the SAME turn.
 * A remedy earns promotion when it moves outcomes from recon/invalid to productive.
 */
/**
 * Which candidate contexts a `--turn` replay should A/B.
 *
 * An explicit injection replaces the catalog entirely: the point of a
 * counterfactual is to test ONE named fact (PRINCIPLES.md #3, and the parseArgs
 * capstone that flipped 3/3 on a single injected sentence), not to shop the
 * whole remedy table. Without this, only problems the distress-signal witness
 * can classify are replayable -- and a spec-shaped defect such as a narrowed
 * lexical contract emits no distress signal and matches no catalog entry.
 *
 * A blank injection falls back to the catalog rather than A/B-ing an empty
 * context against itself.
 */
export function selectRemedies(kind, inject = "") {
  const custom = String(inject ?? "").trim();
  if (custom) return [custom];
  return CONTEXT_REMEDIES[kind] ?? [];
}

export function scoreRemedy(baselineOutputs, remedyOutputs) {
  const tally = (outs) => {
    const counts = { recon: 0, productive: 0, invalid: 0 };
    for (const o of outs) counts[classifyAction(o)] += 1;
    const n = outs.length || 1;
    return { ...counts, n: outs.length, productiveRate: counts.productive / n };
  };
  const baseline = tally(baselineOutputs);
  const remedy = tally(remedyOutputs);
  const lift = remedy.productiveRate - baseline.productiveRate;
  return {
    baseline,
    remedy,
    lift,
    verdict: lift > 0.25 ? "promote" : lift < -0.25 ? "harmful" : "inconclusive",
  };
}
