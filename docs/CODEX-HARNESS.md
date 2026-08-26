# BANTAM as a Codex harness — state, evidence, and open work

**Last measured:** 2026-07-31, `gpt-5.6-terra` / `gpt-5.6-sol` / `gpt-5.6-luna`
against `adapter-migration` and `keyed-task-pool-strong`.

The goal is narrow and testable: **BANTAM driving Codex should beat Codex driving
itself** — more capable, cheaper, and better organised. This records what is
measured, what is merely reasoned, and what was tried and failed, because two of
five prompt experiments here were clean intuitions that measured worse.

---

## Where the numbers are

Same fixture, same model, every arm passing the hidden contract 4/4:

| | start of day | now |
| --- | --- | --- |
| cache hit rate | 79% | **85.8%** |
| delta savings | 36.7% | **39.1%** |
| default reasoning effort | high | **medium** |
| un-slim churn | 10 events / 10 turns | **0** |

Reasoning effort alone: medium is **−19% input, −27% output, −50% reasoning,
−23% wall** against the previous `high` default, on both a well-specified fixture
and the hardest one available, each time finishing a turn earlier.

## The one idea behind most of the wins

**Growth is free; rewriting is paid twice.**

BANTAM assembles a full prompt each turn and Codex delivers it as a delta against
the previous one. Anything appended costs only its own bytes. Anything that
changes bytes *already sent* invalidates the provider prefix cache from that point
AND enlarges the delta suffix — the same waste billed twice.

Every prompt fix today was an instance of the station re-tooling itself between
parts:

- a file body vanished when its file entered the open-files window and **came
  back** when the window slid past (10 flips in 10 turns)
- a pointer had two wordings, so an edit **upgraded** every earlier pointer
- replayed edit bodies followed the same sliding window
- the panel's **order** followed recency, so one new read shifted every file

None of these are visible in a diff. The prompt always looked correct; it just was
not the same bytes twice.

## What was tried and measured WORSE

Recorded so the next person finds the measurement instead of repeating it.

**Immutable history** — never rewrite an observation once emitted, append a
staleness note instead. Prefix retention more than doubled (34.7% → 78.7%) and
cache misses rose 24%, because keeping superseded bodies grew the prompt 44% and
re-sending a bigger prompt every turn outweighs the stability. The in-place
rewrite is a correct optimisation, now measured rather than assumed. Still
available behind `BANTAM_IMMUTABLE_HISTORY`.

**Wider inspect batching** — 6 → 12 ops. The model used the width and saved a
turn (9 → 8), at **+61% cache misses**. A wide batch makes one large observation,
and sticky slimming later rewrites that whole block at once instead of in small
pieces. Batching reads concentrates a later rewrite. Default returned to 6,
overridable via `BANTAM_INSPECT_MAX_OPS`.

## Harness bugs found by trying to measure

Three of these would have produced a *flattering* number, which is worse than a
crash because it looks publishable.

- **Competitor arms hung forever.** External agents were spawned with an stdin
  pipe nobody wrote to or closed; `codex exec` reads stdin. One arm sat 50 minutes
  at 0.0% CPU while the BANTAM arm finished in 101 seconds. Rendered as-is that
  was a ~30× "speed advantage" invented entirely by our spawn options.
- **Competitor arms ran read-only.** `codex exec` defaults to a read-only sandbox
  and could not edit a single file, scoring 0/4 against BANTAM's 4/4 while every
  file it "produced" was the untouched original.
- **A blocked competitor was scored as a loss.** Its own stdout said "I'm blocked
  by the workspace's read-only sandbox … no files were modified" and nothing read
  it. An arm that never attempted the task is a *missing observation*, not a loss.
- **Capacity errors discarded finished work.** Two runs with a hidden contract of
  4/4 were killed at the finish line by "Selected model is at capacity" after
  three attempts spanning nine seconds.
- **The churn report named the wrong section.** `firstChangedSection` compares a
  fixed section order, and `actionHistory` grows every turn by construction, so it
  was named on 8 of 8 turns — true and useless. The real rewrites were in
  `openFiles` and `guidance`.

Five of those are the same bug class in different clothes: **an instrument
reporting a confident number where the honest answer is "no observation."** It has
now appeared in gate-engagement, spec-coverage, compare grading, external arms,
and churn reporting.

## Model characterisation so far

On `keyed-task-pool-strong`, all three **PASS** (n=1 each):

| arm | turns | wall | input | cache hit | output | reasoning |
| --- | --- | --- | --- | --- | --- | --- |
| terra (high) | 9 | **83s** | 291k | **78%** | **3,753** | 1,659 |
| sol (high) | 8 | 114s | 237k | 63% | 4,293 | 2,128 |
| luna (max) | 8 | 260s | 237k | 76% | **13,336** | **10,955** |

**luna at max competes on correctness and loses badly on cost** — same PASS, 3×
the wall clock, 3.5× the output. **terra is the efficiency winner** and the right
default for bounded work.

The honest limit: every fixture we own is cleared by all three arms, so this
measures **cost, not capability**. sol's "Hard" role cannot earn itself on
well-specified single-module work.

**Contract intricacy does not separate them either.** `dependency-scheduler` was
built specifically to try: requirements that INTERACT rather than stack — a failed
task's dependents skipped transitively rather than rejected, while independent
branches continue, while concurrency holds, while ties break by input order — and
where the natural mistake HANGS rather than fails. Two plausible defects fail its
grader. All three arms passed 4/4 on the first attempt:

| arm | turns | wall | hidden |
| --- | --- | --- | --- |
| terra (medium) | 5 | **53s** | 4/4 |
| sol (high) | 7 | 115s | 4/4 |
| luna (max) | 5 | 323s | 4/4 |

So the lever that separates a frontier model is not intricacy. The one thing
measured all day that DOES bind is **incomplete specification** — and it binds the
local 27B (a hard 2/4 ceiling on adapter-migration) while terra infers the missing
contracts and passes. Separating terra from sol will need something qualitatively
different: genuine ambiguity, or scale beyond one module, not more clauses.

## What the harness actually contributes for Codex

**This section previously said the supervision layer was inert. That was wrong,
and the reason it was wrong matters more than the claim.** It rested on artifacts
that were silently dropping 34 of the agent's 42 counters, because the artifact
built its metrics from a hand-maintained list. Mechanisms were firing; they were
invisible. Re-measured on 5 full-capture runs, 36 turns:

**Rejection gates: evaluated every run, never object.**

| | runs |
| --- | --- |
| `verifyDoneGateRuns`, `verifyRedGateEvaluations` | 5 / 5 evaluated |
| `siblingSymbolGateEvaluations`, `familyConventionGateEvaluations` | 5 / 5 evaluated |
| any rejection | **0** |

Reachable and correctly silent. Codex does not make the mistakes they were built
from, so they never refuse anything — but they are asked, every run.

**Advisory interventions: these fire constantly.**

| | runs |
| --- | --- |
| `completionAuditHints` | **5 / 5** |
| `blastRadiusNotes` | 5 / 5 |
| `stateAuditEngagements` | 4 / 5 |
| `stateAuditHints` | 2 / 5 |
| `lexicalContractAuditHints` | 1 / 5 |

So BANTAM's supervision of Codex is **advisory, not rejective**. It does not refuse
the model's work; it makes it re-check. The completion audit appends a block on
every single run telling the model to read the assignment against current source.

That is a better fit for the failure mode anyway. A novice needs jigs that refuse;
an expert needs to be asked "are you sure?" at the right moment. The gates are the
first kind and stay silent. The audits are the second kind and are doing the work.

**The open question this raises.** The completion-audit block is also the
`guidance` section identified as a prompt-churn source: it appears for one turn and
vanishes, rewriting everything after it. So it fires every run AND costs cache. Its
value has never been measured against that cost, and now that the counters are
visible, it can be.

**What contributes beyond supervision, unchanged by the correction:** constraint
(0 invalid actions and 0 protocol violations in 383 turns -- a malformed action is
unrepresentable, not merely caught), verification (25 of 34 runs tested, failed,
fixed and re-ran), scope (immutable files refused at edit time), efficiency (85.8%
cache hit, 39% delta savings), and evidence -- every finding here came from a
replayable artifact, including the one that corrected this section.

## The full sweep, with every measured default in place

Nine fixtures, gpt-5.6-terra at medium effort, 2026-08-01. Every default on this
run was set by a measurement recorded in this document.

| fixture | hidden contract | turns |
| --- | --- | --- |
| ordered-map | 2/2 | 4 |
| ttl-cache | 3/3 | 4 |
| safe-config-merge | 2/2 | 4 |
| range-parser | 2/2 | 6 |
| retry-policy | 3/3 | 5 |
| keyed-task-pool | 4/4 | 6 |
| adapter-migration | 4/4 | 9 |
| dependency-scheduler | 4/4 | 5 |
| retry-consolidation | 5/5 | 6 |

**9/9 fixtures, 29/29 hidden contract assertions, 49 turns, 16,836 output tokens.**

`adapter-migration` is the notable row: it has an under-specified task (8 of 12
contracts unstated) and is the fixture the local 27B has never passed, hitting a
hard 2/4 ceiling across every recorded attempt. terra passes it 4/4 by inferring
the missing contracts — the asymmetry that is the actual product thesis.

The defaults behind this run, each with its measurement:

| default | effect | measured |
| --- | --- | --- |
| medium reasoning effort | −19% input, −50% reasoning | 2 fixtures |
| completion audit OFF | avoided +54% turns | n=3, p=0.05 |
| grounding KB ON (≤40 files) | −16% turns, −22% miss | n=5, p=0.040 |
| state audit ON | −14% turns, −39% miss | n=3, p=0.05 |
| blast-radius ON | −12.5% turns, −10% miss | n=3, p=0.05 |
| 4 prompt-assembly fixes | −27% cache miss | same-fixture A/B |

**What this is not.** A 9/9 on fixtures a frontier model clears anyway is not
evidence that BANTAM improves Codex. It shows the harness does not get in the way,
and that the measured defaults hold together on a full sweep. The claim that BANTAM
makes Codex *better* still rests on the head-to-head, which remains unmeasured
because bwrap cannot start in the assistant's execution context.

## Which mechanisms earn their keep on Codex

Every advisory mechanism, measured individually. Across 31 full-capture runs only
SIX ever fire at all; everything else in the harness is silent for Codex.

| mechanism | fires | effect, n=3 per arm | verdict |
| --- | --- | --- | --- |
| `stateAuditHints` | 5/31 | **−14% turns, −39% cache miss** | keep |
| `blastRadiusNotes` | 26/31 | **−12.5% turns, −10% cache miss** | keep |
| `completionAuditHints` | 9/31 | **+54% turns, +67% cache miss** | **off for Codex** |
| `lexicalContractAuditHints` | 2/31 | too rare to measure | unknown |
| `embeddedBaselineRecognitions` | 1/31 | too rare to measure | unknown |
| `testFocusHints` | 1/31 | too rare to measure | unknown |

Every arm passed the hidden contract 4/4 in every condition. None of these changes
correctness on this fixture set; they change what it costs to get there.

`crossFileUsageNotes`, `peerFunctionFooters` and the rest never fire at all —
Codex does not use the KB-backed `search` path they hang off.

**The thing that did not survive: a rule for predicting which is which.** After the
completion-audit result, "a specific fact helps, a general instruction costs"
looked like a clean generalisation. It was pre-registered against the state audit
and FALSIFIED on the next case: the state audit reads as an instruction ("audit
these boundaries") and is in fact the single most valuable mechanism measured.

Read afterwards, the state audit names the exact boundaries where concurrency bugs
live and the invariant that must hold at each — a compressed expert briefing
wearing an instruction's grammar. So the rule may be true, but it could not be
applied correctly IN ADVANCE by the person who had just written it. A rule that
only sorts cases after they are measured is a summary, not a predictor.

**So the operating conclusion is procedural rather than theoretical: measure each
mechanism separately.** With the counters reaching the artifact that now costs
about six minutes per mechanism, which is cheaper than being wrong about one.

## Tools this left behind

- `examples/experiments/codex-efficiency-report.mjs` — read a recorded run's cache,
  delivery and churn in seconds instead of re-running it. Leads with *which
  section rewrote already-sent bytes*.
- `src/logic/effort-policy.js` — per-turn reasoning effort, escalating on
  setbacks. Mechanism measured (effort is per-turn on `turn/start`; changing it
  does **not** rebase the thread). Policy **default off** — reasoned, not measured.
- `bantam compare --grader <dir>` — arms graded on a contract they cannot see, with
  a `bantam-codex` arm so the comparison is same-model-both-sides.

## Next steps, in order of what they prove

1. **Run the head-to-head from a real terminal.** It cannot complete from the
   assistant's sandbox: `bwrap` has zero capabilities there (`CapEff
   0000000000000000`), so every competitor arm is blocked. This is the single
   outstanding item that would demonstrate the project's central claim.

2. **Build one task that separates the models.** Everything we own is cleared by
   all three frontier arms on the first attempt, which caps model characterisation
   at cost comparisons and leaves the per-turn effort policy unmeasurable — it
   escalates on setbacks, and nothing here produces setbacks. Needs genuine
   ambiguity or cross-file architectural pressure, not more contracts.

3. **Measure the effort policy** once such a task exists, then decide its default.

4. **Parallel dispatch.** BANTAM is one action per turn while Codex supports
   concurrent sessions; three ran side by side today. Independent sub-tasks
   dispatched in parallel is the one wall-clock lever nothing else touches.

5. **`guidance` churn.** The post-green completion audit block appears for one
   turn and vanishes, rewriting everything after it. Deliberately not guessed at —
   the two failed experiments above were both prompt hunches that looked obvious.
