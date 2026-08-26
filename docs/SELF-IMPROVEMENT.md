# BANTAM's Self-Improvement Loop

For the complete system context around this loop—ordinary Local/Codex turns,
trio and gauntlet evidence, consent boundaries, and current measured proof—see
the [BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md).

> BANTAM's long-term design goal is a harness that **gets better at your work by
> doing your work** — it hits a difficulty, studies its own context at the moment
> it failed, proposes and A/B-tests a change, promotes it only if it measurably
> helps, and keeps a revertible trail. This document explains that machinery end
> to end.

For the operator-level boundary between ordinary runs, automatic observation,
explicit gauntlets, teacher calls, and governed mutation, start with
[Model runtimes, gauntlets, and self-improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md).

The loop, in one line:

```
record → witness → rewind → A/B a context remedy → score → preregister → evidence-gated promotion → revertible trail
```

The governing rule, from [`PRINCIPLES.md`](PRINCIPLES.md): **when the model makes a
bad choice, the cause is almost always the context, not the model.** So every
stage below is about finding the true thing the harness knew and wasn't saying,
proving that saying it changes the outcome, and shipping only measured wins. A
crucial invariant runs through all of it: **diagnosis never mutates ambient
state.** It prints and scores. Only an explicit promotion command—or the
evidence-gated `self-improve` controller described below—moves `regular`.

## Production self-host front door

This development checkout has one supported autonomous implementation path:

```bash
./bin/run-dev.sh self-improve --plan     # no model/controller writes; launcher may bootstrap missing deps
./bin/run-dev.sh self-improve            # implement, verify, deploy, promote
./bin/run-dev.sh self-improve --no-apply # retain a verified dev candidate; do not deploy
```

The interactive front end routes `:self-improve` and deliberate natural-language
requests such as “Let’s do a little self improvement” through that same
controller. Questions *about* self-improvement remain normal conversation.

`--max-turns` bounds agent decisions rather than elapsed time. Codex-backed
cycles also inherit the transport's control, inactivity, and hard completion
deadlines described in the guide. A timed-out Codex completion is not
automatically replayed: the app-server is recycled and the attempt is recorded
as failed or interrupted instead of silently spending the same deadline two
more times.

One managed cycle:

1. Captures the exact live tree and requires a green baseline with positive test
   counts before initializing or advancing channels.
2. Freezes one ranked weakness and creates a private lane from that exact channel
   version—never from arbitrary ambient files.
3. Runs the implementation agent only in the lane. The frozen candidate policy
   permits only its named source targets, newly added focused tests discovered by
   the configured verifier, and narrowly bounded import-connected helpers.
   Existing tests, launchers, dependency/package-manager configuration, and all
   `.gitignore` capture rules are immutable.
4. Captures the candidate, measures the weakness on an immutable materialization,
   and runs the full candidate suite there with the complete workspace bind
   mounted read-only in an offline Docker verifier (`/tmp` remains writable).
   Verifier-induced workspace mutations are therefore blocked and independently
   rejected by tree attestations.
5. Restores the baseline tests/config in a second isolated materialization and
   requires at least the baseline test count, preventing test weakening.
6. Transactionally applies the already-tested content-addressed bytes, then runs
   the authoritative verifier again from the deployed live checkout. Live tree
   hashes, executed test-count lift, and the measured improvement are checked
   before a compare-and-swap promotion of `regular`.
7. On any pre-promotion failure, exact backups restore the live checkout and dev
   rolls back. Concurrent edits observed by pre-write, post-write, or rollback
   validation are preserved as explicit recovery conflicts. Operators should
   still avoid editing the checkout during deployment: portable POSIX rename
   does not provide a compare-and-swap primitive for the microscopic interval
   between the final per-file validation and replacement.

Candidate tests never execute against the live checkout or controller state.
After a successful promotion, restart Bantam so the current Node process loads
the promoted modules.

Completed operational work launched by this exact development checkout—even when
the task workspace is another project—feeds this checkout's
`.bantam/self-observations.json`, a bounded 200-row outcome store. It never writes
telemetry into the task project. The store records counters and a task SHA-256
only—never task text, summaries, verifier output, or model trajectories. Repeated
runtime symptoms are shown as candidates. Default cycles advance past build-only
candidates already verified for the exact baseline; explicitly selecting the
current staged candidate reuses its checkpoint. An explicitly selected runtime candidate can
drive the same private-lane implementation, immutable candidate suite, and
protected baseline-suite checks, but it stops as a content-addressed `dev`
checkpoint even when apply was requested. The project verifier proves regression
safety, not behavioral lift; the redacted observations contain no replayable task
inputs from which to construct a paired verifier. Runtime candidates therefore
remain ineligible for live deployment or `regular` promotion until a
preregistered paired behavioral benchmark supplies that missing evidence.
Likewise, filename-detected “missing mechanism” ideas are build-only: creating a
named module and unit test does not prove the mechanism is wired into production.
They may be retained as verified `dev` checkpoints, but cannot deploy or advance
`regular` without an integration-specific behavioral predicate.

Teacher-council candidates add one further implementation constraint: each
cycle selects the smallest independently useful, task-general vertical slice.
The cross-reviewed adversarial test list is a menu for falsification, not a
mandate to implement every suggested mechanism in one large change. Their
implementation prompt treats the frozen targets as the only editable existing
source files, permits at most one import-connected helper, and gives
reconnaissance six read/query actions before the agent must implement or report
a genuine blocker. This keeps a strong teacher model from spending an entire
managed cycle surveying alternate integration points.

## 0. Safety boundary for the experimental adaptive layer

The generic modules in `self-improve.js`, `self-improve-runner.js`,
`self-healing.js`, `action-sequence-integration.js`, and `playground.js` are
candidate-generating tools around the governed loop; they are not an alternate
promotion path.

- The integrated next-action decider is **off by default**. Enable it only for a
  measured run with `BANTAM_INTEGRATED_DECIDER=1` (or
  `runAgent({ integratedDecider: true })`). It learns only from executed action
  sequences ending in test/verifier evidence, an explicit block, or a rejected
  edit. An ordinary unblocked turn is not labelled successful.
- Normal agent runs create no project improvement log. Persistence requires
  `BANTAM_IMPROVEMENT_LOG_PATH` or `improvementLogPath`; canonical state belongs
  under `.bantam/self-improvements.json`.
- `SelfHealing.diagnose()` is classification-only. `heal()` requires one explicit
  test file or an injected runner, executes without a shell, validates one
  snapshotted candidate at a time, and restores exact bytes and mode on failure.
  Test-file edits are disabled unless explicitly opted into.
- `self-improve-runner.js` is plan-only by default. Its legacy direct writer is
  quarantined behind `--unsafe-direct-write` and is not promotion evidence;
  use `./bin/run-dev.sh self-improve` for managed implementation.
- `playground.js` is a deterministic simulation for testing report mechanics.
  Its results carry `promotionEligible: false`; it does not run the real model or
  agent.

---

## 1. Record — every run is a rewindable specimen

A failure is only useful if you can return to the exact moment it happened.

- **`--save-run <path>`** writes a durable artifact (`src/artifact.js`): the full
  turn trajectory (`{ i, reasoning, rawOutput, parsedAction, protocolViolation,
  observation, ... }`), metrics, sampling, and the harness's own git provenance.
  Raw model output is kept separate from the parsed action; unknown values are
  recorded as `null`, never guessed.
- **`BANTAM_SAVE_PROMPTS=1`** additionally records, per turn, the **exact assembled
  prompt** plus a `modelCallIndex` that links the turn to a **byte-exact recorded
  HTTP request** (grammar, seed, every sampler setting, stop tokens). This is what
  makes a turn replayable with fidelity, not just readable.
- **Crash-safe checkpoint** (`src/run-checkpoint.js`): on `SIGTERM`/`SIGINT` the
  harness flushes a `partial: true` artifact atomically, keeping the same
  prompt/`modelCallIndex` fields — so even a `kill -9`'d or OOM-killed run stays
  rewindable.

> **Working rule #1: stop at the first bad turn.** A failure is a specimen; collect
> it while it is fresh, rather than running the loop to completion hoping it
> recovers.

---

## 2. Rewind — counterfactual replay (`src/replay.js`)

The primitive that makes the whole loop cheap: **replay one turn with an adjusted
context and see whether the decision changes — 30 seconds instead of an 80-minute
rerun and a hypothesis.**

```bash
./bin/run-dev.sh replay <artifact.json> --turn N --inject "the true fact the model was missing"
```

- **`prepareReplay(artifact, turnIndex, { inject })`** looks up the turn. If it has
  a `modelCallIndex` it reconstructs the **byte-exact** request via
  `prepareRequestReplay` (verifying `bodySha256` against the recorded body);
  otherwise it falls back to the recorded prompt string.
- **An injection changes only `body.prompt`** and is explicitly labelled
  `fidelity: "counterfactual"` (versus `"request-exact"` with no injection). On a
  legacy prompt-only artifact the injection lands as a final steering note
  `[replay-injection] …` in the harness's own live-signal voice — never disguised
  as a byte-exact replay.
- **`withSampleSeed(replay, sampleIndex)`** closes a subtle trap: a seeded body
  re-sent N times is "one effective draw wearing three hats." Sample 0 re-sends the
  recorded body exactly; sample N steps the seed, and the baseline and remedy arms
  share the derived seed sequence so they stay **paired** draw-for-draw.
- **`formatReplayComparison` reports three outcomes, not two:** `UNCHANGED`,
  `CHANGED`, and `NO ACTION` (an empty/unparseable completion). The third exists
  because a one-newline reply was once wrongly scored as "decides differently."
  And `CHANGED` is deliberately **not** a synonym for *better* — the verdict states
  what moved and leaves the judgement to you.

This is the mechanized form of working rule #3: *test the counterfactual, don't
argue it.*

---

## 3. Diagnose — witness, remedy, score (`src/diagnose.js`)

`bantam diagnose` mechanizes the manual loop. Three stages, one module.

```bash
./bin/run-dev.sh diagnose <artifact.json>                    # WITNESS: which turns went wrong, and why
./bin/run-dev.sh diagnose <artifact.json> --turn 21 --samples 3   # REWIND + SCORE: A/B a remedy
./bin/run-dev.sh diagnose <artifact.json> --repo <task-repo>      # surface SILENT completeness gaps
```

- **Witness** — `witnessProblems` scans every observation against a table of ten
  distress-signal regexes (`redundant-read`, `duplicate-action`,
  `phantom-replace`, `broken-edit`, `fabricated-api`, `corrupted-oracle`,
  `false-regression`, `regression`, `paging`, `failed-action`); the most specific
  match wins per turn, rolled up into `byKind` and a per-verb failure rate.
- **Remedy** — `CONTEXT_REMEDIES` maps each problem kind to one or more
  **gate-voiced** candidate context strings (the imperative voice the model acts
  on, not an advisory footer it ignores — see [§4](#the-delivery-voice-rule)).
- **Score** — `classifyAction` buckets an output into `recon | productive |
  invalid` (the `productive` set is *derived* from all action verbs minus the recon
  set, so a newly added verb can never silently score as invalid). `scoreRemedy`
  compares the productive-rate of the baseline vs remedy arms and returns a `lift`
  with verdict `promote` (> 0.25) / `harmful` (< −0.25) / `inconclusive`.

`--repo` additionally runs the **completeness critic as a silent-failure witness**
([§4c](#c-the-completeness-critic--silent-structural-gaps)) — the misses that leave
*no* distress signal at all. **Diagnosis prints and scores only; it never writes to
ambient knowledge.**

### Targeting — where to invest next (`bantam analyze`)

Before you diagnose a *single* run, `bantam analyze` tells you which failure class
is worth attacking *across all* runs. Every run appends ~40 **friction counters** to
the eval ledger (`fixtures/ledger.jsonl`) — replace/patch failures by kind, premature
`done` rejections, grounding rejects, progress-gate terminations, query-budget
blocks, protocol salvages, and more. `analyze` keeps the *latest* row per task, sums
the counters, and ranks **nine weighted bottleneck categories** (edit-grounding,
state-grammar, completion-rigor, static-repair, shell-ergonomics, verifier-signal,
progress-awareness, environment, integrity) — each with an evidence string and a
concrete `next` recommendation ("prioritize grounded/copy-constrained edits", "tune
the recon-to-build thresholds"). Crucially it is **freshness-gated**: it trusts only
evidence captured at the *current* harness git SHA, and refuses to recommend —
*"capture fresh eval evidence on the current harness before choosing the next
structural investment"* — when every row is stale. Same honesty as the promotion
gate: measure on the version you actually ship. `analyze` is the loop's *aim* step;
`diagnose` is the *study*.

---

## 4. The learning brain — learn from a stronger agent

The richest source of "the fact the harness wasn't saying" is a **stronger agent's
correct answer sitting next to BANTAM's wrong one on the same task.** BANTAM has
six witnesses, all in `src/logic/`, all pure and unit-tested, all feeding the same
discipline:

> **witness → self-generate a gate-voiced remedy → replay-score at the DONE turn →
> promote only on a novel engagement signal.**

<a name="the-delivery-voice-rule"></a>
Two properties they all share, and both are load-bearing:

1. **The remedy is self-generated** — grounded in the reference's actual content or
   the workspace's own KB. No human writes the remedy table.
2. **The remedy is gate-voiced** — an imperative *"Do not finish yet; define
   `cycle_key` …"*, not an advisory *"FYI, you may have missed …"*. This is the
   **delivery-voice asymmetry**, measured three times: *this 27B acts on a done-turn
   gate rejection but ignores the identical fact delivered as a footer on a success
   observation.* It is why several of these ship as **gates**, not notes.

### (a) reference-witness — learn from a stronger arm's TEXT (`reference-witness.js`)

When a recorded four-arm comparison has a reference arm (claude-code / codex) that
**passed** a task BANTAM **failed**:

- `armPassed` — a clean pass is public-green **and** contract fully green **and**
  zero scope violations.
- `findReferenceDivergence` — bantam failed and a reference passed (preference order
  `claude-code`, then `codex`).
- `diffSolutions` — the first divergent line per editable file, with ±3-line
  excerpts of each side.
- `witnessReferenceGaps` — turns each diff into a gap whose remedy quotes both
  versions: *"You failed the hidden check and `<arm>` passed it — reconcile toward
  the reference before finishing."*
- `scoreReferenceRemedy` — **set difference** over engagement signals (does the
  replayed turn read/edit/search the divergent file?). Promote only on a *novel*
  signal the baseline never showed.

### (b) kb-diff-witness — learn from a stronger arm's KB STRUCTURE (`kb-diff-witness.js`)

Text diffs are right for prose but blind to the shape of code. BANTAM's backbone is
a Datalog KB, so the richer signal on a code task is the **difference between the
two arms' KBs**:

- `snapshotWorkspaceKb(dir)` runs `extractCodeFacts` into a KB and returns
  `{defines, calls, depends, unresolved}`.
- `diffKb` surfaces four structural gap classes a text excerpt hides:
  **missing-definition** (the reference defines a symbol BANTAM never did),
  **missing-call** (the reference calls a real symbol BANTAM left unwired — *"even
  though you define it, the behavior is unwired"*), **extra-unresolved** (BANTAM left
  a broken import the reference resolved), **missing-dependency** (an import edge the
  reference wired). This is the SWE-bench *"missing `cycle_key()` call the issue
  never named"* shape.
- `kbStructuralForecast` is the **reference-free sibling**: BANTAM's own unresolved
  relative imports are, at the DONE turn, forecastable load failures. Exposed as
  `bantam forecast [dir]`.
- `scoreKbRemedy` — the same novel-signal set-difference; the strongest signal is
  `wire:<symbol>` (an edit whose text introduces the missing symbol).

### (c) the completeness critic — silent structural gaps (`completeness-critic.js`)

One KB-driven engine, five auditable *Challenge* kinds (each carries the fact
records that justify it), generalizing the ten SWE-bench mechanisms:

- **detectSiblings** — an edited symbol is also defined in other, unvisited files.
- **detectCrossFileReaders** — a *file-scoped* search hid the symbol's readers
  outside that scope.
- **detectFamily** — a new definition whose name is an affix-variant of an existing
  pair whose implementations were never opened.
- **detectPeers** — an edit assigns a rare KB constant that peer functions also
  write; their adjacent step is the omitted one (the `cycle_key` case).
- **detectTransitiveDependents** — files that transitively depend on the edited file
  via the KB's `reaches` rule, unexamined.

Its companion `critic-witness.js` (`witnessCompletenessGaps`) turns the critic into
a **silent-failure witness** for `diagnose --repo`: it walks a run's turns and keeps
only challenges whose site the model **never visited** — real misses with no
distress signal — landing each remedy at the **DONE turn**, exactly where the live
gate fires.

### (d) continuity-anchors — the prose analog of the KB (`continuity-anchors.js`)

`continuityAnchors(text)` indexes same-noun / same-attribute conflicts (two
quantities, two materials) as candidates to reconcile.
`continuityReconcileObjection` is the **done-gate** that catches both the *missed*
and the *half-fixed* conflict, bounded so it can never trap. This is the worked
example of the delivery-voice rule from this project's own history: the read-time
advisory was ignored ~⅔ of the time and did not move the pass rate; the gate flips
the decision and catches the half-fix the advisory could not (measured **ON 4/5 vs
OFF 3/5**, mechanism-verified).

### The unified witness path — `diagnose --compare`

```bash
./bin/run-dev.sh diagnose --compare <recorded-four-arm-directory>
```

Given a recorded four-arm directory, this prints **both** textual gaps
(reference-witness) *and* structural KB gaps (kb-diff-witness), and emits candidate
remedies. This checkout does not include the older standalone scorer drivers named
in historical reports. A gap becomes trusted only after it is preregistered and
measured with the experiment path below; witness output alone is not promotion
evidence.

### (e) Sol/Terra teacher council — propose causes and tests (`teacher-collaboration.js`)

The reference witnesses above derive remedies directly from final text and KB
structure. Some failures need a more semantic collaborator: *why* the local
trajectory failed, which harness mechanism could prevent the class, and what
adversarial test would falsify that proposal. The teacher council handles this
without turning a frontier model into an unreviewed author:

```bash
./bin/run-dev.sh collaborate \
  local-run.json sol-run.json terra-run.json \
  --grades local=3/10,sol=9/10,terra=10/10 \
  --yes
```

The input artifacts must contain the exact same task. Automatic consultation is
local-first: a failed result, external grade gap, excessive turns, or recorded
friction signal is required. `--proactive` is the explicit operator override
for a clean run. `--yes` is a separate data-egress consent gate.

One immutable, bounded packet is constructed from task, outcomes, selected
metrics, and the newest trajectory turns. Credentials are redacted before it
leaves the process. Sol and Terra then:

1. independently return a strict-schema diagnosis, general harness hypotheses,
   falsification criteria, and adversarial-test designs;
2. review the other teacher's hypotheses by exact stable slug;
3. contribute only hypotheses that every independent reviewer accepts.

The resulting report is canonicalized, SHA-256 bound, and stored beneath
`.bantam/teacher-collaboration/reports/`. Tampered or malformed reports are
ignored. Accepted hypotheses are merged into `self-improve --plan` as
`source: teacher-collaboration`, **build-only** candidates. The normal frozen
target policy, private implementation lane, immutable candidate verification,
and protected baseline suite apply if one is explicitly built.

This is deliberately not a shortcut around the scientific loop. Consensus can
select a plausible mechanism and design a good experiment; it cannot prove
behavioral lift. Teacher candidates therefore cannot deploy or advance
`regular` until counterfactual replay and a preregistered paired fresh-task
experiment provide the evidence accepted by the existing promotion gate.

---

## 5. The exploratory four-arm comparison (`src/logic/compare-plan.js`)

`compare` runs `bantam-dev`, `bantam-regular`, `claude-code`, and `codex` on one
task. Before any arm starts it rejects authored source symlinks, freezes one source
workspace, and gives every arm a different clone of that baseline. It verifies
each starting tree and rechecks that the frozen baseline remains unchanged after
every arm. Declared `editable` prefixes are normalized, used for scope grading,
and persisted in the summary.

External reference arms spend money and send task/workspace context to their
services, so they require explicit `--allow-unsafe-competitors`.

This command is intentionally **exploratory**, not promotion evidence. The direct
front door does not itself materialize two channel-pinned Bantam harness versions;
without a separate pinned runner, its two Bantam labels use this checkout's
runtime. Promotion-grade claims must use the preregistered experiment path in
[§7](#7-experiments--the-measured-ab-srcexperimentjs), whose manifest is the only
comparison format accepted by `channel promote --evidence`.

---

## 6. Channels & evidence-gated promotion

This is what keeps self-improvement *reversible* and *honest*. The harness has two
channels — **`regular`** (the vetted, stable line) and **`dev`** (the working
line) — and they are the only two.

- **Model.** A channel is a compare-and-swap pointer to an immutable,
  content-addressed version record. Every move appends a **hash-chained,
  parent-linked, immutable channel event** and CAS-advances the ref. Rollback is
  safe because history is walkable and a target's membership in a channel's own
  history is provable.
- **`channel checkpoint <name>`** captures the working harness and advances a
  channel, with a stale-ref guard (refuses if the ref moved under you).
- **`channel promote`** (dev → regular) is the gate. It **requires** either
  `--evidence <experiment>` **or** an explicit `--allow-unevidenced`; neither is a
  usage error, both is a conflict. The channel event records which path was taken —
  **an unevidenced promotion can no longer happen silently.**
- **The evidence gate** (`validatePromotionEvidence`) re-normalizes the persisted
  `spec.json`, rebuilds the declared schedule, checks every fixture identity and
  terminal sample, and recomputes totals instead of trusting manifest summaries.
  Both `complete` and `complete_with_failures` experiments are admissible so a
  failed reference can demonstrate a real recovery. The candidate still needs at
  least one passing sample, zero scope/integrity violations, zero infrastructure
  errors, and `delta.passed ≥ 0` plus `delta.passRate ≥ 0` versus the reference.
  Evidence must also bind to the exact dev version ref and workspace tree being
  promoted. Anything weaker must be said out loud via the audited waiver.
- **`channel rollback <name> --expected CUR --to PRIOR`** validates the target is in
  history and appends a `channel.rolled_back` event. Rejected descendants stay as
  immutable evidence — nothing is lost.
- **Harness pinning at launch** (`channel-launcher.js`): a pinned channel version is
  materialized into a fresh private dir, its tree re-hashed against the recorded git
  tree (**fails if bytes differ**), all symlinks rejected, `NODE_OPTIONS`/`NODE_PATH`
  stripped, recursive launches blocked, and dependencies accepted **only** from a
  checkout whose `package.json`+lockfile bytes match the pinned tree. A lane runs
  the exact harness version it pinned — byte-for-byte, no shell.

These checks make accidental drift, stale evidence, and inconsistent local edits
fail closed. The local state and evidence files are not externally signed, so they
are not a security boundary against an operator who can deliberately rewrite the
entire Bantam state store.

> **Self-evolution, not self-mutation.** Every change is measured, tracked, and
> reversible. A difficulty is studied, a remedy A/B'd, promoted only if it clears
> its declared bar, and the whole history kept so nothing is lost.

---

## 7. Experiments — the measured A/B (`src/experiment*.js`)

An experiment is the preregistered form of "measure before and after."

- **Versioned spec** (`schema: 1`): `fixtures`, `rounds` (1–50), `seeds` (one per
  round, unique), `passAtK`, 2–8 named `arms`, plus `thinkMode`/`preGate`/`planMode`
  and `stopOnFailure`. Each arm is `{ env (BANTAM_* only), model, skills }`, and
  **arm skills are retrieval-only with distillation forced off** — a run can't mutate
  the skills library mid-experiment and leak lessons across arms.
- **Arm rotation** — each round rotates the arm order so first-arm cache and
  server-state bias are balanced; use at least two rounds and one unique seed per
  round to give corresponding arm runs the same deterministic sampling sequence.
- **Manifest & scoring** — the manifest stamps `specSha256` (what the promotion gate
  binds to). Summaries compute per-arm totals, **unbiased pass@k**, **Wilson 95%
  intervals**, and `compareArms` deltas of every candidate arm versus the reference
  arm — the exact `delta.passed` / `delta.passRate` the evidence gate reads.
- **Crash-safe resume** — the manifest, `summary.md`, and `ledger.jsonl` are
  persisted after every run; an interrupted experiment resumes at the first missing
  fixture against the same spec and harness revision.
- **Promotion provenance** — a direct `experiment` run does not claim a channel
  version. For promotion-grade evidence, `channel experiment` materializes the
  exact pinned harness, verifies its content-addressed tree, passes private launch
  provenance to that process, and stamps the independently resolved channel,
  version, commit, and tree into the manifest. Resume requires the same binding.

An experiment directory contains `manifest.json`, `spec.json`, `summary.md`,
`ledger.jsonl`, and `runs/<arm>/round-NN/<fixture>-<runId>.json`.

This checkout does not ship the older `comparison/runners/harness-ab.js` helper.
Use the experiment command with real fixture directories for measured evidence;
use `compare --dry-run` only to inspect an exploratory four-arm plan.

---

## 8. The end-to-end story

1. **A difficulty is hit.** A run recorded with `--save-run`/`BANTAM_SAVE_PROMPTS=1`
   (or a four-arm comparison) leaves a crash-safe specimen: every turn's exact
   prompt and byte-exact request.
2. **Studied at the failing turn.** `bantam diagnose` witnesses the bad turns
   (distress signals) and — with `--repo`/`--compare` — the *silent* structural gaps
   (completeness critic, reference-witness, kb-diff-witness), each carrying auditable
   KB evidence and a self-generated, gate-voiced remedy.
3. **A remedy proposed and A/B'd.** `prepareReplay` + `withSampleSeed` rewind the
   exact DONE/failing turn and re-ask the live model N times, baseline vs remedy, in
   ~30 s. Scoring is set-difference over engagement signals — promote only when the
   remedy introduces a site-relevant engagement the baseline never showed.
4. **Promoted only if it clears its bar.** A measured winner is preregistered in an
   experiment manifest; `channel promote --evidence <experiment>` passes only if the
   candidate does not regress the reference, otherwise an audited `--allow-unevidenced`
   waiver is stamped into the immutable event.
5. **A revertible trail is kept.** Every channel move is an immutable, parent-linked,
   hash-chained event; `channel rollback` returns to any in-history version; rejected
   descendants stay as evidence; pinned harnesses relaunch byte-exact.

### Canonical proofs

- **The `parseArgs` byte-identical rewrite** (see [`PRINCIPLES.md`](PRINCIPLES.md)) —
  the model rewrote a buggy argument parser three times, *byte-for-byte identically*;
  it could not see the flaw and was one edit from a "reasoning-ceiling" verdict. We
  rewound to the stuck turn and injected one sentence — *"`--json` is a boolean flag;
  it takes no value, so `--json <task>` must not consume the task"* — and the model
  produced the correct fix on the first try in all three samples. The fact it needed
  was already in its own `usage()` string; the harness just never connected it. Not a
  reasoning limit — a context omission, proven by counterfactual replay.
- **SWE-bench Verified 1/7 → 7/7** — real django/sympy/flask bugs, closed in one
  session, every failure context not capability. The ten recorded-specimen mechanisms
  are now generalized into the completeness critic's five kinds and the kb-diff
  `missing-call` shape. Full write-up in
  `superpowers/reports/2026-07-17-swebench-verified-harness-round.md`.
- **The continuity done-gate (this session)** — the read-time advisory was ignored
  ~⅔ of the time and moved the pass rate not at all; the same fact as a **done-gate**
  flipped the decision and caught the half-fixed conflict the advisory missed
  (measured ON 4/5 vs OFF 3/5, mechanism-verified, zero false bounces). A textbook
  run of the whole loop: hypothesis → measured (advisory failed) → dug into context →
  built the real lever → measured again → kept opt-in pending broader validation.

---

## 9. Quick reference — driving the loop yourself

When working in this development checkout, invoke its launcher explicitly. A
global `bantam` command may resolve to a different installed build.

```bash
# Record a rewindable run
BANTAM_SAVE_PROMPTS=1 ./bin/run-dev.sh run --task "…" --workspace . --verify "npm test" \
  --autonomous --save-run .bantam/runs/mytask.json

# Witness what went wrong, then A/B a fix on the exact failing turn
./bin/run-dev.sh diagnose .bantam/runs/mytask.json
./bin/run-dev.sh diagnose .bantam/runs/mytask.json --turn 21 --samples 3
./bin/run-dev.sh replay   .bantam/runs/mytask.json --turn 21 --inject "the missing fact"

# Forecast whether this workspace will finish soundly
./bin/run-dev.sh forecast .

# Inspect the isolated four-arm plan without starting any model or competitor
./bin/run-dev.sh compare "<task>" --dry-run

# Turn same-task local/Sol/Terra artifacts into cross-reviewed build-only hypotheses
./bin/run-dev.sh collaborate local.json sol.json terra.json \
  --grades local=3/10,sol=9/10,terra=10/10 --yes

# After adding the fixture directories named by a preregistered spec
./bin/run-dev.sh experiment path/to/spec.json --dry-run

# Run promotion-grade evidence through the exact pinned dev harness
./bin/run-dev.sh state init --source .
./bin/run-dev.sh channel checkpoint dev --source . --expected <current-dev-version>
./bin/run-dev.sh lane create experiment-lane --channel dev --workspace .
./bin/run-dev.sh channel experiment dev --lane experiment-lane \
  --expected <dev-version> --dependency-root . -- \
  path/to/spec.json --output .bantam/experiments/<id>

# Promote dev → regular only with validated, exactly bound experiment evidence
./bin/run-dev.sh channel promote --from dev --to regular \
  --evidence .bantam/experiments/<id>
./bin/run-dev.sh channel rollback regular --expected <cur> --to <prior>
```

---

## Same-task model evidence: local, Sol, and Terra

The built-in model gauntlet is now a first-class source of self-improvement
evidence. It runs the same hidden-contract repairs through the local model and
Codex Sol/Terra while keeping BANTAM's harness, tools, starting bytes, and
grader constant:

```bash
./bin/run-dev.sh gauntlet --models local,sol,terra --rounds 3 --faults
```

Each run preserves the full trajectory, final grade, turns, requests,
input/output/cache/reasoning accounting, failures, and workspace artifact.
This makes it possible to ask where a stronger trajectory diverged instead of
merely copying its final patch.

When a local artifact and passing Sol/Terra artifacts came from the same task,
the teacher council can collect independent diagnoses, adversarial tests, and
reciprocal reviews:

```bash
./bin/run-dev.sh collaborate local.json sol.json terra.json --yes
```

The result is a hash-bound, build-only candidate. It does not edit the live
channel or count teacher agreement as proof. The governed controller still
requires a private lane, immutable tests, and paired held-out evidence before
promotion. This lets hosted models act as ambitious collaborators while local
Qwen remains the default operating model.

The full architecture, measured 2026-07-25 results, limitations, and next
experiment are documented in
Local Qwen + Codex Sol/Terra integration and model gauntlet.

---

## See also

- [`PRINCIPLES.md`](PRINCIPLES.md) — *it's the context, not the model*: the method,
  the evidence table, and the manual→mechanized diagnose loop.
- [`GUIDE.md`](GUIDE.md) — how to run BANTAM and how the core harness works.
- [`GROUNDING_TOOLS.md`](GROUNDING_TOOLS.md) — the Datalog KB and the symbolic tools
  the learning brain is built on.
- `superpowers/` — the measured upgrade program and its
  reports (the reference-witness, structural-witness, escalation & showcase rounds).
