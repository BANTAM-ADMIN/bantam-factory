# Borrowings: what other fields know about reliable output from fallible parts

Companion to [BANTAM as a factory](FACTORY-MODEL.md). Manufacturing is the closest
analogy but not the only one. Several fields solved "produce reliable output from
components that individually fail," and some of their answers map onto this
harness better than the assembly line does.

This is a thinking document. Each entry names the idea, what it would mean here,
and — where possible — the measured BANTAM observation that motivates it. Nothing
below is implemented unless it says so.

---

## 1. Statistical process control — do not tamper

**The idea.** Deming's funnel: adjust the funnel after every missed marble and the
output gets *worse*. Reacting to common-cause variation as though it were signal is
**tampering**, and it degrades a stable process.

**Here.** BANTAM's pass rate has large common-cause variance — identical inputs
produce 18 to 40 turns and different outcomes. On 2026-07-30 four A/Bs ran at n=3
and the harness was adjusted off several of them; one "3/3 since the fix" streak
went 2/5 immediately after. That is shaking the funnel.

**What it suggests.** A control chart for the gauntlet: compute natural process
limits from repeated identical runs, then treat a change as real only when it
leaves those limits. This is the discipline the preregistered engagement check and
`experiment-power` already gesture at; SPC is the mature version.

**Status.** Not implemented. `src/logic/experiment-power.js` is the nearest thing.

---

## 2. Surgical counts — closure accounting

**The idea.** Operating rooms do not prevent retained instruments by being careful.
They **count what goes in and count what comes out**, and the counts must reconcile
before closing. It is not an inspection of quality; it is an inventory of
obligations.

**Here.** A task states N requirements. A run should discharge N. `adapter-migration`
states twelve contracts; the model verified a handful, declared done, and nothing
counted. Every smoke check built so far asks "is this specific thing wrong?" — none
asks "did you close everything you opened?"

**What it suggests.** Extract the requirement list from the task, track which ones
the run demonstrably exercised, and refuse `done` on an unreconciled count. It
needs no understanding of the requirements themselves, which is what makes it
general where a smoke check is narrow.

**Status.** Not implemented. Closest relative is `requirement_ledger`, which is
opt-in and narrower.

---

## 3. High-reliability organisations — near misses are the richer corpus

**The idea.** Weick and Sutcliffe's "preoccupation with failure": HROs study events
that *almost* went wrong, because near misses are far more numerous than accidents
and carry the same causal information. Aviation's ASRS is non-punitive by design so
they get reported at all.

**Here.** BANTAM records failures thoroughly. It does not record **saves**. Every
gate bounce that rescued a run is a near miss with a known cause and a known
correction — and it is currently discarded once the run passes.

**What it suggests.** A near-miss log: every gate bounce, its trigger, and whether
the following turn corrected. That is a labelled dataset of "context that changed a
decision", which is precisely what the self-improvement loop needs and currently
has to reconstruct from failures alone.

**Status.** Not implemented. The data exists in artifacts; nothing aggregates it.

---

## 4. DNA proofreading — layered checks with *independent* failure modes

**The idea.** Polymerase reaches ~10⁻¹⁰ error rates from ~10⁻⁵ components via three
stages: base-pair selection, proofreading exonuclease, post-replication mismatch
repair. The multiplication only works because the stages fail **independently**.

**Here.** BANTAM's seven expensive gates (`sibling_symbol`, `family_convention`,
`verify_red`, `edge_smoke`, `spec_example`, `lexical_smoke`, `type_contract`) all
fire at the same moment and several read the same signals. Correlated checks do not
multiply; three gates that fail together are one gate.

**What it suggests.** Audit gate independence directly: across recorded runs, do
gate outcomes correlate? A gate that never fires when its neighbours do not is
redundant; a gate that fires on a disjoint population is worth its cost.

**Status.** Not implemented, and cheaply measurable from existing artifacts.

---

## 5. Jidoka properly — stop at the station, not at final inspection

**The idea.** Jidoka is not end-of-line inspection. It is the machine detecting
abnormality and halting *immediately*, so no defect is built upon.

**Here.** All seven expensive gates fire at `done`. A defect introduced at turn 4
can have thirty turns of work built on top before anything objects. In-station
checks do exist — `api-check` at edit time, `editScopeRefusal`, the no-op edit guard
— and they are the minority.

**What it suggests.** For each done-gate, ask what its earliest decidable moment is.
`type_contract` and `lexical_smoke` both probe exported functions; both could run
after the edit that defines them rather than at the finish.

**Status.** Partially present. The ratio is roughly 4 in-station to 7 end-of-line.

---

## 6. The andon cord — the *operator* must be able to stop the line

**The idea.** On a Toyota line the newest hire can halt production. The system
treats "I am not sure this is right" as information worth more than throughput.

**Here.** There is no action for the model to say *"this specification is ambiguous
and I am guessing."* It can only guess and continue. Every `adapter-migration`
failure traced to a requirement the task never stated — and the model, which
restated the contract correctly in its own summaries, had no channel to flag the
omission.

**What it suggests.** A first-class `blocked` or `underspecified` action, recorded
as a run outcome rather than a failure. That converts a silent wrong answer into a
spec bug report — and spec bugs are the cheapest defect class to fix, measured at
~32% fewer turns than gating for them.

**Status.** Not implemented. Grep of the action grammar confirms no such verb.

---

## 7. Theory of Constraints — improve the bottleneck or achieve nothing

**The idea.** Goldratt: throughput is set by one constraint. Effort spent anywhere
else produces local improvement and no global gain.

**Here.** The evidence points at the **oracle** as the constraint, not the model.
Six revisions of one test suite moved the outcome; nothing about the model or the
prompt changed. Meanwhile a purpose-built gate was matched by one sentence of task
text at 32% fewer turns.

**What it suggests.** Weight harness investment toward verification quality —
gauge coverage, repro strength, spec completeness — over additional gates, until
the constraint demonstrably moves.

---

## 8. Quiescence search — do not evaluate an unstable position

**The idea.** Chess engines refuse to score a position in the middle of a capture
exchange, because the evaluation is meaningless until things settle.

**Here.** `done` is graded whenever the model emits it, including mid-refactor with
a half-migrated tree. Several existing gates are really ad-hoc "is this position
quiet?" checks: `verify_red`, the unverified-edit guard, the workspace-coherence
staleness rule.

**What it suggests.** One explicit quiescence precondition — no accepted `done`
while the tree is in flux relative to the last verification — could replace or
subsume several narrower gates.

---

## 9. Mise en place — stage the work before service

**The idea.** Kitchens do not improvise during service. Everything is prepped,
portioned and within reach before the first ticket.

**Here.** Context is assembled per turn and re-read constantly; one recorded
40-turn run spent 23 turns on `read_file`. The harness optimises retrieval
(dedup, open-files panel, repomap) rather than preparation.

**What it suggests.** A prep phase that stages what the task will obviously need —
the modules named in the task, their tests, the verify command's output — before
turn one. Different lever from making retrieval cheaper.

---

## 10. Circuit breakers — fail fast, then *escalate*

**The idea.** Distributed systems trip a breaker after repeated failures and stop
retrying, because retrying a broken dependency wastes capacity and hides the fault.
The breaker also *reports*.

**Here.** The anti-spiral gate terminates a spiralling run. Termination alone
discards the information; a tripped breaker should also emit what it tripped on.

---

## 11. Auftragstaktik — the counterweight

**The idea.** Mission command: give intent and constraints, not step-by-step
instructions, so a capable subordinate can adapt to what they find.

**Here.** This is the necessary corrective to everything above. Over-specify and
the harness becomes brittle and fixture-shaped; a gauge tuned to one task is
overfitting, not tooling. The judgement is **which stations need a jig and which
need intent** — and BANTAM has no principled way to tell them apart yet.

---

## What to try first

Ranked by evidence behind them and cost to build:

1. **Requirement closure accounting** (#2) — general, cheap, addresses the single
   most common observed failure: confident `done` on partial work.
2. **An `underspecified` action** (#6) — converts the cheapest-to-fix defect class
   from silent failure into a report.
3. **Gate independence audit** (#4) — measurable today from existing artifacts, and
   may show that several gates are redundant.
4. **Near-miss log** (#3) — the data already exists; only aggregation is missing.
5. **Control limits before reacting** (#1) — would have prevented several wasted
   experiments on 2026-07-30.

---

## Postscript: #2 was built, validated against real data, and rejected

Requirement closure accounting was the top-ranked idea above. It was implemented,
unit-tested green, then validated against 30 recorded `keyed-task-pool-strong`
runs — and **it does not discriminate**:

| | unexercised clauses at `done` |
| --- | ---: |
| failing runs (n=12) | 4.0 |
| passing runs (n=18) | 3.8 |

At every threshold it fires on 12/12 failures *and* 18/18 passes. As a gate it
would bounce every run.

**Why.** The design counted a clause as exercised when its *subject* appeared in
something the run executed. But the subjects of a coding task's contracts are the
things being built — `KeyedTaskPool` appears 17 times in a single run log, in
reads, edits and test output alike. Name presence carries no information about
whether the *behaviour* was exercised.

The general question — "did you exercise this clause?" — needs semantic
understanding of what exercising means. That is the same wall that killed the
repro-strength metric (assertion counts do not separate passing from failing
fixtures). Both attempts to generalise a specific working check into a universal
one failed the same way.

**What still works is the specific form.** `lexical_smoke` and `type_contract`
mechanise "is *this named defect* present" and validate cleanly red/green.
"Did you cover everything" resists mechanisation; "is this specific thing wrong"
does not.

**The methodological lesson, which is the more valuable half.** The module passed
its own unit tests. Those tests used synthetic evidence strings in which the
subject genuinely was absent — so the mechanism looked like it worked. Only
replaying it against real recorded runs exposed that the signal is not there.

**Red/green on constructed specimens is necessary and not sufficient. A new
instrument must also be replayed against recorded reality before it is trusted**,
because synthetic specimens are built by the same person who built the assumption.
