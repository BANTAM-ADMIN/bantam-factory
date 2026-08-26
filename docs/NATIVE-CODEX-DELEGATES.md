# Native Codex and Claude Code Delegates

> **Status: research-only.** The first strict same-task comparison found
> BANTAM-constrained Sol and Terra faster and substantially lower in total
> provider-reported token processing than native CLI delegation. Ordinary work
> should use `:model codex-sol` or `:model codex-terra`. A native run requires
> explicit `--yes`. See
> [Why Codex Works Efficiently Inside BANTAM](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md).

## What this adds

BANTAM now has three deliberately different execution paths:

1. **BANTAM-constrained Codex** — BANTAM owns the loop. Codex returns one
   schema-constrained BANTAM action at a time. BANTAM owns context assembly,
   tools, workspace policy, verification, recovery, and telemetry.
2. **Native Codex delegate** — Codex owns the inner coding-agent loop through
   `codex exec`. BANTAM owns the immutable starting point, isolated candidate
   workspace, evidence capture, authoritative verification, comparison, and
   explicit transactional adoption.
3. **Native Claude Code delegate** — Claude owns its normal tool loop through
   noninteractive `claude --print` stream JSON. BANTAM retains the same outer
   immutable-baseline, evidence, verification, comparison, and apply boundary.

None of these modes replaces another. The constrained mode is the controlled
research instrument used to compare local and Codex behavior inside the same
harness. Delegate mode answers a different question: what happens when a native
agent operates its own loop while BANTAM remains the outer governor?

## Quick start

Run a Sol delegate:

```bash
./bin/run-dev.sh delegate run --yes \
  --provider codex \
  --model sol \
  --effort high \
  --verify "npm test" \
  --task "Implement the requested change and add focused regression coverage."
```

Run a Terra delegate:

```bash
./bin/run-dev.sh delegate run --yes \
  --provider codex \
  --model terra \
  --effort medium \
  --verify "npm test" \
  --task "Implement the requested change and add focused regression coverage."
```

If the host cannot create Codex's `workspace-write` bubblewrap sandbox and the
artifact reports an infrastructure error such as `bwrap: ... RTM_NEWADDR`, an
explicit isolated-candidate retry is available:

```bash
./bin/run-dev.sh delegate run --yes \
  --provider codex \
  --model terra \
  --effort medium \
  --bypass-sandbox \
  --verify "npm test" \
  --task "Implement the requested change and add focused regression coverage."
```

This is never an automatic fallback. It disables Codex's OS sandbox, so use it
only for a trusted task on a trusted host. BANTAM still gives the agent an
external candidate and never applies its changes to the source checkout without
the separately consented, transactional `delegate apply` step.

Run Claude Code and retain its complete tool/event stream:

```bash
./bin/run-dev.sh delegate run --yes \
  --provider claude \
  --model opus \
  --effort high \
  --permission-mode auto \
  --verify "npm test" \
  --task "Implement the requested change and add focused regression coverage."
```

Claude defaults to `acceptEdits`, which permits source edits but can deny shell
commands. `--permission-mode auto` lets Claude's own safety classifier approve
normal test commands. BANTAM never enables `bypassPermissions`: Claude's Bash
tool is not protected by Codex's OS workspace sandbox, so the stronger mode is
an explicit operator choice and still runs only in the isolated candidate.

The source checkout is not modified. The command prints the durable artifact
path and, when the candidate changed files, a separate apply command.

Inspect an artifact:

```bash
./bin/run-dev.sh delegate show .bantam/delegates/<run-id>
./bin/run-dev.sh delegate show .bantam/delegates/<run-id> --json
```

Compare native delegates with one or more BANTAM gauntlets:

```bash
./bin/run-dev.sh delegate compare \
  .bantam/delegates/<native-sol-run> \
  .bantam/delegates/<native-terra-run> \
  .bantam/gauntlets/<constrained-run>/manifest.json
```

Adopt a candidate only after inspecting it:

```bash
./bin/run-dev.sh delegate apply .bantam/delegates/<run-id> --yes
```

## Execution boundary

The live checkout is frozen into BANTAM's content-addressed `WorkspaceStore`.
The baseline is materialized into a temporary directory outside the source
tree. Runtime dependencies such as `node_modules` may be copied into that
external candidate, but they are excluded from candidate history.

BANTAM invokes:

```text
codex --ask-for-approval never exec
  --json
  --ephemeral
  --ignore-user-config
  --sandbox workspace-write
  --skip-git-repo-check
  --model <gpt-5.6-sol|gpt-5.6-terra>
  --config model_reasoning_effort="<level>"
  --cd <external-candidate>
  <bounded task prompt>
```

For Claude, BANTAM invokes noninteractive `--output-format stream-json` with
partial messages, disables session persistence and slash commands, restricts
settings to the project source, and supplies an empty strict MCP configuration.
The resolved model reported by Claude is recorded separately from the requested
alias.

Important details:

- `--ephemeral` avoids persisting a second native thread history.
- `--ignore-user-config` preserves Codex authentication but excludes personal
  model, MCP, plugin, hook, and sandbox configuration from the experiment.
- `workspace-write` is the least permission level that permits implementation.
- `--bypass-sandbox` is an explicit Codex-only recovery option for hosts where
  bubblewrap itself is unavailable; the choice is recorded in the execution
  arguments and is never selected automatically.
- The delegate never receives the live checkout as its working directory.
- A process-tree deadline prevents an abandoned CLI child from retaining the
  run indefinitely.
- BANTAM independently runs the authoritative verifier after Codex exits.
- Candidate bytes are captured into the workspace store before the executable
  temporary checkout is removed.

## Evidence artifact

Each run writes:

```text
<workspace>/.bantam/delegates/<run-id>/
├── artifact.json
├── events.jsonl
├── claude-stream.jsonl # Claude only: exact complete stdout event stream
├── claude-stderr.log   # Claude only: exact stderr
└── transactions/       # only after an apply attempt
```

`artifact.json` records:

- exact task, model, and reasoning effort;
- immutable baseline commit/tree and candidate commit/tree;
- redacted command shape and execution status;
- native thread id;
- every parsed Codex or Claude JSONL event;
- for Claude, the exact raw stream path, byte count, and SHA-256;
- JSONL parse errors without discarding valid events;
- final agent message;
- command, file-change, message, reasoning, and error event counts;
- elapsed time and process exit/timeout state;
- input, cached-input, cache-miss, output, and reasoning-output tokens;
- BANTAM verifier command, status, duration, exit code, and bounded output;
- final unified diff, changed paths, bytes, and SHA-256;
- overall pass/fail status.

The token source of truth is Codex's `turn.completed.usage` event or Claude's
terminal `result.usage` event. BANTAM does not estimate missing usage. Anthropic
cache-creation/read counters and Codex cached-input counters are retained as
different contracts and are not ranked as comparable cache misses.

## Apply safety

`delegate apply` is intentionally a second command requiring `--yes`.

Before writing:

1. Reload and validate the delegate artifact.
2. Confirm that the requested live workspace is the recorded source workspace.
3. Recompute the live tree and require an exact match to the frozen baseline.
4. Materialize the exact recorded candidate from the workspace store.
5. Run the authoritative verifier against that materialization.

During adoption:

1. Prepare a `WorkspaceTransaction` with backups and content hashes.
2. Apply only the planned byte-level changes.
3. Run the verifier again against the live checkout.
4. Commit the transaction only when the live verifier passes.
5. Roll back automatically on failure.

The delegate cannot promote itself, silently overwrite newer live work, or
turn an unverified native answer into a passing BANTAM result.

## Same-task experiment: ordered-map

On 2026-07-25, five execution paths received the same `ordered-map` coding
fixture. The public test and the separate hidden contract both passed for all
five candidates.

| Mode | Effort | Inner turns / requests | Input | Cache hit | Cache miss | Output | Reasoning | Time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Native Sol delegate | high | 1 / 1 | 714,354 | 676,608 | 37,746 | 7,664 | 2,478 | 3m 30s |
| Native Terra delegate | medium | 1 / 1 | 132,528 | 118,016 | 14,512 | 2,541 | 468 | 58.1s |
| BANTAM local Qwen | local | 8 / 11 | 29,787 | 31,994* | n/a | 2,208 | 0 | 32.7s |
| BANTAM-constrained Sol | high | 6 / 6 | 106,312 | 67,584 | 38,728 | 1,270 | 256 | 46.4s |
| BANTAM-constrained Terra | medium | 6 / 6 | 97,634 | 75,008 | 22,626 | 1,176 | 185 | 31.9s |

\* Local llama.cpp cache accounting is not the same contract as Codex cached
input and can exceed the separately reported input count. `delegate compare`
therefore does not rank local cache misses against Codex cache misses.

Evidence:

- `.bantam/gauntlets/delegate-control-local-sol-ordered-map/`
- `.bantam/gauntlets/delegate-control-terra-ordered-map/`
- `gauntlet/fixtures/ordered-map/repo/.bantam/delegates/`

## What the first result means

Native delegation worked, but the bounded repair showed it was slower and
processed more total tokens than constrained BANTAM Codex. Native delegation
is therefore excluded from ordinary work and automatic routing.

- Native Terra had the lowest comparable Codex cache-miss count, suggesting
  that its large cached prefix may be less expensive than total input alone
  implies.
- Constrained Terra was still faster and generated less output on this small,
  precisely specified repair.
- Constrained Sol used dramatically less total input than native Sol.
- Local BANTAM was both fast and economical on the simple fixture.
- Native Sol emitted several progress messages and tool attempts before the
  final edit. Native autonomy reduced BANTAM-level requests to one, but did not
  reduce the provider's internal work to one inference.

This is a single small fixture, not a general model ranking. The correct next
evaluation is a task-size curve:

1. tiny, precisely specified repair;
2. cross-file repair;
3. ambiguous diagnosis plus implementation;
4. repository-scale refactor;
5. long-running task where native compaction and tool continuity can matter.

The working hypothesis is now conditional:

- Prefer local or constrained Terra for small, well-specified tasks.
- Use constrained Sol when BANTAM needs comparable trajectories and governance.
- Keep native Terra and Sol behind explicit research consent until a
  preregistered larger-task comparison demonstrates an advantage.

## Comparison semantics

`delegate compare` accepts:

- native delegate `artifact.json` files;
- native delegate run directories;
- BANTAM experiment `manifest.json` files;
- directories containing either canonical file;
- individual `bantam-run` artifacts.

It reports pass status, turns, requests, provider-reported input, cache hits,
comparable cache misses, output, reasoning, and task time. It also names the
fastest row and the rows with lowest input, comparable Codex cache miss, and
output.

The comparator preserves accounting boundaries rather than manufacturing a
single misleading "token efficiency" score.

## Current limitations

- JSONL exposes native work as events, but a CLI run is still one outer BANTAM
  request. Internal inference count is not separately reported.
- Codex currently reports command executions reliably; file edits may appear
  only in the captured workspace diff rather than as `file_change` events.
- Delegate artifacts do not yet run a gauntlet's hidden grader automatically.
  Gauntlet fixtures remain the canonical path for strict hidden-contract
  comparisons.
- Codex delegate mode currently supports Sol and Terra aliases. Claude accepts
  Opus, Sonnet, Fable, or an exact native model identifier and records Claude's
  resolved model in the artifact.
- Personal Codex plugins/MCP/hooks and personal/local Claude settings/MCP are
  intentionally excluded for reproducibility. These are clean native agents,
  not clones of the operator's customized interactive environments.

## Relevant implementation

- `src/codex-delegate.js` — isolated Codex runner, JSONL parser, artifact, apply.
- `src/claude-delegate.js` — isolated Claude runner, full stream capture, usage,
  artifact, and apply.
- `src/native-delegate.js` — provider dispatch for the shared CLI surface.
- `src/delegate-comparison.js` — normalized cross-runtime accounting.
- `src/workspace-store.js` — immutable baseline and candidate history.
- `src/workspace-transaction.js` — verified transactional adoption.
- `src/process-runner.js` — deadline, output cap, and process-tree cancellation.
- `src/diff.js` — final unified diff evidence.
- `test/codex-delegate.test.js` — Codex safety, parsing, execution, and apply tests.
- `test/claude-delegate.test.js` — Claude stream, isolation, verification, and
  apply tests.
- `test/delegate-comparison.test.js` — accounting normalization tests.
