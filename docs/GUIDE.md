# BANTAM — How It Works & How to Run It

This guide is the detailed implementation/operator reference. For one
canonical tour of the complete current product—including Local/Codex/trio,
teacher collaboration, governed self-improvement, consent boundaries, artifact
layouts, verified measurements, and limitations—start with the
[BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md). For what an
interactive user sees versus what is recorded, and the network-consent model
(off by default; per-fetch approval; `--dangerously-allow-net`), see
[The interactive experience](INTERACTIVE-EXPERIENCE.md).

BANTAM is a **local-model coding harness**. It owns the agent loop, constrains
every model action with a GBNF grammar so a malformed tool call is *structurally
impossible*, executes actions inside a sandboxed workspace, and — when you give
it a command to check the work — grades the finished result with a verifier the
model never sees.

It is built to be **interactive-first**: you describe work in natural language,
watch concise tool activity, steer it while it runs, and continue from the same
workspace across requests. It also runs unattended for scripted or benchmark use.

This guide has two halves:

1. **[Running BANTAM on a new folder/repo](#part-1-running-bantam-on-a-new-folderrepo)** — the practical walkthrough.
2. **[How it works](#part-2-how-it-works)** — the mental model and an accurate architecture map.

---

## Part 1: Running BANTAM on a new folder/repo

### Prerequisites

- **Node 20+**.
- **A llama.cpp-compatible `/completion` server** with a model loaded. BANTAM
  talks to the *raw completion* API (not a chat/tools API) precisely so it can
  enforce its own grammar — so any llama.cpp server exposing `/completion` works.
  - BANTAM defaults to `http://localhost:8085`. Point it elsewhere with
    `BANTAM_ENDPOINT` or `--endpoint`.
  - The dogfood model is a local **Qwen 3.6 27B** (Q4_K_M), 100k context.

### One-time setup (from the BANTAM repo)

```bash
cd "/path/to/BANTAM"
npm install
npm test                 # optional: confirm the harness is all green
npm run start -- health  # should print: ok   (verifies the model server is reachable)
npm link                 # makes the `bantam` command available everywhere
```

If `health` prints `unreachable`, your model server isn't up or the endpoint is
wrong — start llama.cpp with `/completion` and/or set `BANTAM_ENDPOINT`.

### The main way: interactive REPL on your project

```bash
cd /path/to/your/project
bantam
```

That drops you into a `bantam ❯` prompt operating on the current directory, with
autonomous guardrails **off** (a human is steering). Describe the outcome you
want in plain language:

```
bantam ❯ make the failing cache test pass
bantam ❯ only touch src/parser.js — do not edit the tests
```

The REPL has real **cross-request memory**: the last several
request/outcome pairs are fed back as context on each new instruction, so
"now do the same for the other parser" works without repeating yourself. The
**workspace persists** too — edits accumulate on disk across requests, and a
later `keep going` continues from the real state. If you start interactively
with **no `--verify`**, BANTAM auto-detects your test command and *offers* to
attach it as the grader (disable with `--no-autoverify` / `BANTAM_NO_AUTOVERIFY`).

Attach a **project verifier** so every change that touches the workspace is
graded before you see a green result:

```bash
bantam --verify "npm test"
```

- A **green check** means Bantam observed the verifier pass after the change.
- A **yellow `unverified`** means the edit was allowed but nothing proved it works.
- A **red** result means the verifier failed (with bounded diagnostic output).
- **Ctrl-C** stops the current model or shell work promptly; completed edits stay
  on disk so a later `keep going` continues from the real state.
- Explicit restrictions like `do not edit test/foo.test.js` remain **blocking**
  even interactively — Bantam blocks on your word, warns on its own hunches.

Type another instruction mid-run to steer the next turn. Type `:help` (or `?`) for
the in-session commands — `:model` to switch between local, DeepSeek, and Codex,
`:usage` to control per-response/session accounting, `:team on` for explicit
Local-if-online/Luna/Sol scouting with one Terra primary, `:trio on` to run
persistent isolated Local/Sol/Terra lanes, `:context` for the reuse/accuracy dial,
`:image` to offer image generation and editing, `:eyes` to choose which model reads
an image, `:modes` to list every optional mode with its state, and `:rooster` to
toggle the mascot. Type `exit`,
`quit`, or `:q` to leave. Run without linking with:

```bash
npm run start -- --workspace /path/to/your/project
```

For the complete local/DeepSeek/Codex operating flow—including what is
automatic, what triggers a gauntlet, and what authorizes self-improvement—see
[Model runtimes, gauntlets, and self-improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md).
For DeepSeek's provider adapter, controlled Flash/Pro results, and the
integration standard to follow for future hosted APIs, see
[External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md).
For concurrent Local/Sol/Terra work, see the
[Trio Mode operator guide](TRIO-MODE.md).
For staged parallel specialists and one accountable Terra candidate, see
[Team Mode](TEAM-MODE.md).

### Unattended: one-shot `run`

For scripted or headless use, `run` takes a task and an explicit final verifier
and re-enables the strict guardrails:

```bash
bantam run \
  --task "fix the failing cache test" \
  --workspace /path/to/your/project \
  --verify "npm test" \
  --autonomous \
  --save-run .bantam/runs/fix-cache.json
```

- `--autonomous` turns the interactive backstops into the full progress /
  premature-done / ledger gates (nothing is watching, so it self-polices).
- `--save-run <path>` writes a complete artifact: the full turn trajectory,
  metrics (turns, tokens, timings), sampling, and harness git provenance.
- Exit code is non-zero if the verifier ends in `fail`.

### Pointing at a specific model server

With no `--endpoint`/`BANTAM_ENDPOINT`, Bantam **auto-detects** the server: it probes
`BANTAM_ENDPOINTS` (default `:8085,:18086`), uses the first that answers `/health`, and prints the
model actually loaded. To pin one explicitly:

```bash
BANTAM_ENDPOINT=http://localhost:8085 bantam --verify "npm test"
# or
bantam --endpoint http://host:port run --task "..." --workspace .
```

Inside the REPL, `:model` lists the registered models (which is running, which has vision) and
`:model <n>` switches to one — on a single-GPU rig that's a real stop-and-restart, so you can
shuffle between a code model and a vision model on one card. If nothing is running, an interactive
start presents a role-aware Codex-first picker followed by launchable entries
from `./.bantam/models.json` and configured API presets. Terra medium is the
recommended everyday Codex route; Luna is the fast route; Sol high is the
hard/high-assurance route. The last successful non-secret selection and effort
are stored in `.bantam/model-preference.json`. See
[Model Management](../README.md#model-management).

The same picker discovers every non-hidden model in your authenticated Codex
app-server catalog. Current aliases include `codex-sol`, `codex-terra`,
`codex-luna`, `codex-5.5`, `codex-5.4`, `codex-5.4-mini`, and `codex-spark`.
Catalog upgrade warnings are shown beside models that are approaching
deprecation. These run BANTAM completions through a persistent local Codex
app-server and your existing ChatGPT/Codex subscription:

```bash
codex login status             # should report "Logged in using ChatGPT"
./bin/run-dev.sh
# then inside BANTAM:
:model codex-sol
```

Bare `:model` is an interactive wizard: choose the provider/model, inspect its
measured role, then choose one of the reasoning levels reported for that Codex
model. Enter accepts the displayed or remembered default. For a direct switch,
provide both values on one line:

```text
:model codex-terra xhigh
:model codex-sol max
```

Headless runs can select the same runtime and produce ordinary `--save-run`
artifacts:

```bash
bantam run --codex --model gpt-5.6-sol --codex-effort high \
  --task "fix the failing parser" --workspace . --verify "npm test" \
  --save-run .bantam/runs/codex-sol.json
```

Codex does not replace BANTAM's harness. BANTAM still owns prompts, history,
tools, workspace policy, verification, and model switching. By default one
bounded native thread is reused within each BANTAM run, with a complete
canonical first prompt followed by exact reconstructable deltas; explicit
ephemeral/full modes remain available as rollback controls. Native Codex tools
stay disabled. Action turns receive a strict JSON Schema generated from the
same action protocol and per-turn masks as the local GBNF grammar. Thinking
turns remain prose. Switching
back with `:model local` closes the app-server process. Subscription turns show
tokens and reasoning under `:usage`; their displayed cost is `$0 subscription`,
meaning they are not metered through an API key (not that the subscription
itself is free).

Codex calls are bounded at three layers. App-server control requests default to
30 seconds, a turn that emits no app-server activity defaults to a 120-second
inactivity deadline, and the absolute completion ceiling defaults to 600
seconds. Any matching notification for the active thread—including reasoning
and item lifecycle events—refreshes the inactivity deadline. A deadline
interrupts the native turn, recycles the ambiguous app-server connection, and
is never multiplied by the generic transient-request retry loop. Advanced
operators can tune the defaults with `BANTAM_CODEX_CONTROL_TIMEOUT_MS`,
`BANTAM_CODEX_IDLE_TIMEOUT_MS`, and `BANTAM_MODEL_TIMEOUT_MS`. In a headless
`run`, a terminal model deadline is printed with its layer, persisted as
structured `result.modelFailure` evidence in `--save-run` artifacts, and exits
nonzero. An intentional signal-driven cancellation retains its normal
signal-specific exit status.

### Greenfield ("build me a thing") vs repair

Bantam's real strength is **verifiable repair in an existing repo** — a task with
a `--verify` command, where "green means verified" is the whole point. It also
handles greenfield builds: point it at an empty directory and describe the
artifact.

```bash
mkdir /tmp/tetris
bantam run --task "Build a complete single-file index.html Tetris (all HTML/CSS/JS inline, no libraries)..." \
  --workspace /tmp/tetris --autonomous
```

Caveat worth holding: on a greenfield task **with no `--verify`**, Bantam's
verification machinery stays dormant — it writes the file and finishes, trusting
the model's single grammar-constrained write. That happens to work well (in a
head-to-head it one-shot a fully playable Tetris in ~56s; see
[the comparison note below](#proof-it-works-the-tetris-head-to-head)), but you
get Bantam's honesty guarantees only when you give it something to check.

### How to use it best

BANTAM drives a **small local model**, and the whole design assumes that. A few
habits get dramatically better results:

- **Always give it a `--verify`.** "Green means verified" is BANTAM's entire
  distinct value. On a task with no verifier it will still work, but you lose the
  honesty guarantee — you're trusting a single grammar-constrained write.
- **State restrictions explicitly; they bind.** `only touch src/parser.js` or
  `do not edit the tests` becomes a hard block (the `immutable_file` gate), even
  interactively. The harness *blocks on your word* and only *warns on its own
  hunches*.
- **Decompose and sequence.** A 27B is most reliable when each step is small enough
  to be verifiable. "Make the failing cache test pass" beats "refactor the caching
  layer." Break big work into checkpoints, each with something to verify.
- **Let it query the graph instead of reading everything.** For "understand this
  codebase" work, steer it toward `query`/`map` (the Datalog KB and repo map) rather
  than dozens of blind reads — structural queries return exact facts, while
  `concept` returns deterministic evidence-ranked locations without another model
  call. See [`GROUNDING_TOOLS.md`](GROUNDING_TOOLS.md).
- **Preinstall dependencies.** The shell sandbox is offline by default and
  fail-fast rejects `npm install`/`pip install`. Install deps from a trusted
  terminal first (they belong to *your* project), or opt into networking with
  `--shell-network` for trusted work only.
- **Record the hard runs.** Add `--save-run <path>` and `BANTAM_SAVE_PROMPTS=1`.
  If a run goes wrong, that artifact lets you replay the exact failing turn and
  test a fix in ~30 seconds — the core of the [self-improvement
  loop](SELF-IMPROVEMENT.md).
- **When it gets stuck, suspect the context, not the model.** The first question is
  never "can the model do this?" — it's *"what did the model actually see at the turn
  it went wrong?"* Run `bantam diagnose` on the saved run; the fix is almost always a
  true fact the harness wasn't surfacing. This is the [first
  principle](PRINCIPLES.md).

### Configuration

Most behavior is CLI flags; a handful of environment variables cover the rest.
See the **Configuration** table in the [README](../README.md#configuration) for
the full list (endpoint, profile, timeouts, `--max-turns`, the completion/state
audit, patch/file-op exposure, and the experimental guards). The knobs you'll
reach for most:

| Need | Flag / env |
| --- | --- |
| Point at a model server | `--endpoint` / `BANTAM_ENDPOINT` (default `:8085`) |
| Grade the work | `--verify "<command>"` |
| Unattended run with strict gates | `--autonomous` |
| Save a full run artifact | `--save-run <path>` |
| Cap model turns | `--max-turns N` / `BANTAM_MAX_TURNS` (default 200) |
| Live cockpit view (TTY) | `--tui` |
| Rooster antics on/off | `--no-rooster` / `BANTAM_NO_ROOSTER=1` / `:rooster` in the REPL |
| Context reuse/accuracy dial | `--context-mode rebuild\|immutable\|extension` / `:context` — remembered, and printed at startup |
| Image generation + editing | `BANTAM_CODEX_IMAGE=1` / `:image on` — **spends signed-in Codex quota**, so it is announced on every launch |
| Which model reads an image | `BANTAM_IMAGE_PROVIDER=local\|codex` / `:eyes` — local mmproj wins by default when a projector is loaded |
| Image concurrency ceiling | `BANTAM_CODEX_IMAGE_CONCURRENCY=N` — otherwise 3 at ≥2 Mpx or `--quality high`, else 4 |
| List every optional mode | `:modes` in the REPL |

### Other commands

```bash
bantam exec "<task>" --json                     # headless one-shot: line-delimited JSON, defined exit codes
bantam health                                   # is the model server reachable?
./bin/run-dev.sh self-improve --plan             # exact dev self-host candidate scan
./bin/run-dev.sh self-improve [--no-apply]       # governed private-lane build/test/promote
bantam eval                                     # run the local repair fixtures
bantam experiment examples/experiments/x.json   # measured A/B between settings (see README)
bantam gauntlet --models local,sol,terra --rounds 3 --faults
                                                # held-out same-task model comparison
bantam trio run --task "fix it" --workspace /path --verify "npm test"
                                                # concurrent persistent Local/Sol/Terra lanes
bantam analyze                                   # rank harness bottlenecks from eval evidence (freshness-gated)
bantam facts [--backfill] [<relation query>]     # query .bantam/facts.jsonl run-evidence with the Datalog engine
bantam bench [fixtureDir ...] [--repeat N]       # grammar ON vs OFF: malformed-output / invalid rates
bantam skills                                    # list the learned-skills library
bantam factory list                              # inspect factory travelers and cells
bantam morning                                   # local server, recent runs, fuel, and governor
bantam fuel                                      # provider evidence already recorded locally
bantam governor [status|halt|resume]              # reserve policy and automated-errand kill switch
bantam loadouts [capture]                        # list or capture a local-server invocation
bantam loadout <number|hash>                     # replay a captured machine loadout
bantam swap <registered-profile>                 # launch a registry-defined local profile
bantam strut [idle|peck|flap|crow|walk|all]      # play the rooster animations (--micro for tiny, --list)
```

`exec` is the purpose-built **headless one-shot** (a strict option whitelist,
`--json` line-delimited output, exit codes 0/1/2/3, a lower default turn cap);
`run` is the fuller autonomous/lane runner. Use `exec` for scripts and pipes,
`run` for a full recorded autonomous run.

### Self-diagnosis, learning, and comparison

BANTAM can study its own recorded runs, learn from stronger agents, and forecast
its own state. These power the [self-improvement loop](SELF-IMPROVEMENT.md):

```bash
bantam runlens  <run.json> [--json]              # summarize a saved run: actions, timeline, gate rejections, verdict
bantam diagnose <run.json>                       # witness which turns went wrong, and why
bantam diagnose <run.json> --turn N --samples 3  # A/B a context remedy on the exact failing turn
bantam replay   <run.json> --turn N --inject "…" # rewind one turn with an injected fact (~30s)
bantam replay-mine [.bantam ...] [--untreated] [--uncontrasted] [--coverage FILE --uncovered] [--mode SHA_PREFIX] [--json]
                                                 # model-free exact-task specimens, optionally excluding studied turns
bantam replay-ab <spec.json> --dry-run [--max-calls N] [--require-new-design] [--json]
                                                 # model-free exact request/runtime/order/budget preflight
bantam replay-ab <spec.json> [--max-calls N] [--output <dir>]
                                                 # bounded baseline/remedy samples with durable semantic evidence
bantam audit-replay <evidence.json> [--json]      # independently re-hash and re-score replay evidence, model-free
bantam diagnose --compare comparison/runs/<r>/<t># learn from a passing reference: textual + KB-structural gaps
bantam collaborate local.json sol.json terra.json --grades local=3/10,sol=9/10,terra=10/10 --yes
                                                 # independent Sol/Terra diagnosis + reciprocal review
bantam forecast [dir]                            # will THIS workspace finish soundly? (unresolved imports)
bantam compare  "<task>" --allow-unsafe-competitors   # fire one task at all four arms → one summary (spends money)
bantam escalate <run.json> --task <t> --yes      # consent-gated escalation to a stronger agent when a run is stuck
bantam channel  promote --from dev --to regular --evidence <experiment>   # evidence-gated promotion
```

Recording a run with `--save-run <path>` (and `BANTAM_SAVE_PROMPTS=1` for
turn-level replay) is what makes a failure a rewindable specimen. See
[`docs/SELF-IMPROVEMENT.md`](SELF-IMPROVEMENT.md) for the full loop.

New `replay-ab` evidence includes position-bound SHA-256 call receipts.
`audit-replay` reconstructs each declared receipt's baseline/remedy request
hash and fidelity from the source artifact before accepting its completion,
timing, or provider-usage envelope. Historical receiptless evidence remains
compatible.

`replay-mine` also emits a bounded priority shortlist without hiding the full
candidate-turn set. Every score includes its recorded action and reasons, such
as an immediately preceding task-relevant edit or failed verification. Treat
the order as retrospective navigation, never as proof that a turn caused the
final outcome.

The miner clusters repeated verifier failures by structured assertion evidence
and shows a deterministic representative per mode. This is navigation
compression only: inspect the retained artifact list before deciding that two
runs have the same cause. Large JSON reports are drained before either launcher
exits, so piping `--json` into `jq` is supported without truncation.
The printed mode hash is a stable address; pass a unique 8–64 character prefix
to `--mode` for a smaller report containing that mode's failures and the
cohort's passing references.

Always preflight a new or edited replay spec before launching it. Exact model
request count and serialized context size are knowable; future provider token
usage, latency, caching, and cost are not. Use `--max-calls` on the actual run
when the request ceiling matters—the same guard executes before model or
endpoint work.

Use `--require-new-design` to prevent accidentally rerunning an identical
source/turn/sample/remedy/expectation design already present under
`.bantam/replay-experiments`. A different remedy or semantic expectation on
the same turn remains eligible.

### Troubleshooting

- **`health` says `unreachable`** → server down or wrong endpoint. Start llama.cpp
  with `/completion`; set `BANTAM_ENDPOINT`.
- **Model keeps re-reading / looping** → in `--autonomous`, the progress gate
  bounds this automatically; interactively, Ctrl-C and steer it.
- **`context_overflow`** → Bantam shrinks history and retries automatically; if it
  persists, give a tighter task or start the server with a larger `n_ctx`.
- **It emitted a `/workspace/...` path** → normalized automatically; containment
  checks still reject anything outside your workspace.

---

## Part 2: How it works

### The one idea

A local open-weight model, **constrained by a GBNF grammar so it cannot emit a
malformed tool call**, driven through a loop that separates *what the harness
observed* from *how that observation is delivered*:

> **Block on the user's word. Warn on the harness's hunch.**

Everything else is machinery around that: make the model's actions structurally
valid, execute them safely, and be honest about whether the result is verified.

### Life of a turn

```
        ┌─────────────────────────────────────────────────────────────┐
        │  buildPrompt: system protocol + task + workspace +           │
        │  replayed action/observation turns + plan/skills +           │
        │  live <open_files> (current, line-numbered) + prefill        │
        └───────────────┬─────────────────────────────────────────────┘
                        │  (optional: free-form <think> phase first)
                        ▼
        model.complete under the GBNF action grammar
                        │   → exactly one valid action JSON, e.g. {"a":"replace",...}
                        ▼
        parseAction → validate against the frozen action-protocol table
                        ▼
        normalize /workspace alias → groundAction (reject missing paths)
                        ▼
        executor.execute in the sandboxed workspace
          (read/list/search/inspect · replace/patch/write/delete/move · shell)
          edits get an instant pre-gate syntax check (node --check / py_compile / gofmt)
                        ▼
        observation appended (clipped · deduped · progress-classified)
                        │
     ── repeat until the model emits `done` / `respond`, or maxTurns ──
                        ▼
        on `done`: done-gates evaluated per gate-policy (block / warn by mode)
                        ▼
        after the loop: optional hidden verifier grades the final tree;
        interactive-verdict styles the outcome; a passing run may distill a skill
```

Invalid or failing model output never crashes the run — it becomes a **repair
turn** or an ordinary error observation.

### The grammar guarantee (the core primitive)

- **`action-protocol.js`** is the single source of truth: one frozen table
  describing every action verb, its field shape, an example, and prompt help.
  The grammar, the runtime validator, and the system-prompt action menu are all
  generated from it, so the wire shape can never drift between them.
- **`grammar.js`** renders that table into a **GBNF grammar** that constrains
  sampling, so the model can only produce exactly one syntactically valid action
  object with fixed key order. Malformed tool calls are impossible by
  construction — not parsed-and-repaired after the fact.
- **`actions.js`** is the second line of defense: it extracts and validates the
  JSON (with a one-shot repair for the stray control chars small models emit) and
  turns any structural failure into a clean repair turn.

The action verbs: `read_file`, `list_dir`, `search`, `inspect`, `shell`, `write_file`,
`replace`, `patch` (atomic multi-file, feature-gated), `delete_file` / `move_file`
(audited, feature-gated), `query` (ask the symbolic tools), `done`, `respond`.

### The loop and the prompt

| Component | File | Role |
| --- | --- | --- |
| Agent loop | `src/agent.js` | The orchestrator (`runAgent`): build → complete → parse → execute → observe, wiring in every guard, then the optional final verifier. |
| Model client | `src/model.js` | Wraps the llama.cpp `/completion` endpoint; retries transient errors; tags context-window overflow as `context_overflow` so the loop shrinks history instead of crashing. |
| Prompt assembly | `src/prompt.js` | Builds the raw prompt; scrubs chat-control tokens from all untrusted content so a model can't inject a fake turn by echoing `<|im_start|>`. |
| Model profiles | `src/profiles.js` | Per-model sampling/prompt quirks (Qwen: temp 0.6, cooler action temp 0.4, closed-`<think>` prefill so generation starts in the grammar channel). |
| Thinking mode | `src/thinking.js` | Optional two-phase turn: reason freely in `<think>`, then generate the constrained action. In `auto`, thinking is spent only at hard moments (turn 0, after a repair, after a failure). |
| Plan mode | `src/plan.js` | Optional up-front `{goal, steps}` plan pinned into the prompt, with a bounded adaptive re-plan when the trajectory stalls. |
| Open-files view | `src/open-files.js` | Renders the *current*, line-numbered contents of recently edited files so a line number can be reused directly as a `replace` anchor — makes surgical edits as easy as rewrites. Strictly size-bounded. |

### Execution and sandbox

| Component | File | Role |
| --- | --- | --- |
| Executor | `src/executor.js` | Runs each validated action against one workspace dir with symlink-aware realpath sandboxing; errors become `ERROR: ...` observations instead of throwing. `patch` is a staged, backup-and-rollback atomic multi-file commit. |
| Process runner | `src/process-runner.js` | Spawns shell children with a timeout, output byte cap, and abort signal; SIGKILLs the whole process group on timeout/abort so nothing is left behind. |
| Pre-gate | `src/pregate.js` | Instant syntax-only check on every edit (`node --check`, `py_compile`, `gofmt -e`) — catches a broken edit in milliseconds, not a full test cycle. Not the grader. |
| Shell lexer | `src/shell-lex.js` | Quote/escape-aware lexing shared by the safety guards (cd targets, test pipes, read-only detection) without running a real shell. |
| Observation clipper | `src/clip.js` | Keeps every model-facing observation within a stable char budget (head + bounded tail), so one noisy command can't exhaust context. |

The shell path can run in a **Docker sandbox** (read-only rootfs, `--network none`,
dropped capabilities, workspace-only read-write mount, `tmpfs /tmp`) or on the host.
Host toolchains are bind-mounted read-only into the sandbox — node/python/go install
roots, plus a rustup-managed Rust toolchain via only its secret-free pieces
(`~/.cargo/bin` and `~/.rustup`, never `~/.cargo` itself, where crates.io credentials
live). Build artifacts are diverted to the container tmpfs (`GOCACHE`,
`CARGO_HOME`, `CARGO_TARGET_DIR`) so a green build never litters the workspace —
which also keeps the eval scope-guard from misreading compiler output as edits.

Because Docker is offline by default, Bantam fail-fast rejects registry-backed installers
(`npm install`, `pip install`, `npx`, and equivalents) before spawning them. Interactive mode
then pauses and returns control with safe recovery choices; it never waits through a guaranteed
DNS retry loop. Dependencies still belong to the target project (`node_modules` for Node or a
project-local `.venv` for Python), not Bantam's own environment. Preinstall them from a trusted
terminal, or explicitly enable Docker networking with `--shell-network` /
`BANTAM_SHELL_NETWORK=1`. This preserves filesystem confinement but allows model-chosen commands
to transmit workspace data, so use it only for trusted work. Child stdout/stderr streams live to
the REPL; steering typed during a command is clearly queued for the next step, and Ctrl-C remains
the immediate stop mechanism. Before running npm scripts offline, Bantam also checks that binaries
declared by the project exist in `node_modules/.bin`; a missing local Vite/TypeScript/etc. is blocked
instead of falling through to an unrelated host-global command with the same name.

### Verification and completion gates

This is the product's spine. Every check *runs* in both modes; **`gate-policy.js`**
decides whether the consequence is **block**, **warn**, or **off** for that mode.

| Component | File | Role |
| --- | --- | --- |
| Done-gate chain | `src/done-gates.js` | The ordered gate registry, evaluated only when the model emits `done`. In precedence order: `empty_done` (a build `done` on a pristine tree — not one byte written), `premature_done` (last verdict was red, or code edited after the last verification), `unverified_edit` (edited code, never ran anything that exercises it), `secret_cleanup` (a removal task "proven" by a filtered grep that skips a known secret path), `immutable_file` (edited a file the task said not to touch), `evidence` (the run's own last deliverable check hard-failed with no clean run since), `preview` (a web deliverable `done` on a red/stale/empty render), `requirement_ledger` (recalled a constant from memory and watched its own check pass), `continuity_reconcile` (prose finish with a same-attribute conflict still in the text — incl. the *half-fixed* case), `report_shape` (a summary that promises future work or hedges "should work"). **Every gate declares a finite `max` rejection bound, so a false positive can never trap a run.** Three more gates that cost a subprocess or KB query — `sibling_symbol`, `family_convention`, `verify_red` — run as inline blocks in `agent.js` just after this loop. |
| Gate delivery policy | `src/gate-policy.js` | Maps each gate to **block / warn / off** per mode — *block on the user's word, warn on the harness's hunch.* A block encodes the user's own instruction or a fact the filesystem contradicts (`immutable_file`, `empty_done` block even interactively); a warn encodes the harness's suspicion (blocks unattended, warns with a human present). An unclassified gate **fails closed to block**. New candidate gates ship **off by default** behind an env lever (`BANTAM_*_GATE=1`) until an A/B measures them helping — a discipline enforced by tests (`test/gate-policy.test.js`: every off-by-default gate must expose the lever that enables it). |
| Done-guard | `src/done-guard.js` | The trajectory-scanning objections, plus the shared pass/fail verdict parser over runner output + exit codes. Objection strings avoid PASS/FAIL tokens so they can't be misread as a verdict. |
| Evidence guard | `src/logic/evidence-guard.js` | Vetoes `done` once when the run's own last real verification hard-failed with no clean run since — precision over recall (never on ordinary `grep`/`test` non-zero exits). |
| Immutable-file check | `src/logic/self-check.js` | Parses "do not edit X"/"only edit X" from the *task* and derives violations via a tiny Datalog rule over file-hash facts. |
| Deliverable signals | `src/logic/deliverable-signals.js` | One shared classifier for "is this a real test run / deliverable run?" (unwraps `sudo`/`env`/`timeout`/`poetry run`, skips `--help`). Used by every verification-aware module. |
| Completion audit | `src/completion-audit.js` | After tests go green, injects a one-shot hint to re-check each explicit requirement against *executed behavior* (not names/comments) before `done`. On by default. |
| State-audit policy | `src/state-audit-policy.js` | Experimental companion: for async-lifecycle tasks, adds a stricter concurrency-counterexample audit. The default is `auto`, selected by a conservative task classifier; `BANTAM_STATE_AUDIT=0` / `off` is the rollback. |
| Interactive verdict | `src/interactive-verdict.js` | Classifies a finished REPL request into the outcome the human sees; a real external pass suppresses the harness's now-moot warnings. |

### Convergence steering: making the write→run→edit loop land

Verification says *whether* the work is done; these layers are what make a small
model actually get there. Each was built from an observed failure mode and
validated against the live model.

| Component | File | Role |
| --- | --- | --- |
| Sharp test feedback | `src/logic/test-focus.js` | Parses a failing test run into "test X, file:line, you produced A, it requires B, here's the test's source" and steers on exactly that. Understands eight runner formats — node --test/TAP, pytest, `go test`, vitest, jest, `cargo test`, `bun test`, perl Test::More (raw or via `prove`) — each parser built from captured real output; `test/classifier-matrix.test.js` pins every classifier against every ecosystem's real pass AND fail output. |
| Blind-edit auto-verify | `src/agent.js` (`autoVerifyBlindEdits`, default 4) | After N consecutive edits with no test run, the harness runs the verify itself and injects the real result — kills the "one test run, then 30 blind edits to the cap" spiral, the biggest observed hard-task failure mode. |
| Regression guard | `src/agent.js` (`regressionGuard`, default on) | Tracks the best-passing snapshot of every edited file; a severe regression (or any drop from fully-green) restores the snapshot and steers toward a different fix. Multi-file aware. |
| Stuck-test diagnosis | `src/logic/test-focus.js` (`diagnoseStuckTests`) | When one test stays red through repeated focused feedback, a separate focused reasoning call decomposes just that test against the current implementation and injects the diagnosis (single-fire per test; re-diagnosis A/B'd null). |
| Placeholder-echo guard | `src/agent.js` | Rejects an edit whose body is the history-slimming placeholder (the model copying its own collapsed history into a real file — would destroy it); slimming also carries the pointer in a non-emittable field so the temptation no longer exists. |
| Double-escape guard | `src/agent.js` | Rejects a whole-file write that is one giant line full of literal `\n` sequences (a double-escaped JSON string) with the exact fix, instead of letting a generic syntax error send the model into byte-level forensics. Once per path, so a deliberate one-liner stays writable. |
| Flaky-aware dedup | `src/repetition.js` | A deliverable/test run re-executes until the same result is confirmed three times (a flaky flip resets the counter) — a nondeterministic suite can never freeze the loop on a stale failure. Read-only actions still dedup on the first repeat. |

### Progress and anti-spiral guards

Local models can spiral into read-only reconnaissance or repeat a failing move.
These keep a run moving without a human.

| Component | File | Role |
| --- | --- | --- |
| Progress awareness | `src/progress-awareness.js` | Classifies each turn as real progress vs pure recon; after N progressless turns it refuses read-only actions and forces a create/modify/verify, escalating to termination if the model keeps dodging validation. (Autonomous only.) |
| Interactive wrap-up | `src/agent.js` | The human-steered backstop: after a streak of investigative turns — reads, shell, **or `query`/`map` calls** — with no edit or answer, it masks the investigative verbs from the grammar so the model *must* `respond` or edit, and hard-stops if it keeps dodging. Stops "take a look and tell me what you think" from spiralling. |
| Query budget | `src/query-budget.js` | Novel `query` actions count as progress up to a budget, then stop resetting the progress counter — interrogating the graph forever eventually hits the gate (autonomous), and a `query` also counts toward the interactive wrap-up above. |
| Repetition guard | `src/repetition.js` | Replays the prior observation for an exact-duplicate read-only **or `query`** action (with a "deduplicated, not stale" notice) so a repeated look carries information and a repeated `map` query isn't re-shelled; an edit clears the cache. |
| Failure diagnostics | `src/failure-diagnostics.js` | Fingerprints failures and nudges harder when the *same* failure recurs after edits; points "command not found" at a substrate tool that provides it. |
| Scope / anti-cheat guard | `src/scope-guard.js` | Fails any fixture whose grader was modified or whose edits fell outside declared editable prefixes. Experimental `BANTAM_EVAL_SCOPE_ROLLBACK=1` additionally refuses direct immutable edits and restores protected shell mutations before the run can build on them. |

### Grounding: a symbolic layer under the model

Instead of guessing about the codebase or being force-fed the whole map (an A/B
showed that's net-negative), the model can pull exact structural facts or bounded,
deterministic concept rankings from the live grounding snapshot.

| Component | File | Role |
| --- | --- | --- |
| Datalog engine | `src/logic/datalog.js` | Dependency-free in-memory Datalog with recursion, term interning, and indexed semi-naive joins — the symbolic substrate. |
| Code-fact extraction | `src/logic/codefacts.js` | Deterministically turns a workspace into facts (`file`, `defines`, `imports`, `depends`, `calls`) + derived `symbol`/`reaches`; re-extracts only changed files. |
| Grounding context | `src/logic/grounding.js` | Wraps the KB for the loop; `groundAction()` rejects a read/edit on a path that provably doesn't exist (with nearest-path suggestions); refreshes facts atomically after edits, or fails closed. |
| Tool registry | `src/logic/tools.js` | On-demand `{name, description, answer(q)}` tools: **`code`** (entrypoints/exists/defines/symbols/deps/affects/files), **`concept`** (deterministic meaning-oriented retrieval over function/class chunks, weighted lexical fields plus dependency-graph reranking), **`map`** (whole-repo structure — brief/arch/flow/callers/impact/reach/explain, via the `repo_map/` Go/JS/Python extractors; architecture/feature-ideation requests receive one live brief automatically, while other work stays pull-based; the dev layout discovers the exact sibling extractor, or an authoritative `BANTAM_REPOMAP_DIR`; off with `BANTAM_NO_MAP`), **`sqlite`** (read-only DB probe, auto-registered when the workspace has DB files), **`history`** (queries about *this* run), **`view_image`** (Codex or local semantic vision plus deterministic PNG dimensions/palette, off with `BANTAM_NO_VISION`), **`generate_image`** (opt-in managed Codex image variants under `assets/generated/`, with `--size`/`--quality` and concurrency that falls automatically at high resolution), **`edit_image`** (change an image the workspace already has — the source rides along as a `localImage` reference, so the result is the original with the change applied rather than a fresh picture), and **`preview`** (Chromium runtime/layout evidence plus local or Codex screenshot vision and offline dependency detection). |
| Run-log | `src/logic/runlog.js` | Records the run as append-only `[entity, attribute, value, time]` datoms with an as-of index — so control heuristics (like the done-guard verdicts) can be *queries over history* rather than imperative scans. |

The model reaches all of this through a single action: `{"a":"query","q":"affects src/foo.js"}` —
or `{"a":"query","q":"map arch"}` for a whole-repo overview and
`{"a":"query","q":"map flow bin/tool.js"}` for executable order, or
`{"a":"query","q":"concept error recovery"}` when it knows the behavior but not its symbol.
An identical query on an unchanged
workspace is replayed from cache rather than re-run (`BANTAM_DEDUPE_QUERY=0` to disable).

### Learning, evidence, and self-improvement

This is the machinery by which the harness **gets better at your work by doing your
work** — record a failure, study it at the exact turn it went wrong, A/B a context
fix, and promote it only if measured. The full flow is documented in
**[`docs/SELF-IMPROVEMENT.md`](SELF-IMPROVEMENT.md)**; the components:

| Component | File | Role |
| --- | --- | --- |
| Rewind / counterfactual replay | `src/replay.js` | Reconstructs the byte-exact request for one recorded turn and re-asks the live model with an injected fact — the "fix the context, replay 30 seconds" primitive. `withSampleSeed` keeps baseline and remedy arms paired draw-for-draw; the verdict reports `UNCHANGED`/`CHANGED`/`NO ACTION` and never conflates *changed* with *better*. |
| Diagnose | `src/diagnose.js` | Witnesses a run's own distress signals, proposes gate-voiced context remedies, and **scores** them against the recorded failure (set-difference over engagement signals). Prints and scores only — never mutates ambient knowledge. |
| The learning brain | `src/logic/{reference-witness,kb-diff-witness,completeness-critic,critic-witness,continuity-anchors}.js` | Learn from a *stronger* agent (or the workspace's own KB): reference-witness diffs a passing arm's **text**, kb-diff-witness diffs its **KB structure** (missing definitions/calls/imports), the completeness critic surfaces **silent** structural gaps, continuity-anchors the prose analog. Each self-generates a gate-voiced remedy that is replay-scored at the DONE turn before it's trusted. `bantam diagnose --compare` runs the text+structural path. |
| Sol/Terra teacher council | `src/teacher-collaboration.js` | Given same-task local/Sol/Terra artifacts, sends both teachers one bounded redacted evidence packet, collects independent structured diagnoses and adversarial tests, and makes each cross-review the other. Cross-accepted hypotheses become hash-bound **build-only** candidates for the governed controller. Clean local runs do not consult teachers unless `--proactive`; `--yes` is always required. Consensus is witness evidence, never promotion evidence. |
| Four-arm comparison | `comparison/` | Runs `{bantam-regular, bantam-dev, claude-code, codex}` on one task from an immutable, integrity-sealed manifest, grading each **from the final filesystem only**; harnesses are pinned by `sha256`. `bantam compare "<task>"` is the user-initiated front door; see the frozen agent-duel showcase. |
| Channels & evidence-gated promotion | `src/{state-cli,lane-store,promotion-evidence,channel-launcher}.js` | Two channels (`regular`/`dev`) as compare-and-swap pointers to immutable versions; every move is a hash-chained event. `channel promote` requires completed-experiment evidence (candidate must not regress the reference) or an audited waiver — so `regular` moves only deliberately, and every change is revertible. |
| Skills | `src/skills.js` | With explicit `--skills`, distills a run that *passed hidden verification* into a reusable, versioned skill and retrieves it by keyword overlap. Ordinary runs neither inject nor mutate the library. |
| Run artifacts & ledger | `src/artifact.js` | The durable per-run JSON (sampling, git provenance, full trajectory with raw output kept separate from the parsed action, metrics). Unknown values recorded as `null`, never guessed. |
| Crash-safe checkpoint | `src/run-checkpoint.js` | On SIGTERM/SIGINT, flushes a `partial: true` artifact atomically so a killed run still says where it got to. |
| Fixture runner | `src/fixture-runner.js` | The single repeatable fixture unit shared by `eval` and experiments: copy repo → run agent → scope-guard → contract-grade → capture artifact → append ledger. |
| Experiments | `src/experiment*.js` | Versioned, seeded, balanced A/B between harness settings; Wilson intervals + pass@k; crash-safe manifest with strict resume. See the [README](../README.md#measured-experiments). |
| Model gauntlet | `src/gauntlet.js`, `gauntlet/fixtures/` | Seven isolated public-green/hidden-red coding fixtures routed to Local or any live non-hidden Codex alias. Reuses the experiment engine, freezes the catalog, records complete usage and integrity telemetry, and supports transport fault injection. Every completed run emits a correctness-first N-model showcase; see the Local/Sol/Terra report and hard Codex role tournament. |
| Parallel trio session | `src/trio-session.js` | Freezes the live source once, materializes external Local/Sol/Terra workspaces, runs the normal BANTAM loop concurrently, streams tagged activity, persists comparable artifacts, and transactionally applies only an explicitly selected verified arm. |
| Bottleneck analysis | `src/evidence-analysis.js` | Offline: ranks the harness's own friction counters to recommend the next structural investment — but only trusts evidence captured at the current harness git SHA. |

### CLI and TUI

- **`bin/bantam.js`** — the package executable and development dispatcher. Its
  surfaces include ordinary `run`/`exec`/interactive work; evaluation,
  comparison, collaboration, state/channel/lane, and self-improvement commands;
  the `factory` command family; and machine-local `morning`, `fuel`, `governor`,
  `loadout`, and profile-swap controls. It also owns the
  default interactive REPL (persistent workspace, session memory, mid-run
  steering, Ctrl-C abort).
- **`src/tui.js`** — an opt-in (`--tui`) read-only ANSI cockpit view over the same
  event stream.

### Proof it works: the Tetris head-to-head

As a live sanity check, all three of BANTAM (local Qwen 27B), Claude Code
(Sonnet), and Codex (`gpt-5.6-sol`) were given the *same* prompt — "build a
complete single-file Tetris" — and each result was tested in a real browser:

| Arm | Result | Wall time | Notes |
| --- | --- | ---: | --- |
| **BANTAM** (local Qwen 27B) | Working, 8/8 requirements | **56s**, 2 turns, free | One `write_file`; ghost piece + next preview. Verification machinery dormant (no `--verify`). |
| **Claude Code** (Sonnet) | Working, 8/8 | **43s**, $0.225 | Clean minimal build; auto-start + restart. |
| **Codex** (gpt-5.6-sol, ultra) | Working, 8/8 | **~15 min** | Most elaborate (944 lines, game-over modal); spent most of the time self-auditing. |

The honest read: this is one subjective task with each agent on different
settings, so it's an anecdote, not a benchmark. But it shows the local harness is
genuinely usable for real builds — the grammar-constrained loop produced a
working, complete game faster than the cloud agents. BANTAM's *distinct* value
(honest verification) only engages when you give it something to check; that's
what the `eval`/`experiment`/`--verify` paths are for.

---

## See also

- [`README.md`](../README.md) — quick start, interactive details, experiments, configuration.
- [`docs/PRINCIPLES.md`](PRINCIPLES.md) — the first principle (*it's the context, not the model*), the evidence table, and the diagnose loop.
- [`docs/SELF-IMPROVEMENT.md`](SELF-IMPROVEMENT.md) — the full self-improvement loop: record → witness → rewind → A/B → score → evidence-gated promotion.
- [`docs/ROADMAP.md`](ROADMAP.md) — the product thesis and where it's headed.
- [`docs/GROUNDING_TOOLS.md`](GROUNDING_TOOLS.md) — the symbolic-tool design in depth.
- `docs/superpowers/` — the measured upgrade program and results.
