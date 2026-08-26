# BANTAM Trio Mode

For how trio fits into the complete BANTAM agent, Codex runtime, teacher
council, and self-improvement flywheel, see the
[BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md).

Trio mode runs the same request through three independent BANTAM agents at the
same time:

1. **Local** — the configured local Qwen model;
2. **Sol** — `gpt-5.6-sol` through the Codex app-server and your Codex
   subscription;
3. **Terra** — `gpt-5.6-terra` through the same Codex subscription.

Each agent receives the same frozen starting project but works in a different
private workspace. You can watch all three work, compare their evidence, and
explicitly apply one candidate. Trio mode never merges their edits and never
changes the live project merely because a run completed.

## Before you begin

Trio requires:

- the local model server reachable at the normal BANTAM endpoint;
- Codex installed and authenticated (`codex login status`);
- a project verifier such as `npm test`, `pytest`, or another deterministic
  command.

From this development checkout, confirm the command surface:

```bash
./bin/run-dev.sh trio --help
```

The local model remains BANTAM's ordinary default. Sol and Terra are started
only when you explicitly run `trio` or enable `:trio`.

## Choose a workflow

Use **interactive trio mode** when the work will involve follow-up requests.
Each model keeps its own evolving filesystem and bounded history across the
session.

Use a **one-shot trio run** for one reproducible task, automation, or a clean
comparison artifact.

### Interactive workflow

Start BANTAM in the project:

```bash
cd /path/to/BANTAMBUILD
./bin/run-dev.sh --workspace /path/to/project
```

Enable the three lanes:

```text
bantam ❯ :trio on high
```

The optional value is the Codex reasoning effort for both hosted arms:

```text
low
medium
high
xhigh
max
ultra
```

Now enter an ordinary request:

```text
bantam ❯ Repair the cache expiration bug and add a regression test.
```

BANTAM prints events as they arrive:

```text
[local] started in isolated workspace
[sol] started in isolated workspace
[terra] started in isolated workspace
[local] inspect: read src/cache.js · read test/cache.test.js
[sol] edit src/cache.js
[terra] $ npm test
```

The agents are actually concurrent; the interleaving is expected. A slow arm
does not prevent you from seeing another arm's progress.

### Advisory requests versus implementation requests

Trio classifies each new request before starting the arms:

- **Advisory** requests ask for explanation, review, assessment, suggestions,
  or recommendations. Each arm may inspect the project and answer, but BANTAM
  structurally disables edits, file operations, shell commands, and autonomous
  `done`. It does not run the project verifier. A successful arm is reported as
  `response`, meaning it answered and its private workspace remained unchanged.
- **Implementation** requests ask BANTAM to build, fix, change, or otherwise
  mutate the project. The ordinary autonomous editing and verification policy
  remains active.

This is a hard execution policy, not merely a sentence in the model prompt. If
an unconstrained or fallback model emits a disabled action during an advisory
turn, BANTAM rejects it before execution and asks for a safe response.
Ambiguous terse tasks default to implementation mode so the classifier does
not silently suppress requested coding work.

```text
# advisory: inspect and recommend, no edits or verifier
bantam ❯ Take a look at this codebase and suggest the highest-value improvement.

# implementation: isolated edits followed by verification
bantam ❯ Implement that improvement and add regression tests.
```

Follow-up prompts continue all three private lanes:

```text
bantam ❯ Also preserve stale-while-revalidate behavior.
bantam ❯ Add coverage for a zero-second TTL.
```

Useful commands:

```text
:trio status
:trio compare
:trio apply <local|sol|terra>
:trio reset
:trio off
```

- `:trio status` prints the session directory and completed turn count.
- `:trio compare` prints the latest verifier and efficiency table.
- `:trio apply sol` asks for confirmation and applies Sol's complete current
  workspace if all safety checks pass.
- `:trio reset` closes the current lanes, freezes the live project as a new
  baseline, and starts fresh lanes.
- `:trio off` closes the three model clients. Saved evidence and private lane
  data remain available; later ordinary prompts use the currently selected
  single model.

Applying an arm ends the active trio session because the live project now has a
new baseline.

### One-shot workflow

Run one task from the BANTAM checkout:

```bash
./bin/run-dev.sh trio run \
  --task "Repair the cache expiration bug and add a regression test." \
  --workspace /path/to/project \
  --verify "npm test" \
  --models local,sol,terra \
  --effort high \
  --max-turns 30
```

If `--verify` is omitted, BANTAM attempts to detect the project's test command.
Supplying it explicitly is preferable for consequential work and is required
before a candidate can be applied.

Options:

| Option | Meaning |
| --- | --- |
| `--task "..."` | Exact request sent to every selected arm |
| `--workspace <dir>` | Live source project; defaults to the current directory |
| `--verify "<command>"` | Candidate and live-workspace acceptance test |
| `--models <list>` | Any subset of `local,sol,terra`; defaults to all three |
| `--effort <level>` | Sol/Terra reasoning effort; defaults to `high` |
| `--max-turns <n>` | Per-arm BANTAM turn ceiling; defaults to 30 |
| `--endpoint <url>` | Override the local model endpoint |
| `--output <dir>` | Override the trio evidence root |

For implementation work, the command exits successfully only when every
selected arm passes its verifier. For advisory work, success means every arm
returned a response without changing its lane. A failed arm does not erase
successful arms or their evidence.

## Reading the result

At completion, BANTAM prints:

- status and verifier result for each arm;
- BANTAM turns and model requests;
- input, output, reasoning, and cache-token accounting;
- elapsed time;
- each agent's final summary;
- the session and HTML report paths.

Example:

```text
Trio turn 1: all arms passed

Arm     Status       Turns  Requests  Input      Output     Reasoning  Time
local   pass              4         6      12,520         385           0    7.8s
sol     pass              4         6      87,664         679         173   47.8s
terra   pass              4         6      78,133         674         173   47.7s
```

An advisory comparison is intentionally different:

```text
Trio turn 1 (advisory): all arms responded safely

Arm     Status
local   response
sol     response
terra   response
```

`response` is not an unverified implementation. It means the request was
read-only, the model answered, and BANTAM observed a zero-file diff.

`Fastest` and `Fewest turns` are descriptive labels, not winner selection.
A fast candidate can be incomplete, and a token-heavy candidate can contain a
better design. Check at least:

1. verifier status;
2. final summary;
3. final diff in the run artifact;
4. whether tests were modified appropriately;
5. scope and maintainability;
6. warnings, invalid actions, or protocol violations.

Inspect a saved session:

```bash
./bin/run-dev.sh trio show /path/to/project/.bantam/trios/<session-id>
```

Open its visual report:

```text
/path/to/project/.bantam/trios/<session-id>/report/index.html
```

The report links to each complete run artifact.

## Applying one candidate

A trio run does not alter the live source project. After reviewing the results,
apply one arm explicitly:

```bash
./bin/run-dev.sh trio apply \
  /path/to/project/.bantam/trios/<session-id> \
  --arm sol \
  --yes
```

The apply operation:

1. confirms that the live source tree still equals the frozen baseline;
2. materializes the selected candidate outside the source project;
3. runs the configured verifier against that candidate;
4. prepares a conflict-aware filesystem transaction;
5. applies the candidate delta to the live project;
6. runs the verifier again in the live project;
7. commits on success or restores exact backups on failure.

If you or another process changed any source byte after trio mode began, apply
refuses with:

```text
live workspace changed since the trio baseline
```

This is deliberate. Preserve the newer human work, start a fresh trio session,
or reconcile the candidate manually. BANTAM will not guess how to overwrite
concurrent edits.

`--yes` is required in headless mode. In the REPL, BANTAM asks for confirmation
instead.

## Files and workspaces

Source-local evidence is stored under:

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
  transactions/              # created after apply
```

These are inert evidence files, not executable copies of your project.

The three working copies live in an external temporary runtime directory. Its
path and the exact lane paths are recorded in `manifest.json`:

```bash
jq '{runtimeRoot, arms}' \
  /path/to/project/.bantam/trios/<session-id>/manifest.json
```

Keeping executable copies outside the project prevents recursive test runners
from finding duplicate tests and prevents the agents from writing over one
another. Candidate commits are also stored content-addressably, so headless
apply does not depend on a still-running model client.

Before the first implementation turn, BANTAM prepares each external lane for
execution. If the live project has `node_modules`, it is mirrored into each
lane and mounted read-only for the agent. BANTAM then runs a baseline preflight
with the configured verifier. Ordinary red tests are allowed—repair tasks often
start red—but missing packages, missing runtimes, and unavailable offline
dependencies stop the trio before any model begins editing. Advisory turns skip
this implementation preflight entirely.

## From trio evidence to self-improvement

Trio mode creates comparable telemetry; it does not automatically change the
BANTAM harness. This boundary prevents “Sol did something different” from being
mistaken for “that difference is a proven general improvement.”

Preview the latest completed turn without making any model call:

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --preview
```

The preview resolves the canonical Local/Sol/Terra roles from the session
manifest and prints a deterministic, SHA-256-bound comparison: outcome gaps,
first action divergence, turn and verification deltas, action-count deltas,
and reference-only/local-only read and edit coverage. These are observations,
not causal claims.

Then explicitly authorize teacher analysis:

```bash
./bin/run-dev.sh collaborate \
  .bantam/trios/<session-id> \
  --turn latest \
  --grades local=5/10,sol=9/10,terra=8/10 \
  --yes
```

Sol and Terra independently diagnose reusable harness gaps, propose adversarial
tests, and cross-review one another over the same redacted packet and exact
deterministic comparison. Accepted hypotheses retain their cited evidence and
the comparison hash and become build-only candidates:

```bash
./bin/run-dev.sh self-improve --plan
./bin/run-dev.sh self-improve --candidate <candidate-id> --no-apply
```

Teacher agreement is still only witness evidence. Promotion requires BANTAM's
private-lane build, immutable tests, paired held-out evidence, and normal
promotion gates.

For imported or older runs, the explicit three-artifact form remains available:

```bash
./bin/run-dev.sh collaborate \
  local-turn.json sol-turn.json terra-turn.json \
  --preview
```

## Trio versus gauntlet

| Use trio when… | Use gauntlet when… |
| --- | --- |
| You have a real project request | You want standardized hidden-contract fixtures |
| You want persistent follow-up lanes | You want fresh, independent fixture runs |
| You may apply one candidate | You want measurement without source application |
| You want live three-model collaboration | You want repeated/order-balanced evaluation |

Neither runs automatically. The operator explicitly starts both.

## Troubleshooting

### One arm is unavailable

Trio checks every selected model before starting the task and fails closed if
one is unavailable.

For Local:

```bash
./bin/run-dev.sh health --endpoint http://localhost:8085
```

Start the configured model server if necessary, then retry.

For Sol or Terra:

```bash
codex login status
codex login
```

### Apply says a verifier is required

Start the trio with `--verify "<command>"`, or provide it during apply:

```bash
./bin/run-dev.sh trio apply <session-directory> \
  --arm local \
  --verify "npm test" \
  --yes
```

### One arm fails

The other arm artifacts remain valid. Inspect the failed arm's saved artifact
for its terminal model failure, verification output, invalid actions, or
warnings. Do not infer that another passing arm is correct without reviewing
its actual diff.

### The output is noisy

Three agents produce interleaved output by design. Shell output is bounded per
arm. Use the final comparison, `summary.md`, or `report/index.html` for a stable
post-run view.

### Can trio modify tests?

Each agent is an ordinary BANTAM agent and can modify files allowed by the
request and normal workspace policy. State constraints explicitly in the task,
for example:

```text
Fix the implementation. Do not modify existing tests or package configuration.
```

The verifier and final-diff review remain authoritative.

## Command reference

```text
./bin/run-dev.sh trio run --task "..." [options]
./bin/run-dev.sh trio show <session-directory>
./bin/run-dev.sh trio apply <session-directory> --arm <local|sol|terra> --yes

:trio on [effort]
:trio status
:trio compare
:trio apply <local|sol|terra>
:trio reset
:trio off
```

For model authentication and runtime details, see
[Model runtimes, gauntlets, and self-improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md).
For the implementation and measured live proof, see
[Parallel Local/Sol/Terra Trio Mode](superpowers/reports/2026-07-25-parallel-trio-mode.md).
