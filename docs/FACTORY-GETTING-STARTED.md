# Factory: build, inspect, apply

This guide covers the implemented general coding cell. It builds a candidate
in a private workspace, runs a configured acceptance command, and records a
durable event history called a traveler. Updating your source is a separate
operation. The wider factory research does not change this command's scope.

## Choose the entry point

| Command | Behavior |
| --- | --- |
| `bantam` or `bin/bantamfactory` | Ordinary interactive agent; edits the selected workspace |
| `bantam run --factory --task "..."` | Ordinary run with additional factory telemetry |
| `bantam factory build "..." --verify "..."` | Build and inspect a private candidate |
| `bantam factory apply JOB --yes` | Apply a released candidate to its original source workspace |

`bin/bantamfactory` is a launcher for the same CLI. To select the isolated
workflow through that launcher, use `bin/bantamfactory factory build ...`.

## Prepare a project

Use Linux or WSL2 with Node 20+, Git, Docker, and the project's tools installed.
From the BANTAM checkout, run `npm ci` and `docker pull alpine:3` once, then
`node bin/bantam.js doctor` to check local setup. The general cell can use an
explicit llama.cpp endpoint or `--codex`; its options are listed by
`node bin/bantam.js factory --help`. The ordinary CLI's saved API picker is
not the factory build's provider-selection interface.

These examples assume your project has an `npm test` command. Replace the
project path, task, endpoint, and verification command for your project:

```bash
# Run this assignment from the BANTAM checkout.
BANTAM_DIR="$PWD"
cd /path/to/your/project
export BANTAM_FACTORY_HOME="$PWD/.bantam/factory"
```

Install the project's dependencies before starting the build. The factory
copies an existing real `node_modules` directory into its private workspace.
It does not provision arbitrary project environments. Snapshot selection honors
the workspace's inclusion rules; ignored build outputs and local credentials
are not a substitute for reproducible project inputs.

## Build a candidate

```bash
node "$BANTAM_DIR/bin/bantam.js" factory build \
  "Fix the failing parser test. Preserve the existing tests and package configuration." \
  --workspace . \
  --endpoint http://localhost:8085 --profile qwen \
  --focused-verify "npm test" --verify "npm test" \
  --max-turns 30 --job-id first-repair
```

`--focused-verify` supplies feedback to the implementation loop. `--verify` is
required and supplies the final acceptance command. `--verify-timeout` sets its
deadline in milliseconds (default 120000). The general cell's default budget
is 30 agent turns. Choose a new job ID for another attempt; existing job records
are not overwritten.

The command prints a job ID, status, baseline and candidate tree IDs, and the
manifest path. Exit code 0 means the candidate reached `released`; a contained,
blocked, or failed job is not ready to apply. The source remains unchanged by
the implementation work; factory records are written under the factory home.

`released` means the configured acceptance command passed at the recorded
candidate. It does not mean the change was applied or that all unstated
requirements are correct. Using `npm test` for both commands is convenient,
but it is one test suite used twice, not two independent proofs. For independent
acceptance, keep the acceptance criteria and their checks under the reviewer's
control and verify that the candidate did not weaken them. Asking the agent to
preserve tests is useful, but does not create an independently controlled judge.

A standalone acceptance script can live outside the candidate workspace:

```bash
--verify 'CANDIDATE_ROOT="$PWD" node /absolute/path/to/acceptance.cjs'
```

Use that option in the build command. The verifier mounts the exact existing
file named as a literal absolute operand read-only. It does not expose the
enclosing directory, neighboring files, or that file to ordinary model shell
commands. The script should locate the candidate through `CANDIDATE_ROOT` and
use built-in modules or explicitly supplied dependencies; adjacent script
dependencies are not mounted automatically.

## Inspect the work and its evidence

```bash
node "$BANTAM_DIR/bin/bantam.js" factory show first-repair
node "$BANTAM_DIR/bin/bantam.js" factory audit first-repair
node "$BANTAM_DIR/bin/bantam.js" factory report first-repair \
  --output .bantam/first-repair.html
```

These commands do not need a running model. `show` projects the traveler,
`audit` checks its event history, and `report` writes an HTML inspection report.
An intact event chain is evidence of record consistency, not proof that its
acceptance criteria are sufficient. The manifest at
`$BANTAM_FACTORY_HOME/jobs/first-repair/manifest.json` also records the final
inspection's command, outcome, and bounded output.

Inspect the actual code diff using the two tree IDs printed by the build:

```bash
git --git-dir "$BANTAM_FACTORY_HOME/workspace-store/store.git" \
  diff BASELINE_TREE CANDIDATE_TREE
```

Replace `BASELINE_TREE` and `CANDIDATE_TREE` with those IDs. For a live view,
`factory watch first-repair` prints activity and `factory floor first-repair`
serves a local viewer. `factory yard`, `dispatch`, and `schedule` project
recorded factory state; they do not authorize automatic work or release.

## Apply the reviewed candidate

```bash
node "$BANTAM_DIR/bin/bantam.js" factory apply first-repair --yes
```

This changes the original source workspace. Apply requires a released job and
checks that the source still matches the captured baseline. It re-verifies the
candidate, installs it transactionally, checks the installed tree, and verifies
a fresh materialization of that tree. A detected failure rolls the transaction
back. This is not an integration test of a running service or its external state.

If the source has changed since the build, apply refuses. Build a new candidate
from the current source and review it. A job that has already been applied
cannot be applied again.

## Execution boundary and limits

Model-chosen shell commands and final acceptance execution use Docker by
default. Final acceptance mounts the candidate read-only; checks must keep
temporary output in temporary directories. A timeout, infrastructure failure,
or attempted authored-file mutation is not a passing inspection. Read-only
files still contain executable code: the container boundary, not test naming,
provides isolation.

`BANTAM_SHELL_SANDBOX=host` explicitly selects host execution and gives executed
code your user's reach. It drops Docker isolation and its offline boundary.
Do not interpret a private working directory as a host security boundary.
Hosted model selection sends model inputs to that provider; a local endpoint
keeps those inference calls local. See [the operator guide](GUIDE.md#choosing-the-sandbox)
for shell configuration and platform constraints.

This workflow is a bounded implementation/inspection/apply path. It does not
claim autonomous scheduling, guaranteed semantic correctness, or automatic
promotion of experimental factory mechanisms. See [the factory model](FACTORY-MODEL.md)
for the design thesis and [supported setup and limits](LAUNCH-READINESS.md)
before choosing a deployment configuration.
