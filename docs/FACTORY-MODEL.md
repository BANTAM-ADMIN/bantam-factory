# BANTAM as a factory

A companion to [PRINCIPLES](PRINCIPLES.md). The assembly-line framing is not
decoration: manufacturing solved "get unreliable steps to produce reliable output"
a century ago, and its vocabulary maps onto this harness closely enough to
generate work rather than merely describe it.

This document describes manufacturing lessons already grounded in BANTAM's
implementation and recorded behavior. The experimental
[BANTAMFACTORY architecture](BANTAMFACTORY/README.md) begins one level above it:
compile an entire product contract into a routed graph of bounded stations with
explicit inputs, outputs, gauges, containment, rework, and release authority.
The existing BANTAM loop remains its control.

Nobody bolts together a car. A car is built by a long line of small operations,
each simple enough to do reliably, each checked before the part moves on. An
arbitrarily complex coding task admits the same treatment — and BANTAM is unusual
in that it can **rebuild the line while running on it**.

## The mapping

| Factory | BANTAM |
| --- | --- |
| Station — one small operation | A turn: one action, one observation |
| Jig / fixture — the part physically cannot mount wrong | GBNF grammar and the strict JSON schema |
| Inspection gauge | The verify command, hidden grader, `edge_smoke`, the smoke checks |
| Andon cord — stop the line on a defect | Done-gates: refuse the finish, hand back the reason |
| Rework loop | Repair turns |
| WIP limit | Turn budget, concurrency, query budget |
| Batch records / traceability | Run artifacts, saved prompts, `bantam replay` |
| Statistical process control | The experiment harness, engagement checks, power analysis |
| Preventive maintenance | Auditing mechanisms that have gone inert |
| Retooling the line | Self-improvement: build, test, promote a new gate |
| Muda — waste elimination | Retiring inert mechanisms and unreachable code |
| Line history / revision control | Content-addressed channels, git, run artifacts |

## Poka-yoke: the hierarchy that matters most

Toyota's mistake-proofing doctrine ranks three ways to stop a defect, weakest to
strongest:

1. **Instruction** — tell the operator the rule
2. **Detection** — a gauge catches the bad part after it is made
3. **Prevention** — a jig makes the bad part impossible to produce

BANTAM has all three layers, and its own measurements reproduce the ranking
exactly:

| Layer | Mechanism | Measured |
| --- | --- | --- |
| Instruction | Advisory footer on an observation | Fired 3/3, ignored 3/3 (`adapter-migration`) |
| Detection | Done-gate bounce | 0/12 → 11/12 corrected (p = 9.6e-06) |
| Prevention | GBNF-constrained action grammar | **0 invalid, 0 protocol violations across 376 runs** |

That last row is the most important number in the harness. The prevention layer
does not have a failure rate to report — a malformed action is not *rejected*, it
is *unrepresentable*. Every other agent harness spends engineering on retry loops
for a defect class BANTAM cannot produce.

**The design rule that follows:** when a defect recurs, ask whether it can be moved
*down* this list. An instruction that is ignored should become a gate; a gate that
fires constantly should become a grammar constraint or a mask. Words persuade,
gauges catch, jigs prevent.

## A blind gauge is worse than no gauge

The corollary that cost the most to learn. A station with instructions and no
gauge produces confident, uniform, undetected defects — and a gauge that cannot
reach the defect is worse still, because it **certifies** bad work.

`keyed-task-pool`, measured 2026-07-30:

- the model was told the whole async lifecycle contract, and restated it correctly
- its gauge ran everything at `concurrency: 1` with a single key, so the
  queue-drain path — where every recorded failure lived — was never executed
- told its implementation was wrong, it reran that gauge, saw green, and declared
  done. **6 of 6 replays did exactly this**

Six revisions of the gauge, each closing a hole the previous one exposed:
queued work → queued coalescing → `onIdle` before later work → prototype-named
keys → `runPlan` atomicity → concurrency *during drain*. Each hole admitted an
implementation that passed every existing test and failed the real contract.

The last one is the cleanest illustration: a pool that drains its whole queue when
a slot frees preserves FIFO order and settles everything, so it passed all 13
tests then in place. The clause it violated — "runs at most concurrency unique
tasks at once" — had been in the task the entire time. Nothing was ever measuring
it.

## Muda: a line that only adds stations is a line getting worse

Toyota's other half is waste elimination. A station that catches no defects is not
neutral — it costs takt time, it must be maintained, and it makes the line harder
to reason about. Real lines *remove* stations as readily as they add them.

BANTAM's self-modification has always had the construction half. The measured
state on 2026-07-30 showed the destruction half barely existed:

| | |
| --- | ---: |
| Generated proposal modules | 29 |
| Reaching the agent loop | **3** |
| Built, sometimes tested, never executed | 4,336 lines |

Two of those dead modules were listed in `REMEDY_TARGETS` as files a teacher may
edit for a remedy — so the self-improvement system could direct work at code that
**cannot affect a run**. Dead stations do not merely sit there; they misroute the
mechanics sent to repair the line.

## Tearing itself apart safely

Removal is harder than construction, because construction fails loudly and removal
fails silently — six weeks later, in a path nobody exercised. What makes it safe is
not courage but instrumentation. Five properties, all of which BANTAM has:

1. **Reachability is measurable.** You cannot retire what you cannot prove is
   unused. `integration-audit` resolves real import edges and splits
   production-wired / test-only / unreferenced. Two hand-audits of the same
   question were wrong in opposite directions before the tool existed.
2. **Removal is testable before it is real.** The 13 modules were deleted in a
   scratch checkout and the full suite run there first — 1258/1258 — before the
   repo was touched. A removal that has not been rehearsed is a guess.
3. **Removal is reversible.** Content-addressed channels with checkpoint,
   materialize, promote and rollback (`src/state-cli.js`, `src/lane-store.js`),
   plus ordinary git history. Nothing retired is unrecoverable.
4. **Removal is regenerable.** The registry entries in `self-improve.js` were kept
   when the files went. `self-improve-runner.js` still holds the builders. If the
   problem recurs, the line rebuilds the station from the recipe — which is why
   deleting the *output* costs nothing and keeping it costs takt time.
5. **The line's history is traversable.** Every promotion, rollback and retirement
   is a commit with its evidence attached, and run artifacts are content-addressed.
   The development of the harness is itself a walkable tree, which is what makes
   "when did this stop being useful?" answerable rather than a matter of memory.

The asymmetry to watch: **BANTAM's build side has been exercised far more than its
retire side.** Twenty-nine builders exist; the first retirement instrument was
written the same day this section was. A self-improving system that only accretes
is not self-improving, it is self-inflating.

## What the model tells us to build

A framing earns its keep by generating work. This one suggests:

- **Gauge coverage as a first-class question.** For each stated requirement, which
  station measures it? `spec-coverage` answers a narrow version of this (does the
  grader test what the spec never states); the general version — does the
  *verifier* exercise every clause — is not yet automated.
- **Preventive maintenance on mechanisms.** Tooling wears out; so do gates. The
  anti-spiral gate was structurally unable to fire, and 4,336 lines of
  self-improvement output had no call site. `integration-audit` and the
  always-zero-metric sweep are this idea; they should run on a schedule, not on a
  hunch.
- **WIP limits must scale with the line.** Raising the gauge from 6 assertions to
  39 while leaving `maxTurns` at 40 made the pass rate *worse* before it made it
  better. More stations need more takt time.
- **Move defects down the poka-yoke list.** Every recurring gate bounce is a
  candidate for a grammar constraint or a capability mask.

## Where the analogy breaks

Worth stating so it is not over-applied.

- **A factory builds the same part repeatedly; BANTAM's parts are all different.**
  Stations must generalise across tasks, so a gauge tuned to one fixture is
  overfitting, not tooling. This is why gauges are derived from the task's own
  stated invariants rather than from the grader.
- **A line has fixed takt time; agent turns vary wildly.** Passing runs here span
  18–40 turns on identical inputs.
- **The operator is stochastic.** The same station, same inputs, produces different
  output run to run — which is why single-run results are anecdotes and engagement
  checks matter more than outcomes.

## Beyond the factory

Manufacturing is the closest analogy, not the only one. Surgical counts, high-
reliability organisations, DNA proofreading, statistical process control, chess
quiescence and mission command each solved a piece of this problem differently.
See [Reliability borrowings](RELIABILITY-BORROWINGS.md) for eleven of them, what
each would mean here, and the five worth trying first.

## Reading order

- [PRINCIPLES](PRINCIPLES.md) — the working assumption and the discipline
- [BANTAMFACTORY](BANTAMFACTORY/README.md) — the experimental architecture,
  current-system boundary, proof ladder, and realization plan
- [Specification beats the gate](superpowers/reports/2026-07-30-specification-beats-the-gate.md)
  — the cheapest station is usually a sentence
- [keyed-task-pool: the oracle gap](superpowers/reports/2026-07-30-keyed-task-pool-oracle-gap.md)
  — the blind-gauge case in full
