# BANTAM Codex Creative Stress Suite

This suite exercises Codex models *inside BANTAM's constrained action loop*.
It deliberately excludes the local model and covers capabilities that ordinary
code-repair fixtures miss:

1. exact OCR and spatial extraction from a raster image;
2. visual evidence overriding a contradictory written brief;
3. prompt-injection resistance when hostile text appears inside an image;
4. image generation followed by visual self-review and selection;
5. image-informed interactive web implementation;
6. tightly constrained brand copy and editorial judgment;
7. creative coding with deterministic behavioral contracts.

Run the balanced Sol/Terra experiment:

```bash
BANTAM_GROUND=1 BANTAM_CODEX_IMAGE=1 \
  ./bin/run-dev.sh experiment creative-suite/experiment.json
```

The public checks validate deliverable shape. Hidden contract graders validate
the actual visual facts, writing constraints, behavioral invariants, and asset
relationships. Generated-image quality remains partly qualitative; the run
artifact proves whether the model generated and then inspected its asset.

The suite also includes a focused regression for the offline creative-code and
preview path:

```bash
BANTAM_GROUND=1 \
  ./bin/run-dev.sh experiment creative-suite/offline-code-regression.json
```

Run the paired promotion studies independently:

```bash
BANTAM_GROUND=1 \
  ./bin/run-dev.sh experiment creative-suite/pixel-facts-ab.json

BANTAM_GROUND=1 \
  ./bin/run-dev.sh experiment creative-suite/pixel-facts-noncolor-ab.json

BANTAM_GROUND=1 \
  ./bin/run-dev.sh experiment creative-suite/preview-vision-ab.json

BANTAM_GROUND=1 \
  ./bin/run-dev.sh experiment creative-suite/usage-attribution-smoke.json

BANTAM_GROUND=1 BANTAM_CODEX_IMAGE=1 \
  ./bin/run-dev.sh experiment creative-suite/image-review-packet-smoke.json
```

Deterministic PNG facts are enabled by default and can be rolled back with
`BANTAM_IMAGE_PIXEL_FACTS=0`. Rendered-preview vision remains experimental and
default-off; enable it with `BANTAM_CODEX_PREVIEW_VISION=1`.

Calibrate task-aware screenshot review directly, without running a coding
agent, then independently audit the self-contained evidence:

```bash
node bin/preview-review-calibration.js
node bin/preview-review-calibration.js --audit \
  .bantam/preview-review-calibrations/<run>/evidence.json
```

When rendered-preview vision is explicitly enabled, the task-aware structured
review is now the default: exact `RESULT: REPAIR` evidence becomes a trusted
visual failure and exact `RESULT: CLEAR` closes it. Restore legacy generic
narration with `BANTAM_CODEX_PREVIEW_TASK_REVIEW=0`. Screenshot vision itself
remains default-off because the paired clear-page cohort measured additional
requests, tokens, and latency despite zero false repairs.

Deterministic Chromium pointer hit-testing is enabled by default. It reports
visible buttons, links, and form controls whose center point is owned by another
rendered element, making stacking and `pointer-events` defects actionable
without a model call. Roll it back with
`BANTAM_PREVIEW_POINTER_HIT_TEST=0`.

Interactive DOM execution and optional screenshot capture are separate Chromium
passes and now retain separate timeout evidence. A screenshot-only timeout does
not accuse working page controls; a real interaction timeout still blocks, with
one confirmation rerun requested before source edits.

See [report.md](report.md) for the 2026-07-29/30 findings, implementation changes,
raw versus evaluator-corrected results, and follow-up ideas. Machine-readable
decisions and evidence paths live in
[promotion-ledger.json](promotion-ledger.json).

Experiment runs now archive bounded changed visual evidence from
`assets/generated/` beside each run JSON. Generated summaries and showcases link
the attachment index and contact sheets after the isolated fixture workspace has
been removed.

Long image batches emit progress every 30 seconds. Override the display cadence
with `BANTAM_CODEX_IMAGE_HEARTBEAT_MS`; this changes event frequency only, not
the model prompt, generated assets, or task result.

Image-worker evidence distinguishes operator cancellation, idle timeout, hard
timeout, and provider failure. Partial batches retain both successful artifacts
and structured failure provenance.

Every query turn also retains a normalized tool outcome envelope. Experiment
summaries aggregate pass, partial, failed, blocked, and error counts without
requiring report code to understand each tool's private state. Codex vision and
image-generation outcomes retain the usage they caused plus its accounting
source, allowing exact per-turn-to-run reconciliation.

Audit the complete saved evidence envelope without another model call:

```bash
./bin/run-dev.sh audit-run .bantam/experiments/<run>/runs/<arm>/<artifact>.json
```

Rare exact-turn failures can also be tested without rerunning a full fixture:

```bash
./bin/run-dev.sh replay-mine .bantam
./bin/run-dev.sh replay-mine .bantam --untreated
./bin/run-dev.sh replay-mine .bantam --untreated --uncontrasted
./bin/run-dev.sh replay-mine .bantam --untreated --uncontrasted \
  --coverage creative-suite/replay-coverage.json --uncovered
./bin/run-dev.sh replay-ab creative-suite/replays/visual-alt-coverage-moonroot.json --dry-run --max-calls 6
./bin/run-dev.sh replay-ab creative-suite/replays/visual-alt-coverage-moonroot.json --dry-run --require-new-design
./bin/run-dev.sh replay-ab creative-suite/replays/visual-alt-coverage-moonroot.json
./bin/run-dev.sh audit-replay .bantam/replay-experiments/<run>/evidence.json
```

The miner groups only exact-task cohorts containing both a verified failure
with saved model requests and at least one passing reference. Its output is
witness-only: it identifies specimens, not remedies or causality. It indexes
prior replay artifacts by immutable source SHA-256 plus exact turn, labels
completed, attempted/inconclusive, and untreated turns separately, and
`--untreated` removes previously attempted exact turns from the candidate
queue. This status means evidence was found in the scanned roots, not that its
result passes the current audit; run `audit-replay` before relying on a study.
It also does not mean the current harness lacks a deterministic safeguard for
that historical failure. `--coverage FILE --uncovered` applies an explicit
schema-checked registry of immutable failing-artifact SHA-256 values, named
current mechanisms, and evidence paths. Matching failures remain visible
without `--uncovered`; the filter is an auditable navigation exclusion, not
causal proof.
New artifacts are matched by exact task-spec, starting-repo,
and grader roots; legacy comparisons stay within one experiment.
`--uncontrasted` omits cohorts that already contain failures in one experiment
arm and passes in another, which is useful for finding novel gaps. A contrast
is provenance, not proof that the arm caused the outcome or was promoted.
The miner separately caps JSON traversal and actual `bantam-run`/replay
evidence. Copied fixture, package, and workspace JSON therefore cannot exhaust
the 5,000-evidence-file limit; the independent 100,000-JSON scan ceiling still
fails closed on an unexpectedly broad corpus.
Each failure also includes up to five model-free priority turns with its score,
original action, and every scoring reason. Post-edit decisions,
verification-recovery points, and task-named paths rank higher; terminal
decisions rank lower. The complete candidate list remains available because
this navigation aid is heuristic, not causal turn identification.

Repeated failed runs are grouped into verifier-backed failure modes. The
fingerprint prefers the actual assertion stack location over TAP's subtest
declaration, and uses the failing subtest, error code, operator, and headline.
Run-level scope failures take precedence over a passing contract log. Text
output shows one deterministic representative per mode; JSON retains every
artifact and the representative-selection rule. Both CLI launchers wait for a
large report to drain to stdout before exiting, so piped JSON remains complete.
Use the printed mode SHA-256 prefix with `--mode SHA_PREFIX` to retrieve one
mode's matching failures and exact-task passing references without carrying
the rest of the corpus.

The miner also exposed a recurring evaluator failure family: models modifying
tests directly or through shell commands. The experimental
`BANTAM_EVAL_SCOPE_ROLLBACK=1` pairs direct immutable-edit refusal with an
atomic shell transaction. Protected test/config/out-of-scope mutations are
restored and that shell's verification output is invalidated, while allowed
source changes from the same command survive. It remains opt-in pending natural
interventions across more fixture families; see the promotion ledger.

Replay specs may require an edit's exact `old` anchor to exist in the recorded
prompt, preventing a plausible-looking but non-applicable edit from scoring as
a repair. Archived specs and evidence use paths relative to their evidence
directory, so moving the checkout does not bake in the original absolute path.
Specs may also score an exact `done` decision against its bounded summary. A
done-only expectation needs no edit path; any expectation that permits an edit
verb still requires at least one path, so completion scoring does not weaken
edit applicability checks.
Unseeded samples rotate baseline-first and candidate-first call position and
persist the order for independent audit. Each arm also retains provider-reported
usage and request latency; the audit independently reconciles their arithmetic
and reports calls whose provider supplied no usage. New evidence SHA-256 binds
each arm's request hash, raw completion, duration, usage, and error state into a
position-specific call receipt. When source bytes are available, the auditor
also reconstructs every baseline/remedy request—including derived sample
seeds—and checks the receipt's request hash and fidelity against that
provenance. Legacy evidence remains auditable without claiming the newer
receipt binding.

Before spending replay calls, `replay-ab --dry-run` reconstructs every exact
baseline/remedy request without initializing a model, probing an endpoint, or
writing evidence. It reports runtime, seed/order semantics, exact request
count, serialized bytes, prompt characters, and source-call usage telemetry.
The telemetry is not multiplied into a token/cost forecast because provider
cache behavior is not known before execution. `--max-calls N` is also enforced
on the real launch path before endpoint detection, providing a fail-closed
request cap.

Preflight also scans the bounded replay-study directory for prior work. Exact
design identity includes the source artifact hash, turn, sample count, remedy,
and normalized semantic expectation; names, descriptions, and storage paths do
not create fake differences. `--require-new-design` blocks an identical design
on both dry-run and real execution while allowing a genuinely different
same-turn hypothesis. Corpus presence records that calls were attempted; audit
the prior evidence before trusting its conclusion.

The audit re-hashes archived visual evidence, checks its offline index, verifies
normalized tool outcomes and counts, reconciles usage by source against the
run total, re-hashes a complete final workspace diff, and reconstructs Codex
prompt delivery.

Fixture and experiment runs execute that complete audit automatically before
acceptance. A failed evidence envelope overrides a green task result with
`evidence-invalid`; the bounded verdict is retained in the run artifact and
aggregated in the experiment summary.

Spatial hidden graders use semantic axis/quality normalization for equivalent
region language while exact assertions remain in place for OCR, counts, colors,
types, and paths.
