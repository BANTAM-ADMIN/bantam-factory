# Fixture-backed probe (experimental)

`BANTAM_PROBE=1 bantamfactory` adds a scoped experiment action to the normal
worker loop. It is **off by default**. The programmatic option is
`runAgent({ probeEnabled: true, ... })`; `Executor` independently enforces the
same opt-in boundary. Ordinary shell, cache mode, and final verification defaults
do not change.

The tool turns one uncertain assumption into three ordered processes:

1. `setup` constructs a fresh case.
2. `witness` asserts that the intended case actually exists.
3. `check` asserts the candidate's behavior on that case.

A failed setup skips both later stages. A failed witness skips the behavior
check. Timeout, cancellation, process error, signal termination, output overflow,
or changed selected source makes the result unresolved. A clean nonzero check
is a scoped check failure, not necessarily a candidate bug: a missing import can
also produce it. Inspect the output before interpreting it as a semantic
counterexample. Three clean passing stages produce a scoped assertion pass.
Docker launcher exit codes 125–127 are infrastructure
outcomes, not behavioral counterexamples.

## Model-facing action

```json
{
  "a": "probe",
  "question": "Does the copied parser accept this witnessed record?",
  "inputs": [{"p": "parser.mjs"}],
  "setup": "printf 'fixture data\\n' > case.txt",
  "witness": "test -s case.txt",
  "check": "node subject/parser.mjs < case.txt"
}
```

This is an interface example, not a sufficient semantic gauge: the worker must
design a witness for the actual uncertainty and a check that fails when the
claimed behavior is wrong. Printing `case_observed=true` is not itself such an
assertion. A witness that merely checks file existence cannot establish that
Git emitted a rename record. A check must exercise the copied candidate, not a
retyped surrogate implementation.

Each invocation gets a private temporary root. Explicitly selected files appear
under read-only `subject/`, preserving their relative paths and permission bits.
All commands start in `/probe`, the temporary root's container alias. Fixture
files **and `/tmp` files persist across stages of that experiment**; shell
variables, working-directory changes, and processes do not. A new probe starts
with empty scratch. Include package metadata
or supporting modules explicitly when the candidate needs them.

The action accepts zero to sixteen regular, non-symlink input files, at most
2 MiB total. It always uses the existing offline Docker executor—even if the
ordinary shell was explicitly configured for host execution. Each stage has a
15-second deadline and a 64-KiB captured-output ceiling. It inherits existing
Docker process/memory ceilings. The host-backed fixture has **no separate disk
quota**; this is not a claim of arbitrary hostile-workload resource containment.
Deadlines and container cleanup are managed by the running harness. An abrupt
host kill/crash can bypass that cleanup; this version does not add a separate
daemon-side watchdog. Normal abort, timeout, and output-limit paths are tested.

Only the invocation's owned temporary tree is removed afterward. Neither the
live candidate workspace nor the authoritative receipt is mounted writable to
the experiment. The controller owns the scratch directory outside the writable
fixture and mounts it directly, so a fixture-created `.bantam/scratch` symlink
cannot redirect it. Byte and permission identities are checked again against the
selected live inputs afterward; concurrent user edits are never rolled back.
The identity covers selected inputs, not every file in the project, and remains
historical evidence after later edits—not a continuously current assertion.

## Existing factory machinery, now connected to the action loop

The evidence projector uses the existing `FactBus` and `FactDatalogBridge`:
model-designed question metadata belongs to the observation lane; captured
process measurements belong to telemetry. Fixed controller rules derive the
scoped conclusion and retain proof leaves with source datoms. No model-designed
probe is admitted into the accepted-fact lane or the project claim ledger.

That projection drives the worker's actual observation. The conclusion and
stage summary come before bounded, explicitly untrusted output excerpts. Full
captured commands, outputs, input identities, and proof are retained in the
turn's separate `probeEvidence` field, including saved runs and checkpoints.
Resume preserves that evidence without upgrading it to fresh verification.

`shellExecution` and `verificationEvidence` remain explicitly null on probe
turns. A passing probe cannot erase a failed suite or satisfy task completion.
An ordinary project verifier is still required.

Factory coding-cell runs already record agent events. In ordinary CLI runs,
`--factory` / `BANTAM_FACTORY=1` additionally persists the dedicated probe event
through existing `FactoryRunTelemetry`, content-addressed evidence storage, and
traveler telemetry. The launcher alone does not imply traveler recording.
This integration does not introduce a parallel journal, authority ladder,
semantic DSL, or completion controller.

## Qualification

`test/probe-evidence.test.js` checks the proof projector.
`test/probe.test.js` independently checks execution, isolation, freshness,
ordering, interruption, and misleading-output negative controls.
`test/probe-integration.test.js` exercises a real agent loop, persistence,
investigation budgets, and the boundary with final verification.

An additional real-container isolation check is opt-in:

```sh
BANTAM_PROBE_DOCKER_TEST=1 node --test test/probe.test.js
```

The [changed-path pilot](../examples/fights/probe-git-name-status/README.md)
uses the existing fight launcher and metrics. It freezes source/task/material,
keeps independent acceptance outside the candidate, records both conditions,
and does not give hidden-test feedback back to the worker. Its grader is itself
checked against a reviewer oracle and five deliberately broken implementations.
One ordered pair can demonstrate instructed use and identify integration
failures; it cannot establish a general improvement or justify changing defaults.

The [machinery program](FACTORY-MACHINERY-PROGRAM.md) describes the broader
build → independent audit → real consumer → measured qualification approach.
The [dated construction and pilot report](PROBE-PILOT-2026-09-06.md) separates
the unsuccessful local builder attempt, assisted implementation, and adoption
evidence.
