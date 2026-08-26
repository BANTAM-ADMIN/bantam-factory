# Improving BANTAM's Codex Integration

## Executive summary

BANTAM is using Codex **effectively**: Codex remains a model runtime rather than a second, competing agent; BANTAM retains authority over history, tools, workspace mutation, verification, and termination; structured actions are enforced with an output schema; unexpected native tool requests are declined; and token usage is captured. The measured gauntlet confirms that this is a real end-to-end integration, not a nominal adapter.

The main opportunity was **efficiency**. The original integration created a
fresh Codex thread and sent a complete assembled prompt for every BANTAM model
request. BANTAM now defaults to one bounded native thread per `runAgent`
invocation and sends exact, artifact-reconstructable base-relative deltas after
the first canonical prompt. A later user request, trio arm, or gauntlet fixture
still starts a separate thread, and `ephemeral/full` remains an explicit
compatibility rollback.

This promotion followed paired Sol/high evaluations across an ordered-map
repeat and a five-fixture breadth sweep: run/delta preserved 8/8 strict passes,
was 23.1% and 21.0% faster respectively, and reduced cache-miss input 22.2% and
20.3%. It did raise provider-reported accumulated total input 18.7% and 24.8%,
so BANTAM records both totals rather than treating one counter as “cost.”
Recovery tests kill the real app-server after a long delta history, and an
independent audit reconstructed 159/159 live delivered prompts byte-for-byte
from stored evidence.

The remaining recommended sequence is:

1. expand long-horizon fixture families and add a live operator-edit smoke;
2. measure p95 latency and provider-reported accumulated input over more rounds;
3. add a Codex-specific prompt profile and remove only independently verified redundancy;
4. route routine work to Terra/medium and reserve Sol/high for genuinely difficult work;
5. improve request-level telemetry so prompt growth and cache behavior can be diagnosed by section;
6. adopt automated routing only when paired evaluations show no loss of correctness, reproducibility, or control.

## Current operating policy

- Default Codex thread delivery: `run/delta`.
- Explicit rollback/control: `--codex-thread-mode ephemeral --codex-prompt-mode full`.
- `--codex-thread-mode ephemeral` alone infers `full`.
- `--codex-prompt-mode delta` alone infers `run`.
- Periodic rebasing remains disabled by default.
- Adaptive minimum-savings rebasing remains disabled by default; the measured
  `0.2` policy was correct but often triggered too late to amortize.
- Correctness-required inefficient-delta fallback and process recovery remain
  active in every delta run.
- New artifacts carry an independently recomputed prompt-integrity report.
  `./bin/run-dev.sh audit-codex <artifact>` replays that proof offline, and
  gauntlets fail closed as `evidence-invalid` when the proof fails.
- `audit-codex --calls` exposes bounded per-request delivery, token/cache,
  reasoning, and latency rows for diagnosing the turn where efficiency falls.
- Recently observed workspace paths are exact-fingerprinted. Between-turn
  changes invalidate cached context and proofs; a change that lands during
  model inference blocks the stale action before execution. Artifacts and
  experiment summaries count events, paths, and blocked actions.

## Immediate finding from an interactive Sol session

A real `codex-sol` / high-reasoning repository-review session exposed a
lower-risk problem ahead of the larger transport experiments. Across four user
requests, BANTAM reported:

- 27 accepted BANTAM turns;
- 32 Codex model calls;
- 664,181 input tokens;
- 237,312 cache-hit and 426,869 cache-miss input tokens;
- 14,897 output tokens, including 4,156 reasoning tokens;
- roughly nine minutes of wall time.

Five calls were above the accepted-turn count. The cause was not Codex native
thread behavior: unconfigured Codex `ModelClient` instances inherited BANTAM's
default Qwen profile. Qwen's assistant prefill contains `<think>` markers, so
`thinkMode: "auto"` activated BANTAM's two-call local-model reasoning rail
while Codex was already reasoning natively at the selected effort.

The immediate correction is now part of the runtime contract:

- Codex defaults to the neutral `generic` model profile;
- local unconfigured models retain the Qwen profile;
- an explicit `--profile` or `BANTAM_PROFILE` choice still wins;
- run metrics expose model calls, auxiliary calls, and calls per accepted turn;
- terminal session usage calls them **model calls**, not responses.

This does not solve full-prompt replay or ephemeral-thread overhead. It removes
provably duplicated reasoning first and gives later experiments a cleaner
baseline. For a clean Codex trajectory, the expected relationship is now one
model call per accepted turn. Invalid structured output, retries, planning, or
other explicit auxiliary phases can still raise that ratio and will be visible.

Live subscription-backed smoke tests after the correction confirmed the
contract on both primary hosted choices:

| Model | Effort | Turns | Model calls | Auxiliary | Think phases | Calls/turn |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | high | 1 | 1 | 0 | 0 | 1.0 |
| GPT-5.6 Terra | medium | 1 | 1 | 0 | 0 | 1.0 |

Both runs used isolated disposable workspaces, emitted normal advisory
responses, recorded `profile: "generic"` in their artifacts, and made exactly
one app-server completion. The repository verifier then passed all 956 tests.

## What is already strong

### BANTAM, not Codex, owns the agent

`src/codex-transport.js` explicitly treats Codex as a completion runtime. Its base instructions say that BANTAM owns the conversation, tools, workspace operations, and verification. This is the correct architectural choice. Letting Codex independently inspect or mutate the workspace would create two histories, two permission systems, and ambiguous responsibility for verification.

The transport reinforces this boundary in code:

- each BANTAM completion supplies the prompt;
- native Codex tool and approval requests are declined;
- only the agent-message result is returned to BANTAM;
- BANTAM parses and executes the resulting action;
- hard, idle, and control timeouts prevent indefinite hangs.

This separation should remain a non-negotiable invariant through any optimization.

### Structured action generation is being used correctly

`src/model.js` passes `jsonMode` and BANTAM's JSON output schema to the Codex transport. This is materially better than asking for JSON in prose and repairing arbitrary output afterward. The gauntlet produced zero invalid actions and zero protocol violations across all 15 runs, which is strong evidence that this boundary works.

The implication is important: prompt space devoted to repeatedly explaining JSON formatting may now have diminishing value for Codex. The schema is already doing the hard enforcement. BANTAM should measure whether some Codex-facing formatting instructions can be shortened without increasing invalid actions.

### Usage and liveness accounting are real

The transport recognizes assistant deltas, completed messages, token-usage updates, and terminal turn notifications. Reasoning and token events refresh the idle watchdog, avoiding false timeouts during quiet visible output. `src/model-usage.js` normalizes input, output, cache-hit, cache-miss, reasoning, request, and Codex-request counts.

This provides a good foundation for optimization. The missing piece is not raw accounting; it is attribution: which prompt sections and harness behaviors caused the cost.

### The evaluation design is directionally sound

The current gauntlet uses identical starting repositories and task text, immutable controls, hidden contracts, filesystem grading, and recorded trajectories. That is the right way to compare runtimes. The report also correctly limits its conclusion: one round of five small JavaScript repairs is useful integration and efficiency evidence, not a broad model-quality verdict.

## The clearest inefficiency: fresh threads plus full prompts

The transport comment and implementation establish the current policy: one ephemeral Codex thread per BANTAM completion. BANTAM then sends the complete prompt assembled from the task, instructions, bounded history, observations, repository context, open files, skills, plans, and re-anchors.

This has real advantages:

- every request is independently replayable;
- BANTAM's prompt is the sole source of truth;
- there is no hidden conversational state to reconcile;
- retrying after transport failure is conceptually simple;
- artifact inspection can explain exactly what the model received.

But it also means that a six-action repair is not one Codex conversation. It is six independent conversations, each reconstructing the work so far. Prompt caching softens the cost when prefixes remain stable, but it does not eliminate latency, cache misses, or the growth caused by changing history and open-file panels.

The measured result illustrates the scale:

| Runtime | Strict pass | Requests | Input tokens | Cache hit | Cache miss | Task time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local Qwen | 5/5 | 57 | 158,834 | 171,319 | 0 | 218.887s |
| GPT-5.6 Sol | 5/5 | 49 | 743,850 | 236,544 | 507,306 | 489.406s |
| GPT-5.6 Terra | 5/5 | 37 | 491,519 | 281,600 | 209,919 | 293.981s |

Provider token categories are not necessarily identical across runtimes, so this is not a perfect apples-to-apples billing comparison. It is nevertheless enough to identify repeated hosted-model context as the first optimization target.

## Recommended improvements

## 1. Define the optimization target before changing the transport

A lower token count is not automatically better if it increases wrong edits, hidden-test failures, or recovery turns. BANTAM should promote changes against a compact scorecard rather than a single metric.

For every arm, record at least:

- strict pass rate and pass@k;
- wall time and model time;
- model requests and BANTAM turns;
- input, cache-hit, cache-miss, output, and reasoning tokens;
- invalid actions and protocol violations;
- duplicate inspections, duplicate actions, no-op edits, and failed edits;
- verification attempts before the first correct change;
- cost per strict pass, where provider pricing is available;
- p50 and p95 values, not just totals.

Two derived metrics would be especially useful:

- **effective fresh input per strict pass** = cache-miss input tokens / strict passes;
- **trajectory efficiency** = strict passes / (normalized model time × model requests).

The acceptance gate for an efficiency change should require non-inferior strict pass rate and a meaningful reduction in either fresh input, wall time, or both. A reasonable initial threshold is a 20% reduction across at least three rotated rounds, with no new authority or protocol violations.

## 2. Add a Codex-specific prompt profile

BANTAM currently assembles a rich prompt designed to make constrained local models reliable. Many of those interventions are valuable for every model, but some may duplicate capabilities or instructions already supplied by the Codex runtime and output schema.

Do not create an entirely separate agent. Instead, introduce a small runtime capability/profile layer used by prompt assembly, for example:

```js
{
  structuredOutput: "json-schema",
  nativeConversation: true,
  strongToolSelection: true,
  needsVerboseActionExamples: false,
  needsRepeatedFormatReminder: false
}
```

Candidate reductions to test independently:

1. shorten repeated JSON/action-format prose when an output schema is present;
2. avoid replaying tool descriptions that cannot be selected on the current turn;
3. omit local-sampler-specific recovery guidance from Codex prompts;
4. collapse stable harness rules into one immutable prefix;
5. send repository briefs only when task classification says repository knowledge is needed;
6. prefer compact ledger pointers over verbatim historical observations already represented in current state;
7. suppress re-anchors when the most recent observation already restates the goal or completion criteria.

Each reduction should be an A/B flag, not a wholesale rewrite. `src/prompt-audit.js` already measures total characters, section sizes, duplicate observation bytes, source copies, and required facts. Extend those gates per runtime and compare exact request artifacts.

The desired result is not the shortest prompt. It is the smallest prompt that preserves the facts needed for the next correct action.

## 3. Route models and reasoning effort by task difficulty

The measured run makes the default choice fairly clear for small routine repairs: Terra used the fewest turns and requests and was substantially faster and lighter than Sol while matching its 5/5 result. Sol used more context and reasoning without improving this sample's score.

A pragmatic policy would be:

- **Terra, medium effort**: default hosted Codex runtime for ordinary fixes, bounded refactors, test-driven repairs, and straightforward repository questions;
- **Sol, high effort**: architectural changes, ambiguous multi-file diagnosis, security-sensitive reasoning, incomplete tests, difficult concurrency bugs, or escalation after a cheaper arm stalls;
- **local model**: inexpensive reconnaissance, simple mechanical edits, or privacy/offline workflows when its measured capability is sufficient.

Avoid an elaborate learned router initially. Start with transparent task features:

- estimated number of affected files;
- whether failure evidence exists;
- architectural or security vocabulary;
- task type: question, document, repair, feature, migration;
- previous failed attempts or progressless turns;
- context size and repository breadth.

Escalation should be evidence-based. Examples:

- two progressless turns;
- repeated failed edits with no new diagnosis;
- verification failure after a plausible fix;
- detected cross-module design change;
- prompt nearing the configured context budget.

Routing needs its own evaluation matrix. A policy that saves tokens but escalates too late can waste more time than simply starting with the stronger model.

## 4. Experiment with one Codex thread per BANTAM run

This is the highest-potential transport improvement and the one with the greatest architectural risk.

Instead of creating a new Codex thread for every action, create one thread at the start of a BANTAM run and submit subsequent BANTAM turns to it. The first turn would receive the full prompt. Later turns could receive a compact state delta containing:

- the exact BANTAM action previously emitted;
- the authoritative observation from BANTAM;
- changed open-file or repository context;
- any new recovery or completion instruction;
- a reminder that only one JSON action is allowed.

This could improve prefix reuse and avoid repeatedly transmitting stable instructions and history. It may also reduce latency by preserving runtime-side conversational state.

However, persistent thread state must never become authoritative. The following safeguards are required:

1. BANTAM continues to store the canonical task, action history, observations, and filesystem state.
2. Every delta is recorded byte-for-byte in the artifact.
3. A run can rebuild a fresh thread from canonical BANTAM state after a crash or suspected divergence.
4. Thread identity is scoped to one run and never shared across workspaces or users.
5. Native Codex tools remain disabled or declined.
6. Retries distinguish an idempotent transport retry from a new model attempt.
7. A periodic checkpoint can intentionally rebase with a fresh full prompt.
8. Tests prove that stale model-side assumptions are corrected by authoritative observations.

Implement this behind a flag such as `codexThreadMode: "ephemeral" | "run"`. Keep `ephemeral` as the control until a paired experiment shows that `run` mode preserves strict pass rate and replayability.

Useful adversarial fixtures for this experiment include:

- a file changed externally between turns;
- a failed edit whose observation contradicts the model's belief;
- test output that invalidates the previous diagnosis;
- prompt compaction after a long trajectory;
- app-server restart in the middle of a run;
- an aborted turn followed by recovery;
- two concurrent BANTAM runs in the same process.

If app-server thread semantics or caching behavior cannot be verified from the live protocol, that is a blocking research item. Do not assume that thread reuse guarantees cheaper billing or automatic cache reuse; measure the emitted token-usage events.

### Implemented run-scoped prototype and first live result (historical rollout)

The initial guarded prototype was implemented with `ephemeral` as its control.
At that historical rollout stage:

- `ephemeral` was still the default;
- `run` requires `--codex-thread-mode run` or
  `BANTAM_CODEX_THREAD_MODE=run`;
- `runAgent` begins and ends the native scope in a `finally` block;
- one run cannot change models or issue concurrent completions on its thread;
- any failed/ambiguous transport turn discards the reusable binding;
- different BANTAM runs start different native threads;
- every artifact records mode, call count, unique threads, and reused calls.

The first same-fixture comparison used the `ordered-map` hidden contract at high
reasoning. Both modes passed strictly with zero invalid actions and zero
protocol violations. The run-scoped artifacts each prove one unique native
thread across six calls, with five reused calls.

| Model | Mode | Turns | Time | Input | Cache hit | Cache miss |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Sol/high | ephemeral | 6 | 50.924 s | 89,373 | 11,008 | 78,365 |
| Sol/high | run | 6 | 38.369 s | 124,287 | 71,680 | 52,607 |
| Terra/high | ephemeral | 7 | 66.487 s | 94,236 | 16,384 | 77,852 |
| Terra/high | run | 6 | 39.417 s | 114,926 | 86,272 | 28,654 |

On this single stochastic sample, run scope reduced wall time by 24.7% for Sol
and 40.7% for Terra. Cache-miss input fell 32.9% and 63.2% respectively, while
reported total input rose 39.1% and 22.0%. That tradeoff matters: native thread
continuity appears to make far more context cacheable, but it also causes the
provider to report the accumulated conversation alongside BANTAM's replayed
full prompt. The result clears the prototype's initial usefulness threshold,
but is not enough to promote it. The next evaluation must repeat all fixtures
over multiple rounds and distinguish total processed context from fresh,
provider-billed input.

Evidence:

- `.bantam/gauntlets/prompt-churn-2026-07-25/` — ephemeral baseline;
- `.bantam/gauntlets/codex-run-thread-2026-07-25/` — run-scoped prototype.

A subsequent balanced-order, same-model three-round A/B removed the Sol/Terra
model difference. Both Sol/high arms passed 3/3 strictly in exactly 18 turns and
18 requests:

| Sol/high arm | Strict | Time | Input | Cache hit | Cache miss | Reasoning |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ephemeral | 3/3 | 168.928 s | 268,133 | 147,200 | 120,933 | 953 |
| Run thread | 3/3 | 128.046 s | 373,263 | 286,720 | 86,543 | 768 |

Run scope was 24.2% faster and used 28.4% fewer cache-miss input tokens, while
total reported input rose 39.2%. This repeat confirms the direction of the
single-sample result for this fixture. It still does not justify a default:
the experiment covers one compact repair shape and the pass-rate interval is
wide. The checked-in reproducible spec is
`examples/experiments/codex-thread-mode.json`; evidence is in
`.bantam/experiments/codex-thread-ab-2026-07-25/`.

The subsequent five-fixture breadth sweep preserved correctness across more
shapes:

| Sol/high arm | Strict | Turns | Time | Input | Cache hit | Cache miss | Reasoning |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ephemeral | 5/5 | 28 | 312.286 s | 416,075 | 254,208 | 161,867 | 4,022 |
| Run thread | 5/5 | 30 | 288.407 s | 629,425 | 509,440 | 119,985 | 3,050 |

Across this wider sample, run scope remained 7.6% faster and reduced cache-miss
input 25.9%, but required two extra action turns and increased total reported
input 51.3%. Individual task time varied: two tasks were roughly tied or slower,
while the more involved range-parser and safe-config-merge repairs were faster.
This strengthens the case that continuity helps, but also argues against making
it universal without quota/context-pressure evidence. Reproducible spec:
`examples/experiments/codex-thread-mode-breadth.json`; evidence:
`.bantam/experiments/codex-thread-breadth-2026-07-25/`.

### Implemented exact base-relative prompt deltas (historical rollout)

The next rollout stage separated native thread continuity from prompt replay.
Its initial control was `full`; after the evaluation and recovery work recorded
below, the combined run/delta path became the default. At that stage:

- `full` was still the default prompt-delivery mode;
- `delta` requires run-scoped threads and otherwise fails closed;
- the first turn records and sends the complete canonical prompt;
- later turns compare against that first immutable base, never against another
  delta;
- a delta records base and canonical SHA-256 values, an exact UTF-16 prefix
  length, the complete replacement suffix, and the exact transmitted envelope;
- common prefixes below 2,048 characters and envelopes that are not smaller
  rotate to a fresh thread and install the current full prompt as its base;
- artifacts retain the complete canonical request and exact delta evidence,
  while reports aggregate canonical/delivered characters, saved ratio, delta
  calls, fallback calls, rebases, and rebase reasons;
- failed native turns clear the run binding and immutable base so the bounded
  model retry recreates from BANTAM's canonical state;
- `--codex-rebase-every <n>` adds optional periodic fresh-thread checkpoints,
  with `0` as the default.
- `--codex-rebase-min-savings <ratio>` adds an adaptive checkpoint based on
  actual next-delta wire savings, also defaulting to `0` (disabled).

The balanced three-round ordered-map study compared ephemeral/full, run/full,
and run/delta using the same Sol/high model and seeds. All nine repairs passed
strictly in six turns with zero invalid or protocol actions:

| Sol/high arm | Strict | Time | Input | Cache hit | Cache miss | Reasoning | Delivered | Saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ephemeral/full | 3/3 | 159.924 s | 268,158 | 195,584 | 72,574 | 887 | 171,048 | 0.0% |
| Run/full | 3/3 | 147.543 s | 373,171 | 304,896 | 68,275 | 834 | 171,417 | 0.0% |
| Run/delta | 3/3 | 123.023 s | 318,330 | 261,888 | 56,442 | 632 | 86,745 | 49.3% |

Against run/full, exact deltas cut delivered characters 49.4%, total input
14.7%, cache-miss input 17.3%, reasoning 24.2%, and task time 16.6%. Against
ephemeral/full, delta was 23.1% faster and used 22.2% fewer cache-miss tokens,
although native accumulated history still made total reported input 18.7%
higher. Reproducible spec:
`examples/experiments/codex-prompt-delta.json`; evidence:
`.bantam/experiments/codex-prompt-delta-2026-07-25/`.

The five-fixture breadth sweep tested concurrency, expiration semantics,
prototype-pollution-safe merging, signed range parsing, and retry policy. All
15 arm/fixture runs passed strictly with zero invalid or protocol actions:

| Sol/high arm | Strict | Turns | Time | Input | Cache hit | Cache miss | Reasoning | Delivered | Saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ephemeral/full | 5/5 | 30 | 331.842 s | 447,425 | 335,616 | 111,809 | 3,431 | 284,018 | 0.0% |
| Run/full | 5/5 | 30 | 251.125 s | 627,954 | 507,392 | 120,562 | 3,206 | 284,057 | 0.0% |
| Run/delta | 5/5 | 31 | 262.211 s | 558,394 | 469,248 | 89,146 | 2,883 | 148,246 | 49.8% |

Against run/full, delta cut delivered characters 47.8%, total input 11.1%,
cache-miss input 26.1%, and reasoning 10.1%; it was 4.4% slower and used one
extra turn. Against ephemeral/full, it was 21.0% faster and used 20.3% fewer
cache-miss tokens, while total input remained 24.8% higher. The tradeoff is now
clear: delta is the better run-thread option when fresh context or quota
pressure matters, while run/full was the latency winner in this single breadth
sweep. Reproducible spec:
`examples/experiments/codex-prompt-delta-breadth.json`; evidence:
`.bantam/experiments/codex-prompt-delta-breadth-2026-07-25/`.

### Implemented fresh-thread rebasing and recovery

The delta transport now treats a native thread and its immutable base as one
binding. It discards both together after a failed turn, when a candidate delta
would be inefficient, or when an explicit periodic checkpoint is due. The next
call creates a new native thread and sends the complete current canonical
prompt. This avoids sending a full replacement into a thread whose original
base no longer helps and gives retries a deterministic reconstruction point.

The five-fixture breadth experiment compared continuous deltas with a forced
checkpoint every three calls:

| Sol/high arm | Strict | Turns | Time | Input | Cache hit | Cache miss | Reasoning | Delivered | Saved | Rebases |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Continuous delta | 5/5 | 28 | 243.098 s | 493,030 | 388,608 | 104,422 | 3,140 | 130,861 | 49.9% | 0 |
| Rebase every 3 | 5/5 | 29 | 304.901 s | 458,364 | 350,464 | 107,900 | 3,206 | 168,110 | 38.6% | 7 |

Both arms had zero invalid actions and zero protocol violations. Rebase-three
reduced total reported input 7.0%, but raised cache-miss input 3.3%, reasoning
2.1%, and task time 25.4%; it also lost 11.3 percentage points of prompt
delivery savings. An independent artifact audit reconstructed all 17 deltas
exactly, verified all seven rebases as fresh-thread full prompts, and matched
the reported 12 unique threads.

The conclusion is deliberately narrow: fresh-thread rebasing is a correct
recovery primitive, but a three-call periodic interval is too aggressive.
Periodic rotation stays disabled by default. Automatic inefficient-delta and
failed-turn recovery remain enabled, while longer or adaptive intervals require
rotated multi-round evidence. Reproducible spec:
`examples/experiments/codex-delta-rebase-breadth.json`; evidence:
`.bantam/experiments/codex-delta-rebase-breadth-2026-07-25/`.

### Adaptive savings candidate

The adaptive candidate measures the exact next-delta savings ratio before
starting a turn. If the ratio is below the configured floor, BANTAM rotates to
a fresh thread and sends the current canonical prompt in full. Unlike a call
interval, the policy does nothing while the immutable base remains efficient.

Offline replay of `0.2` across both saved five-fixture continuous-delta
trajectories predicted zero rotations: every real short-run delta still saved
at least 20%. A deterministic 40-turn observation-growth trajectory showed the
opposite long-horizon shape:

| Policy | Rebases | Rebase turn | Delivered chars | Saved |
| --- | ---: | ---: | ---: | ---: |
| Continuous delta | 0 | — | 1,200,925 | 19.2% |
| Minimum savings 0.2 | 1 | 21 | 639,234 | 57.0% |

The production transport test executes all 40 turns through separate fake
app-server runtimes and requires adaptive delivery to use less than 60% of the
continuous candidate. Artifacts now expose `minDeltaSavedRatio` and
`lowSavingsDeltaCalls`, and experiment rows/totals propagate the same evidence.
The live long-horizon test now exists. A twelve-module adapter migration starts
with two public tests green and four hidden contract groups red. Two balanced
two-round Sol/high experiments compared continuous exact deltas with a `0.2`
adaptive floor:

| Policy | Strict | Turns | Input | Cache miss | Reasoning | Task time | Delivered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Continuous delta | 4/4 | 72 | 3,107,630 | 411,438 | 6,910 | 693.972 s | 923,762 |
| Adaptive 0.2 | 4/4 | 67 | 2,413,274 | 367,066 | 6,053 | 671.717 s | 835,093 |

Combined, adaptive used 22.3% fewer input tokens, 10.8% fewer cache-miss
tokens, 12.4% fewer reasoning tokens, and 3.2% less task time. The aggregate
does not establish a latency win: the first experiment favored adaptive, while
the independent replication made three extra turns and was 31 seconds slower.
All four rotations were late; two were terminal and only four calls total
followed a rotation. BANTAM now reports terminal rebases, post-rebase calls,
and rebase call indices, and suppresses optional low-savings rotation for the
entire bounded post-green audit phase. Correctness-required fallback and
failed-turn recovery remain active.

All eight comparison runs were strict-green with no invalid or protocol
actions. A cross-experiment audit reconstructed every canonical prompt from
its native thread base and exact delivered delta; including the guarded live
probe, 159/159 calls matched their canonical SHA-256. The adaptive candidate
therefore remains opt-in: it is promising for input pressure, but model-path
variance and late-rotation amortization are not stable enough for a default.

## 5. Preserve a stable prefix and move volatile context to the end

Even if BANTAM retains ephemeral threads, cache performance can improve when byte-stable content stays at the front of the prompt and rapidly changing content stays near the end.

Audit the assembled prompt for avoidable prefix churn:

- timestamps or run-specific IDs in early sections;
- reordered tool descriptions;
- repository summaries regenerated with nondeterministic ordering;
- changing open-file panels placed before stable rules;
- re-anchors that alter otherwise reusable prefixes;
- whitespace or serialization differences between turns.

Create a prompt fingerprint for each logical section and store it with every model call. Then report:

- longest common prefix with the prior request;
- first changed section;
- bytes added and removed per section;
- observed cache-hit ratio;
- cache-miss tokens per turn.

This turns “Codex used a lot of context” into an actionable diagnosis such as “the repository panel changed near the front on every turn and destroyed the reusable prefix.”

### Implemented prompt-churn evidence

Run artifacts now attach content-free prompt telemetry to every captured model
call. It records:

- total prompt characters and bytes;
- SHA-256 fingerprints and sizes for system, initial task/environment,
  action-history, observation, guidance, open-file, and assistant-prefill
  sections;
- exact common-prefix characters versus the prior call in the same run;
- reusable-prefix ratios relative to both prompts;
- added and replaced suffix characters;
- every changed semantic section and the first changed section.

Artifacts also contain an aggregate `metrics.promptChurn` record. Gauntlet rows,
arm totals, generated Markdown summaries, ledgers, and showcase cards expose
prompt size and reusable-prefix behavior alongside provider cache tokens. The
two measurements are intentionally kept separate: byte-prefix stability is a
harness fact, while provider cache accounting is provider-reported behavior.
The telemetry does not add another raw prompt copy.

## 6. Make telemetry diagnostic rather than merely cumulative

Current usage totals are good, but aggregate numbers hide the turn where efficiency collapses. Add a per-call record containing:

- runtime, model, and reasoning effort;
- thread mode and thread ID hash;
- prompt total characters and estimated tokens;
- prompt section character counts from `auditPrompt`;
- input, cache hit, cache miss, output, and reasoning tokens;
- time to first delta and total model time;
- action type returned;
- whether the request was an invalid-output retry;
- whether it followed a duplicate, failure, or progressless observation;
- common-prefix bytes relative to the preceding request.

A run report should graph cumulative input and cache-miss tokens by turn. It should also identify the most expensive request and largest prompt-growth transition.

Be careful with terminology: the current report's “Input” and cache columns may reflect provider-specific definitions. Keep raw provider fields in artifacts alongside normalized fields so future corrections do not destroy evidence.

## 7. Separate invalid-output repair from task reasoning

Codex had zero invalid actions in the measured run, which suggests the current schema path is strong. Yet the agent loop permits multiple invalid attempts per turn, and each retry can involve another expensive hosted request.

For Codex specifically:

- keep the JSON schema as the primary constraint;
- use a minimal repair prompt containing the validation error and original task-state fingerprint;
- do not duplicate the full invalid response if a bounded excerpt or structured error suffices;
- classify schema failure separately from semantic action rejection;
- immediately surface regressions in invalid-action rate when prompt instructions are shortened.

Do not optimize a path that is not currently hot. This recommendation is mainly defensive: ensure future prompt-profile experiments do not turn formatting repair into a new source of cost.

## 8. Improve completion and verification policy by task class

Every extra model turn is expensive when the full prompt is replayed. Some extra turns are essential verification; others are generic ceremony.

Use task-aware completion gates:

- a question or review task should usually finish with `respond`, without mutation-oriented wrap-up turns;
- a documentation task needs artifact reread or targeted content audit, not the full code-test policy;
- a code repair needs a relevant test after the latest edit;
- a UI change needs a preview or interaction check when available;
- a broad refactor needs scoped tests plus an import/build check.

The gate should be deterministic wherever possible. The model should not spend a turn deciding whether an already-known mandatory verification is mandatory. Conversely, BANTAM should not inject repeated completion reminders when the current state makes completion impossible.

## 9. Use Codex as a teacher selectively, not continuously

The repository's local/Sol/Terra comparison and self-improvement workflow is a strong strategic use of hosted models. Stronger models can diagnose local failures, propose adversarial tests, and review candidate changes without becoming the always-on production runtime.

Keep that workflow narrow and evidence-bound:

- same starting bytes and task;
- complete trajectory artifacts;
- a deterministic, hash-bound trajectory comparison before model diagnosis;
- independent proposals before cross-review;
- immutable tests and held-out evaluation;
- no promotion based only on teacher agreement.

This often produces more durable value per hosted token than using Sol for every routine edit. A successful teacher session can improve the harness or local model behavior for many future runs.

## Changes not recommended

### Do not expose Codex native workspace tools alongside BANTAM tools

That would undermine the central control boundary, make artifacts incomplete, and create state BANTAM did not observe. The likely turn reduction is not worth the loss of determinism and governance.

### Do not remove full-prompt ephemeral mode

Even if persistent threads win, ephemeral mode remains necessary for replay, debugging, bisecting, and validating that hidden thread state is not carrying an experiment.

### Do not select Sol merely because it is the strongest-sounding model

The measured compact-repair workload did not justify its additional context, reasoning, or latency. Model selection should follow workload evidence.

### Do not optimize solely against token totals

A shorter failed run is not more efficient. Strict pass, policy compliance, and verification remain hard gates.

### Do not infer cache economics from local-model fields

Provider accounting differs. Store raw values, normalize cautiously, and compare like with like.

## Proposed implementation plan

### Phase 0: stronger baseline

1. Keep Codex on the neutral profile so native reasoning is not duplicated.
2. Record model calls, auxiliary calls, and calls per accepted turn.
3. Run at least three rounds of the existing five fixtures with rotated arm order.
4. Add multi-file debugging, architectural change, incomplete-test, documentation, and long-horizon fixtures.
5. Record p50/p95 request latency and per-turn usage.
6. Freeze the baseline spec and artifacts.

Exit criterion: stable enough intervals to detect a 20% efficiency change without treating one stochastic run as proof.

### Phase 1: low-risk prompt optimization

1. Add runtime capability flags to prompt construction.
2. Add per-section fingerprints and common-prefix reporting.
3. Test one prompt reduction at a time.
4. Default ordinary Codex runs to Terra/medium where policy permits.
5. Retain Sol/high as an explicit or automatic escalation.

Exit criterion: non-inferior strict pass with lower fresh input or wall time over the expanded suite.

### Phase 2: persistent-thread prototype

Status: run scoping, lifecycle guards, exact recorded base-relative deltas,
fresh-thread recovery, explicit periodic rebasing, deterministic process-death
recovery after a long delta history, transport evidence, repeated same-task
evaluation, and two five-fixture breadth evaluations are implemented. Rotated
live-managed interruption and external-mutation evaluation remain future work.

1. Refactor `CodexAppServer.complete` so thread creation can be run-scoped.
2. Add a thread-session object with explicit create, turn, rebase, abort, and close operations.
3. Define the compact authoritative delta format. **Implemented.**
4. Implement crash recovery by recreating a thread from BANTAM state.
   **Implemented for failed turns, real child-process death, and bounded model
   retry; destructive live-managed interruption remains an operator smoke
   test.**
5. Add concurrency, abort, stale-state, and restart tests.
6. Compare ephemeral and run-thread modes on identical schedules.

Exit criterion: meaningful reduction in cache-miss input or wall time, no strict-pass regression, zero cross-run contamination, and successful recovery tests.

### Phase 3: routing and escalation

1. Add transparent task-feature classification.
2. Log why each route or escalation occurred.
3. Replay the same fixture matrix through fixed-model and routed policies.
4. Reject routing rules that save average cost by creating bad p95 latency or correctness tails.

Exit criterion: lower cost per strict pass than the best fixed default, with bounded tail behavior.

## Concrete tests to add

### Transport tests

- multiple BANTAM turns reuse a thread only in run-thread mode;
- ephemeral mode still creates exactly one thread per completion;
- two simultaneous runs never share thread state;
- abort targets only the active turn;
- app-server exit rejects pending requests and permits clean recreation;
- an unexpected native tool request is declined in both modes;
- completed item text remains authoritative over streamed deltas;
- usage from the final turn is attributed to the correct BANTAM request.

### Prompt tests

- stable rules produce a byte-identical prefix across turns;
- volatile observations occur after stable sections;
- Codex profile omits only explicitly optional instructions;
- all safety, authority, and one-action requirements remain present;
- required-fact gates pass after compaction;
- open-file content is not copied redundantly into history and context panels.

### Evaluation fixtures

- routine single-file repair;
- ambiguous multi-file bug;
- architectural feature addition;
- failure with misleading public tests;
- external workspace mutation between turns;
- long observation requiring compaction;
- repeated invalid edit parameters;
- documentation-only request;
- question requiring no file change.

## Suggested success criteria

For a new Codex default to replace the current behavior, require all of the following on the expanded, multi-round suite:

- strict pass rate is non-inferior within the chosen confidence bound;
- zero native-tool authority violations;
- zero cross-run or cross-workspace state leakage;
- invalid-action rate does not materially increase;
- cache-miss input tokens per strict pass improve by at least 20%, or wall time improves by at least 20% with no token regression;
- p95 task time does not regress materially;
- every run remains reconstructable from BANTAM artifacts;
- an interrupted persistent thread can be rebuilt from canonical BANTAM state.

## Bottom line

The largest identified transport inefficiency has moved from prototype to
default without weakening BANTAM's authority boundary. Codex receives a bounded
native run thread and exact prompt deltas; BANTAM still owns canonical state,
actions, workspace mutation, verification, recovery, and termination. Every
delivered prompt remains independently reconstructable, and operators retain a
one-command ephemeral/full control.

The next gains should come from broader evidence rather than another speculative
transport switch: more long-horizon fixture families, external-mutation
recovery, section-level prompt attribution, and measured Terra/Sol routing.
The guiding principle remains BANTAM's own: when behavior is inefficient or
wrong, inspect the exact context supplied at the exact turn. For Codex, extend
that principle to cost: identify which exact prompt bytes changed, which were
cached, and whether they contributed to the next correct action.
