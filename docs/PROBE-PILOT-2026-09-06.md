# Fixture probe: construction and qualification, 2026-09-06

The [experimental probe](FIXTURE-PROBE.md) is connected to the real worker loop,
saved-run/checkpoint path, and optional factory traveler telemetry. It uses the
existing FactBus and FactDatalogBridge, not a parallel receipt controller. It
remains off by default; existing cache and verification defaults are unchanged.

## Construction attribution and unsuccessful local attempt

Astra supplied the runner, integration, bounded classifier contract, public
tests, and external acceptance. The classifier itself was first assigned to
the local 27B through the existing isolated factory coding cell. It received
the actual five substrate source files, six public tests, and a stub; eleven
independent acceptance groups remained outside its candidate workspace.

That original attempt **did not qualify**. At its eight-minute deadline it had
27 recorded turns and 34 model requests, with no accepted completion. The saved
candidate failed both public and independent acceptance; protected files were
unchanged. There was no hidden-test feedback, manual candidate repair, or second
local attempt during that construction run.

The main implementation mistakes were concrete:

- Telemetry fact operations lacked the required `op: 'assert'` field.
- The source registry pinned empty fact views before measurements were added.
- The bridge's typed constants were confused with raw Datalog terms; queries
  also double-encoded a literal.
- A fallback object was presented as a proof despite no supporting derivation.

The original candidate is preserved at source digest
`a6107c78887eaf740a84296795f54215f4124315643e631d7c7dfa778059eee5`.
The corrected classifier is explicitly **Astra-assisted**, not an unassisted
27B construction win. Acceptance cases consulted during repair are now
regressions, not fresh generalization evidence for the repaired implementation.

This build used a frozen harness at `a798d06f` and the direct factory/programmatic
agent path, with its rebuild trajectory default. It was not a comparison of
cache-fast against rebuild. Raw turns, observations, and factory events were
retained, but exact full transport envelopes were not captured by this wrapper;
they must not be reconstructed and described as original request evidence.

The factory's own cleanup also encountered an EACCES error in its persistent
scratch tree after saving its manifest. The captured candidate commit was
rematerialized from the existing WorkspaceStore for untouched grading. This
is a separate existing cleanup limitation, not a successful release. The new
probe's owned fixture cleanup and isolated `/tmp` handling have independent tests;
this change does not claim to fix every factory cleanup path.

### Context lesson, rather than a capability ceiling

Providing all the relevant source files did not yield correct API use in this
attempt. A practical next builder packet should include a small *executed*
FactBus-to-bridge example establishing transaction shape, snapshot timing, typed
literal handling, query decoding, and a real explanation. That is a hypothesis
for improving the builder's context, not an isolated causal result from this run.
Do not globally stuff another reminder into every task's prefix.

The runtime tool addresses a different boundary: it executes a worker-designed
setup/witness/check and prevents missing or failed evidence from being silently
reported as a successful experiment. It cannot prove the worker designed the
right semantic witness. Both boundaries matter.

## Verified implementation

The first implementation passed these checks before its live pilot:

- 77 focused tests, including the real-Docker containment test and seven actual
  agent-loop integration tests with scripted model responses.
- Full repository suite: **3,420 passed, zero failed, five skipped** out of 3,425;
  concurrency four, 120.8 seconds. The Docker-only probe test is separately
  exercised in the focused run.
- Documentation links and whitespace checks.

The agent-loop tests demonstrate delivery of a scoped counterexample to the
next prompt, subsequent source repair, preserved input identity/evidence across
save/resume, and independent final verification. A passing probe cannot clear
a previous failed project verifier or count fixture writes as source edits.

The updated live safety test exercises read-only selected inputs, persistent
fixture and `/tmp` files within one probe, fresh scratch between probes,
malicious scratch symlinks, and parent-workspace preservation.
Limits remain explicit: no per-fixture disk quota or independent daemon-side
watchdog after an abrupt host crash/kill.

## Live matched pilot

The [pilot kit](../examples/fights/probe-git-name-status/README.md) asks for a
small Git name-status parser useful for selecting changed files for context.
It requires a real Git rename witness with unusual filename characters, not
merely a synthetic parser example. Git's documented distinction between
machine-readable NUL output and human-readable quoting informs the fixture.
See [Git's diff-format reference](https://git-scm.com/docs/diff-format).

The preregistered order is baseline then probe, one local-27B run each, identical
task/material/model/settings, extension trajectory with immutable history,
thirty-turn/eight-minute limits, offline Docker, and no cloud teacher. The task
explicitly requests the probe when available: this measures instructed adoption,
not spontaneous discovery. Saved prompts and factory telemetry are enabled in
both conditions. Runtime source and kit hashes are frozen before the pair.

Independent acceptance is outside the candidate and executes read-only. Before
the pilot, its gauge passed a reviewer oracle and rejected five deliberately
broken implementations. Neither condition receives hidden-test feedback or
manual candidate edits. All attempts are retained. One ordered pair cannot
establish a general capability/token/latency improvement or justify a default
change.

### First pair: correct product, worse experiment tool

| Metric | Baseline | Probe v1 |
| --- | ---: | ---: |
| Independent product acceptance | Pass | Pass |
| Worker turns / requests | 12 / 19 | 17 / 30 |
| Input tokens | 167,215 | 355,328 |
| Cached input tokens | 138,141 | 287,043 |
| Fresh input tokens | 29,074 | 68,285 |
| Output tokens | 11,560 | 19,034 |
| Wall time | 146.9 s | 300.2 s |
| Probe calls with completed witness/check | N/A | 0 of 6 |

Both final parsers passed, but v1 was **not an improvement** in this pair. The
worker called it six times, obtained only unresolved outcomes, then built and
verified the parser using ordinary shell. The original manifest's
`instrumentAdoptionDemonstrated` means invoked-with-receipt, not useful completed
evidence. The corrected pilot additionally records `instrumentCompleted` and
`completedProbeDemonstrated`; invocation alone is not a benefit claim.

The first failed setup referred to a nonexistent `HEAD~1`. More importantly,
later setups really produced `R100` output but saved it to `/tmp/out.bin`.
The next container had a fresh `/tmp`, so the witness could not read that file.
The action menu said files persisted between stages without making that
exception explicit. The worker misdiagnosed subsequent witness failures as a
Git/rename issue. This was a defect in the experiment's physical/context contract,
not evidence that the model could not make Git produce a rename.

### Corrective replay and sandbox v2

The corrected tool mounts controller-owned persistent scratch at `/tmp` for all
stages of one experiment, and a new experiment gets empty scratch. Its backing
directory is outside the writable fixture, so a `.bantam/scratch` symlink cannot
redirect the mount. The fixture is mounted at the fixed container alias `/probe`
to avoid nested root-owned mountpoints under the persistent `/tmp` bind. Both
the model-facing action menu and the observation describe this lifetime.

The exact saved v1 action at turn index 5 was replayed, with identical spec and
selected-input digests and no model intervention. It changed from
`unresolved: witness_unobserved` to `assertion_passed`, with three exit-zero
stages and the real tab-containing Git destination intact. That is a narrow
mechanical counterfactual for the scratch-lifetime bug, not a general benchmark
win. It probes Git framing, not an imported candidate parser.

A fresh matched pair with unchanged task/material/acceptance is used to check
the corrected tool. It is development validation on an already examined task,
not new heldout generalization evidence. No previous candidate solution or
hidden-test feedback is supplied to either new worker run.

The corrected version's full suite passes **3,422 tests, zero failures, four
skips out of 3,426**, at concurrency four in 128.0 seconds. Unlike the v1 full
run, this includes the opt-in real-Docker check. The additional regression
rejects host-mode, symlinked, or overlapping explicit scratch mappings.

Audit of the original live run confirms all six probe receipts reached the
following saved prompt and all six were retained through factory traveler
telemetry. Persistence and Datalog delivery therefore worked; the missing
cross-stage file was the defect. Neither the passing final parser nor those
six durable unresolved receipts should be described as a probe efficiency win.

### Corrected pair: usable instrument, mixed efficiency

| Metric | Fresh baseline | Probe v2 |
| --- | ---: | ---: |
| Independent product acceptance | Pass | Pass |
| Worker turns / requests | 12 / 19 | 13 / 21 |
| Input tokens | 157,976 | 203,196 |
| Cached input tokens | 121,039 | 157,284 |
| Fresh input tokens | 36,937 | 45,912 |
| Output tokens | 11,436 | 8,036 |
| Wall time | 156.1 s | 122.5 s |
| Probe calls | N/A | 4 |
| Final source-bound probe | N/A | Pass |

The corrected worker first made a literal backslash-t filename; setup's explicit
assertion caught that mismatch. After repairing the fixture, two check processes
failed because the candidate module was not present at the imported path. The
worker added the selected input and then corrected the import to
`./subject/changed-paths.js`. Its final check imported the copied candidate and
asserted the real Git record's status, original path, and tab-containing
destination. All four probe receipts reached the next prompt and the factory
traveler, while ordinary verification receipts remained null on those turns.

Those two missing-import outcomes are **check-process failures, not evidence of
a parser bug**. `assertion_failed` is scoped to the declared check's nonzero
exit; the operator/worker must inspect why it failed. The implementation cannot
infer semantic counterexamples from exit codes alone.

Both final products passed independent acceptance. Source and kit seal
mismatches were empty. In this single corrected pair, tool-enabled wall time was
21.6% lower and output tokens were 29.7% lower, but fresh input tokens were
24.3% higher, with two more requests and one more turn. This supports **usable
integration**, not an overall token-efficiency win or a general speedup. The
explicit copied-input/import convention remains an ergonomic cost worth testing
in a future bounded change. The probe stays opt-in; no defaults were promoted.

## Local evidence

Raw records remain in the ignored private `.bantam/acceptance/2026-09-06/` tree:

- `probe-evidence-27b-144843/`: frozen original builder materials and harness,
  original raw run, factory traveler, recovered candidate, independent grading.
- `probe-verification-v1/`: focused and complete-suite logs/results, corrected
  source hashes, and explicit assisted-build attribution.
- `probe-pilot-v1/`: matched-plan manifest, source/material hashes, saved runs,
  prompts, factory telemetry, acceptance output, and measured usage.
- `probe-verification-v2/`: exact failed-action replay and corrected-sandbox
  regression evidence.
- `probe-pilot-v2/`: fresh corrected-tool pair, using the unchanged task and
  acceptance kit; development validation, not fresh generalization evidence.

The evaluation setup follows the separation of builder and evaluator described
in [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
No model's own completion claim substitutes for deterministic acceptance.
