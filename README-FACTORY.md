# BANTAM — Local-Model Coding Agent

A constrained-action coding agent that owns the full loop:
build prompt → constrained completion → parse action → execute in workspace →
observe → repeat until done. Local models are constrained with GBNF; Codex uses
an equivalent strict JSON Schema through its native app-server runtime.

For the complete current system—architecture, runtimes, turn lifecycle,
Codex integration, Team/Trio/gauntlet operation, teacher collaboration,
self-improvement governance, artifacts, safety boundaries, commands, measured
proof, and limitations—start with the
**[BANTAM System Handbook](docs/BANTAM-SYSTEM-HANDBOOK.md)**.
What a user watching a run sees (and how network consent works — off by
default, ask-per-fetch, `--dangerously-allow-net`) is documented in
**[The interactive experience](docs/INTERACTIVE-EXPERIENCE.md)**.
The **[documentation index](docs/README.md)** separates current operator guides,
experimental factory material, and historical evidence. A source-review
notebook with architectural observations and
possible next directions lives in
**[Discoveries and Directions](docs/DISCOVERIES-AND-DIRECTIONS.md)**.
Terminal-Bench work in this repository means only the
**[curated Terminal-Bench 2.1 79-task subset](docs/TERMINAL-BENCH-2.1-SUBSET.md)**
stored in `./terminal-bench`; tasks outside that local catalog are intentionally
out of scope and are not benchmark failures or pending work.
For the evidence-derived manufacturing philosophy — why a task decomposes into
checkable stations, and why a blind verifier is worse than none — see
**[BANTAM as a factory](docs/FACTORY-MODEL.md)**. The experimental
`BANTAMFACTORY` architecture extends that idea into compiled job routes,
contracted stations, local gauges, line supervision, and a staged proof program;
start with the **[BANTAMFACTORY documentation index](docs/BANTAMFACTORY/README.md)**.

## Quick Start

```bash
npm install
./bin/run-dev.sh doctor              # check readiness, scaffold model registry
./bin/run-dev.sh doctor --setup      # download llama.cpp + model, scaffold, launch
./bin/run-dev.sh                     # interactive development REPL
```

To illuminate an ordinary run on the experimental BANTAMFACTORY floor:

```bash
./bin/run-dev.sh run --factory --task "Implement the requested change" \
  --workspace . --verify "npm test"
./bin/run-dev.sh factory list
./bin/run-dev.sh factory dispatch
./bin/run-dev.sh factory schedule
./bin/run-dev.sh factory workers onboard \
  --endpoint http://127.0.0.1:8085 --profile qwen --yes
./bin/run-dev.sh factory contract-edges \
  "An empty input returns an empty result." \
  --catalog examples/factory/contract-edge-catalog.json \
  --expected empty-input --endpoint http://127.0.0.1:8085 --profile qwen
./bin/run-dev.sh factory contract-plan \
  "A missing key returns null." \
  --catalog examples/factory/contract-edge-catalog.json \
  --expected missing-key --endpoint http://127.0.0.1:8085 --profile qwen
./bin/run-dev.sh factory test-scenario \
  "A lookup for an absent key must return null." \
  --edge-id missing-key --catalog examples/factory/test-scenario-catalog.json \
  --expected absent-returns-null --endpoint http://127.0.0.1:8085 --profile qwen
./bin/run-dev.sh factory blueprint show \
  src/factory/blueprints/contract-edge-cell.json
./bin/run-dev.sh factory blueprint report \
  src/factory/blueprints/contract-edge-cell.json \
  --job-id <job-id> --factory-home .bantam/factory-qwen36-qualification \
  --output factory-blueprint.html
./bin/run-dev.sh factory show <job-id> --at 12
./bin/run-dev.sh factory report <job-id> --output factory-floor.html
./bin/run-dev.sh factory floor <job-id> --port 4317
./bin/run-dev.sh factory yard --port 4318
```

Local onboarding proves endpoint health, exact served-model identity, observed
slots, context, and constrained grammar operation. It records attendance only;
it never grants a station qualification. Factory telemetry is opt-in and does
not route or alter agent actions. See the
[factory operations guide](docs/BANTAMFACTORY/OPERATIONS.md) for storage,
dispositions, single-line time travel, multi-job supervision, offline audit,
and current limitations.

### Machine operations

The development CLI also exposes local, machine-scoped controls:

```bash
./bin/run-dev.sh morning                 # local server, recent work, fuel, governor
./bin/run-dev.sh fuel                    # read provider records already on this machine
./bin/run-dev.sh governor                # show reserve policy and kill-switch state
./bin/run-dev.sh governor halt "reason"  # write .bantam/no-spend for automated errands
./bin/run-dev.sh governor resume
./bin/run-dev.sh loadouts capture        # capture the live server invocation
./bin/run-dev.sh loadouts                # list captured machine loadouts
./bin/run-dev.sh loadout <number|hash>   # replay one captured argv
./bin/run-dev.sh swap <profile>          # launch a registered local profile
```

Fuel is observational: Codex percentages come from vendor-reported snapshots
in local session records; Claude shows only locally measured token volume and
never fabricates a percentage. `NO-READING` is distinct from zero. The governor
is currently enforced automatically by the librarian and citation-verification
errands; it is not a universal interceptor for every hosted-model path. Loadouts,
profile names, swap timings, and launch scripts are machine-local. Current
capture parses the flattened `ps` command line, so quoted arguments or paths
containing whitespace are not losslessly round-tripped. See
[Fuel metering](docs/fuel-metering.md) and
[Model runtimes](docs/MODEL-RUNTIMES-AND-IMPROVEMENT.md).

Or point at an existing OpenAI-compatible server:

```bash
bantam --api-url http://localhost:8080 --model qwen3-27b
```

The interactive `:model` picker keeps a reachable local model as the default
and can switch the same BANTAM session to DeepSeek or any live Codex model.
When no local endpoint is healthy, startup presents a Codex-first role menu:
Terra medium is the measured everyday recommendation, Luna is the fast option,
and Sol is the hard/high-assurance option. BANTAM remembers the last successful
model and reasoning level in `.bantam/model-preference.json`; it stores no
credentials there. Codex uses your existing ChatGPT/Codex subscription
login—run `codex login` once if `codex login status` does not report a signed-in
account. No OpenAI API key is needed for this path.

### DeepSeek quick start

DeepSeek V4 Pro and Flash are separately billed hosted API routes; they do not
use the Codex subscription. Prefer an environment variable so the key does not
need to be saved in workspace configuration:

```bash
export DEEPSEEK_API_KEY='your-key'
./bin/run-dev.sh
```

Then select a preset in the REPL:

```text
:model deepseek-pro
:model deepseek-flash
```

For headless work, make the provider explicit:

```bash
./bin/run-dev.sh exec "Inspect this repository and identify the main risk." \
  --deepseek --model deepseek-v4-pro --workspace .

./bin/run-dev.sh run \
  --deepseek --model deepseek-v4-pro \
  --workspace . --task "Implement the requested change." \
  --verify "npm test" --save-run
```

Pro is the current contract-sensitive coding recommendation; Flash is the
lower-cost reconnaissance/advisory option. That routing rule is based on one
controlled hidden-contract fixture and is deliberately narrower than a general
model ranking. The adapter uses native chat roles, non-thinking routine action
turns, and a forced `bantam_action` function call while BANTAM retains local
validation and execution authority. See
[External API provider integration](docs/EXTERNAL-API-PROVIDER-INTEGRATION.md)
for the full repair record, telemetry, troubleshooting, and future-provider
checklist.

For an explicitly collaborative run, use `:team on`. BANTAM then runs Local
when reachable as a repository mapper, Luna as contract auditor, and Sol as
adversarial reviewer, hands their bounded findings to a Terra primary, and
keeps Terra's candidate isolated until `:team apply`. Team mode never starts
from an ordinary prompt. Every scout lane is restored to its pre-scout commit
before integration, and any observed scout mutation fails the phase closed.
See the [Team Mode operator guide](docs/TEAM-MODE.md).

**Measured operating default:** use single-agent Terra medium for routine
implementation. Across the current controlled samples it is substantially
faster and cheaper on broad work while matching Team correctness. Team is an
explicit assurance purchase for concurrency, security, lifecycle, ambiguous
contracts, or unusually costly hidden failures—not a generally superior mode.

The next development phase is an evidence-first solo-versus-Team evaluation
loop, not another automatic routing mode. It will compare verified outcomes,
critical-path time, aggregate provider traffic, and observable trajectories
before proposing any harness change. The planned `:team benchmark` convenience
command is **not implemented yet**; existing gauntlet, experiment, Trio, and
Team artifacts provide the current substrate. See the
[Evaluation and Improvement Loop](docs/EVALUATION-AND-IMPROVEMENT-LOOP.md).

Measured on the repeated hard suite, Terra medium delivered 47.25 observed
output tokens/second and completed tasks in 89.8 seconds on average. Luna had
the fastest median individual call at 4.96 seconds but averaged 105.0 seconds
per task because it used more turns. Sol high averaged 192.9 seconds while
providing the most assurance-oriented trajectory. These are complete
app-server wall-time measurements, not raw backend decode rates. See the
[hard Codex role tournament](docs/superpowers/reports/2026-07-25-codex-hard-role-tournament.md)
for the full method, compact-suite control, cache ratios, and limitations.

## What It Does

- **Interactive-first**: describe work in natural language, watch concise tool
  activity, steer mid-run, and continue across requests with cross-request memory.
- **Constrained actions**: local servers use GBNF and Codex app-server turns use
  a strict, closed JSON Schema generated from the same action definitions and
  per-turn capability masks. Invalid output still becomes a normal repair turn.
- **Sandboxed execution**: all actions run inside a workspace directory with
  symlink-aware realpath resolution.
- **Live workspace coherence**: BANTAM fingerprints recently read files,
  invalidates stale reads and verification proofs after an external edit, and
  refuses an action chosen while those bytes were changing.
- **Hidden verifier**: attach a test command (`--verify`) and BANTAM grades the
  final result against ground truth the model never sees.
- **Self-improvement**: the trajectory witness in `src/diagnose.js` classifies a
  run's own distress signals into ten kinds (redundant-read, phantom-replace,
  fabricated-api, corrupted-oracle, false-regression, …), and three witness
  modules in `src/logic/` — `reference-witness`, `critic-witness`, and
  `kb-diff-witness` — generate remedies, replay-score them, and promote only on
  novel engagement signals. In this development checkout,
  `./bin/run-dev.sh self-improve` also runs the governed self-host path: private
  exact lane → immutable tests → transactional deployment → live-checkout
  verification → content-addressed promotion or exact rollback.
- **Modular logic layer**: grounding, test focus, previews, escalation,
  repository maps, evidence guards, Datalog facts, vision, provider fuel,
  loadouts, and more live under `src/logic/`. Treat the directory and its
  integration tests as authoritative; a fixed module count goes stale quickly.

## Architecture

| Component | File | Role |
| --- | --- | --- |
| Development CLI | `bin/bantam.js` via `bin/run-dev.sh` | Current argument parsing, setup, doctor checks, REPL loop |
| Packaged CLI | `bin/bantam.js` | Entry exposed as `bantam` by `package.json` |
| Agent loop | `src/agent.js` | Build → complete → parse → execute → observe |
| Workspace coherence | `src/workspace-coherence.js` | Detect out-of-band changes to observed files and block stale actions before execution |
| Model client | `src/model.js` | Local, API, and Codex app-server transports with bounded retry, cancellation, and usage accounting |
| Codex transport | `src/codex-transport.js` | Persistent app-server process, run-scoped exact-delta completion threads, explicit ephemeral/full rollback, strict output, streaming, deadlines, recovery, and cleanup |
| Parallel trio | `src/trio-session.js` | Concurrent isolated Local/Sol/Terra sessions, comparable evidence, and guarded transactional selection |
| Collaborative team | `src/team-session.js` | Explicit parallel Local-if-online repository mapping plus Luna contract and Sol adversarial scouting, bounded evidence handoff, one Terra writer, complete cache/token telemetry, and guarded apply |
| Teacher council | `src/teacher-collaboration.js` | Local-first Sol/Terra diagnosis, reciprocal review, adversarial-test plans, durable build-only candidates |
| Prompt assembly | `src/prompt.js` | System prompt + context building, chat-token scrubbing |
| Executor | `src/executor.js` | Run validated actions in sandboxed workspace |
| Action constraints | `src/grammar.js` | Matching GBNF and strict JSON Schema generation |
| Logic modules | `src/logic/` | Grounding, convergence, evidence, machine-operation, and evaluation helpers |
| Factory runtime | `src/factory/`, `src/factory-cli.js` | Typed travelers, cells, workforce, blueprints, Fact Bus, yard, dispatch, and observe-only scheduling |

## Governed Self-Improvement (Development Checkout)

Use the local launcher so you never load an older global Bantam:

```bash
./bin/run-dev.sh self-improve --plan    # no model/controller writes; launcher may bootstrap missing deps
./bin/run-dev.sh self-improve           # build, test, deploy, promote
./bin/run-dev.sh self-improve --no-apply # stop after the verified dev checkpoint
```

Inside the interactive prompt, use `:self-improve`, `:self-improve plan`, or a
deliberate request such as “Let’s do a little self improvement.” Completed
operational runs launched by this development checkout—including work in other
projects—append only bounded, redacted outcome counters to this checkout; task
text is stored as a SHA-256 digest and no telemetry is written into the task
project. Repeated runtime symptoms become proposals, and an explicitly selected
proposal can be built and tested in a private lane.
Because redacted telemetry is not a replayable efficacy verifier, that result is
staged on `dev` only; behavioral proposals still require a preregistered paired
A/B before live deployment or `regular` promotion. Repeating the same build-only
candidate explicitly against the same baseline reuses its current verified `dev`
checkpoint instead of rebuilding it; ordinary repeated cycles advance past
already verified build-only candidates.

### Multi-model hidden-contract gauntlet

Run the same held-out coding repairs through fresh isolated workspaces:

```bash
./bin/run-dev.sh gauntlet --quick --models local,sol,terra
./bin/run-dev.sh gauntlet --models local,sol,terra --rounds 3 --faults
# Codex defaults to one bounded native thread per BANTAM run and exact
# base-relative prompt deltas after the first canonical prompt.
./bin/run-dev.sh gauntlet --quick --models sol,terra
# Every live non-hidden Codex alias is accepted. This example uses the measured
# operating roles and their explicit reasoning levels through an experiment spec.
./bin/run-dev.sh experiment \
  examples/experiments/codex-hard-tournament-2026-07-25.json
# Explicit rollback/control: one fresh native thread and full prompt per request.
./bin/run-dev.sh gauntlet --quick --models sol \
  --codex-thread-mode ephemeral --codex-prompt-mode full
# Optional recovery experiment: rotate to a fresh canonical thread every 12 calls.
./bin/run-dev.sh gauntlet --quick --models sol \
  --codex-rebase-every 12
# Adaptive experiment: rotate only after wire savings fall below 20%.
./bin/run-dev.sh gauntlet --quick --models sol \
  --codex-rebase-min-savings 0.2

# One manifest can also place native Codex and Claude Code in the same hidden-
# contract protocol. --dry-run is model-free; --yes is mandatory for execution.
./bin/run-dev.sh experiment examples/experiments/model-league-smoke.json --dry-run
./bin/run-dev.sh experiment examples/experiments/model-league-smoke.json --yes
```

Native experiment arms use `runtime: "native-codex"` or
`runtime: "native-claude"`. They receive isolated copies and retain their full
CLI streams, but BANTAM—not the delegate—assigns the result after rerunning the
public verifier, hidden contract, and immutable-scope audit on the captured
candidate. Every row also records an observable escalation decision: complete,
repair context, request a diagnostic teacher, delegate the task, retry an
infrastructure failure, or require human review. Model confidence is never an
input. On hosts where Codex's `bwrap` helper cannot initialize, a native Codex
arm may explicitly set `"bypassSandbox": true`; this is accepted only for that
runtime, still requires `--yes`, and runs against BANTAM's disposable fixture
copy. The original fixture and hidden grader remain outside the delegate's
workspace.

At experiment completion BANTAM also writes `trajectory-audit.json` and
`trajectory-audit.md`. The audit recomputes every stored BANTAM API request and
response hash, verifies hash-bound raw native JSONL, and reports repeated
reads/commands, permission failures, sandbox failures, and cross-teacher logic
patterns. Candidate Datalog remains hypothesis-only until recurrence or a
preregistered replay. The frozen five-round protocol is
`examples/experiments/model-league-v1.json`; it contains 225 runs, including an
explicitly expensive Opus arm, so inspect its dry-run schedule before launch.

The seven built-in fixtures begin public-test green but hidden-contract red:
the original five compact repairs plus the harder `keyed-task-pool` async
lifecycle task and twelve-module `adapter-migration`.
Their existing tests, package configuration, and out-of-scope files are
immutable. Each arm receives the same task and starting bytes. Reports under
`.bantam/gauntlets/` include pass/strict rates, turns, model requests,
input/output/reasoning tokens, prefix-cache hits and misses, cost, elapsed time,
invalid actions, protocol violations, and all autonomous-gate counters.
Codex reports also distinguish canonical prompt characters from characters
actually delivered to app-server, including delta/fallback counts and saved
delivery ratio. They also include an offline exactness verdict. Re-audit any
saved Codex run without contacting a model:

```bash
./bin/run-dev.sh audit-codex .bantam/gauntlets/<run>/runs/<arm>/<artifact>.json
./bin/run-dev.sh audit-codex .bantam/gauntlets/<run>/runs/<arm>/<artifact>.json --calls
```

The command exits nonzero on a missing base, malformed delta, checksum,
character-count, reconstruction, or thread-reuse mismatch. New Codex gauntlet
runs also fail as `evidence-invalid` when this audit does not pass. `--calls`
adds per-request prompt delivery, token/cache/reasoning, and latency diagnostics
without exposing prompt contents.

For the broader evidence envelope, audit any saved run without contacting a
model or executing workspace code:

```bash
./bin/run-dev.sh audit-run path/to/run-artifact.json
./bin/run-dev.sh audit-run path/to/a.json path/to/b.json --json
```

`audit-run` re-hashes archived attachments (rejecting missing files, symlinks,
and path traversal), reconciles normalized tool outcomes with their aggregate
counts and their causally-linked external usage, sums every source-attributed
usage field against the run total, and
recomputes complete final-diff metadata and hashes before reusing the exact
Codex prompt-delivery audit. Exit `0` means all applicable
checks passed; exit `1` means evidence failed. Older artifacts remain auditable:
fields that predate their schema are reported as `not-applicable` warnings
rather than invented proof.

Fresh `run --save-run` and lane artifacts persist task-scoped aggregate and
per-source usage too. For a restored historical prefix, BANTAM intentionally
leaves aggregate usage unavailable instead of attaching the new segment's
numbers to the whole trajectory.

Fixture and experiment artifacts run the complete audit before acceptance.
Their bounded verdict is stored in `metrics.runArtifactIntegrity`; an audit
failure overrides a green task result with `evidence-invalid` and appears in the
experiment summary. Experiment summaries also list gate interventions. If an
arm enables a recognized opt-in gate but that gate rejects zero actions, BANTAM
marks its quality and efficiency deltas as non-attributable to the mechanism;
a coincidental pass-rate change is not promotion evidence, and `channel promote`
rejects it. Failed runs are indexed separately with their arm, round, fixture,
contract counts, and direct artifact link.

Interrupted experiments can resume from either a clean harness or an exactly
matching dirty harness snapshot. Dirty recovery is fail-closed: the commit,
porcelain status, worktree diff, staged diff, and content hashes for all
untracked files must match the original manifest. Any changed or incomplete
fingerprint refuses recovery.

Delta mode automatically starts a fresh canonical thread when
the next delta would be inefficient. `--codex-rebase-every <n>` additionally
forces periodic fresh-thread checkpoints; `0` disables periodic rotation and
is the measured default. A five-fixture trial showed that an interval of three
was correct but 25.4% slower, so short periodic intervals are not recommended.
The opt-in adaptive threshold instead rotates only when the next exact delta's
saved-character ratio falls below the configured value. Reports expose the
minimum observed ratio and count deltas below 20% so the policy can be selected
from evidence rather than guessed. They also expose terminal rebases,
post-rebase calls, and one-based rebase call indices. Once BANTAM enters its
bounded post-green completion audit, optional low-savings rebases are suppressed
for the rest of that audit phase; correctness-required fallback and failed-turn
recovery remain active.
`--faults` first exercises silent turns, control-plane hangs, cancellation,
non-retryable timeouts, terminal failure evidence, and real app-server
child-process death after a long delta history. The recovery case proves a
bounded retry starts from the complete canonical prompt and then resumes exact
deltas from the new base. Use three rounds for a balanced three-arm order;
`--quick` is a one-fixture wiring/smoke check.
Every completed gauntlet now freezes the live Codex catalog in `catalog.json`
and writes a self-contained N-model `showcase/index.html` beside its manifest.
The showcase ranks correctness before efficiency and displays failed arms
honestly. See the
[measured Local/Sol/Terra report](comparison/model-gauntlet/2026-07-25-local-sol-terra/report/index.html)
and the
[hard Codex role tournament](docs/superpowers/reports/2026-07-25-codex-hard-role-tournament.md).

### Live parallel trio mode

Trio mode runs an ordinary request through Local Qwen, Codex Sol, and Codex
Terra concurrently. Each arm receives the same frozen source tree and owns a
different external temporary workspace, so model edits and recursive test
discovery cannot collide. The terminal streams tagged `[local]`, `[sol]`, and
`[terra]` activity as it arrives; BANTAM then writes the three run artifacts,
token/request/timing comparison, Markdown summary, and HTML report under
`.bantam/trios/`.

```bash
# One-shot
./bin/run-dev.sh trio run \
  --task "fix the failing cache behavior" \
  --workspace /path/to/project \
  --verify "npm test" \
  --effort high

# Inspect or deliberately promote one result
./bin/run-dev.sh trio show /path/to/project/.bantam/trios/<session-id>
./bin/run-dev.sh trio apply /path/to/project/.bantam/trios/<session-id> \
  --arm sol --yes
```

In the REPL, `:trio on [effort]` makes subsequent ordinary prompts persistent
three-lane turns. Use `:trio compare`, `:trio status`, and
`:trio apply <local|sol|terra>`; `:trio off` returns to the selected single
model. A trio run never modifies the source workspace. Apply is a separate,
explicit operation that refuses a stale baseline, verifies the candidate,
applies it transactionally, verifies the live tree, and rolls back on failure.
Reviews, explanations, and suggestion requests are hard read-only trio turns
and are scored as successful responses without running the verifier. Coding
requests retain the normal edit-and-verify loop; their isolated lanes receive a
dependency and toolchain preflight before model work begins.
Trio comparison produces telemetry; it does not automatically trigger teacher
collaboration or governed self-improvement.

See the dedicated [Trio Mode operator guide](docs/TRIO-MODE.md) for the complete
interactive and one-shot workflows, result interpretation, safe apply process,
artifact layout, troubleshooting, and teacher/self-improvement handoff.

### Sol/Terra teacher council

When the local model struggles on a task that was also run through Sol and
Terra, turn the three saved artifacts into an independent, cross-reviewed
improvement witness:

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

The first command is entirely local: it resolves the exact Local/Sol/Terra
artifacts and prints a hash-bound deterministic comparison of outcomes, action
divergence, verification attempts, and read/edit coverage. The second command
explicitly authorizes the teacher calls. Explicit artifact paths remain
supported:

```bash
./bin/run-dev.sh collaborate \
  /path/to/local-run.json \
  /path/to/sol-run.json \
  /path/to/terra-run.json \
  --grades local=3/10,sol=9/10,terra=10/10 \
  --yes
```

The council sends the same bounded, credential-redacted packet—including the
deterministic trajectory comparison—to both Codex models. Sol and Terra
independently diagnose reusable harness gaps and propose adversarial tests,
then each reviews the other's exact hypotheses. Only
cross-accepted hypotheses are written under
`.bantam/teacher-collaboration/reports/`. They appear in
`./bin/run-dev.sh self-improve --plan` as **build-only** candidates.

Teacher output never changes source, tests, `dev`, or `regular` by itself.
`--yes` is required because task and trajectory evidence leaves the machine.
A clean local run with no struggle signal makes no calls unless `--proactive`
is explicit. Even unanimous teacher consensus remains a hypothesis: the
governed private-lane build, counterfactual replay, fresh-task paired experiment,
and evidence-gated promotion rules still apply.

When model review is unnecessary, reduce the same saved artifacts locally:

```bash
./bin/run-dev.sh hypothesize \
  /path/to/local-run.json \
  /path/to/sol-run.json \
  /path/to/terra-run.json
```

`hypothesize` makes no model calls and changes no source. It emits candidates
only for a failing subject versus passing references, hashes the exact
trajectory comparison, and attaches falsification, promotion, and rollback
criteria. Use `--json` to feed later experiment tooling.

Teacher candidates are implemented one narrow vertical slice per governed
cycle. The council's adversarial cases are a falsification menu, not a request
to build every proposed mechanism at once. The builder is held to its frozen
source targets (plus at most one connected helper) and a six-action
reconnaissance budget before it must edit or identify a real blocker.

## Documentation

- [Native Codex and Claude Code delegates](docs/NATIVE-CODEX-DELEGATES.md) — an explicitly
  consented research control for comparing isolated native Codex or Claude Code
  with constrained BANTAM. Native trajectories and raw Claude stream JSON are
  retained for inspection; native delegation is not an ordinary routing option.
- [Why Codex works efficiently inside BANTAM](docs/WHY-BANTAM-MAKES-CODEX-EFFICIENT.md)
  — the in-depth system-level finding: measured results, cognitive economics,
  why constraints can increase observed capability, the “cognitive
  exoskeleton” model, local-model and self-improvement implications, capability
  boundaries, threats to validity, research program, routing doctrine, and the
  evidence required to reconsider native delegation.

- **[BANTAM System Handbook](docs/BANTAM-SYSTEM-HANDBOOK.md)** — canonical end-to-end description of what BANTAM is, how every major subsystem works, what is automatic, evidence/consent boundaries, current proof, and limitations
- **[Model runtimes, gauntlets, and self-improvement](docs/MODEL-RUNTIMES-AND-IMPROVEMENT.md)** — complete operator handbook: local/DeepSeek/Codex setup, model switching, triggers, evidence, and commands
- **[External API provider integration](docs/EXTERNAL-API-PROVIDER-INTEGRATION.md)** — DeepSeek V4 repair, controlled Flash/Pro evidence, prompt/reasoning/structured-action architecture, and a reusable validation standard for future hosted providers
- **[Codex integration improvements](docs/CODEX-INTEGRATION-IMPROVEMENTS.md)** — measured efficiency findings, current fixes, experiment design, and guarded next steps
- **[Evaluation and improvement loop](docs/EVALUATION-AND-IMPROVEMENT-LOOP.md)** — current baseline, solo-versus-Team study design, required telemetry, grading rules, proposed `:team benchmark` workflow, and evidence-gated route from observations to local-harness improvements
- **[Collaborative Team implementation report](docs/superpowers/reports/2026-07-26-collaborative-team-mode.md)** — the complete build narrative, two-phase protocol, adversarial hardening findings, live subscription evidence, regression coverage, claims boundary, and stopping state
- **[Solo Terra versus Team evaluation](docs/superpowers/reports/2026-07-26-solo-terra-v-team-keyed-task-pool.md)** — controlled keyed-concurrency implementation comparison with public, hidden, and task-derived grading; full cache/token/time telemetry; honest solo win; and two harness issues discovered and fixed
- **[Team v2 controlled follow-up](docs/superpowers/reports/2026-07-26-team-v2-controlled-followup.md)** — corrected contract-auditor/adversarial-reviewer/sole-primary composition tested on concurrency and a twelve-module migration, including the repaired contract miss, large traffic reduction on the first task, broad-task efficiency failure, and resulting preservation-aware handoff
- **[Codex prompt-delta evaluation](docs/superpowers/reports/2026-07-25-codex-prompt-delta.md)** — exact delivery design, two live Sol studies, evidence, and promotion limits
- **[Codex delta-rebase evaluation](docs/superpowers/reports/2026-07-26-codex-delta-rebase.md)** — recovery semantics, exact trace audit, live breadth results, and the disabled-by-default periodic policy
- **[Seven-model Codex tournament](docs/superpowers/reports/2026-07-25-codex-model-tournament.md)** — 35 isolated hidden-contract runs across every live non-hidden Codex model, with correctness, trajectory quality, time, input/cache/output/reasoning telemetry, failure analysis, and routing recommendations
- **[Trio Mode](docs/TRIO-MODE.md)** — run Local/Sol/Terra concurrently, compare evidence, and safely apply one candidate
- **[How It Works & How to Run It](docs/GUIDE.md)** — full reference
- **[Self-Improvement System](docs/SELF-IMPROVEMENT.md)** — witnesses, promotion, replay
- **[Roadmap](docs/ROADMAP.md)** — what's next
- **[Realization Plan](docs/BANTAM-REALIZATION-PLAN.md)** — design decisions
- **[Fable Defaults](docs/FABLE_DEFAULTS.md)** — prompt rules & gates
- **[Fact Log](docs/FACT_LOG.md)** — measured evidence
- **[Grounding Tools](docs/GROUNDING_TOOLS.md)** — code KB and repo map
- **[Principles](docs/PRINCIPLES.md)** — design philosophy
- **[Superpowers](docs/superpowers/README.md)** — experiment reports

## License

MIT
