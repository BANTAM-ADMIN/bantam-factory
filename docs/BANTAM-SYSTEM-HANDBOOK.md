# BANTAM System Handbook

> The current Codex operating policy is documented in
> [WHY-BANTAM-MAKES-CODEX-EFFICIENT.md](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md).
> Measured same-task evidence favors schema-constrained Codex inside BANTAM in
> elapsed time and total token processing. Native Sol/Terra CLI delegation is
> retained only as an explicitly consented research control; it is not an
> ordinary model-routing option.

> Canonical description of the current BANTAM system: what it is, how it
> operates, what Local/Codex/trio/self-improvement mean, what is automatic, what
> requires authorization, where evidence lives, and what has actually been
> verified.
>
> Source and documentation audit refreshed **2026-08-19**. No models, project
> commands, or test suites were run during that docs-only audit. The numerical
> checkpoints later in this handbook are retained as dated evidence from their
> original runs, not presented as fresh verification of the current tree.

## 1. What BANTAM is

BANTAM is a coding-agent **harness**. It is not merely a chat client and it is
not merely a wrapper around one model.

The harness owns a complete controlled loop:

```text
user request
    ↓
classify task intent
    ↓
assemble bounded repository context and action constraints
    ↓
ask the selected model for one structured BANTAM action
    ↓
validate and admit that action
    ↓
execute it through BANTAM's workspace tools
    ↓
record the observation and update evidence
    ↓
repeat until response, verified completion, interruption, or bounded failure
```

The selected model supplies decisions. BANTAM supplies the operating system
around those decisions:

- the prompt and context;
- the available action vocabulary;
- filesystem and command execution;
- workspace boundaries;
- observations and recovery messages;
- progress and repetition policy;
- verification and completion gates;
- run artifacts and accounting;
- experiments, comparisons, and promotion governance.

That separation is the central design decision. It lets the same BANTAM agent
run with:

- a local OpenAI-compatible model server;
- DeepSeek's API;
- subscription-backed OpenAI Codex models through Codex app-server.

The model changes. The BANTAM action protocol, workspace policy, verifier,
evidence format, and promotion rules remain under harness control.

## 2. The three roles BANTAM now fills

### 2.1 A practical local coding agent

The normal default is a local Qwen model. It can inspect repositories, edit
files, execute commands, run tests, explain code, and maintain a continuing
interactive session without sending inference traffic to an external model.

### 2.2 An online Codex-powered BANTAM agent

BANTAM can select Sol, Terra, Luna, and other supported Codex catalog entries
while retaining BANTAM's constrained loop. Codex is used as the structured
decision engine; it does not silently become a second uncontrolled workspace
agent.

This path uses the operator's Codex/ChatGPT subscription login. It is distinct
from ordinary metered OpenAI API traffic.

#### DeepSeek as a hosted BANTAM reasoning engine

BANTAM also supports separately billed DeepSeek V4 Pro and Flash. The provider
adapter translates BANTAM's canonical transcript into native chat roles,
selects a neutral prompt profile, disables unbounded native thinking for
routine action turns, and forces one `bantam_action` function call described by
the current action schema. BANTAM still parses, validates, admits, executes,
observes, and verifies the returned action.

This provider-specific translation is important: OpenAI-compatible HTTP
endpoints do not imply compatible prompts, reasoning controls, structured
output, streaming, or usage fields. The complete repair record and reusable
provider checklist are in
[External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md).

### 2.3 A comparative improvement laboratory

BANTAM can run the same task through Local, Sol, and Terra:

- on standardized hidden-contract fixtures with a gauntlet;
- on a real project in three isolated workspaces with trio mode.

It records the resulting trajectories, final filesystems, grades, tokens,
latency, cache behavior, and protocol health. Those observations can then be
used by a governed Sol/Terra teacher council to propose improvements to the
local BANTAM harness.

## 3. What “improving the local model” means

BANTAM does **not** currently retrain or fine-tune Qwen's neural weights.

It improves the effective local agent by improving the machinery surrounding
the weights:

- better repository context at the right moment;
- stronger action constraints;
- better tool feedback;
- more useful recovery after malformed or ineffective actions;
- improved file and test targeting;
- completion gates that catch premature success;
- less repeated or stale work;
- durable learned failure patterns and skills;
- better experiment-backed policies.

This is harness-level learning. The local model receives a better interface,
better evidence, and better guardrails, so its observable coding behavior can
improve without a weight update.

The distinction matters:

```text
model-weight improvement     changes the neural model
harness improvement          changes how BANTAM helps the model perceive,
                             decide, act, recover, and prove completion
```

This repository implements the second category.

## 4. Core terminology

| Term | Meaning in BANTAM |
| --- | --- |
| Model | The inference model, such as local Qwen, GPT-5.6-Sol, or GPT-5.6-Terra |
| Provider | The credential/network source used to reach a model |
| Runtime/transport | How BANTAM exchanges completions with that provider |
| Harness | BANTAM's action loop, tools, policies, evidence, and verification |
| Arm | One model/configuration participating in an experiment |
| Lane | A materialized, isolated, versioned workspace state |
| Run artifact | A durable JSON record of one BANTAM run |
| Verifier | A command whose result independently grades the produced workspace |
| Witness | Evidence that identifies a possible harness weakness |
| Candidate | A bounded proposed harness improvement |
| `dev` | A content-addressed development channel/checkpoint |
| `regular` | The deliberately promoted channel |
| Trio | Concurrent Local/Sol/Terra work on one real task |
| Gauntlet | Standardized, isolated evaluation across fixture tasks |
| Teacher council | Independent Sol/Terra diagnosis plus reciprocal review |

## 5. Launchers and installation surfaces

There are two important entry points.

### 5.1 Development checkout

Use this while developing BANTAM itself:

```bash
./bin/run-dev.sh
```

This launcher always executes this checkout's `bin/bantam.js`. It also verifies
the small parser dependencies used by the development build. It avoids
accidentally invoking an older global installation.

### 5.2 Packaged/stable entry

The package manifest exposes:

```text
bin/bantam.js
```

through the `bantam` command. The current development work and the commands
documented in this handbook should be exercised through `./bin/run-dev.sh`
unless specifically validating the packaged entry.

## 6. First start

### 6.1 Prepare a local model automatically

```bash
npm install
./bin/run-dev.sh doctor
./bin/run-dev.sh doctor --setup
./bin/run-dev.sh
```

### 6.2 Use an already-running local server

```bash
./bin/run-dev.sh doctor \
  --api-url http://localhost:8085 \
  --model qwen3-27b

./bin/run-dev.sh
```

### 6.3 Prepare Codex subscription access

```bash
codex login status
codex login
```

Then open BANTAM and select a Codex model:

```text
bantam ❯ :model
```

The picker asks for:

1. a model;
2. a supported reasoning level;
3. confirmation by returning to the BANTAM prompt with the new selection.

If no registered local endpoint is healthy, this same role-aware model picker
appears during startup. It recommends Terra medium for ordinary work, offers
Luna as the fast route and Sol high as the hard/high-assurance route, and then
lists other automatic Codex, local-launch, and configured API choices. The last
successful selection is marked and stored in
`.bantam/model-preference.json`. That file contains no token, account, or API
key.

Direct switching is also supported:

```text
:model codex-sol high
:model codex-terra medium
:model local
```

The live Codex model catalog remains authoritative. Model availability can
change with the installed Codex version and signed-in account.

### 6.4 Inspect and control this machine's inference plant

These commands read or change machine-local operating state; they do not alter
the BANTAM action protocol:

```bash
./bin/run-dev.sh morning
./bin/run-dev.sh fuel
./bin/run-dev.sh governor
./bin/run-dev.sh governor halt "operator reason"
./bin/run-dev.sh governor resume
./bin/run-dev.sh loadouts capture
./bin/run-dev.sh loadouts
./bin/run-dev.sh loadout <number|hash>
./bin/run-dev.sh swap <registered-profile>
```

`morning` combines reachable local-server status, recent workspace run totals,
provider fuel, and the governor verdict. Fuel readings come only from local
provider records: Codex can expose vendor-reported quota percentages, while
Claude records only this machine's token volume. Missing or unrecognized data
is `NO-READING`, never zero.

The governor combines `.bantam/governor.json`, its conservative defaults, and
the `.bantam/no-spend`/`BANTAM_NO_SPEND=1` kill switch. Its automated
enforcement currently covers the librarian and citation-verification errands;
other hosted-model routes remain explicit operator actions rather than being
universally intercepted. A kill switch takes precedence over force.

Loadouts capture and replay a live local-server invocation. Capture currently
parses the flattened `ps` command line by whitespace, so it is exact only when
individual arguments contain no whitespace; quoted paths/values do not round
trip losslessly. `swap` and
the direct profile verbs resolve names through `.bantam/models.json`, so profile
names, scripts, slot geometry, context size, VRAM estimates, and timing history
are installation-specific. See [Fuel metering](fuel-metering.md) and
[Model runtimes](MODEL-RUNTIMES-AND-IMPROVEMENT.md).

## 7. Ordinary interactive use

> **What the feed shows vs what the model sees:** the interactive feed hides
> internal station notes (steers/gates/pins) because they read as malfunction
> to an observer; `BANTAM_SHOW_STATIONS=1` restores them, and run films always
> keep every byte. Shell **network is off by default**: interactive sessions
> pause and ask you per classified internet fetch (once / always / no), and
> `--dangerously-allow-net` grants the whole run without asking. Full detail,
> screen examples, and the offline "walled-garden" behavior:
> [The interactive experience](INTERACTIVE-EXPERIENCE.md).

Start in a target repository:

```bash
./bin/run-dev.sh \
  --workspace /path/to/project \
  --verify "npm test"
```

BANTAM opens an interactive prompt:

```text
bantam ❯
```

Useful interactive commands:

```text
:model
:usage
:trio on high
:trio status
:trio compare
:trio apply sol
:trio off
:self-improve plan
:self-improve
:rooster off
:help
```

Ordinary text is treated as a request. While a turn is running, later input can
steer the active run at safe message boundaries. `Ctrl-C` interrupts the active
operation.

## 8. One-shot and unattended use

Run one task and exit:

```bash
./bin/run-dev.sh run \
  --task "Fix the failing cache invalidation behavior." \
  --workspace /path/to/project \
  --verify "npm test" \
  --save-run
```

The `exec` command is the headless task-text form:

```bash
./bin/run-dev.sh exec \
  --workspace /path/to/project \
  --verify "npm test" \
  "Fix the failing cache invalidation behavior."
```

Autonomous mode enables additional unattended guardrails:

```bash
./bin/run-dev.sh run \
  --task "..." \
  --workspace /path/to/project \
  --verify "npm test" \
  --autonomous \
  --ground \
  --save-run
```

Interactive mode intentionally leaves some autonomous progress policy off so
the harness follows the operator's steering rather than terminating or
redirecting as aggressively.

## 9. Life of a BANTAM turn

The precise loop has many policies, but the useful mental model is:

### Step 1: classify intent

BANTAM distinguishes advisory work from implementation work.

Advisory examples:

- “Look over this repository.”
- “Give me architectural suggestions.”
- “Explain how this subsystem works.”

Implementation examples:

- “Fix the failing test.”
- “Add support for TTL expiry.”
- “Refactor this module and verify it.”

Advisory mode is read-only. It suppresses edit actions, does not run an
implementation verifier merely to grade a recommendation, and succeeds when a
complete response is returned without workspace mutation.

Implementation mode retains editing, execution, verification, progress policy,
and completion auditing.

### Step 2: assemble context

BANTAM combines:

- the exact task;
- system/action rules;
- bounded conversation and trajectory history;
- relevant files and repository structure;
- recent observations;
- verifier state;
- optional grounding facts, plan, and skills;
- progress and recovery guidance.

Context is budgeted. Large or repeated observations are clipped, summarized, or
represented through current repository state rather than replayed without
limit.

### Step 3: generate one constrained action

The selected model returns one BANTAM action envelope.

For local models, the server receives a generated GBNF grammar.

For Codex, app-server receives an equivalent strict, closed JSON Schema.

Both derive from the same action definitions and current capability mask.

### Step 4: parse and validate

BANTAM rejects:

- malformed envelopes;
- disabled actions;
- invalid paths;
- unsafe arguments;
- stale actions;
- policy violations;
- repeated ineffective actions when the applicable guard is active.

Malformed model output is not necessarily fatal. It becomes an observation that
can guide a repair turn.

### Step 5: execute through BANTAM

The executor performs the admitted operation inside the workspace boundary.
The model does not directly write arbitrary host state through an invisible
side channel.

### Step 6: observe

The result is converted into bounded model-visible evidence:

- file contents or directory entries;
- edit success/failure;
- shell output and exit state;
- verifier result;
- policy feedback;
- progress or completion objections.

### Step 7: update durable and in-memory state

BANTAM updates:

- the turn trajectory;
- action and token accounting;
- read coverage;
- repetition/progress state;
- workspace fingerprints;
- verification and preview evidence;
- optional crash checkpoint.

### Step 8: continue or stop

A run ends when it:

- returns an advisory response;
- reaches verified completion;
- exhausts a configured turn/deadline budget;
- is interrupted;
- encounters a terminal runtime/infrastructure failure;
- is blocked by a hard safety or evidence gate.

## 10. The action protocol

The action vocabulary includes families such as:

- file and repository inspection;
- batched `inspect` operations;
- search and structural query;
- exact replacement, line editing, writing, and patching;
- shell execution;
- response and completion;
- selected planning or evidence operations.

Actions are feature-gated and masked per turn. The prompt menu and structured
schema are generated from the same canonical definitions so a disabled action
does not remain advertised accidentally.

The protocol is intentionally narrower than a general shell-agent transcript.
That narrower surface provides:

- deterministic validation;
- complete run artifacts;
- policy enforcement;
- replayable observations;
- comparable Local/Codex trajectories.

## 11. Local-model runtime

The local runtime targets OpenAI-compatible inference servers such as
llama.cpp/vLLM-style endpoints.

The local model path provides:

- GBNF-constrained action generation;
- local token/cache accounting when the server reports it;
- selectable thinking handling;
- ordinary BANTAM tool execution;
- no subscription or per-request API dependency.

Local inference is the normal everyday path when privacy, marginal cost, and
continuous availability matter most.

## 12. Codex runtime

### 12.1 Ownership boundary

Codex supplies structured completions. BANTAM still owns:

- prompt construction;
- action admission;
- filesystem and shell tools;
- workspace policy;
- verifier policy;
- run history;
- artifacts;
- completion decisions;
- experiment grading.

BANTAM intentionally does not expose a second independent set of Codex-native
workspace writes alongside its own executor. Doing so would create actions and
state changes absent from BANTAM's evidence.

### 12.2 App-server lifecycle

`src/codex-transport.js` manages a persistent Codex app-server child process.
The transport includes:

- startup and protocol negotiation;
- structured output requests;
- streamed progress;
- control-plane deadlines;
- turn completion deadlines;
- cancellation;
- process cleanup;
- bounded recovery after replay-safe failure.

### 12.3 Run-scoped threads

The current default is one bounded native Codex thread per BANTAM run.

That gives Codex native continuity within one run without allowing Codex thread
state to become BANTAM's source of truth. BANTAM still records the complete
canonical request for every model call.

### 12.4 Exact prompt deltas

The first Codex request sends the complete canonical BANTAM prompt.

Later requests normally send an exact base-relative delta:

```text
first canonical prompt
    +
recorded exact delta
    =
current canonical prompt
```

Every delta records enough information to reconstruct and hash-check the
canonical prompt offline. If a delta cannot be represented safely or
efficiently, the transport can fall back to a full canonical request or rotate
to a fresh thread.

The explicit control configuration is:

```bash
--codex-thread-mode ephemeral --codex-prompt-mode full
```

That starts a fresh native thread and sends the full prompt for each request.
It remains useful as a debugging and experimental baseline.

### 12.5 Rebase and recovery

Optional policies can rotate to a new canonical thread:

```bash
--codex-rebase-every 12
--codex-rebase-min-savings 0.2
```

Periodic rebasing is disabled by default because a measured short interval was
correct but slower. Adaptive rebasing remains an experiment selected by
evidence, not a universal optimization.

After a replay-safe app-server failure, BANTAM can start a new thread from the
complete current canonical prompt, then continue exact deltas from that new
base. It does not reconstruct recovery state from an unverified partial prompt.

### 12.6 Offline prompt-integrity audit

Audit any saved Codex run without contacting a model:

```bash
./bin/run-dev.sh audit-codex path/to/run-artifact.json
./bin/run-dev.sh audit-codex path/to/run-artifact.json --calls
```

The auditor checks:

- base availability;
- delta structure;
- reconstruction equality;
- canonical and delivered character counts;
- SHA-256 values;
- thread reuse claims;
- fallback/rebase consistency.

`--calls` adds per-request delivery savings, input/cache/output/reasoning
tokens, and latency.

A new Codex gauntlet arm cannot retain a passing grade if its prompt evidence
fails this audit; it becomes `evidence-invalid`.

## 13. Reasoning levels and model selection

Codex models expose supported reasoning levels through the model picker. The
current UI can present levels such as:

```text
low
medium
high
xhigh
max
ultra
```

Support is model-specific. The picker uses each model descriptor rather than
assuming every level works for every model.

General operating guidance:

- Local: routine private work and continuous experimentation.
- Terra medium: recommended balanced hosted coding and diagnosis.
- Luna medium: latency-oriented current-family option; measure total trajectory
  cost rather than assuming the faster model always uses fewer turns.
- Sol high: difficult architectural, debugging, review, teacher, or
  high-consequence work.
- GPT-5.5 medium: manual experimental option, not an automatic default.
- Lower effort: mechanical or latency-sensitive tasks when measured evidence
  supports it.
- Higher effort: difficult reasoning, not as a blanket default optimization.

Token totals alone do not determine quality. A short failed run is not more
efficient than a longer strict pass. In the repeated hard-role tournament,
Terra and Sol both passed 4/4, but Terra used 38 turns and 1.05M input tokens
versus Sol's 66 turns and 2.99M. Luna also passed 4/4 but used 62 turns. GPT-5.5
failed the same hidden adapter boundary twice and finished 2/4. See the
full report.

Observed hard-suite app-server output throughput was 47.25 tokens/second for
Terra medium, 36.88 for Luna medium, and 32.92 for Sol high. Luna had the
fastest median individual call at 4.96 seconds, but Terra completed a hard task
in 89.8 seconds on average versus Luna's 105.0 and Sol's 192.9. This is why the
runtime policy distinguishes response latency from trajectory efficiency.
Those figures include complete app-server wall time and are not raw
server-side decode benchmarks.

## 14. Verification and completion

Attach a verifier:

```bash
./bin/run-dev.sh --verify "npm test"
```

If none is configured, interactive startup can detect a likely command from
project configuration and ask whether to use it.

Verification and completion are separate:

- a command can pass while the requested work is incomplete;
- a model can say “done” while tests fail;
- a different test command cannot be compared numerically with an earlier
  full-suite baseline;
- documentation and advisory tasks require different completion evidence from
  code repair tasks.

BANTAM therefore combines:

- verifier exit state and parsed counts;
- post-edit verification freshness;
- preview and artifact evidence where applicable;
- completion-confidence and done guards;
- state audits for risky implementation tasks;
- task-specific completion policy.

The verifier remains authoritative for objective checks, but it is not treated
as proof of every semantic requirement.

## 15. Workspace safety and coherence

### 15.1 Path confinement

File actions resolve beneath the configured workspace. Symlink-aware checks
prevent a workspace path from escaping to an external target.

### 15.2 External edits

BANTAM fingerprints a bounded set of recently observed paths.

It scans:

1. before building the next prompt;
2. after the model selects an action but before that action executes.

If a human or another process changes an observed file, BANTAM invalidates
stale state including:

- cached reads;
- repetition assumptions;
- grounding/repository summaries;
- verifier and preview proof;
- unsafe rollback snapshots.

If the change lands while a model is choosing an action, that stale action is
blocked. The external bytes are preserved.

Owned BANTAM edits refresh the baseline and are not misclassified as external
mutations.

Workspace fingerprints are persisted in run checkpoints so an edit between two
resumed invocations is detected before the resumed model receives stale
context.

### 15.3 Shell and network

Shell execution remains workspace-governed. Docker and previews default to
offline behavior.

Explicitly allowing shell network:

```bash
--shell-network
```

is a meaningful trust decision because workspace-visible data could be sent
over the network.

## 16. Run artifacts

A saved run is a `bantam-run` JSON artifact. It records, where applicable:

- run ID and timestamp;
- exact task;
- model/provider identity;
- sampling and reasoning configuration;
- source/git provenance;
- every accepted/rejected turn;
- raw completion separately from parsed action;
- observations;
- final result and verifier evidence;
- final diff;
- token/cache/reasoning/cost accounting;
- timing;
- invalid/protocol/repetition/progress counters;
- Codex thread and prompt-delivery evidence;
- workspace-coherence events.

Unknown values are represented as unknown/null rather than guessed.

Artifacts are the substrate for:

- replay;
- diagnosis;
- gauntlet reports;
- trio comparison;
- explicit Team collaboration;
- teacher collaboration;
- experiment evidence;
- promotion gates.

## 17. Trio mode

Trio mode runs one real request concurrently through:

```text
Local Qwen
GPT-5.6-Sol
GPT-5.6-Terra
```

### 17.1 Why three workspaces are required

All three models receive the same frozen starting tree, but each gets a
different external temporary workspace:

```text
source project (frozen baseline)
    ├── external local workspace
    ├── external sol workspace
    └── external terra workspace
```

This prevents:

- simultaneous writes to the same files;
- one model seeing another model's partial solution;
- recursive test runners discovering copied tests beneath the source project;
- ambiguous final diffs.

The source project is unchanged until an explicit apply.

### 17.2 Interactive trio

```text
:trio on high
```

Every later ordinary request runs in all three persistent lanes. Tagged
activity appears as it arrives:

```text
[local] ...
[sol] ...
[terra] ...
```

Commands:

```text
:trio status
:trio compare
:trio apply local
:trio apply sol
:trio apply terra
:trio reset
:trio off
```

### 17.3 One-shot trio

```bash
./bin/run-dev.sh trio run \
  --task "Fix the failing cache behavior." \
  --workspace /path/to/project \
  --verify "npm test" \
  --effort high
```

### 17.4 Advisory trio

Suggestion, review, and explanation requests are hard read-only turns.

Success means:

- a complete response was returned;
- no workspace mutation occurred;
- the run was not interrupted or blocked.

The code verifier is not run merely to grade advice.

This behavior fixes the original failure mode where “look over the repository
and suggest an improvement” caused models to invent edits and then be marked
failed by an unrelated implementation verifier.

### 17.5 Implementation preflight

Before implementation arms begin, BANTAM checks that the isolated environment
can run the configured verifier. It distinguishes an ordinary red test suite
from missing dependencies, missing runtimes, or an unavailable offline
package.

Dependencies copied into lanes are treated as managed/read-only runtime state.

### 17.6 Applying a result

```bash
./bin/run-dev.sh trio apply \
  /path/to/project/.bantam/trios/<session-id> \
  --arm sol \
  --yes
```

Apply:

1. verifies the live tree still matches the frozen baseline;
2. materializes the selected candidate externally;
3. verifies that candidate;
4. prepares a conflict-aware transaction;
5. applies the exact delta;
6. verifies the live tree;
7. commits or restores exact backups.

Trio does not merge three solutions and does not automatically select a winner.

## 18. Team mode

Team mode is explicit staged collaboration:

```text
:team on
```

Local joins only when its configured endpoint is already reachable. Local,
Luna medium, Sol high, and Terra medium first inspect independent workspaces
under a hard read-only advisory action mask. BANTAM bounds their findings and
passes them to a second Terra run. That Terra primary is the sole possible
writer and works only in its isolated candidate lane.

The phase boundary is fail-closed: BANTAM requires an empty captured diff from
every scout, discards every scout workspace and history, and rematerializes the
pre-scout commits before Terra integration. Dynamically enabled edit verbs are
covered by the same deny policy. A mutation attempt therefore prevents the
primary from starting instead of contaminating its candidate.

For advisory requests, the primary remains read-only. For implementation
requests, `:team apply` is the only route to the live workspace and requires
confirmation, candidate verification, a clean frozen baseline, transactional
application, and live verification.

Because advisory integration already receives three or four specialist
findings, the Terra primary may take at most two additional investigation
actions before responding. Implementation work retains its full investigation
and turn budget. The cap is regression-tested; its provider savings have not
yet been separately live-benchmarked.

Commands:

```text
:team on
:team status
:team compare
:team apply
:team reset
:team off
```

Team never auto-fires, never launches Local, never merges concurrent edits, and
never invokes self-improvement on its own. Its additional calls and tokens are
appropriate for difficult high-value tasks, not routine defaults. The complete
operator and evidence contract is in [Team Mode](TEAM-MODE.md). The
Collaborative Team implementation report
records the build history, adversarial finding, two live runs, regression
coverage, and exact boundary between proven behavior and future evaluation.

## 19. Gauntlet mode

Gauntlets compare models on standardized fixture repositories with hidden
contracts.

Quick wiring check:

```bash
./bin/run-dev.sh gauntlet --quick --models local,sol,terra
```

Stronger evidence:

```bash
./bin/run-dev.sh gauntlet \
  --models local,sol,terra \
  --rounds 3 \
  --faults
```

Each arm receives:

- identical starting bytes;
- identical task text;
- a private workspace;
- immutable public tests/package configuration/scope controls;
- hidden final-filesystem grading.

Reports include:

- visible and strict pass rates;
- turns and requests;
- input/output/cache/reasoning tokens;
- provider cost when available;
- elapsed time;
- invalid/protocol/no-op/repetition/progress counters;
- complete artifacts and final diffs;
- Codex delivery/integrity metrics;
- external workspace mutation telemetry.

The model registry is built from the live non-hidden Codex catalog, so
`--models` is not limited to Local/Sol/Terra. Each experiment freezes that
catalog in `catalog.json`. The seven built-in fixtures include the original
five compact repairs plus `keyed-task-pool` and `adapter-migration`, which add
async lifecycle, Promise identity, cross-file orchestration, broad migration,
immutability, and prototype-safety pressure.

Every completed run writes a generalized N-arm `showcase/index.html`.
Correctness and strict grading sort before turns, time, and cache-miss input, so
a fast hidden-contract failure is never presented as the winner.

`--faults` validates transport behavior such as silence, hangs, cancellation,
timeouts, child-process death, and exact recovery.

A gauntlet is never started automatically. It spends compute and potentially
subscription capacity and must be operator-initiated.

## 20. Trio versus gauntlet

| Trio | Gauntlet |
| --- | --- |
| Real project request | Standardized fixture task |
| Persistent conversational lanes | Fresh controlled runs |
| Can explicitly apply one arm | Measurement only |
| Live concurrent output | Repeated/order-balanced evaluation |
| Useful for collaboration | Useful for claims and regression evidence |

Neither result automatically changes BANTAM.

## 21. Deterministic trajectory comparison

Before asking a teacher model why Local behaved differently, BANTAM computes
the facts without a model.

Preview one completed trio turn:

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --preview
```

The local-only preview reports:

- each visible outcome;
- turn count;
- first normalized action divergence;
- verifier-attempt delta;
- DONE-turn delta;
- action-count delta;
- Local-only and reference-only read/edit coverage;
- shared Sol/Terra reference-only coverage;
- a SHA-256 over the comparison.

Batched `inspect` operations are included. Paths are bounded and credential
patterns are redacted.

These are observations, not causal conclusions. “Sol read file X and Local did
not” does not itself prove that reading X caused Sol's outcome.

The resolver rejects:

- an incomplete trio turn;
- missing arm artifacts;
- task mismatch;
- paths escaping the session;
- symlinked artifact substitution.

## 22. Sol/Terra teacher collaboration

Authorize the teacher council:

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --yes
```

Or use explicit artifacts:

```bash
./bin/run-dev.sh collaborate \
  local-run.json \
  sol-run.json \
  terra-run.json \
  --grades local=3/10,sol=9/10,terra=10/10 \
  --yes
```

`--yes` is mandatory because bounded task and trajectory evidence leaves the
machine.

### 22.1 Eligibility

Without `--proactive`, a clean local run does not spend teacher calls.

Struggle signals include:

- failed or blocked local result;
- failing external grade;
- excessive turns;
- invalid output;
- protocol violations;
- duplicate ineffective actions;
- no-op edits;
- progress termination.

### 22.2 Council protocol

With the default two teachers, the council performs four structured Codex
calls:

1. Sol independently analyzes the immutable evidence packet.
2. Terra independently analyzes the same packet.
3. Sol reviews Terra's exact hypotheses.
4. Terra reviews Sol's exact hypotheses.

The packet includes:

- the exact shared task, redacted and bounded;
- run identities and outcomes;
- selected metrics;
- bounded trajectories;
- external grades;
- deterministic trajectory comparison and hash.

Teachers must distinguish:

- a reusable harness weakness;
- a task-specific implementation mistake;
- insufficient evidence.

Each proposed harness mechanism must include:

- concrete cited evidence;
- failure mode;
- mechanism;
- remedy type and delivery point;
- bounded source targets;
- falsification test;
- expected local behavior;
- confidence;
- adversarial tests.

Only hypotheses accepted by the other teacher become candidates. Semantically
overlapping accepted hypotheses are consolidated while preserving
corroboration.

### 22.3 Candidate status

Teacher candidates are:

```text
build-only
promotionEligible: false
```

They retain:

- cited evidence;
- deterministic comparison SHA-256;
- teacher identities;
- reciprocal reviews;
- falsification/adversarial tests;
- source targets.

Teacher consensus is a useful witness, not proof of behavioral lift.

## 23. Governed self-improvement

### 23.1 What triggers it

Self-improvement is explicit:

```bash
./bin/run-dev.sh self-improve --plan
./bin/run-dev.sh self-improve
./bin/run-dev.sh self-improve --no-apply
./bin/run-dev.sh self-improve --candidate <candidate-id>
```

Interactive equivalents:

```text
:self-improve plan
:self-improve
:self-improve --no-apply
:self-improve --candidate <candidate-id>
```

A deliberate natural-language request such as “Run a self-improvement cycle
now” can route to the same controller. A question such as “How does
self-improvement work?” remains a normal advisory request.

BANTAM does not spontaneously rewrite itself after an ordinary user task.

### 23.2 Candidate sources

Candidate sources include:

- bounded self-observation from repeated operational symptoms;
- diagnostic witnesses;
- stronger-reference divergence;
- structural KB differences;
- completeness and continuity critics;
- Sol/Terra teacher collaboration;
- recurring cross-task teacher mechanisms.

Candidate provenance affects what evidence and write scope are required.

### 23.3 Plan mode

```bash
./bin/run-dev.sh self-improve --plan
```

Plan mode reads current observations and candidates. It does not call an
implementation model, modify BANTAM source, or write controller attempt state.
The development launcher may still ensure its own required parser dependencies
exist.

### 23.4 Managed cycle

A full governed cycle:

1. verifies the exact development checkout and baseline;
2. acquires an exclusive controller lock;
3. freezes one candidate and its targets;
4. creates a private content-addressed implementation lane;
5. asks the selected implementation model to build one narrow vertical slice;
6. enforces candidate-specific write, dependency, and test policy;
7. runs focused and full verification;
8. records exact candidate bytes and evidence;
9. stages a verified `dev` checkpoint;
10. applies transactionally only when authorized and eligible;
11. verifies the live checkout;
12. promotes with compare-and-swap evidence or rolls back exactly.

Recursive self-improvement is refused.

### 23.5 Build-only versus promotion evidence

A successful implementation and green full suite prove:

- the candidate can be built;
- its allowed tests pass;
- the repository did not regress under the configured verifier.

They do not necessarily prove that the local agent behaves better on unseen
tasks.

Behavioral policies therefore require stronger evidence such as:

- counterfactual replay at a captured failure point;
- a preregistered paired experiment;
- fresh held-out tasks;
- no regression against a pinned reference;
- exact binding between candidate version and experiment artifact.

Teacher agreement alone cannot move `regular`.

## 24. Channels, lanes, and promotion

BANTAM stores immutable workspace versions and channel pointers.

Important commands:

```bash
./bin/run-dev.sh state init
./bin/run-dev.sh lane list
./bin/run-dev.sh channel list
./bin/run-dev.sh channel show dev
./bin/run-dev.sh channel show regular
./bin/run-dev.sh channel history regular
```

Promotion is compare-and-swap:

- the expected old version must still be current;
- evidence must bind to the exact candidate;
- concurrent movement is detected;
- history is append-only/content-addressed;
- rollback targets an immutable prior version.

This prevents a green run for one tree from being used to promote different
bytes.

## 25. What is automatic and what is not

| Event | Automatic? | External model call? | Can change source? |
| --- | ---: | ---: | ---: |
| Build bounded prompt/context | Yes, during a run | Only selected inference provider | No |
| Observe run outcome counters | Yes | No | No |
| Detect external workspace edits | Yes | No | No |
| Run configured verifier during implementation | Yes, by policy | No | Verifier side effects are contained/governed |
| Start trio mode | No | Yes for Sol/Terra | Only isolated lanes |
| Start a gauntlet | No | Depends on selected arms | Only isolated fixtures |
| Preview trajectory comparison | No, operator command | No | No |
| Call teacher council | No; requires `--yes` | Yes | No |
| Create teacher candidate | During authorized council | Yes | No |
| Inspect self-improvement plan | No, operator command | No | No |
| Build self-improvement candidate | No, explicit command | Selected implementation model | Private lane/dev checkpoint |
| Apply trio candidate | No, explicit arm + confirmation | No required model call | Yes, transactionally |
| Promote `regular` | No | No required model call | Changes channel pointer after evidence gates |

## 26. Evidence locations

### Ordinary saved runs

Location depends on `--save-run`; every artifact has kind:

```text
bantam-run
```

### Trio

```text
.bantam/trios/<session-id>/
  manifest.json
  events.jsonl
  summary.md
  comparisons/
    turn-001.json
  runs/
    local/
    sol/
    terra/
  report/
    index.html
  transactions/
```

Executable model workspaces live outside the source project in the runtime
directory recorded by the manifest.

### Gauntlet

```text
.bantam/gauntlets/<experiment-id>/
  manifest.json
  ledger.jsonl
  summary.md
  runs/
  report/
  showcase/
```

### Teacher collaboration

```text
.bantam/teacher-collaboration/reports/
```

Reports and candidates are hash-bound. Tampered reports are ignored by the
candidate loader.

### Governed self-improvement

```text
.bantam/self-improve/
```

This contains controller locks, attempt records, evidence references, and
private state required by the managed cycle.

## 27. Practical workflows

### 27.1 Everyday local-first work

```bash
./bin/run-dev.sh \
  --workspace /path/to/project \
  --verify "npm test"
```

Use Local for routine work. Switch to Terra or Sol inside the same BANTAM
session when the task warrants hosted reasoning.

### 27.2 Hard task with a hosted model

```text
:model codex-sol high
```

Run the task normally. BANTAM retains the same action loop and verifier.

### 27.3 Compare all three on a real task

```text
:trio on high
```

Submit the task, inspect `:trio compare`, then either:

- keep all results as evidence;
- explicitly apply one verified arm;
- run a teacher preview.

### 27.4 Learn from a local struggle

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --preview

./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --yes

./bin/run-dev.sh self-improve --plan
./bin/run-dev.sh self-improve \
  --candidate <candidate-id> \
  --no-apply
```

Review the resulting candidate and require fresh behavioral evidence before
promotion.

### 27.5 Compare runtimes under controlled grading

```bash
./bin/run-dev.sh gauntlet \
  --models local,sol,terra \
  --rounds 3 \
  --faults
```

Use the resulting HTML showcase and raw artifacts for measured claims.

### 27.6 Debug Codex prompt behavior

```bash
./bin/run-dev.sh audit-codex run.json --calls
```

Compare the run-scoped delta default against:

```bash
--codex-thread-mode ephemeral --codex-prompt-mode full
```

under the same fixtures and ordering.

## 28. Recorded verification evidence

### 28.1 What this integration effort shipped

That recorded checkpoint combined the following completed pieces:

1. **Codex as a first-class selectable BANTAM runtime.** Subscription-backed
   models appear beside Local and API models rather than requiring a separate
   agent product.
2. **Interactive model and reasoning selection.** The `:model` flow selects a
   model, then a model-supported reasoning level, and returns to BANTAM.
3. **Full provider accounting.** Runs retain input, output, cache, reasoning,
   request, latency, and cost fields where the provider makes them available.
4. **Run-scoped Codex continuity.** One bounded native thread is reused across
   one BANTAM run while BANTAM retains canonical prompt ownership.
5. **Exact prompt-delta delivery.** Later Codex turns transmit reconstructable
   base-relative changes instead of blindly resending the full prompt.
6. **Offline Codex integrity auditing.** Saved traces can be independently
   reconstructed and inspected per call; invalid evidence cannot remain a
   passing gauntlet result.
7. **Transport deadline and lifecycle hardening.** Silent turns, control hangs,
   post-tool synthesis, cancellation, close, child death, and replay-safe
   recovery have explicit bounded behavior.
8. **Local/Sol/Terra gauntlet.** Standardized fixtures, hidden contracts,
   order-balanced rounds, complete accounting, failure injection, and static
   showcases are integrated.
9. **Parallel trio mode.** Three live agents operate concurrently in isolated
   external workspaces with tagged output and persistent per-arm follow-up
   state.
10. **Transactional trio adoption.** One selected result can be verified and
    applied with stale-baseline refusal and exact rollback.
11. **Task-intent enforcement.** Advisory requests are read-only and are no
    longer mislabeled as failed coding tasks merely because they made no edit.
12. **Workspace coherence.** Same-size external edits, deletion, type/symlink
    changes, and mid-inference mutations invalidate stale state or block stale
    actions.
13. **Sol/Terra teacher council.** Independent diagnosis, adversarial-test
    design, reciprocal review, semantic consolidation, and hash-bound
    build-only candidates are integrated.
14. **Deterministic learning bridge.** A trio session now resolves directly
    into Local/Sol/Terra artifacts and a bounded model-free trajectory
    comparison before any teacher inference.
15. **Governed handoff to self-improvement.** Teacher hypotheses enter the
    existing private-lane, write-scoped, verified, reversible controller rather
    than becoming direct source edits.
16. **Operator documentation.** Runtime, trio, Codex evaluation, DeepSeek
    provider adaptation, self-improvement, and canonical system documentation
    now describe the same current boundaries and commands.

### 28.2 Dated test and live-runtime proof

At the original documented checkpoint (retained here as historical evidence):

- full repository suite: **1,033 tests, 142 suites, 0 failures**;
- full-suite runtime: **25.253 seconds** on the recorded host;
- repaired DeepSeek V4 Pro hidden-contract run:
  - public 2/2 and hidden 4/4;
  - 10 turns / 10 model requests;
  - 63,646 input tokens, including 31,232 cache hits;
  - 3,045 output tokens and 0 native reasoning tokens;
  - 49.880 seconds;
  - zero malformed protocol actions;
- repaired DeepSeek V4 Flash hidden-contract run:
  - public 2/2 and hidden 3/4;
  - 18 turns / 18 model requests;
  - 99,204 input tokens, including 65,664 cache hits;
  - 3,489 output tokens and 0 native reasoning tokens;
  - 45.919 seconds;
  - the remaining miss was an ordinary implementation-contract error, not a
    malformed provider response;
- latest fresh Sol/high ordered-map smoke:
  - strict pass;
  - 6 turns / 6 model requests;
  - 46.815 seconds;
  - one native thread and five delta requests;
  - 49.2% aggregate delivered-character savings;
  - 106,435 input tokens;
  - 80,640 cache-hit tokens;
  - 25,795 cache-miss tokens;
  - 1,320 output tokens;
  - 282 reasoning tokens;
  - zero invalid outputs and protocol violations;
  - exact offline reconstruction on 6/6 calls.

Across the larger exactness audit recorded in the Codex evaluation report:

- 159 model calls were audited;
- every delta reconstructed the intended canonical request;
- every recorded prompt digest matched;
- 9/9 live runs were strict-green;
- zero invalid actions or protocol violations were observed.

These measurements establish transport correctness and useful prompt-delivery
savings for the tested workload. They are not a universal benchmark of model
quality.

## 29. Important limitations

### 29.1 No neural weight training

Local improvement currently changes harness behavior, not Qwen weights.

### 29.2 Teacher hypotheses are not truth

Sol and Terra can produce a plausible shared explanation that is still wrong.
That is why candidates remain build-only until behavior is measured.

### 29.3 One trio task is anecdotal

A trio result is useful operational evidence, but promotion-grade claims need
fresh tasks, repeated/order-balanced runs, and preregistered gates.

### 29.4 Provider accounting differs

Local servers, API providers, and subscription Codex can report different token
and cache semantics. Raw values are retained; comparisons must remain
like-for-like.

### 29.5 Stronger models can still misuse the task

The original advisory trio demonstrated this directly: all three arms began
implementing unrelated improvements because the task-intent boundary was not
hard enough. The boundary is now enforced, but future task classes can reveal
new interface failures.

### 29.6 Complexity is concentrated

`src/agent.js` and the command entry remain large policy integration surfaces.
The extensive suite protects behavior, but policy extraction and cross-feature
matrix testing remain valuable architectural work.

### 29.7 Codex availability is external

Subscription limits, account state, app-server compatibility, and model
catalog changes remain outside BANTAM's control.

## 30. Troubleshooting

### Local model is unavailable

```bash
./bin/run-dev.sh health --endpoint http://localhost:8085
./bin/run-dev.sh doctor
```

Verify the model server and registry entry.

### Codex model is unavailable

```bash
codex login status
codex login
```

Then reopen BANTAM and inspect `:model`.

### Codex appears to stall

Distinguish:

- active reasoning with progress events;
- control-plane timeout;
- post-tool synthesis idle timeout;
- dead app-server child;
- verifier/runtime work.

Saved run evidence and transport events identify which boundary fired.

### Trio implementation preflight fails

Read the preflight detail in `manifest.json`. Missing dependencies or an
unavailable offline package are infrastructure failures; an ordinary failing
test can be a valid repair baseline.

### Trio apply refuses

The live tree changed after the trio baseline. BANTAM preserves the newer work
instead of guessing a merge. Start a fresh trio, reconcile manually, or apply
the candidate to a clean matching baseline.

### Teacher council is withheld

The local artifact has no recognized struggle signal. Use `--preview` first.
Use `--proactive --yes` only when deliberately studying a clean run.

### Teacher candidate will not promote

Expected behavior: teacher agreement is witness evidence. Build it in a private
lane and provide replay or fresh paired experiment evidence.

### A request for suggestions starts editing

That is a task-intent regression. Preserve the run artifact and add a focused
advisory-mode test. Current trio advisory policy excludes mutating actions and
requires an unchanged final diff.

## 31. Code map

| Surface | Authoritative implementation |
| --- | --- |
| Development CLI and REPL | `bin/bantam.js` |
| Packaged CLI (`bantam` command) | `bin/bantam.js` |
| Agent loop | `src/agent.js` |
| Canonical action definitions | `src/action-protocol.js` |
| GBNF/JSON Schema generation | `src/grammar.js` |
| Prompt assembly | `src/prompt.js` |
| Model routing | `src/model.js` |
| Codex model catalog | `src/codex-models.js` |
| Codex app-server transport | `src/codex-transport.js` |
| Offline Codex evidence audit | `src/codex-artifact-audit.js` |
| Action execution | `src/executor.js` |
| Workspace coherence | `src/workspace-coherence.js` |
| Task-intent classification | `src/task-intent.js` |
| Verification/done policy | `src/done-gates.js`, `src/done-guard.js`, `src/completion-audit.js` |
| Run artifacts | `src/artifact.js` |
| Crash/resume checkpoint | `src/run-checkpoint.js`, `src/run-continuation.js` |
| Trio orchestration | `src/trio-session.js` |
| Trio evidence resolver | `src/trio-evidence.js` |
| Deterministic trajectory comparison | `src/trajectory-comparison.js` |
| Teacher council | `src/teacher-collaboration.js` |
| Gauntlet specification | `src/gauntlet.js` |
| Experiment runner/reporting | `src/experiment*.js`, `src/fixture-runner.js` |
| Governed self-improvement | `src/self-improve-controller.js` |
| Candidate write boundary | `src/self-improve-change-policy.js` |
| Automatic bounded observations | `src/self-observation.js` |
| Channels and lanes | `src/lane-store.js`, `src/state-cli.js` |
| Promotion evidence | `src/promotion-evidence.js` |
| Learning witnesses | `src/logic/` |

## 32. Design invariants

The system should continue to preserve these invariants:

1. **BANTAM owns tools and evidence.**
2. **The model cannot self-certify completion.**
3. **Advisory work is not graded as implementation.**
4. **Identical comparisons start from identical bytes and tasks.**
5. **Concurrent models never share a writable workspace.**
6. **Unknown telemetry is not guessed.**
7. **Teacher agreement is not promotion evidence.**
8. **Source mutation and external calls retain explicit consent boundaries.**
9. **Promotion binds exact candidate bytes to exact evidence.**
10. **Human/external edits are preserved over stale model actions.**
11. **Every optimization keeps a full, auditable control path.**
12. **Correctness gates dominate latency and token optimization.**

## 33. Where to read next

- [How It Works & How to Run It](GUIDE.md) — detailed tool, prompt, and
  execution reference.
- [Model runtimes, gauntlets, and self-improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md)
  — provider setup and operator workflows.
- [External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md) —
  canonical DeepSeek V4 repair record, live Flash/Pro evidence, implementation
  map, troubleshooting, and reusable hosted-provider acceptance standard.
- [Trio Mode](TRIO-MODE.md) — complete trio command and apply guide.
- [Self-Improvement System](SELF-IMPROVEMENT.md) — witnesses, replay,
  experiments, channels, and promotion.
- [Improving BANTAM's Codex Integration](CODEX-INTEGRATION-IMPROVEMENTS.md) —
  design analysis and measured optimization history.
- [Why Codex Works Efficiently Inside BANTAM](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md)
  — the principal architectural finding: why the same model can perform more
  efficiently inside a specialized harness, what the evidence establishes,
  where the capability envelope ends, and how the result directs BANTAM's
  local-model and self-improvement strategy.
- BANTAMFACTORY — the isolated experimental program
  for compiling broad product contracts into routed stations with local gauges,
  containment, rework, supervision, and an explicit proof ladder. It describes
  proposed architecture, not current production behavior.
- [Evaluation and Improvement Loop](EVALUATION-AND-IMPROVEMENT-LOOP.md) — the
  current regression and Team baseline, the next solo-versus-Team evaluation
  matrix, grading and telemetry rules, proposed benchmark automation, and the
  evidence-gated path from observed trajectories to local-harness improvements.
- Codex delta/rebase evaluation
  — exact transport evidence and current policy.
- [Principles](PRINCIPLES.md) — the design philosophy behind the harness.

## 34. Bottom line

BANTAM is now one coherent system with three complementary operating modes:

```text
Local-first coding agent
        +
Subscription-backed Codex decision engine
        +
Governed comparative self-improvement laboratory
```

The important accomplishment is not simply that BANTAM can call more models.
It can make those models operate through the same constrained interface,
measure their behavior on the same work, preserve exact evidence, ask stronger
models for independently reviewed hypotheses, and route promising ideas through
a private, reversible, evidence-gated improvement process.

That makes Sol and Terra useful collaborators without making them unaccountable
authors of the harness, and it gives the local model a practical path to improve
through better context, tools, feedback, policy, and verification.
