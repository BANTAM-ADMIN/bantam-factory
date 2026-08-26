# BANTAM evaluation and improvement loop

This document defines the next development phase after the Local, Codex,
Trio, gauntlet, teacher-council, and Team-mode foundations became operational.
The priority is no longer adding another way to call a model. It is learning,
with repeatable evidence, which existing mode works best for which task and
turning those observations into safe improvements to BANTAM.

The short version is:

```text
freeze a baseline
        ↓
run the same fresh tasks through comparable modes
        ↓
grade outcomes and retain complete telemetry
        ↓
extract observable, reusable harness hypotheses
        ↓
build one narrow candidate in a private lane
        ↓
repeat the paired experiment
        ↓
promote only measured improvements
```

This is an operator-triggered research and development loop. Ordinary prompts,
Team runs, Trio runs, and accumulated telemetry do not automatically launch it.

## Current operating baseline

As of 2026-07-26, the development checkout has:

- a local OpenAI-compatible model path;
- selectable Codex Luna, Terra, and Sol roles and reasoning levels through the
  authenticated Codex app-server;
- one bounded Codex native thread per BANTAM run with exact prompt-delta
  delivery;
- single-model operation;
- isolated same-task Trio comparison;
- hidden-contract gauntlets and experiment specifications;
- an explicitly invoked Sol/Terra teacher council;
- governed self-improvement with private build lanes and evidence-gated
  promotion;
- optional Team mode with parallel read-only scouts and one Terra primary;
- per-run request, token, cache, reasoning, timing, action, verification, and
  protocol telemetry.

At that 2026-07-26 checkpoint, the complete verifier recorded **1,033 passing
tests and zero failures**. That dated number is a regression baseline for that
implementation, not fresh verification of the current tree and not proof that
one model-routing policy is best.

Team mode has live wiring and safety evidence. The hardened live audit at
`.bantam/teams/2026-07-26T11-25-30-110Z-fc027b94/` proved:

- Luna, Sol, and Terra scouts completed under the read-only policy;
- Local could be unavailable without invalidating the three-Codex workflow;
- all scout lanes were restored before integration;
- Terra produced a visible, repository-grounded final answer;
- the live workspace remained unchanged;
- the run recorded 16 requests, 418,607 input tokens, 5,486 output tokens,
  1,646 reasoning tokens, and 1 minute 59 seconds elapsed.

That is a phase-boundary proof, not a claim that Team is generally more accurate
or efficient than solo Terra or Sol. Advisory integration now has a deterministic
two-investigation-action ceiling, but that newer cap has not yet been
live-benchmarked. It is covered by the complete test suite.

The later controlled implementation samples establish the present operating
rule: **solo Terra medium is the default**. Team can improve assurance on a
hidden-contract concurrency task, but it was substantially slower and more
token-intensive on a broad migration with equal correctness. Team therefore
remains explicit and exception-driven; BANTAM does not auto-route ordinary
work into it.

The full implementation and evidence narrative is preserved in the
[Collaborative Team mode report](superpowers/reports/2026-07-26-collaborative-team-mode.md).

## Questions the next phase must answer

The evaluation program should resolve these questions separately:

1. When does solo Terra provide the best correctness/traffic tradeoff?
2. When does Sol's slower assurance-oriented trajectory prevent a real defect?
3. When does Team's parallel evidence improve the final result enough to
   justify two or three scouts plus integration?
4. Does Luna contribute unique useful evidence, or primarily duplicate faster
   reconnaissance?
5. Which context, action, stopping, verification, and effort policies explain
   stronger results?
6. Which of those policies improve the local model without depending on
   inaccessible private model reasoning?

The unit of learning is observable behavior: inspected paths, actions,
verification choices, corrections, final patches, and graded outcomes. BANTAM
does not need or attempt to extract hidden chain-of-thought.

## Evaluation matrix

Use fresh, verifiable tasks from several classes:

| Task class | Example risk | Why it matters |
| --- | --- | --- |
| Advisory/review | plausible but unsupported architectural claims | tests synthesis quality and unnecessary investigation |
| Focused repair | small bug with a hidden edge case | measures ordinary coding efficiency |
| Multi-file implementation | contracts split across modules | tests localization and integration |
| Test design | visible behavior omits adversarial cases | tests contract extraction |
| Lifecycle/concurrency | ordering, cancellation, or cleanup | tests Sol-style adversarial value |
| Migration | compatibility and stale call sites | tests Team's cross-cutting coverage |

For each task, start every arm from identical bytes and use the same task text,
public setup, verifier, deadline, and artifact policy. At minimum compare:

| Arm | Recommended setting | Purpose |
| --- | --- | --- |
| Terra | medium | everyday single-agent baseline |
| Sol | high | high-assurance single-agent baseline |
| Team | Local when available + Luna medium + Sol high + Terra medium | collaborative treatment |
| Local | registered local profile | improvement target and local-first control |

Luna may also run alone when the question is specifically whether its speed
outweighs extra turns. Do not spend subscription traffic on deprecated or
already rejected model families unless a new hypothesis requires a control.

## What to measure

Correctness is the primary outcome:

- public and hidden verifier result;
- strict contract result;
- regression count;
- completeness of the requested deliverable;
- advisory factual grounding;
- workspace diff and scope compliance.

Efficiency is secondary and should include:

- BANTAM turns;
- model requests;
- input, cache-hit/cache-miss, output, and reasoning tokens;
- end-to-end wall time;
- time to first useful action;
- investigation actions before the first edit or final synthesis;
- duplicate reads, no-op edits, invalid actions, and protocol violations;
- verifier attempts and post-green activity.

For Team, retain both aggregate traffic and critical-path time:

```text
aggregate traffic = every scout request + Terra integration requests
critical path      = slowest concurrent scout + Terra integration
```

Parallelism can improve latency while increasing total traffic. Reporting only
one of those values is misleading.

## Grading and ranking

Rank results lexicographically:

1. evidence validity;
2. correctness and strict-contract success;
3. regression safety;
4. task completeness;
5. efficiency.

A fast wrong answer does not beat a slower correct answer. A correct run with
missing or incomparable evidence does not establish a promotion claim.

Avoid declaring a routing winner from one task. A useful minimum study has:

- multiple task classes;
- fresh hidden contracts;
- repeated runs where provider variance matters;
- order balancing;
- exact source and configuration hashes;
- preregistered pass and regression thresholds.

## What can be run today

The existing gauntlet and experiment runner provide the controlled
single-model comparison substrate:

```bash
./bin/run-dev.sh gauntlet \
  --models local,sol,terra \
  --rounds 3 \
  --effort high \
  --faults

./bin/run-dev.sh experiment \
  examples/experiments/codex-hard-tournament-2026-07-25.json

# Recover an interrupted schedule without rerunning completed entries.
./bin/run-dev.sh experiment \
  examples/experiments/codex-hard-tournament-2026-07-25.json \
  --resume .bantam/experiments/<experiment-id>
```

Resume accepts an exactly matching clean or dirty harness snapshot. A dirty
snapshot is bound to its commit, status, worktree and staged diffs, and every
untracked file's content hash; any mismatch fails closed. Generated summaries
also expose per-gate rejection counts and warn when a treatment enabled an
opt-in gate that never intervened. Outcome deltas from such an arm are not
causal evidence for that gate, and the promotion evidence validator rejects
them.

Trio provides an interactive same-task comparison:

```text
:trio on high
<task>
:trio compare
:trio off
```

Team provides an explicitly collaborative treatment:

```text
:team on
<task>
:team compare
:team off
```

These artifacts can be compared now, but a single command that schedules a
balanced solo-versus-Team study does **not** exist yet. `:team benchmark` is the
proposed convenience layer, not a current command.

## Proposed `:team benchmark` workflow

The next implementation should compose existing runners rather than invent a
second evaluator. Its responsibilities should be:

1. resolve an immutable task/fixture specification;
2. capture the exact source, model catalog, model roles, effort, and policy
   hashes;
3. schedule solo Terra, solo Sol, Team, and optional Local arms from identical
   materializations;
4. preserve randomized or balanced run order;
5. invoke the same hidden verifier;
6. validate every artifact before including it;
7. produce one machine-readable comparison and one HTML showcase;
8. rank correctness before efficiency;
9. emit improvement hypotheses without changing source;
10. provide exact artifact references suitable for a later governed candidate.

Suggested interfaces:

```text
:team benchmark <fixture-or-spec>

./bin/run-dev.sh team benchmark \
  --spec examples/experiments/<study>.json \
  --rounds 3
```

This command must remain explicit. It should print the expected models, run
count, and external-call scope before beginning.

## Turning results into improvements

After a study, compare trajectories rather than copying a stronger model's
answer. Candidate mechanisms might include:

- a context packet that consistently localizes the correct files sooner;
- a cheaper reasoning level for mechanical turns;
- an action mask that prevents unproductive work;
- a stopping rule that reduces post-green churn;
- a verifier strategy that catches a recurring hidden edge case;
- a bounded specialist role that adds unique evidence;
- a better recovery observation after a failed action.

The model-free first reduction step is implemented:

```bash
./bin/run-dev.sh hypothesize \
  <failing-subject-run.json> \
  <passing-sol-run.json> \
  <passing-terra-run.json>
```

It derives only observations shared by the supplied passing references, caps
the candidate set, hashes the source comparison, and gives every candidate a
falsification test plus promotion and rollback thresholds. `--json` exposes
the complete deterministic comparison and reduced candidates for later
experiment composition. It does not call a teacher, edit source, or promote.

Each candidate should state:

- the observed failure pattern;
- the exact supporting artifacts;
- the proposed mechanism;
- the tasks it should help;
- the tasks it could harm;
- a falsifying test;
- promotion and rollback thresholds.

Then use the existing governed path:

```bash
./bin/run-dev.sh self-improve --plan
./bin/run-dev.sh self-improve --candidate <candidate-id> --no-apply
```

A candidate does not promote merely because Sol and Terra agree, Team wins one
task, or the full unit suite remains green. It needs fresh paired behavioral
evidence against the frozen control and must pass the existing transactional
promotion gates.

## Recommended routing while evidence accumulates

- Use **Terra medium** for routine coding, repository discussion, and ordinary
  implementation work.
- Use **Sol high** when adversarial review, subtle invariants, or assurance
  matter more than latency.
- Use **Luna** for deliberately speed-oriented reconnaissance or as its bounded
  Team specialist role.
- Use **Team** only for high-value, cross-cutting, ambiguous, security,
  lifecycle, concurrency, migration, or architecture work.
- Use **Trio** when the goal is independent comparison rather than one
  integrated answer.
- Use the **gauntlet/experiment runner** for claims intended to guide routing or
  self-improvement.
- Use **native Codex delegates** only as an explicit research control; current
  evidence favors Codex inside BANTAM for ordinary work.

## Stop conditions

Do not keep adding policies simply because telemetry exists. Pause a proposed
improvement when:

- the task evidence is anecdotal;
- the candidate cannot be falsified;
- the comparison does not start from identical state;
- the improvement only shifts provider-specific accounting;
- gains disappear on fresh tasks;
- correctness is unchanged and saved traffic is negligible;
- complexity added to the orchestration core exceeds the measured benefit.

The desired outcome is a smaller number of proven policies, not an ever-growing
collection of speculative mechanisms.

## Definition of success

This phase is complete when BANTAM can produce a reproducible report answering:

```text
For this preregistered task cohort and exact source state,
which operating mode produced the best verified outcomes,
at what latency and provider traffic,
which observable harness behaviors explain the difference,
and did the resulting candidate improve a fresh paired cohort?
```

Until then, Team remains a valuable optional capability with strong safety
proof, while broad claims about its quality advantage remain hypotheses.

## Creative and multimodal promotion example

The 2026-07-29 creative suite applied this policy to two visual candidates.
Deterministic PNG facts moved an exact-color fixture from 0/3 to 3/3 while
reducing traffic and time, then held an evaluator-corrected 4/4 on a non-target
cohort. It is default-on with a rollback flag. Rendered-preview vision produced
interesting observations and a superficially better 4/4 versus 3/4 result, but
the pass difference was not causally connected to screenshot evidence and the
model ignored the defects that vision found. It remains default-off.

The raw and corrected outcomes, rollback flags, and immutable artifact paths are
recorded in
[`creative-suite/promotion-ledger.json`](../creative-suite/promotion-ledger.json).

## First controlled sample

The first solo Terra versus Team implementation sample is now recorded in
[Solo Terra versus Team: keyed task-pool](superpowers/reports/2026-07-26-solo-terra-v-team-keyed-task-pool.md).
Both arms passed the supplied public and hidden suites, but solo alone passed
an additional validation probe directly implied by the written task. Team
reduced its primary's requests and input substantially, while the complete
workflow remained slower and more expensive. This reinforces the
correctness-first grading order and the need for a broader repeated cohort.
