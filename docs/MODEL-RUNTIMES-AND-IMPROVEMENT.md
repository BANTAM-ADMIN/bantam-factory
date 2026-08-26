# BANTAM model runtimes, gauntlets, and self-improvement

> **Routing policy:** Codex normally runs through BANTAM's constrained action
> loop. The native CLI delegate is research-only and requires explicit consent
> because the first strict paired comparison found constrained Sol/Terra faster
> and lower in total token processing. See
> [WHY-BANTAM-MAKES-CODEX-EFFICIENT.md](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md).

For the complete product-level description and architecture map, see the
[BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md). This document remains the
authoritative provider setup and multi-model operations reference.

This is the operator handbook for the current multi-model BANTAM development
build. It answers four practical questions:

1. What happens when BANTAM starts and receives an ordinary task?
2. How do local Qwen, DeepSeek, and Codex differ?
3. What is automatic, and what requires an explicit operator command?
4. How do gauntlet and teacher evidence become a governed BANTAM improvement?

For implementation details and the first measured Local/Sol/Terra result, see
[the 2026-07-25 technical report](superpowers/reports/2026-07-25-local-codex-model-gauntlet.md).

## The short version

BANTAM is the agent harness. Local Qwen, DeepSeek, and Codex are interchangeable
reasoning engines inside that harness.

```text
user request
    ↓
BANTAM prompt + allowed actions
    ↓
selected reasoning engine
    ↓
one proposed action
    ↓
BANTAM validation, execution, observation, and verification
    ↓
repeat until response, verified completion, failure, or interruption
```

BANTAM continues to own:

- conversation and task context;
- the one-action protocol;
- filesystem, shell, search, preview, and code-intelligence tools;
- workspace and network policy;
- verification and completion gates;
- usage accounting and run artifacts;
- model switching;
- experiment scheduling and hidden grading;
- self-improvement lanes and promotion.

Changing the model does not hand the workspace to another autonomous coding
agent. Codex app-server is used as a completion transport with native Codex
tools disabled. DeepSeek is called through its API. Their proposed actions still
pass through BANTAM.

### Current Codex model evidence

Two complementary tournaments now inform the picker.

The first queried the live account catalog and ran all seven non-hidden Codex
models at the shared medium reasoning level over five compact hidden-contract
fixtures—35 runs total, with no local-model calls.

- Sol, Terra, Luna, GPT-5.5, and GPT-5.4 passed 5/5.
- GPT-5.4 Mini and Spark passed 4/5; both broke async rejection semantics on
  ordered-map after writing an incorrect focused probe.
- GPT-5.5 was the fastest perfect arm on this compact suite.
- Luna was the fastest current 5.6-family arm.
- Terra remains the balanced ordinary-work recommendation.
- Sol supplied the strongest visible adversarial evidence at higher time/input
  cost.
- GPT-5.4 and GPT-5.4 Mini are marked for replacement by Terra and Luna in the
  live catalog.

See the
[seven-model Codex tournament](superpowers/reports/2026-07-25-codex-model-tournament.md)
for complete input/cache/output/reasoning telemetry, quality analysis, failure
artifacts, limitations, and routing recommendations.

The second repeated two harder fixtures twice for Sol high, Terra medium, Luna
medium, and GPT-5.5 medium—16 runs total:

- Terra, Sol, and Luna passed 4/4.
- GPT-5.5 passed 2/4 and reproduced the same leading-zero count-contract miss
  in both adapter migrations.
- Terra matched Sol's strict result with 28 fewer turns, 1.94 million fewer
  total input tokens, and 412 fewer task seconds.
- Luna remained correct but used 24 more turns and 1.55 million more input
  tokens than Terra.

That harder evidence is the basis for the current automatic roles: Terra medium
is recommended, Luna medium is the speed option, Sol high is reserved for hard
or high-assurance work, and GPT-5.5 remains manual/experimental. See the
[hard-role tournament](superpowers/reports/2026-07-25-codex-hard-role-tournament.md).

### Measured Codex speed

Observed app-server throughput on the repeated hard suite was:

| Runtime | Output tok/s | Output + reasoning tok/s | Median call | Average complete task |
| --- | ---: | ---: | ---: | ---: |
| Terra medium | 47.25 | 63.68 | 5.90s | 89.8s |
| Luna medium | 36.88 | 44.23 | 4.96s | 105.0s |
| Sol high | 32.92 | 43.96 | 7.55s | 192.9s |

On the earlier compact suite with all three at medium, Luna and Terra were
nearly tied: 39.4 versus 40.7 seconds per task, while Sol took 54.1 seconds.

“Output tok/s” here means returned output tokens divided by complete app-server
call wall time. It includes provider scheduling, prompt ingestion, and response
delivery; it is not a pure backend decode benchmark. End-to-end task time also
includes BANTAM actions, verification, and audits. Input tokens are not reported
as tokens/second because 81%-87% of hard-tournament input was provider-reported
cache hits and cannot be treated as fresh prompt processing.

The operating consequence is that Luna often returns a single action fastest,
but Terra can finish hard tasks sooner by taking substantially fewer actions.
See the hard-role report for average/P90 calls, cache ratios, calculation method,
and limitations.

## Provider and billing boundaries

| Runtime | Authentication | Billing | Action constraint | Default? |
| --- | --- | --- | --- | --- |
| Local Qwen | Local llama.cpp server | Local compute, displayed as `$0 local` | GBNF grammar | Yes, whenever reachable |
| Codex models | Existing `codex login` ChatGPT account | ChatGPT/Codex subscription, displayed as `$0 subscription` | Closed JSON Schema through app-server | Explicit startup/menu selection |
| DeepSeek | `DEEPSEEK_API_KEY`, `BANTAM_API_KEY`, session entry, or saved API preset | Separate DeepSeek API billing | Forced `bantam_action` function call plus local validation | Never selected silently |

DeepSeek does **not** run through the OpenAI/Codex subscription. The Codex Max
plan applies to authenticated Codex app-server models such as Sol and Terra,
not to third-party API traffic.

`$0 subscription` means BANTAM did not meter an OpenAI API-key charge for that
turn. It does not mean the subscription itself is free.

## Starting BANTAM

From this development checkout:

```bash
./bin/run-dev.sh
```

For a different project:

```bash
./bin/run-dev.sh --workspace /absolute/path/to/project
```

For a verifier-backed project:

```bash
./bin/run-dev.sh \
  --workspace /absolute/path/to/project \
  --verify "npm test"
```

If no verifier is supplied interactively, BANTAM attempts to detect one and
offers to attach it. Declining leaves changes possible but means completion may
be reported as unverified.

### Startup selection

Without an explicit endpoint or provider flag, BANTAM probes the registered
local endpoints first. The default endpoint list is controlled by
`BANTAM_ENDPOINTS`; the common local endpoint is `http://localhost:8085`.

If local Qwen answers its health check:

1. BANTAM selects it.
2. The startup banner prints the model actually loaded.
3. No online provider is contacted.

If no local model is running in an interactive terminal, BANTAM queries the
live Codex catalog and presents a role-aware startup picker:

1. Terra medium, the recommended everyday route;
2. Luna medium, the fast route;
3. Sol high, the hard/high-assurance route;
4. other automatic current Codex choices;
5. registered local models, which can launch their configured scripts;
6. configured DeepSeek presets;
7. cancellation.

The last successful model and reasoning effort are marked and reused when
selected again. The preference file is `.bantam/model-preference.json`; it
contains only a provider kind, alias, model id, and effort—never authentication
material. The live catalog remains authoritative, so a stale preference cannot
force an unavailable model.

Each local registration may carry a launch script in `.bantam/models.json`.
Those paths are installation-specific and may be absolute; documentation should
refer to the registration name rather than copying a host path.

No hosted model is contacted for a completion merely because local Qwen is
absent. The startup catalog query discovers available choices; an operator
still selects the runtime before a task is sent.

### Pinning a local endpoint

```bash
BANTAM_ENDPOINT=http://localhost:8085 ./bin/run-dev.sh
```

Or:

```bash
./bin/run-dev.sh --endpoint http://localhost:8085
```

## Switching models inside BANTAM

At the prompt:

```text
:model
```

The numbered list combines:

- registered local models;
- configured API presets such as `deepseek-pro` and `deepseek-flash`;
- non-hidden models discovered from the authenticated Codex app-server catalog.

Bare `:model` is a wizard. Choose a model by number or name. Choosing a Codex
model opens a second selection for reasoning effort. Each Codex entry also
shows its measured operating role and whether it is recommended.

Direct forms include:

```text
:model local
:model deepseek-pro
:model deepseek-flash
:model codex-sol high
:model codex-terra xhigh
```

The Codex catalog currently has stable aliases for:

| Alias | Model |
| --- | --- |
| `codex-sol` | `gpt-5.6-sol` |
| `codex-terra` | `gpt-5.6-terra` |
| `codex-luna` | `gpt-5.6-luna` |
| `codex-5.5` | `gpt-5.5` |
| `codex-5.4` | `gpt-5.4` |
| `codex-5.4-mini` | `gpt-5.4-mini` |
| `codex-spark` | `gpt-5.3-codex-spark` |

The live catalog is authoritative. BANTAM filters hidden models, shows upgrade
warnings, and offers only the reasoning levels reported for a model. Supported
levels can include:

```text
low · medium · high · xhigh · max · ultra
```

Terra medium is the recommended default. Sol defaults to `high` when available
because its role is deliberate high-assurance work. Other models use their
catalog default or the remembered successful effort.
If a named reasoning level is unsupported, the switch is rejected rather than
silently substituting another level.

Switching from Codex to local closes the persistent app-server client. Switching
local registrations may stop and start model servers on a single-GPU machine.
If a requested API preset fails its health check, BANTAM restores the previous
model.

## Machine profile operations and captured loadouts

The top-level CLI can manage the local inference plant independently of the
in-session `:model` picker:

```bash
bantam morning
bantam fuel
bantam governor
bantam loadouts capture
bantam loadouts
bantam loadout <number|hash>
bantam swap <registered-profile>
```

`swap` resolves a registration in `.bantam/models.json`, warns from observed
load/VRAM data, launches the configured argv, and records successful swap
timing in `~/.bantam/swap-ledger.json`. Direct verbs such as `solo`, `crew`,
`max`, `solomax`, `duo`, and `crewmtp` are conveniences only when registrations
with those names exist. In the current checkout's registry they describe one-
to-four-slot variants with different context and multi-token-prediction
geometry; they are not portable product defaults.

`loadouts capture` records the live server command line, plus observed
slots/context/VRAM metadata, in `~/.bantam/loadouts.json`. `loadout` replays
that parsed invocation by index or hash. This is stricter than choosing a
friendly profile name, but it is not yet a fully lossless argv capture: the
implementation splits flattened `ps` output on whitespace, so quoted arguments
and paths containing spaces cannot be reconstructed exactly. Both stores are
operator-local and must not be treated as repository configuration or portable
benchmark evidence.

`fuel` and `governor` concern hosted-provider capacity, not local VRAM. See
[Fuel metering](fuel-metering.md) for the evidence basis, `NO-READING`
semantics, reserve thresholds, and the current automated-enforcement boundary.

## Local model profiles and chat templates

A profile holds everything about a model family that is not the endpoint:
sampling defaults, per-turn token budget, stop tokens, the assistant prefill,
and the family's **chat template** — its turn markers, what it calls the
assistant's own turn, which control tokens must be neutralized in untrusted
content, and how its reasoning channel is spelled.

| Profile | Family | Turn markers | Assistant turn | Reasoning channel |
| --- | --- | --- | --- | --- |
| `qwen` (default) | Qwen 3.x | `<\|im_start\|>role` … `<\|im_end\|>` | `assistant` | `<think>` … `</think>` |
| `gemma` | Gemma 4 | `<\|turn>role` … `<turn\|>` | `model` | `<\|channel>thought` … `<channel\|>` |
| `generic` | neutral / hosted | ChatML, no reasoning prepass | `assistant` | none |

Because the template belongs to the profile, prompt assembly is
family-agnostic: adding a model family is a profile addition, not a change to
`prompt.js`. Selection order is `--profile` (or `BANTAM_PROFILE`), then a
registry entry's `profile`, then a match on the model id, then `qwen`.

```bash
./bin/run-dev.sh run --profile gemma --endpoint http://localhost:8085 --task "..."
```

### Registering a local model

`./.bantam/models.json` (or `BANTAM_MODELS`) lists local models:

```json
[
  {
    "label": "Local Gemma 4 26B A4B (official QAT)",
    "script": "/abs/path/start_gemma4_26b_a4b_qat_100k.sh",
    "endpoint": "http://localhost:8085",
    "match": "qat",
    "profile": "gemma"
  }
]
```

`profile` is optional; omit it and the profile is inferred from the model id.
`match` is a substring of the id the server reports at `/v1/models`, and it
matters whenever several models share one endpoint: BANTAM only restarts the
server when the resident id fails the match. An entry with no `match` means
"whatever is already serving that port", so on a single-GPU machine where every
model uses 8085, leaving it blank makes BANTAM drive the resident model under
the wrong template instead of switching.

### Gemma 4 specifics

Gemma 4 gates reasoning with a `<|think|>` token at the start of the system
turn, which BANTAM emits only when the run's think mode is not `off` — think
mode is fixed per run, so the prompt prefix stays cache-stable. With thinking
disabled the model still emits an empty thought block, which is the fast action
rail.

Two behaviors are worth knowing before running one:

- **Historical model turns carry no thought block.** BANTAM renders them as bare
  `<|turn>model\n` + content, per the canonical template. Replaying an empty
  closed block instead (the Qwen shape) makes the model close its reasoning
  channel after one token on every turn that has history, which BANTAM reads as
  "cannot think" and latches the rail off for the rest of the run.
- **It is a long-CoT model.** At the default 4096-token think budget every phase
  ends truncated mid-sentence. Bound it:

  ```bash
  BANTAM_THINK_N_PREDICT=1024 ./bin/run-dev.sh run --profile gemma --think auto ...
  ```

  Measured across five gauntlet fixtures: 4096 → 3/5 and ~15 minutes, `off` →
  2/5, **1024 → 5/5 and 7 minutes**.

Sampling follows Google's published guidance (temperature 1.0, top-p 0.95,
top-k 64). See
`docs/superpowers/reports/2026-07-26-gemma4-profile-and-fixture-integrity.md`.

## Local prompt trajectories

How the per-turn prompt relates to the previous turn's prompt is a runtime
choice with large cache consequences on local servers. **`rebuild` is the
default for every transport**; `extension` is an explicit choice:

```bash
BANTAM_PROMPT_TRAJECTORY=rebuild    # default
BANTAM_PROMPT_TRAJECTORY=extension  # opt-in: byte-extension prompts, measured below
```

**`rebuild`** reassembles volatile sections every turn: superseded reads are
collapsed in place, the `<open_files>` panel is refreshed after history, and
per-turn guidance re-renders at the tail. This is the right trade for a small
model that must not be handed two competing source truths, and for providers
whose cache can reuse an arbitrary byte-common prefix.

**`extension`** makes every prompt begin with the previous prompt byte-for-byte:
the head (system menu, task, environment, run-start plan/skills) is frozen for
the run, history is immutable and append-only, and nothing renders after it.
Guidance that would have lived in the tail is folded once into the newest
observation when its content changes; the `<open_files>` panel is not rendered
at all, because immutable history retains every read body as the source of
truth. The history character budget widens (120k default instead of 36k) since
an eviction slides the window and resets the slot cache.

Extension-mode assistant turns render **bare** (`<|im_start|>assistant\n`
directly followed by the action) rather than replaying the profile's empty
closed think block. Adopted 2026-08-14 by preregistered A/B on Qwen 3.8:
replaying empty `<think></think>` blocks in immutable history taught the model
in-context that turns here do not reason — the auto think rail collapsed to
the turn-0 opener, with 12 of 13 phase-1 completions returning empty in the
worst run. Bare history restored post-turn-0 thinking in 9/9 runs, eliminated
empty think completions (29 → 0), and passed 6/9 vs control's 4/9
(`docs/superpowers/reports/2026-08-14-extension-bare-history-results.md`).
`BANTAM_EXTENSION_BARE_HISTORY=0` restores the closed-think form.

The mode exists because of how llama.cpp caches **hybrid-attention** models
(Qwen 3.5/3.6): their recurrent state cannot rewind to an arbitrary prefix
position, so `cache_prompt` restores a saved context checkpoint or nothing.
Checkpoints are saved at prompt ends, and a prompt end embeds that turn's
volatile tail — so under `rebuild` the only checkpoint that survives across
turns is the run's initial head. Measured on the 2026-08-12
`dependency-scheduler` run: 16 of 21 calls reused exactly the 1,804-token head
regardless of how many thousands of prefix characters they actually shared, and
the two think-phase calls whose menu had churned reused zero.

Same fixture, same seed, both arms passing the hidden contract 4/4:

| | rebuild (frozen head) | extension |
| --- | ---: | ---: |
| Prefix reuse (llama.cpp `cache_n`) | 64% | **92%** |
| Fresh prefill tokens | ~41k | **~16.5k** |
| Prefill time | 20.9s | **11.5s** |
| Wall time | 129.1s | 131.9s |

Evidence:
`.bantam/experiments/2026-08-12T08-17-26-652Z-local-prompt-trajectory-a-b-rebuild-vs-extension/`.

Wall time was a wash on that short fixture because decode dominates once
prefill stops being wasted; the reuse advantage compounds with run length,
since `rebuild` re-prefills a growing prompt every turn while `extension` pays
only for each turn's appended bytes.

Extension held the local default for part of 2026-08-12 and lost it the same
day, both times by preregistered rule. The four-fixture flip experiment
(results:
`docs/superpowers/reports/2026-08-12-extension-trajectory-results.md`) put it
ahead on correctness (11/12 vs 10/12) with fresh prefill at 8% of control and
92% vs 47% slot reuse. The breadth sweep then flagged the compact-strictness
family, and the routing decision at n=10 per arm (results:
`docs/superpowers/reports/2026-08-12-strictness-routing-results.md`) measured
rebuild 10/10 against extension 7/10 there — the missing `<open_files>` panel
leaves post-bounce repairs working from stale self-knowledge — and its ordered
rule reverted the default globally rather than buy per-family routing
complexity. What survives: extension's efficiency evidence stands (roughly
2.4x faster wall on equal workloads in the breadth sweep) for anyone who opts
in on tasks with strong verifiers, and the run-frozen system head from the
same day's work is trajectory-independent, lifting rebuild's own reuse from
36% to 64% and halving its prefill waste.

Related, and independent of the trajectory choice: the system-turn action menu
is rendered from the run's base features and never changes mid-run. A
turn-scoped capability grant (line-pointer editing during edit recovery)
teaches its exact JSON shape inside the recovery guidance instead of rewriting
the menu — a menu rewrite sits above every checkpoint and invalidates the
entire cached prefix, which is what zeroed the think-phase calls above.

## Setting up Codex

Codex uses the operator's existing Codex authentication:

```bash
codex login
codex login status
```

Codex defaults to BANTAM's neutral `generic` prompt profile. Its selected
reasoning effort is handled natively by Codex; BANTAM does not also run the
Qwen-specific `<think>` prepass unless an operator explicitly selects the Qwen
profile. Completed run summaries show accepted turns and model calls
separately. A `+N auxiliary` count identifies retries, invalid-output repairs,
or another explicit model phase above the one-call-per-turn baseline.

The status should report a ChatGPT login. Then start BANTAM and use `:model`.
No OpenAI API key is required for the subscription route.

A headless Codex-backed BANTAM run is:

```bash
./bin/run-dev.sh run \
  --codex \
  --model gpt-5.6-sol \
  --codex-effort high \
  --task "fix the failing parser" \
  --workspace . \
  --verify "npm test" \
  --save-run .bantam/runs/codex-sol.json
```

### Codex lifecycle and deadlines

BANTAM keeps one app-server process while Codex remains selected. Individual
agent runs use one bounded native thread by default; later BANTAM requests,
trio arms, and gauntlet fixtures receive separate threads. Model clients are
explicitly closed after experiment fixtures and arms. Use
`--codex-thread-mode ephemeral` for the former one-thread-per-completion
rollback behavior.

Codex calls have three deadlines:

| Layer | Default | Meaning |
| --- | ---: | --- |
| Control plane | 30 seconds | Starting threads and other app-server requests |
| Inactivity | 120 seconds | No matching progress for the active turn |
| Hard completion | 600 seconds | Absolute lifetime of one completion |

The corresponding controls are:

```text
BANTAM_CODEX_CONTROL_TIMEOUT_MS
BANTAM_CODEX_IDLE_TIMEOUT_MS
BANTAM_MODEL_TIMEOUT_MS
```

Matching reasoning and item-lifecycle progress refreshes the inactivity timer.
A timeout interrupts the thread, recycles an ambiguous app-server, becomes
structured `modelFailure` evidence, and exits nonzero in headless mode. It is
not automatically replayed, because an ambiguous coding turn may already have
caused a side effect.

### Default run-scoped Codex threads

Codex reuses one native thread only within one `runAgent` invocation by
default. This is equivalent to `--codex-thread-mode run` (or
`BANTAM_CODEX_THREAD_MODE=run`). BANTAM
creates an opaque run token before the first request and clears the binding in a
`finally` block. A later user request, another trio arm, or another gauntlet run
therefore starts a different thread. Concurrent completions and model changes
inside one run-scoped thread fail closed. Native tools remain declined.

The explicit compatibility rollback is:

```bash
./bin/run-dev.sh gauntlet \
  --quick \
  --models sol,terra \
  --effort high \
  --codex-thread-mode ephemeral \
  --codex-prompt-mode full
```

Artifacts record `model.metadata.codexThreadMode` plus
`metrics.codexThreads.{mode,calls,uniqueThreads,reusedCalls}`. This proves
whether a measured run really reused one native thread rather than inferring
reuse from cache counters.

Every newly built run artifact also records
`metrics.codexPromptIntegrity`. The offline auditor parses each canonical
request, follows full bases by native thread id, reconstructs every exact delta,
and independently checks request, canonical, delivered, character-count,
savings, and thread-reuse evidence. A Codex fixture becomes
`evidence-invalid` if this verdict is not `pass`.

```bash
./bin/run-dev.sh audit-codex path/to/run-artifact.json
./bin/run-dev.sh audit-codex path/to/a.json path/to/b.json --json
./bin/run-dev.sh audit-codex path/to/run-artifact.json --calls
```

This command is local and model-free. Exit `0` means every applicable artifact
passed (local artifacts are reported as not applicable), exit `1` means
integrity failure, and exit `2` means an artifact could not be read or parsed.
`--calls` prints one bounded diagnostic row per Codex request: exactness,
delivery mode, delivered/canonical characters, savings, input/cache-miss,
output/reasoning tokens, and wall time. Pair it with `--json` for structured
diagnostics; prompt text is not copied into these rows.

Use the complete run auditor when the trust question extends beyond prompt
delivery:

```bash
./bin/run-dev.sh audit-run path/to/run-artifact.json
./bin/run-dev.sh audit-run path/to/a.json path/to/b.json --json
```

This read-only command verifies artifact identity, normalized per-turn tool
outcomes and aggregate counts, exact source-attributed usage arithmetic,
attachment metadata/indexes/bytes/hashes with no symlink traversal, and Codex
prompt reconstruction. Complete final diffs also have their bytes, SHA-256,
file list, and file count recomputed; intentionally truncated diffs are
reported as partial because their full pre-truncation hash cannot be reproduced.
The command never imports task code or contacts a model. Legacy missing fields
are named as `not-applicable`; present but malformed or inconsistent evidence
fails closed.

Fixture and experiment runs make this check load-bearing after assembling their
attachments and final diff. The compact verdict is stored under
`metrics.runArtifactIntegrity` and aggregated in the summary. Any audit failure
overrides task success with `evidence-invalid`; no audit content enters the
model prompt or observation.

Run scoping was promoted only after paired same-model evaluation, isolation
tests, process-death recovery, and exact artifact reconstruction. Run/full
alone reduced cache-miss input but raised accumulated total input substantially;
the promoted default therefore combines run scope with exact prompt deltas.
See
[Codex integration improvements](CODEX-INTEGRATION-IMPROVEMENTS.md) for the
tables, evidence paths, and promotion criteria.

### Default exact prompt deltas

With run-scoped threads, BANTAM defaults to `--codex-prompt-mode delta`
(or `BANTAM_CODEX_PROMPT_MODE=delta`). Delta mode requires run scope and fails
closed if paired explicitly with ephemeral threads. The first request sends and records
the complete canonical BANTAM prompt. Later requests are compared with that
first immutable base and may send a `BANTAM_PROMPT_DELTA_V1` envelope containing:

- the base SHA-256;
- an exact JavaScript UTF-16 prefix length;
- the complete replacement suffix;
- the reconstructed canonical SHA-256.

The delta is used only when the common prefix is at least 2,048 characters and
the transmitted envelope is smaller than the complete prompt. If either test
fails, BANTAM closes the old binding, starts a fresh native thread, and sends
the complete current canonical prompt as the new immutable base. Deltas never
chain from previous deltas, so reconstruction cannot accumulate patch drift.
The transport stores the exact delivered delta text and checksums with the
model response; the original model request still stores the complete canonical
prompt. Native Codex tools remain declined and BANTAM's executor remains the
only workspace authority.

### External edits during a run

Run-scoped native continuity does not make Codex's earlier view of the
workspace authoritative. BANTAM fingerprints the exact bytes of up to twelve
recently read paths. It scans those paths at the start of each action turn and
again after the model returns but before the proposed action is executed.

When another process or the operator changes an observed path, BANTAM:

- invalidates the read ledger, duplicate-action cache, paging state, grounding
  entry, repository brief revision, preview proof, and verifier proof derived
  from the old bytes;
- abandons any regression snapshot that could otherwise restore over the
  external edit;
- refreshes the directory listing and symbolic repository state;
- reanchors the next prompt with the changed paths and makes current disk
  content authoritative; and
- refuses the current proposed action if the change arrived while the model
  was choosing it.

Agent-owned writes and shell changes refresh the fingerprints instead of being
misclassified as external. The tracker is deliberately bounded to observed
paths: it protects facts already supplied to the model without hashing the
entire repository every turn. Fingerprints and pending-change paths are stored
with each completed turn and crash checkpoint, so an edit made between user
requests or before a resumed lane is detected against the last observed bytes.
Legacy checkpoints without fingerprints discard restored read coverage rather
than claiming stale observations are current. Run artifacts and gauntlet
summaries report external mutation events, paths, and stale actions blocked.

```bash
./bin/run-dev.sh gauntlet --quick --models sol --effort high
```

Selecting only `--codex-thread-mode ephemeral` infers its compatible `full`
prompt mode. Selecting only `--codex-prompt-mode delta` infers `run`. Explicit
`ephemeral` plus `delta` remains an error rather than silently changing either
requested policy.

`--codex-rebase-every <n>` (or `BANTAM_CODEX_REBASE_EVERY`) can additionally
force a fresh canonical thread after `n` calls. The default is `0`, meaning no
periodic rotation; automatic inefficient-delta and failed-turn recovery still
apply. Periodic rotation is a recovery/long-horizon experiment, not the current
efficiency default.

`--codex-rebase-min-savings <ratio>` (or
`BANTAM_CODEX_REBASE_MIN_SAVINGS`) is the adaptive alternative. A value from
zero to one rotates only when the next valid delta would save less than that
fraction of its canonical prompt. Zero disables the threshold. For example,
`0.2` means “install a fresh canonical base once delta delivery saves less than
20%.” The threshold remains opt-in. During BANTAM's bounded post-green
completion audit, optional low-savings rebasing is suppressed through any
audit correction, re-verification, and terminal decision. Inefficient-delta
fallback and failed-turn recovery are correctness boundaries and are not
suppressed.

Artifacts expose `model.metadata.codexPromptMode` and
`metrics.codexPromptDelivery`, including full, delta, and fallback calls;
canonical and delivered characters; saved characters; saved ratio; rebase
calls; rebase reasons; the minimum per-delta savings ratio; and the number of
deltas below 20%. Thread metrics separately record fresh, reused, and rebased
calls, terminal rebases, calls after rebases, and one-based rebase call indices.

Measured evidence keeps this opt-in. A balanced three-round ordered-map study
held every arm at 3/3 strict and reduced delivered prompt characters 49.3%.
Run/delta was 16.6% faster than run/full, with 14.7% fewer total input tokens
and 17.3% fewer cache-miss tokens. A separate five-fixture sweep held all three
arms at 5/5 strict with zero invalid/protocol actions. Against run/full,
run/delta delivered 47.8% fewer characters, used 11.1% fewer total input tokens,
26.1% fewer cache-miss tokens, and 10.1% less reasoning, but was 4.4% slower
and used one extra turn. This is a useful quota/context-efficiency mode, not
yet a universal latency winner.

A five-fixture forced-rebase study kept both continuous delta and
`--codex-rebase-every 3` at 5/5 strict with zero invalid or protocol actions.
The short interval reduced total reported input 7.0%, but increased cache-miss
input 3.3%, reduced delivery savings from 49.9% to 38.6%, and increased task
time 25.4%. Therefore periodic rebasing remains disabled by default; the
automatic inefficient-delta rebase is the normal safety path. See the
[delta-rebase evaluation](superpowers/reports/2026-07-26-codex-delta-rebase.md).

A separate live long-horizon study used a twelve-module adapter migration with
public tests initially green and four hidden contract groups initially red.
Across two balanced experiments, continuous delta and adaptive `0.2` each
finished 4/4 strict. Combined adaptive results used 22.3% fewer input tokens,
10.8% fewer cache-miss tokens, 12.4% fewer reasoning tokens, and 3.2% less task
time, but model-path variance was large: one experiment was faster and the
independent replication was 31 seconds slower. All four adaptive rotations
were late, including two terminal rotations. This evidence supports the
completion-aware guard and continued opt-in status, not promotion to the
default. The trace audit reconstructed all 159 saved calls exactly.

## Setting up DeepSeek

The recommended secret path is an environment variable:

```bash
export DEEPSEEK_API_KEY='your-key'
./bin/run-dev.sh
```

Then select it:

```text
:model deepseek-pro
```

If the selected preset has no key and neither `DEEPSEEK_API_KEY` nor
`BANTAM_API_KEY` is set, BANTAM asks for one with hidden terminal input. That
interactive value is used for the session.

An API endpoint can also be validated and saved with `doctor`:

```bash
./bin/run-dev.sh doctor \
  --api-url https://api.deepseek.com/v1 \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-pro \
  --deepseek
```

Saved API configuration lives at `.bantam/api.json` in the workspace. The
current format can contain an API key in plaintext. Prefer environment
variables on shared or backed-up machines, keep `.bantam/` private, and rotate
any key that has appeared in terminal history, chat, logs, or version control.

DeepSeek's public route is chat-completions based. BANTAM converts its
canonical transcript into native system, user, and assistant messages. Action
turns use non-thinking mode and a forced `bantam_action` function call whose
parameters are the current BANTAM action schema. Returned arguments still pass
through BANTAM's parser and semantic policy; the provider function call is
generation guidance, not trusted execution.

DeepSeek does not implement BANTAM's GBNF grammar, and the stable API's
function calling is not claimed as strict schema enforcement. BANTAM therefore
retains its own validation. See
[External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md) for
the repaired architecture, live Flash/Pro evidence, and the reusable
integration checklist.

## What an ordinary request does

At the prompt:

```text
bantam ❯ Fix the cache expiration bug and run the tests.
```

BANTAM:

1. adds bounded session context when this is a follow-up request;
2. constructs the system prompt, workspace facts, task, verifier state, and
   currently allowed action menu;
3. asks the selected runtime for a thinking completion or one structured action;
4. parses and validates the action;
5. applies workspace, shell, network, and capability policy;
6. executes the action;
7. records the raw model output separately from the parsed action;
8. feeds the bounded observation into the next request;
9. refreshes grounding after edits;
10. runs verification according to the current mode;
11. repeats until a response, verified completion, explicit block, failure,
    turn limit, or user interruption.

Interactive requests use permissive operator-facing completion semantics:
unverified edits are allowed but labeled. `--autonomous` enables the stronger
progress, premature-completion, and ledger gates required when no operator is
watching.

Ctrl-C interrupts the active work. Completed filesystem changes remain, so a
later `keep going` continues from actual workspace state.

## Usage accounting

In the REPL:

```text
:usage on
:usage
:usage reset
:usage off
```

It can be enabled at startup with `--usage` or `BANTAM_USAGE=on`.

Each model response can report:

- input tokens;
- output tokens;
- reasoning tokens;
- prefix/cache hit and miss tokens;
- estimated direct-API cost;
- provider/model identity.

The session line aggregates every response since startup or the last reset,
including responses made before or after a model switch.

Local llama.cpp and Codex expose different cache semantics. Local accumulated
prefix-cache counters can exceed the summed prompt-token count and should not be
treated as directly equivalent to Codex cache reads and cache creation.

## What is automatic

Ordinary use does **not** automatically launch a gauntlet, contact teacher
models, edit BANTAM's source, or promote a candidate.

The automatic part is observation:

1. A completed operational BANTAM run is summarized.
2. If it was launched by this development checkout, bounded harness telemetry
   is written to this checkout—not to the task project.
3. Task text, trajectory, verifier output, and summaries are excluded.
4. The task is represented by a SHA-256 digest.
5. The store is capped at 200 rows.
6. Repeated symptoms can later appear as self-improvement candidates.

Observed signals include:

- terminal verification quality;
- edit-grounding and rejected-edit recovery;
- malformed or invalid model output;
- duplicate actions or shell actions;
- no-op edits;
- excessive reconnaissance or progressless turns;
- progress-gate termination.

Observation creates evidence and candidate proposals. It grants no mutation
authority.

## What triggers governed self-improvement

The operator triggers it with:

```text
:self-improve plan
:self-improve
:self-improve --no-apply
:self-improve --candidate <candidate-id>
```

Or:

```bash
./bin/run-dev.sh self-improve --plan
./bin/run-dev.sh self-improve
./bin/run-dev.sh self-improve --no-apply
./bin/run-dev.sh self-improve --candidate <candidate-id>
```

The REPL also recognizes deliberately imperative natural language:

```text
Let's do a little self improvement.
Run a self-improvement cycle now.
I want you to self-improve.
```

Questions and discussion do not trigger it:

```text
How does self-improvement work?
Should we do self-improvement?
Tell me about self-improvement.
```

The parser rejects questions, negations, descriptions, and vague mentions.
When an authorized request arrives during ordinary work, BANTAM stops the
current operation at its abort boundary and queues self-improvement as the next
top-level operation. It is never injected as ambient steering into another
task.

### Candidate sources

`self-improve --plan` merges:

1. reproducible static-scan candidates;
2. recurring runtime-observation candidates;
3. cross-reviewed teacher-council candidates.

It prints the ranked selection without making model calls or changing source
or controller state.

### One managed cycle

```text
green exact baseline
    ↓
freeze one candidate and its allowed source scope
    ↓
create private lane from the exact channel version
    ↓
implementation agent works only in the lane
    ↓
immutable candidate suite + protected baseline suite
    ↓
content-address the passing candidate
    ↓
stage on dev or transactionally deploy
    ↓
authoritative live verification
    ↓
evidence-gated compare-and-swap promotion
```

Important controls:

- the target must be the exact BANTAM checkout that owns the launcher;
- the baseline must be green with a positive observed test count;
- one candidate is frozen before implementation;
- existing tests, launchers, dependency configuration, and capture rules are
  immutable;
- tests run in isolated materializations, not against controller state;
- baseline test count cannot decrease;
- candidate bytes are hashed before deployment;
- concurrent human edits are preserved as conflicts rather than overwritten;
- failed pre-promotion deployment restores exact backups;
- recursive self-improvement is refused.

`--no-apply` retains the verified candidate on `dev` without changing the live
checkout.

Runtime-observation and teacher-council candidates are build-only. Their
evidence can justify implementing and testing a hypothesis, but cannot prove
behavioral lift. They remain staged on `dev` until a preregistered paired
experiment supplies promotion evidence.

## What triggers a gauntlet

Only an explicit operator command triggers a gauntlet. There is currently no
timer, scheduler, failure hook, conversational implication, or automatic
post-task launch.

Inspect the normalized plan without model calls:

```bash
./bin/run-dev.sh gauntlet \
  --dry-run \
  --models local,sol,terra
```

Run one fixture as a wiring check:

```bash
./bin/run-dev.sh gauntlet \
  --quick \
  --models local,sol,terra
```

Run an order-balanced comparison:

```bash
./bin/run-dev.sh gauntlet \
  --models local,sol,terra \
  --rounds 3 \
  --effort high \
  --faults
```

Available options:

| Option | Meaning |
| --- | --- |
| `--models local,sol,terra` | Select comparison arms; all live non-hidden Codex aliases are accepted |
| `--fixtures <list>` | Select built-in fixtures |
| `--rounds <n>` | Repeat and rotate arm order |
| `--effort <level>` | Codex reasoning effort |
| `--codex-thread-mode run\|ephemeral` | Codex thread lifetime; default `run`, explicit rollback `ephemeral` |
| `--codex-prompt-mode delta\|full` | Codex prompt delivery; default `delta` with run scope, rollback `full` |
| `--codex-rebase-every <n>` | Fresh canonical thread every `n` delta-run calls; `0` disables periodic rotation |
| `--codex-rebase-min-savings <ratio>` | Adaptive fresh base when delta wire savings fall below `0..1`; `0` disables |
| `--quick` | Use only the first selected fixture |
| `--faults` | Run transport/model fault tests before fixtures |
| `--faults-only` | Run only fault tests |
| `--output <dir>` | Choose evidence directory |
| `--dry-run` | Print spec and schedule without model calls |

The fault suite includes a real child-process death after eight accepted
run-thread requests. It verifies the ninth logical request records the failed
attempt, restarts app-server, replays the same complete canonical prompt on a
fresh native thread, and resumes exact delta delivery from that recovered base.

### What a gauntlet run does

For every scheduled arm/fixture pair:

1. copy the same broken starter repository into a fresh workspace;
2. give the selected model the same task;
3. run the normal BANTAM action loop;
4. keep public tests, package configuration, and out-of-scope files immutable;
5. grade the final filesystem with a hidden model-invisible contract;
6. save the complete run artifact and normalized provider accounting;
7. close the model client;
8. checkpoint the experiment manifest.

The seven built-in fixtures are:

- `ordered-map`;
- `ttl-cache`;
- `safe-config-merge`;
- `range-parser`;
- `retry-policy`;
- `keyed-task-pool`;
- `adapter-migration`.

Each begins public-test green and hidden-contract red. This prevents the agent
from merely repairing an obvious public failure and makes final-filesystem
grading authoritative. The last two are deliberately harder: one exercises
Promise identity, lifecycle, concurrency, cross-file orchestration, and async
failure semantics; the other migrates twelve adapters across strict validation,
immutability, prototype safety, sparse inputs, and numeric/date boundaries.

### Gauntlet output

By default:

```text
.bantam/gauntlets/<experiment-id>/
  manifest.json
  catalog.json
  summary.md
  ledger.jsonl
  faults.json                  # when --faults is used
  runs/<arm>/round-<n>/*.json
  showcase/index.html
```

The report includes strict pass rate, Wilson interval, pass@k, turns, requests,
input/output/cache/reasoning tokens, provider cost, task and wall time, invalid
actions, protocol violations, duplicate actions, no-op edits, audit hints,
patches, file operations, total prompt characters, exact byte-prefix reuse, and
added/replaced prompt suffix characters.

Each saved run includes `modelCalls[].promptTelemetry` and
`metrics.promptChurn`. Section fingerprints identify whether churn began in
system rules, initial context, action history, observations, guidance, or open
files without storing another prompt copy. This harness-measured prefix evidence
stays separate from provider-reported cache accounting.

The showcase supports any number of arms, links each recorded artifact, and
ranks correctness before turns, time, and cache-miss input. A fast failed arm
therefore cannot outrank a strict pass.

Current measured showcases are:

[Local Qwen vs Codex Sol vs Codex Terra](../comparison/model-gauntlet/2026-07-25-local-sol-terra/report/index.html)

[Sol/Terra/Luna/GPT-5.5 hard-role tournament](../.bantam/experiments/codex-hard-tournament-2026-07-25/showcase/index.html)

One round is useful integration evidence but is not order-balanced. Repeat and
rotate arms before changing a routing policy. The hard-role tournament used two
rounds; its small sample still supports only workload-specific operating
guidance, not universal model claims.

## Parallel trio mode

The gauntlet answers a research question over fixed hidden-contract fixtures.
Trio mode answers a working-session question: “How would Local Qwen, Sol, and
Terra each handle this actual request?” It is also operator-triggered; ordinary
BANTAM use never silently starts two subscription models.

One-shot:

```bash
./bin/run-dev.sh trio run \
  --task "repair the cache and preserve the public API" \
  --workspace /path/to/project \
  --verify "npm test" \
  --models local,sol,terra \
  --effort high
```

Persistent interactive use:

```text
bantam ❯ :trio on high
bantam ❯ Repair the cache and preserve the public API.
bantam ❯ Add regression coverage for the expiration edge case.
bantam ❯ :trio compare
bantam ❯ :trio apply sol
```

After `:trio on`, every ordinary request is sent concurrently to three
persistent BANTAM lanes. Each lane retains its own filesystem and a bounded
summary of its earlier requests, so a follow-up continues each model's own
work. Activity is tagged as `[local]`, `[sol]`, or `[terra]` and printed as it
arrives. `:trio off` closes the model clients and returns subsequent prompts to
the currently selected single model.

### Isolation and apply contract

Starting a session captures one content-addressed baseline of the live project.
The executable lane workspaces are materialized under a private external
temporary directory—not beneath the source project. This prevents agents from
writing over one another and prevents tools such as `node --test` from
recursively discovering test copies inside `.bantam`.

The source `.bantam/trios/<session-id>/` directory contains inert evidence:

```text
manifest.json
events.jsonl
summary.md
comparisons/turn-<n>.json
runs/<arm>/turn-<n>-<stamp>.json
report/index.html
transactions/                 # only after an apply
```

The manifest records the external runtime root and each lane path for
inspection. A run does not copy a candidate back. Selection is deliberately
separate:

```bash
./bin/run-dev.sh trio show /path/to/.bantam/trios/<session-id>
./bin/run-dev.sh trio apply /path/to/.bantam/trios/<session-id> \
  --arm terra --yes
```

Apply:

1. requires an explicit arm and `--yes` (or REPL confirmation);
2. refuses if any live source byte changed since the frozen baseline;
3. materializes and verifies the selected candidate outside the source tree;
4. computes a three-way transactional change set;
5. applies it to the live workspace;
6. runs the verifier again against the live workspace;
7. commits the transaction on green or restores exact backups on failure.

Trio mode records per-arm status, turns, requests, input/output/reasoning and
cache tokens, provider cost when available, elapsed time, final diff, complete
run artifact, and final summary. Subscription-backed Codex rows correctly show
zero metered API cost while retaining token and reasoning traffic.

### What trio mode does not do

- It does not automatically choose a winner; fastest and fewest-turn labels are
  descriptive, not quality judgments.
- It does not merge three candidates.
- It does not apply a candidate without explicit confirmation and verification.
- It does not automatically call the teacher council or launch self-improvement.

The trio artifacts are suitable inputs for later comparative diagnosis. That
next step remains a separate consent boundary: use `collaborate ... --yes` to
ask Sol and Terra to derive cross-reviewed harness hypotheses, then use the
governed self-improvement controller to build and test any selected hypothesis.
See the [implementation and live proof](superpowers/reports/2026-07-25-parallel-trio-mode.md).
For a task-oriented walkthrough, command reference, result-reading guide, and
troubleshooting, use the dedicated [Trio Mode operator guide](TRIO-MODE.md).

## Collaborative Team mode

Team mode is a separate explicit workflow from Trio. It runs Local when
reachable plus Luna medium, Sol high, and Terra medium concurrently as
read-only specialists. Their bounded findings are then handed to a second Terra
run. Terra alone may write an isolated candidate for implementation requests.

```text
bantam ❯ :team on
bantam ❯ Diagnose and fix the lifecycle race without changing the public API.
bantam ❯ :team compare
bantam ❯ :team apply
```

It never starts automatically, does not launch Local, never permits concurrent
writers, and never changes the live workspace before confirmed verified apply.
Use it for hard cross-cutting work where parallel assurance is worth the extra
model traffic; continue using a single Terra or Luna run for routine work.

See [Team Mode](TEAM-MODE.md) for roles, phases, commands, isolation, telemetry,
promotion semantics, costs, and limitations.

Team's live results currently establish wiring, isolation, read-only scouting,
restored integration provenance, and visible synthesis. They do not establish a
broad quality or efficiency advantage over solo Terra or Sol. The next
evidence phase will compare those modes on identical fresh tasks and use
correctness-first grading before proposing harness changes. See
[Evaluation and Improvement Loop](EVALUATION-AND-IMPROVEMENT-LOOP.md).

## Teacher collaboration

A gauntlet produces evidence; it does not automatically ask Sol or Terra to
teach the local model.

To analyze one same-task trio:

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --preview

./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --yes
```

`--preview` is local-only and requires no consent flag. It resolves the exact
three artifacts from the trio manifest, validates their shared task, and emits
a hash-bound deterministic trajectory comparison. Passing `--yes` sends the
bounded redacted packet, including that comparison, to the configured teachers.
The original `local.json sol.json terra.json` form remains supported.

Optional external grades and settings:

```bash
./bin/run-dev.sh collaborate \
  local.json sol.json terra.json \
  --grades local=3/10,sol=9/10,terra=10/10 \
  --models gpt-5.6-sol,gpt-5.6-terra \
  --effort high \
  --yes
```

`--yes` is mandatory because a bounded task/trajectory evidence packet leaves
the machine for Codex.

Without `--proactive`, teacher calls require a local struggle signal:

- failed or blocked local result;
- failing external grade;
- at least 20 local turns;
- invalid output;
- protocol violation;
- duplicate action or duplicate shell action;
- no-op edit;
- progress-gate termination.

`--proactive` is an explicit override for studying a clean local run.

The council:

1. verifies that artifacts are comparable;
2. computes deterministic outcome, action, verification, and path divergence;
3. constructs one bounded, credential-redacted evidence packet;
4. asks Sol and Terra for independent diagnoses and adversarial tests;
5. asks each teacher to review the other's exact hypotheses;
6. accepts only cross-reviewed hypotheses;
7. preserves each candidate's cited evidence and comparison SHA-256;
8. clusters recurring mechanisms across distinct tasks;
9. writes hash-bound reports and build-only candidates.

Teacher consensus is witness evidence, not promotion evidence. Teachers cannot
write BANTAM source, modify tests, move channels, or self-certify a deployment.

## The complete improvement flywheel

```text
ordinary work
    ↓
bounded automatic observation
    ↓
operator runs a gauntlet when comparison is useful
    ↓
local/Sol/Terra same-task artifacts
    ↓
operator authorizes teacher collaboration
    ↓
independent diagnosis + reciprocal review
    ↓
build-only candidate appears in self-improve plan
    ↓
operator launches governed self-improvement
    ↓
private lane + immutable tests
    ↓
paired held-out experiment for behavioral lift
    ↓
evidence-gated promotion or retained/rejected candidate
```

The intended asymmetry is:

- observation may be automatic;
- external model calls require explicit selection or authorization;
- comparative experiments require explicit launch;
- source mutation requires an explicit governed self-improvement request;
- promotion requires objective evidence.

## Recommended operating patterns

### Everyday local-first work

```bash
./bin/run-dev.sh --workspace /path/to/project --verify "npm test"
```

Keep local Qwen selected. Switch to Terra for a difficult but routine problem,
or Sol for a particularly hard diagnosis. Return with `:model local`.

### Preserve a difficult run

```bash
./bin/run-dev.sh run \
  --task "..." \
  --workspace /path/to/project \
  --verify "npm test" \
  --autonomous \
  --save-run /path/to/local-run.json
```

Run the same task through Codex with the same starting repository when you want
a comparable reference artifact.

### Validate the multi-model system

```bash
./bin/run-dev.sh gauntlet --faults-only
./bin/run-dev.sh gauntlet --quick --models local,sol,terra
```

### Produce research-quality comparison evidence

```bash
./bin/run-dev.sh gauntlet \
  --models local,sol,terra \
  --rounds 3 \
  --effort high \
  --faults \
  --output .bantam/gauntlets/local-sol-terra-3round
```

### Inspect improvement opportunities without writes

```bash
./bin/run-dev.sh self-improve --plan
```

### Build a selected candidate without touching live source

```bash
./bin/run-dev.sh self-improve \
  --candidate <candidate-id> \
  --no-apply
```

## Trigger matrix

| Event | Automatic observation | Calls online model | Runs gauntlet | Changes BANTAM source | Can promote |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary local task | Yes | No | No | No | No |
| Ordinary Codex task | Yes | Yes, selected Codex | No | Only the task workspace | No |
| Ordinary DeepSeek task | Yes | Yes, selected API | No | Only the task workspace | No |
| Repeated runtime symptom | Candidate only | No | No | No | No |
| `gauntlet ...` | Yes | For selected hosted arms | Yes | No | No |
| `trio run ...` / `:trio on` | Yes, three isolated lanes | Sol/Terra by explicit mode | No | No until explicit apply | No |
| `trio apply ... --yes` | Uses saved evidence | No | No | Selected task workspace only, transactionally | No |
| `collaborate ... --yes` | Saves teacher report | Yes | No | No | No |
| `self-improve --plan` | Reads observations | No | No | No | No |
| `self-improve --no-apply` | Records attempt | Selected implementation model | No | Private lane/dev checkpoint | No |
| Evidence-eligible `self-improve` | Records attempt | Selected implementation model | No | Governed transactional deployment | Only after all gates |

## Troubleshooting

### Local model is not found

```bash
./bin/run-dev.sh health --endpoint http://localhost:8085
```

Then start it through the interactive startup menu or run the registered Qwen
script directly.

### Codex models do not appear

```bash
codex login status
```

Confirm that the account is signed in, restart BANTAM, and run `:model` again.
The live app-server catalog controls availability.

### Codex stalls

The current transport should terminate on its control, inactivity, or hard
deadline and save `modelFailure` evidence. Verify the deterministic failure
paths with:

```bash
./bin/run-dev.sh gauntlet --faults-only
```

### DeepSeek asks for a key

Set `DEEPSEEK_API_KEY`, configure a preset, or enter it at the hidden prompt.
If an exposed key was pasted into chat or terminal history, rotate it.

### Number selection is treated as a task

Numbers are model selections only while the `:model` wizard is actively asking
for a choice. Outside that wizard, use:

```text
:model 3
```

### A teacher council makes no calls

The local artifact has no recognized struggle signal. That is expected. Supply
a failing external grade or explicitly choose `--proactive`.

### A teacher/runtime candidate will not promote

That is also expected. These are build-only hypotheses until a preregistered,
paired behavioral experiment demonstrates lift without unacceptable regression.

## Related documentation

- [How BANTAM works](GUIDE.md)
- [External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md)
- [Self-improvement system](SELF-IMPROVEMENT.md)
- [Principles](PRINCIPLES.md)
- [Measured Local/Sol/Terra integration report](superpowers/reports/2026-07-25-local-codex-model-gauntlet.md)
- [Local/Sol/Terra showcase](../comparison/model-gauntlet/2026-07-25-local-sol-terra/report/index.html)
