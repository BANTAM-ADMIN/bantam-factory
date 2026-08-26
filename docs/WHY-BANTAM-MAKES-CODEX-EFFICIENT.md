# Why Codex Works Efficiently Inside BANTAM

## Executive conclusion

BANTAM is not merely a compatibility wrapper around Codex. It is a specialized
coding-agent control system that removes work Codex would otherwise need to
discover, plan, execute, observe, and verify for itself.

In the first controlled same-task experiment, BANTAM-constrained Sol and Terra
both passed the same public and hidden contracts as their native Codex CLI
counterparts while completing faster and processing substantially fewer total
tokens:

- **Sol-high:** BANTAM used 106,312 input tokens versus 714,354 natively and
  finished in 46.4 seconds versus 3 minutes 30 seconds.
- **Terra-medium:** BANTAM used 97,634 input tokens versus 132,528 natively and
  finished in 31.9 seconds versus 58.1 seconds.

BANTAM reduced Sol's reported input by 85.1%, output by 83.4%, reasoning output
by 89.7%, and elapsed time by 77.9%. For Terra, it reduced reported input by
26.3%, output by 53.7%, reasoning output by 60.5%, and elapsed time by 45.1%.

All five tested paths—local BANTAM, BANTAM Sol, BANTAM Terra, native Sol, and
native Terra—passed the hidden ordered-map contract. The efficiency difference
was therefore not purchased by accepting an incorrect result.

This evidence establishes the current operating policy:

> **Use Codex inside BANTAM for ordinary work. Native Codex CLI delegation is a
> research-only comparison surface and requires explicit consent.**

The result is one bounded repair, not a universal theorem. Native Codex may
still prove advantageous on sufficiently broad or long-horizon work. Until
repeated evidence demonstrates such a crossover, BANTAM remains the default.

## The important finding, stated precisely

It is tempting to summarize the result as “Codex is better inside BANTAM than
inside Codex.” That phrasing captures the surprise, but it combines several
different claims.

The experiment supports these claims:

1. **The complete BANTAM-plus-Codex system was more operationally efficient**
   than the native Codex CLI control on this task.
2. **The BANTAM system reached the same independently verified correctness**
   with less elapsed time, total input processing, generated output, and
   reasoning output.
3. **BANTAM made Codex's trajectory more explicit and governable.** Six bounded
   decisions can be inspected separately, compared across models, replayed,
   and connected to exact observations.
4. **Frontier models benefit from harness engineering.** External state,
   constrained actions, deterministic verification, and explicit terminal
   conditions are not merely compensations for weak local models.

The experiment does **not** establish these stronger claims:

- BANTAM changed the underlying Codex model or increased its raw intelligence.
- BANTAM Codex produced a more correct solution than native Codex; both passed.
- BANTAM will outperform native Codex on every repository or task class.
- provider-reported token totals map directly to subscription quota or dollars.
- six BANTAM requests are inherently cheaper than one native outer turn.

The correct unit of comparison is the whole problem-solving system:

```text
model
+ prompt and context policy
+ action space
+ tools and observations
+ memory and state representation
+ recovery policy
+ verification
+ stopping rule
= observed agent performance
```

The same model can perform very differently when the rest of that equation
changes. This is the central architectural finding.

## “Natural harness” versus specialized harness

Native Codex is a general coding agent. A native `codex exec` run is designed
to accept a goal, explore a workspace, use native tools, edit files, run
commands, reassess the result, and finish without an application-specific
controller prescribing every intermediate move.

That generality is a capability. It allows Codex to handle:

- unfamiliar repository structures;
- broad tasks whose solution path is not known in advance;
- arbitrary shell and development tools;
- long-horizon exploration;
- native subagents and other native runtime features;
- workflows not represented in BANTAM's current protocol.

BANTAM is specialized. It uses Codex as the decision-making component inside a
coding loop whose state, actions, execution, evidence, and terminal conditions
are substantially predefined.

The native harness therefore solves two problems at once:

1. the user's software problem; and
2. the meta-problem of how to operate as an agent in the current environment.

BANTAM solves much of the second problem in deterministic code. Codex can spend
more of its inference on the first.

This is why the native harness should not be called defective or wasteful in
the abstract. It pays a generality tax. On tasks that fit BANTAM well, that tax
can be unnecessary. On tasks outside BANTAM's competence envelope, the same
generality may become an advantage.

## What “more efficient” means here

The comparison measures several distinct resources:

1. **Elapsed task time** — wall-clock time from task start to candidate.
2. **Input tokens** — provider-reported input processed across the run.
3. **Cached input tokens** — the provider-reported portion served from cache.
4. **Cache-miss tokens** — input minus cached input for Codex runs.
5. **Output tokens** — generated model output.
6. **Reasoning-output tokens** — provider-reported reasoning output.
7. **Outer requests** — BANTAM completions or native `codex exec` turns.
8. **Correctness** — public verification plus a held hidden contract.

These should not be collapsed into one invented score. Cached input can be
cheaper to process than uncached input, and subscription limits are not
necessarily debited as a simple sum of these counters. Local llama.cpp cache
reporting is also not equivalent to Codex cached-input reporting.

The defensible statement is:

> BANTAM completed the measured work faster, with less total provider-reported
> token processing, less generated output, and less reasoning output.

Native Terra had fewer Codex cache-miss tokens than BANTAM Terra—14,512 versus
22,626—even though its total input, output, reasoning, and elapsed time were
higher. BANTAM preserves every counter instead of claiming that total input is
identical to cost or quota consumption.

## The same-task evidence

Task:

> Fix `src/ordered-map.js`. Implement bounded concurrency, preserve result
> order, support empty input, reject invalid concurrency, and do not modify
> tests or package configuration.

Every arm started from the same fixture bytes. Every candidate ran the public
test. A separate hidden grader checked delayed out-of-order completion,
concurrency limits, empty input, and invalid inputs.

| Execution path | Effort | Result | Turns | Requests | Input | Cache hit | Cache miss | Output | Reasoning | Time |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Native Sol delegate | high | strict pass | 1 | 1 | 714,354 | 676,608 | 37,746 | 7,664 | 2,478 | 3m 30s |
| Native Terra delegate | medium | strict pass | 1 | 1 | 132,528 | 118,016 | 14,512 | 2,541 | 468 | 58.1s |
| BANTAM local Qwen | local | strict pass | 8 | 11 | 29,787 | 31,994* | n/a | 2,208 | 0 | 32.7s |
| BANTAM-constrained Sol | high | strict pass | 6 | 6 | 106,312 | 67,584 | 38,728 | 1,270 | 256 | 46.4s |
| BANTAM-constrained Terra | medium | strict pass | 6 | 6 | 97,634 | 75,008 | 22,626 | 1,176 | 185 | 31.9s |

\* Local cache accounting is a different contract and is not used for Codex
cache-miss rankings.

### Relative result: Sol

Compared with native Sol-high, BANTAM Sol-high:

- processed 608,042 fewer input tokens;
- generated 6,394 fewer output tokens;
- reported 2,222 fewer reasoning-output tokens;
- finished 163.6 seconds sooner;
- used six narrow BANTAM decisions instead of one opaque outer native turn;
- passed the same hidden correctness contract.

Although the native run is labeled as one turn, its JSONL shows multiple agent
messages and six completed commands. “One native turn” means one outer
conversation turn, not one inference or one decision.

### Relative result: Terra

Compared with native Terra-medium, BANTAM Terra-medium:

- processed 34,894 fewer input tokens;
- generated 1,365 fewer output tokens;
- reported 283 fewer reasoning-output tokens;
- finished 26.2 seconds sooner;
- passed the same hidden correctness contract.

Native Terra's advantage was cache misses: it missed on 14,512 input tokens
versus BANTAM Terra's 22,626. Its other measured operational counters were
higher.

## The central mechanism: BANTAM reduces the search problem

Native Codex receives a goal and a general tool environment. It must repeatedly
decide what to inspect, which tool to invoke, how to invoke it, whether an
observation is sufficient, whether to revise its plan, how to edit, what to
test, and whether the task is complete.

BANTAM turns much of this open-ended search into a prepared decision problem.
Codex selects one action from a bounded typed protocol while BANTAM supplies
the machinery around it.

This changes the model's job from:

> “Operate an entire coding environment and continually decide how to operate
> it.”

to:

> “Given this exact state and evidence, choose the next useful bounded action.”

That reduction in branching is the main efficiency mechanism.

## A cognitive-economics view

Every agentic step consumes more than the tokens visible in its final answer.
The agent must allocate attention among possible next actions, maintain a model
of the workspace, interpret tool results, remember unresolved obligations,
decide whether evidence is adequate, and determine whether to continue.

These are useful cognitive operations, but many are repetitive and
mechanizable. BANTAM converts them from inference-time questions into software
invariants.

| Agent responsibility | Native general agent | BANTAM-constrained Codex |
| --- | --- | --- |
| Discover available operations | Model/tool surface | Fixed typed protocol |
| Decide how to inspect | Model | BANTAM actions and bounded observations |
| Preserve run state | Native thread/model context | Explicit harness state |
| Construct shell mechanics | Often model-generated | Executor-owned where possible |
| Validate action shape | Runtime/tool failure | Schema before execution |
| Detect stale workspace | Model may rediscover | Generation/coherence checks |
| Select authoritative tests | Often model judgment | Frozen verifier policy |
| Interpret pass/fail | Model plus command output | Exit status and evidence gates |
| Decide completion | Model judgment | Model proposal plus harness admission |
| Record telemetry | Runtime-dependent | Unified BANTAM artifact |

The right question is not simply “How many calls did the model make?” It is:

> How much uncertain cognitive work did each call have to perform?

One broad native turn can contain many internal decisions, commands, assistant
messages, reconsiderations, and large context updates. Several narrow BANTAM
calls can still process less total material because each call is conditioned on
a smaller, more explicit decision surface.

## Why constraints can improve observed capability

Constraint is often mistaken for capability loss. Some constraints do remove
useful options, but well-designed constraints remove mostly invalid,
duplicative, or low-value branches.

Consider a repair after reading the relevant function. A general agent might
still choose among:

- reading unrelated files;
- searching globally;
- running a broad test suite;
- constructing an ad hoc script;
- explaining a plan;
- editing with several different mechanisms;
- reconsidering project architecture;
- asking whether it has enough information;
- implementing the localized fix.

A task-aware constrained harness can make the useful subset much more salient.
The model is not forced to be less intelligent. It is relieved from repeatedly
proving that irrelevant branches are irrelevant.

This produces four capability effects:

### 1. Reduced branching factor

Fewer legal next moves make action selection easier and more reliable. The
model spends less inference distinguishing among mechanically equivalent
operations.

### 2. Reduced state ambiguity

Explicit read sets, edit sets, verifier status, task intent, and completion
blockers reduce uncertainty about what has happened and what remains.

### 3. Reduced error surface

Typed actions prevent missing fields, invalid path shapes, unsupported verbs,
and some unsafe operations before they reach the workspace.

### 4. Stronger terminal semantics

“Done” becomes an evidence-backed state transition rather than a persuasive
sentence. That can prevent both premature termination and unnecessary
continuation.

Constraints are beneficial while they preserve the actions required by the
task. Once the required action lies outside the protocol, the benefit can
reverse abruptly. This boundary is why BANTAM retains—not deletes—the native
control.

## 1. A closed action vocabulary

BANTAM gives Codex a strict action schema rather than a general prose-and-tools
surface. Inspection, reading, replacement, shell verification, and completion
have explicit fields and validation.

Consequences:

- fewer tokens are spent inventing shell syntax or narrating a tool plan;
- malformed or disabled operations are rejected deterministically;
- the model does not rediscover how to express common operations;
- BANTAM attaches action-specific evidence and safety policy;
- equivalent Local, Sol, and Terra actions remain directly comparable.

Native flexibility is valuable when a task needs it, but flexibility increases
the number of possible next moves. On a bounded repair, most have no value.

## 2. BANTAM owns repository observation

BANTAM's tools return bounded structured observations:

- repository maps and symbol-oriented queries;
- paged file reads and path-scoped search;
- batched read-only inspection;
- changed-path and workspace-coherence evidence;
- focused verification output;
- bounded failure digests.

The model receives the useful result without building a bespoke shell pipeline,
interpreting terminal decoration, or deciding how much raw output to retain.
Higher-signal observations reduce context size and unnecessary recovery turns.

## 3. Stable prompts and exact deltas

BANTAM's Codex transport uses one run-scoped app-server thread and sends one
full canonical prompt followed by exact prompt deltas. It rebases only when
configured or delivery efficiency degrades.

For the constrained controls:

- Sol used six calls, one thread, and five exact delta calls;
- Sol reduced delivered prompt characters by 49.1%;
- Terra used six calls, one thread, and five exact delta calls;
- Terra reduced delivered prompt characters by 47.4%;
- offline reconstruction passed 6/6 for each run.

BANTAM avoids repeatedly delivering full assembled state while retaining an
exact auditable canonical prompt.

## 4. Harness state replaces model narration

BANTAM records action history, read/edit evidence, verification, state audits,
completion blockers, workspace generation, retry patterns, and request
telemetry. The model does not maintain all of this as free-form prose.

BANTAM reconstructs the next prompt mechanically and consistently. The
experiment shows that frontier Codex models, not only local models, benefit
from externalized orchestration state.

## 5. Verification is deterministic infrastructure

Native agents can spend model work deciding what to test, interpreting it, and
deciding whether to test again. BANTAM knows the authoritative verifier before
the task begins. It:

- detects project test commands;
- uses pipefail-safe execution;
- captures exit status independently of output filters;
- separates infrastructure failure from task failure;
- runs hidden contracts in gauntlets;
- rejects unverified completion when proof is required.

Codex produces the candidate. The harness determines whether it passes.

## 6. Completion is externally governed

BANTAM does not accept “looks done.” It can require changed source bytes,
passing verification, focused edge evidence, resolved state audits, and task
intent compliance.

This prevents both premature completion and open-ended self-questioning. The
model has a clear terminal condition: satisfy the explicit evidence gate.

## 7. Recovery is typed and targeted

When an action fails, BANTAM provides a compact recovery observation: exact
replacement mismatch, patch failure, repeated outcome, stale workspace,
malformed output, verifier digest, or gate rejection.

The next call receives a failure class rather than reconstructing a long
conversational story. Recovery becomes another bounded decision.

## 8. Task intent suppresses irrelevant work

Advisory requests disable mutation actions and automatic verification and
require an unchanged workspace. Implementation requests enable edit, progress,
audit, and verification policy.

This prevents models from editing files and running entire suites when the user
asked only for analysis or suggestions.

## 9. One harness makes models comparable

Local Qwen, Sol, and Terra share the same protocol. BANTAM can compare inspected
paths, first-action divergence, action count, verification timing, repeated
operations, output usage, and final correctness.

Codex trajectories can improve the local harness as measurable policies,
tests, context changes, or action affordances rather than opaque imitation.

## 10. BANTAM removes duplicated agency

Native delegation creates two governance layers:

```text
BANTAM outer controller
└── native Codex agent
    ├── planning and tool selection
    ├── repository observation and editing
    ├── verification decisions
    └── completion decisions
```

Constrained mode assigns each responsibility once:

```text
BANTAM
├── context and repository observation
├── action protocol and execution
├── workspace policy
├── verification and completion gates
├── telemetry and artifacts
└── Codex
    └── next bounded decision
```

Codex supplies judgment. Deterministic software supplies bookkeeping,
execution mechanics, and evidence.

## BANTAM as a cognitive exoskeleton

A useful mental model is that BANTAM acts as a cognitive exoskeleton around the
model.

The exoskeleton does not supply the model's semantic understanding. Codex still
has to:

- understand the user's intent;
- identify relevant code and behavior;
- infer the likely defect;
- choose among plausible repairs;
- understand test failures;
- recognize edge cases;
- decide which bounded action advances the task.

BANTAM supplies structure around those judgments:

- a map of legal motion;
- memory that does not depend on conversational prose;
- sensors that return bounded observations;
- actuators with validated arguments;
- reflexes for common failure classes;
- an external balance system for workspace coherence;
- an objective finish line.

The combination can outperform a more autonomous system for the same reason
that a skilled operator can perform better with a specialized instrument than
with unrestricted raw materials. Generality is exchanged for leverage.

This framing also explains why BANTAM is more than a prompt. A prompt may ask
the model to behave systematically, but BANTAM implements the system outside
the model. The distinction matters:

```text
Prompted discipline:
  “Remember to verify, avoid repetition, preserve state, and stop correctly.”

Implemented discipline:
  The verifier, repetition detector, state store, path policy, and completion
  gate exist whether or not the model remembers them.
```

Implemented discipline is cheaper to repeat, easier to test, and less sensitive
to context pressure.

## Where Codex intelligence is being spent

BANTAM is not trying to replace frontier reasoning with a fixed state machine.
It is trying to concentrate frontier reasoning where deterministic code is
least adequate.

The intended division is:

```text
Deterministic when known:
  path validation
  action parsing
  workspace mutation
  output bounding
  verifier execution
  exit-code interpretation
  state bookkeeping
  evidence persistence

Model-driven when judgment is required:
  intent interpretation
  localization
  semantic diagnosis
  repair selection
  unfamiliar failure interpretation
  tradeoff reasoning
  explanation
```

If BANTAM asks Codex to decide something deterministic software already knows,
it wastes model capacity. If BANTAM hard-codes a decision that requires semantic
judgment, it cripples the model. The architecture succeeds by moving that
boundary carefully.

## Why more outer calls did not mean more total work

The constrained Sol run used six BANTAM requests while the native delegate was
reported as one outer turn. This can look paradoxical until the measurement
levels are separated.

The native outer turn contained:

- eight completed agent messages;
- six completed commands;
- repository inspection;
- implementation;
- verification;
- reconsideration;
- a second edit;
- another verification cycle.

The native “one” is a session-level count. It is not evidence of one inference,
one decision, one tool operation, or one prompt-sized unit of work.

The BANTAM run exposed six protocol decisions as six measured requests. Each
request received a prepared state and returned one bounded action. Exact prompt
deltas prevented the full canonical state from being resent after every
decision.

Therefore:

```text
request count ≠ cognitive work
outer turn count ≠ inference count
input tokens ≠ cache misses
total tokens ≠ subscription quota
```

The experiment reports all available counters precisely because no single one
captures the entire resource contract.

## Why native Sol was especially expensive

Native Sol produced eight completed agent messages and six completed commands.
Its transcript included environment characterization, inspection,
implementation, verification, edge-case reconsideration, a second edit, and
another verification.

BANTAM Sol made six constrained requests: inspect, read, replace, focused
verification, formal verification, and done. The sequence was not necessarily
smarter in the abstract; it was better shaped for this job.

## Efficiency, effectiveness, and legibility

The finding has three separate dimensions.

### Efficiency

BANTAM used less measured time, input, output, and reasoning output on the
ordered-map control.

### Effectiveness

Every compared route passed the same public and hidden contract. BANTAM
preserved effectiveness while improving measured efficiency. This experiment
does not show superior correctness because the verifier saturates at pass.

Future tasks with partial grades, mutation coverage, or adversarial contracts
may distinguish solution quality beyond a binary pass.

### Legibility

BANTAM's trajectory is easier to inspect:

- each action has a typed purpose;
- each observation is attached to a known action;
- failures have categories;
- verifier evidence is separate from model assertions;
- Local, Sol, and Terra trajectories share a vocabulary;
- prompt delivery and token accounting are retained;
- the final candidate is bound to reproducible evidence.

Legibility is itself an engineering advantage. It makes failures diagnosable
and successful strategies teachable.

## Implications for the local model

The most important long-term implication may not be hosted-model efficiency. It
may be the evidence that a strong harness can move capability from model weights
into reusable infrastructure.

The local Qwen model cannot acquire Sol's latent knowledge merely by sharing an
action protocol. But it can inherit systematic advantages discovered through
Sol and Terra runs:

- better context selection;
- clearer action affordances;
- stronger recovery observations;
- improved stopping conditions;
- focused tests for recurring blind spots;
- heuristics for effective action ordering;
- detectors for repeated or low-information behavior;
- repository queries that replace expensive manual exploration.

This is a form of system-level improvement, not neural-weight training.

The loop is:

```text
same task
   ├── local trajectory
   ├── Sol trajectory
   └── Terra trajectory
          ↓
compare actions, evidence, failures, time, and tokens
          ↓
identify a repeatable difference
          ↓
encode the difference as context, tool, policy, test, or verifier
          ↓
rerun local and frontier controls
          ↓
promote only if held evidence improves
```

The crucial step is encoding only generalizable mechanisms. Copying a frontier
model's answer teaches one fixture. Adding a better symbol query, recovery
signal, or verification gate can improve every future local run with the same
structural need.

## Implications for self-improvement

This finding gives BANTAM's self-improvement system a sharper objective.
BANTAM should not merely ask stronger models to propose more features. It
should search for places where model inference is performing work that can be
made:

- deterministic;
- reusable;
- observable;
- cheaper;
- independently testable.

High-value improvement candidates often have this shape:

> “Sol succeeded because it inferred X from evidence Y. Can BANTAM expose Y
> more directly, test for X, or make the useful next action easier for every
> model?”

Examples:

- If Sol localizes immediately while local Qwen performs five broad reads, add
  a repository query or localization packet—not a fixture-specific hint.
- If Terra recovers from a replacement mismatch using nearby anchors, return
  those anchors automatically in the failure observation.
- If all models repeatedly run an expensive broad suite before a focused test,
  improve test targeting and verification staging.
- If native Codex benefits from a tool absent from BANTAM, either add a safe
  bounded equivalent or mark that task class as a native-routing candidate.

The frontier models become collaborators in harness design and experimental
controls, while promotion remains governed by code and evidence.

## A capability-envelope model

BANTAM should think of its protocol as defining a capability envelope.

Inside the envelope:

- the relevant information can be obtained with BANTAM observations;
- the necessary mutation can be expressed through BANTAM actions;
- verification can be executed and interpreted;
- the task horizon fits BANTAM's state and recovery design.

Within this envelope, specialization can produce large efficiency gains.

Near the boundary:

- the task requires many cross-file inferences;
- context pressure is high;
- tool needs are unusual;
- action batching may matter;
- native compaction or subagents may help;
- the verifier is incomplete or exploratory.

Outside the envelope:

- required tools or environments are unavailable;
- the action protocol cannot express the solution;
- the task depends on broad external interaction;
- the harness's assumptions distort the problem.

The correct response outside the envelope is not to force Codex through an
inadequate protocol. It is to improve the protocol or deliberately select a
more general runtime. A future router should be based on measured task-class
evidence, not prestige assumptions about either harness.

## When native Codex may still win

Native Codex is a serious control and may outperform BANTAM when:

- the repository is unfamiliar and broad exploration is essential;
- the solution requires tools BANTAM does not expose;
- the task benefits from native multi-agent decomposition;
- long native thread continuity or compaction dominates;
- the task is research-like and cannot be reduced to a known verifier;
- a single semantic plan spans many interdependent edits;
- BANTAM's one-action boundary creates excessive turn overhead;
- the correct workflow is outside BANTAM's encoded operating knowledge.

These are hypotheses to test, not excuses to route natively by default.

Native Codex is retained for three reasons:

1. **escape hatch** — a task outside BANTAM's current envelope can still run;
2. **experimental control** — BANTAM needs a general-agent baseline;
3. **source of new affordances** — native trajectories can reveal capabilities
   the constrained harness should safely acquire.

It is not retained as an automatically “more powerful” route.

## Threats to validity

This finding is important enough to protect from overstatement.

### One task

The controlled evidence currently centers on one bounded ordered-map repair.
That is enough to reject the assumption that native execution must always be
more efficient. It is not enough to estimate average performance across
software engineering.

### One success threshold

All routes passed the hidden contract. The experiment therefore compares
resources conditional on success, not degrees of solution quality.

### Different orchestration contracts

Native Codex and BANTAM Codex expose different tools and stopping rules by
design. This is not a model-only benchmark. It is a system benchmark—and that
is the point—but conclusions must be phrased at the system level.

### Cache accounting

Total input, cached input, cache misses, output, and reasoning output reflect
different resource dimensions. Cached-input behavior can change with prompt
shape, runtime state, or provider implementation. Subscription enforcement is
authoritative and should not be inferred from a homemade token sum.

### Runtime variance

Network latency, service load, warm caches, process startup, and nondeterminism
can affect one-shot timings. Repeated randomized paired runs are required for
stable estimates.

### Fixture familiarity

Models may have different prior familiarity with common concurrency patterns.
More diverse tasks are needed: localization, cross-file repair, refactoring,
ambiguous failures, test authoring, and design work.

## Research program created by this finding

The next experiments should map the crossover rather than merely repeat a
victory lap.

### Task axes

Measure both harnesses across:

- localized versus cross-file changes;
- precise versus ambiguous requirements;
- existing verifier versus verifier creation;
- small versus large repository context;
- common versus unusual tooling;
- short versus long horizon;
- advisory, repair, refactor, and greenfield intent;
- single-agent versus decomposition-friendly work.

### Required controls

Each comparison should freeze:

- exact starting bytes;
- exact task text;
- model and reasoning effort;
- deadline;
- environment and dependency state;
- public verifier;
- hidden or held-out contract;
- number of repetitions;
- success and resource metrics before the run.

### Metrics

Retain at least:

- strict pass rate;
- partial/hidden grade where possible;
- elapsed distribution, not only average;
- provider input, cached input, cache miss, output, and reasoning;
- action and tool counts;
- repeated or invalid operations;
- paths inspected and changed;
- verifier attempts;
- recovery events;
- candidate patch size;
- human intervention.

### Promotion question

The experiment should answer:

> For which measurable task classes does constrained BANTAM preserve or improve
> correctness while reducing resource use, and where does native autonomy regain
> the advantage?

That produces a routing policy grounded in evidence rather than a single global
winner.

## Architectural doctrine

This finding suggests several durable rules for BANTAM:

1. **Spend model intelligence only where semantic judgment is required.**
2. **Move recurring mechanical reasoning into tested infrastructure.**
3. **Prefer explicit state over conversational memory.**
4. **Prefer bounded high-signal observations over raw environment exhaust.**
5. **Make completion an admitted state transition, not a model assertion.**
6. **Preserve the general native runtime as a control and escape hatch.**
7. **Measure systems end to end, including correctness.**
8. **Do not optimize token totals while hiding cache or quota semantics.**
9. **Turn frontier-model advantages into general harness affordances.**
10. **Treat every efficiency claim as provisional until paired evidence repeats.**

The broad lesson is not “agents need fewer tools.” It is:

> Agents need the smallest action and state surface that fully expresses the
> task class they are solving.

Too little structure forces the model to reinvent an operating system on every
run. Too much structure prevents the model from expressing the solution.
BANTAM's work is to discover and continually test that boundary.

## Current routing policy

For ordinary work:

- `:model codex-terra` handles normal repairs and refactors;
- `:model codex-sol` handles difficult diagnosis, design, and implementation;
- `:model local` uses the local model;
- trio and gauntlet modes collect comparison evidence.

Native `codex exec` delegation is retained only as an experimental control and
requires:

```bash
./bin/run-dev.sh delegate run --yes ...
```

Without `--yes`, BANTAM exits before creating state or launching Codex.

Use native delegation only for a preregistered comparison, a task-size crossover
experiment, diagnosis of a BANTAM protocol limitation, or native-behavior
research. Do not use it merely because native Codex is assumed to be better.

## What would justify changing the policy

Native delegation should become ordinary only after paired experiments show an
advantage for a defined task class:

1. at least three representative fixtures;
2. identical bytes, task, model, effort, verifier, and deadline;
3. hidden or independently held correctness;
4. no lower strict pass rate;
5. material improvement in preregistered resource metrics;
6. no unacceptable latency or failure tail;
7. reproducible artifacts rather than anecdotes.

Until then, native mode remains available for research and excluded from
automatic routing.

## Limits of the conclusion

Ordered-map is small, precisely specified, localized, easily verified, and well
represented by BANTAM's action vocabulary. It does not establish that BANTAM
will beat native Codex on broad exploration, dozens of files, unusual tools,
native compaction, native subagents, or rich external integrations.

The ambitious but defensible conclusion is:

> BANTAM has demonstrated that a carefully designed harness can make frontier
> Codex models materially more efficient on bounded coding work. It is an
> optimization layer and research platform, not a diminished Codex.

## Reproducing the comparison

Constrained controls:

```bash
./bin/run-dev.sh gauntlet --models local,sol --fixtures ordered-map \
  --rounds 1 --effort high --output .bantam/gauntlets/control-local-sol

./bin/run-dev.sh gauntlet --models terra --fixtures ordered-map \
  --rounds 1 --effort medium --output .bantam/gauntlets/control-terra
```

Explicit native research controls:

```bash
./bin/run-dev.sh delegate run --yes \
  --workspace gauntlet/fixtures/ordered-map/repo \
  --model sol --effort high --verify "npm test" \
  --task "<the exact ordered-map task>"

./bin/run-dev.sh delegate run --yes \
  --workspace gauntlet/fixtures/ordered-map/repo \
  --model terra --effort medium --verify "npm test" \
  --task "<the exact ordered-map task>"
```

Comparison:

```bash
./bin/run-dev.sh delegate compare \
  <native-sol-evidence> <native-terra-evidence> \
  .bantam/gauntlets/control-local-sol/manifest.json \
  .bantam/gauntlets/control-terra/manifest.json
```

## Related documentation

- [Native Codex Delegates](NATIVE-CODEX-DELEGATES.md)
- [Model Runtimes and Improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md)
- [Codex Integration Improvements](CODEX-INTEGRATION-IMPROVEMENTS.md)
- [BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md)
- [Principles](PRINCIPLES.md)
