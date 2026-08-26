# BANTAM Codex Creative and Multimodal Evaluation

Date: 2026-07-29

## Outcome

BANTAM now supports a complete Codex-only creative loop: inspect supplied
images, extract exact raster facts, generate image variants, inspect and compare
those variants, write constrained copy, build image-informed web experiences,
render them in Chromium, and let Codex inspect the resulting screenshot.

The main matrix ran 14 isolated tasks: seven fixtures through Terra/medium and
the same seven through Sol/high. The experiment originally scored Terra 5/7 and
Sol 6/7. Inspection of every failed artifact found no task failure:

| Apparent failure | Evidence | Correction |
| --- | --- | --- |
| Terra visual brief | Correct counts, corrections, copy, and an unobstructed upper-middle placement | Accept more than one visually valid open-sky phrase |
| Terra image critique | Two real PNGs generated and inspected; selection contained stronger-than-required evidence | Accept string or array summaries for an unspecified field |
| Sol image critique | Same evaluator schema issue | Same correction |

With those evaluator defects corrected, the preserved task outputs satisfy
14/14 contracts. This is a post-hoc corrected score, not a rewritten raw
experiment result; the original manifest remains immutable evidence.

A focused follow-up then reran the newly strengthened offline creative-code
contract. Terra and Sol both passed, including interactive preview: 2/2.

No local-model completion was used. The launcher printed the configured local
endpoint health banner, but every experiment arm and every visual sidecar call
used authenticated Codex.

## Coverage

The reusable suite in this directory covers:

1. OCR, object counting, spatial extraction, and exact palette recovery;
2. image evidence overriding a stale written brief;
3. visual prompt-injection resistance;
4. two-variant image generation, visual self-critique, and selection;
5. source-image-informed responsive web design;
6. highly constrained product copy and editorial judgment;
7. deterministic creative coding, accessibility, keyboard behavior, export,
   reduced motion, offline operation, and rendered preview.

All fixture repositories begin with failing public tests. Hidden graders inspect
facts and behavior the task model cannot read.

## Measured Terra/Sol behavior

Raw v2 totals:

| Model | Raw pass | Corrected pass | Turns | Accounted requests | Input tokens | Output tokens | Reasoning tokens | Task time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Terra medium | 5/7 | 7/7 | 47 | 55 | 1,055,811 | 16,695 | 2,696 | 622.155 s |
| Sol high | 6/7 | 7/7 | 48 | 56 | 1,219,266 | 27,337 | 5,846 | 944.307 s |

The request totals include eight Codex sidecar operations per arm: supplied-image
vision, two image-generation workers, generated-image inspection, and web-image
vision. That traffic was previously invisible in experiment totals.

Terra was the better default for this suite. It reached the same corrected
quality in about 34% less time than Sol, with about 13% fewer input tokens and
39% fewer output tokens. Sol produced more elaborate web and creative-code
surfaces and asked more targeted visual questions, but that additional
deliberation did not improve corrected contract reliability on this sample.

Practical routing recommendation:

- use Terra/medium for ordinary visual extraction, copy, and bounded creative
  implementation;
- escalate to Sol/high for unusually ambiguous editorial judgment, higher-risk
  review, or when greater implementation elaboration is worth roughly 1.5×
  elapsed time.

## Improvements implemented from observed failures

### Codex vision broker

`view_image` now attaches only a BANTAM-validated workspace image to an isolated
Codex app-server turn. The agent receives textual evidence; Codex does not gain
an independent workspace tool surface.

### Deterministic PNG evidence

BANTAM now decodes ordinary RGB/RGBA PNG scanlines itself and appends dimensions
plus frequent exact pixel colors to semantic vision results. This removed the
unreasonable expectation that a vision model estimate exact hex values.

### Reliable image generation

Image workers now have generation-sized hard and idle deadlines, configurable
with `BANTAM_CODEX_IMAGE_TIMEOUT_MS` and
`BANTAM_CODEX_IMAGE_IDLE_TIMEOUT_MS`. The old two-minute idle timeout failed
both workers just before valid images arrived. Live v2 batches completed 2/2 in
2.6 minutes for Terra and 2/2 in 1.3 minutes for Sol.

If every image worker fails, the query now emits a terminal infrastructure block
instead of forcing the model through repeated completion gates after it has
truthfully reported that no asset exists.

### Complete usage accounting

Vision, preview vision, and image-generation calls now feed their Codex usage
into the owning `ModelClient`. Experiment request and token totals therefore
include work performed by model-backed tools, not only action-generation turns.

### Experimental Codex eyes for rendered previews

Codex task models can now inspect Chromium screenshots through an isolated
visual turn. A live Terra probe accurately described the existing BANTAM model
gauntlet page and accounted 11,526 input tokens, 375 output tokens, and 28
reasoning tokens. The feature is gated behind
`BANTAM_CODEX_PREVIEW_VISION=1` and remains default-off pending evidence that
the task model actually uses the visual feedback to improve its output.

### Honest offline preview

Preview now scans local stylesheets for remote imports and URLs. With browser
networking disabled, a page that depends on a remote font is reported as
`offline-external-dependency` even when Chromium does not surface a load error.

### Better evaluator design

The suite now states required JSON types and normalization rules, accepts
semantically equivalent valid visual placements, forbids hidden CDN dependency
in web fixtures, and tests promised behavior rather than one incidental spelling
such as `Escape` versus `Esc`.

## Controlled promotion studies

The implementation features above were separated into narrow treatments and
compared against identical Terra/medium controls. Raw artifacts remain
unchanged; evaluator corrections are reported separately.

### Deterministic PNG facts: promoted, default-on

On three rounds of the exact-color OCR fixture, semantic vision alone passed
0/3 and guessed a different near-miss palette each time. Adding deterministic
PNG dimensions and color counts passed 3/3 with the exact
`#37d6c0` / `#ed4e87` pair.

| Arm | Strict | Turns | Requests | Input | Output | Reasoning | Task time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Semantic vision | 0/3 | 17 | 22 | 330,762 | 5,134 | 1,785 | 153.886 s |
| + pixel facts | 3/3 | 13 | 16 | 233,940 | 3,139 | 435 | 109.612 s |

The treatment improved correctness by 100 percentage points while using four
fewer turns, six fewer requests, 96,822 fewer input tokens, and 44.274 fewer
seconds.

The two-round non-target cohort covered contradictory briefs and hostile text
inside images. Its immutable raw score was control 4/4 versus treatment 2/4.
Both treatment failures rejected only the phrase `central sky`; the model had
all counts, locations, corrections, copy constraints, and injection handling
right. Direct inspection of the 1536×1024 source confirmed that the
central/lower-central sky is the largest open region. After correcting that
over-constrained semantic matcher, the result is 4/4 versus 4/4. This is an
evaluator-corrected regression result, not a rewritten raw score.

Decision: keep deterministic PNG facts default-on. Operators retain an
immediate rollback with `BANTAM_IMAGE_PIXEL_FACTS=0`.

### Rendered-preview vision: experimental, default-off

The first 4+4 pilot was invalid: interactive preview did not activate screenshot
capture, so both arms effectively received the control. BANTAM now explicitly
captures an initial-state screenshot after a successful interactive DOM pass
when the treatment is enabled.

The valid rerun delivered screenshot observations in all four treatment runs:

| Arm | Strict | Turns | Requests | Input | Output | Reasoning | Task time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DOM preview | 3/4 | 43 | 45 | 1,194,761 | 16,626 | 1,674 | 419.250 s |
| + screenshot vision | 4/4 | 36 | 42 | 910,746 | 16,639 | 1,356 | 422.561 s |

The apparent pass gain is not evidence of causality. The sole control failure
was a missing source-level `aria-pressed` attribute that a screenshot cannot
observe. More importantly, screenshot feedback identified concrete rendered
problems—blurred headline shadow, very low caption contrast, and a blank beige
band—but the task model immediately finished without repairing them.

Decision: retain the capability behind `BANTAM_CODEX_PREVIEW_VISION=1`; do not
pay its extra visual call by default until a fresh treatment causes verified
rendered fixes.

### Failure-path reliability: promoted

Injected tests now cover default and configurable generation deadlines, total
image-worker failure, one-of-two partial success, exact external usage totals,
the pixel-facts rollback gate, and the preview-vision promotion gate. Total
worker failure produces a terminal infrastructure block; partial success
remains usable and is not mislabeled terminal.

### Source-attributed usage: promoted

Aggregate accounting is now decomposed into canonical sources without changing
the legacy totals: `action_generation`, `supplied_image_vision`,
`generated_image_review`, `image_generation`, and `preview_vision`. Every run
artifact retains the per-source map, experiment manifests aggregate it, and
Markdown summaries render it as a separate table.

A fresh Terra/medium OCR run passed strictly in four turns. Its five accounted
requests reconciled exactly as four action-generation requests plus one
supplied-image-vision request:

| Source | Requests | Input | Output | Reasoning |
| --- | ---: | ---: | ---: | ---: |
| Action generation | 4 | 61,184 | 697 | 136 |
| Supplied-image vision | 1 | 11,440 | 461 | 14 |
| **Reconciled total** | **5** | **72,624** | **1,158** | **150** |

Unit coverage additionally requires every numeric breakdown field to sum to its
legacy cumulative total and verifies that reset clears both representations.

### Generated-image review packets: promoted

Every successful `generate_image` batch now writes two additional local
artifacts under `assets/generated/`:

- a JSON manifest containing the original prompt, model, effort, elapsed time,
  completion count, failure list, worker-revised prompts, dimensions, byte
  counts, and SHA-256 for every variant;
- an offline responsive HTML contact sheet showing all variants beside that
  provenance.

These artifacts require no additional model request. Their paths are returned
to the task model and included in the tool's structured artifact list.
Deterministic coverage rendered a packet in Chromium with no page, resource, or
promise-rejection errors.

A live Terra/medium self-critique then generated exactly two images, inspected
both, passed its public and hidden contracts, and preserved this packet in the
run diff:

| Variant | Dimensions | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| 1 | 1727×911 | 1,775,731 | `05747cdde0c68826a1062dcd37ff8d613dfef5361b82641f8a17305e340fd3b7` |
| 2 | 1536×1024 | 1,768,623 | `ba407a1ac3b97b435e23ad7eff3d0b95f9bcc01d64507b62b2ec51d4d584c1e6` |

That run also proved all three new attribution categories together: seven
action-generation calls, two image-generation calls, and two
generated-image-review calls.

### Generated evidence archival: promoted

Isolated fixture workspaces are deleted after grading. BANTAM now archives
changed files from the managed `assets/generated/` subtree beside the run JSON
before cleanup, so historical images and contact sheets remain directly usable.
Each run records a content-addressed attachment index, and experiment summaries
and showcases link both the index and every archived contact sheet.

The default policy is deliberately bounded: 32 files, 16 MiB per file, 64 MiB
per run, and only PNG, JPEG, WebP, GIF, HTML, and JSON. The copier opens regular
files without following symlinks, ignores unchanged baseline files, rejects
absolute/traversing metadata paths, and reuses the recorded SHA-256 as the
evidence identity. Archival errors are recorded but cannot turn a correct task
into a false task failure.

A model-free end-to-end fixture created JSON and HTML evidence, verified the
workspace, saved a real run artifact, deleted the workspace, then read the JSON
and rendered the archived HTML successfully in Chromium. Additional injected
cases proved symlink, extension, per-file, aggregate-size, file-count, malformed
hash, absolute-path, and traversal rejection.

### Image-generation progress heartbeats: promoted

The live two-variant review-packet run spent 133.786 seconds inside concurrent
image workers with no intermediate output. Image generation now emits an
event-only heartbeat every 30 seconds containing elapsed time, completed worker
count, requested variants, and the learned estimate when available. Experiment
output prints each heartbeat; interactive sessions use it to update their
existing activity display.

The heartbeat never enters the model observation, makes no additional model
request, and cannot change the task result. The interval is configurable with
`BANTAM_CODEX_IMAGE_HEARTBEAT_MS`. Injected delayed-worker coverage observed
multiple heartbeats, reconciled their count with the tool outcome, and verified
that the timer emitted nothing after all workers settled.

### Image cancellation and timeout provenance: promoted

The agent's cancellation signal now reaches the image tool, every concurrent
worker, and the Codex app-server transport. Worker failures retain a structured
kind rather than collapsing into an undifferentiated error string:

| Kind | Meaning |
| --- | --- |
| `operator_cancelled` | The active run was deliberately interrupted |
| `idle_timeout` | The Codex turn stopped making progress |
| `hard_timeout` | The generation exceeded its absolute deadline |
| `provider_failure` | A different worker/provider error occurred |

These records survive in partial and terminal tool outcomes, completion events,
and review manifests. Tests cover cancellation at the real transport boundary,
both timeout kinds, ordinary provider failure, and partial success. This makes
reliability analysis honest: operator intent is no longer counted as provider
instability.

### Normalized tool outcomes: promoted

Every routed query now crosses a registry-owned schema rather than requiring
the agent to understand tool-specific `lastOutcome` or `lastResult` shapes.
Version 1 standardizes `pass`, `partial`, `failed`, `blocked`, and `error`, plus
terminal/retryable state, artifacts, failures, infrastructure blocks, usage,
trusted proof, and tool-specific details.

The registry adapts legacy tools, catches both synchronous and asynchronous
tool errors, rejects malformed outcome statuses, removes duplicate artifact
paths, and preserves terminal-block behavior. Normalized envelopes are saved on
their exact turns; per-status counts are aggregated into manifests and rendered
in experiment summaries.

A fresh Terra/medium OCR run passed strictly after the boundary change. Its
`view_image` turn retained one normalized `pass` envelope in the run JSON, the
manifest aggregated `pass: 1`, and the generated summary rendered the same
count. Synthetic lifecycle coverage separately proves partial results, preview
failures, async rejection, malformed legacy state, and terminal agent stopping.

### Semantic visual-region grading: promoted

Visual placement graders now tokenize explicit horizontal axes, vertical axes,
openness, and surfaces instead of depending on increasingly broad regular
expressions. Each fixture declares its own semantic policy; the normalizer does
not decide globally that every center or right placement is valid.

For the Moonroot image, the policy accepts central or center-bearing regions and
open right-side space while rejecting upper-right placement occupied by the moon
and lower-left placement occupied by the greenhouse and gardener. Seven valid
paraphrases pass, including `central sky`, `upper-center-left sky`, and
`mid-right open sky`; five nearby invalid placements fail. Word boundaries also
prevent strings such as `copyright` from being misread as `right`.

The archived `central sky` campaign and the fresh `right of the title` OCR
deliverable both pass their real hidden graders after migration. This promotes
the evaluator, not a model: it makes measured outcomes more faithful without
changing task prompts or model behavior.

### Independent complete-run audit: promoted

`audit-run` now provides one read-only, model-free trust boundary over a saved
run. It validates artifact identity; normalized tool envelopes and their
aggregate counts; all nine aggregate usage fields against the sum of
source-attributed usage; archived attachment paths, regular-file status, byte
counts, SHA-256 hashes, and offline indexes; and exact Codex prompt delivery.
Complete final workspace diffs also have their bytes, SHA-256, file list, and
file count recomputed. It never imports task workspace code.

A fresh Terra/medium OCR run passed strictly and then passed every applicable
audit with no warnings. Five real requests reconciled across
`action_generation` and `supplied_image_vision`: 71,075 input tokens, 998 output
tokens, 41,216 cache-hit tokens, 29,859 cache-miss tokens, 242 reasoning tokens,
and five Codex requests. One `view_image` outcome reconciled with the aggregate,
and all four action-generation prompt deliveries reconstructed exactly.

Negative controls modify controlled copies or archived bytes and prove failure
on tampering, deletion, symlinks, traversal, index disagreement, usage
misaccounting, malformed tool status, aggregate tool-count disagreement, and
final-diff hash disagreement or unreadable JSON. The full regression suite
passes 36/36. Older artifacts do not
receive invented guarantees: absent newer evidence is reported as
`not-applicable` with a warning, while present inconsistent evidence fails.

### Causal tool-usage linkage: promoted

The source-attribution smoke revealed a narrower evidence gap: the run correctly
recorded one `supplied_image_vision` request, but the exact `view_image` turn
stored `usage: null`. Codex visual inspection now retains normalized usage and
its source on the tool outcome itself. Multi-variant image generation similarly
aggregates successful worker usage into its exact outcome. Invalid image
arguments, missing paths, empty responses, and provider errors also stop being
misclassified as implicit passes.

The identical Terra/medium OCR fixture provides a direct before/after:

| Measure | Before | After |
| --- | ---: | ---: |
| Strict passes | 1/1 | 1/1 |
| Turns | 4 | 4 |
| Requests | 5 | 5 |
| Invalid / protocol | 0 / 0 | 0 / 0 |
| Task time | 44.745 s | 36.045 s |
| Tool usage linkage | `null` | exact `supplied_image_vision` record |

The after-run tool record equals the run's source record across requests, input,
output, total, cache hit/miss, reasoning, cost, and Codex-request count. The
complete-run auditor now enforces that equality and an injected one-token
disagreement fails. This is an evidence-only promotion: it changes neither the
model observation nor the prompt.

### Task-scoped accounting for ad-hoc artifacts: promoted

Usage reconciliation no longer stops at experiment fixtures. Fresh
`run --save-run` and fresh lane artifacts snapshot a reusable model client's
cumulative totals and per-source totals at task start, then persist only the
task delta. A live one-turn Terra/low saved run reconciled one request, 12,092
input tokens, 82 output tokens, 13 reasoning tokens, and one exact Codex prompt.

Restored run/lane prefixes deliberately do not receive a misleading aggregate:
their historical usage predates the current process snapshot. Those artifacts
remain `not-applicable` for aggregate reconciliation until prefix-scoped usage
can be reconstructed. Unit coverage proves aggregate/source delta isolation and
safe zero-shaped fallback when a model cannot expose accounting.

### Complete-run integrity gate: promoted

The complete audit is now load-bearing for every fixture and experiment run.
After BANTAM assembles model calls, normalized tool outcomes, task-scoped usage,
final diff, and archived attachments, it runs the independent audit before
accepting the artifact. A compact check/failure/warning verdict persists in the
run JSON and experiment summaries aggregate pass/failure counts.

A model-free lifecycle fixture proves the green path, including archived JSON
and HTML evidence that remains readable after workspace cleanup. A controlled
injected audit failure proves the red path: the task verifier passes, but the
row becomes `evidence-invalid`, `artifact.result.pass` becomes false, and the
specific audit failure survives in the artifact. The gate changes no model
observation or prompt.

### Task-aware rendered review: still experimental

The first exact-turn follow-up replayed a saved Moonroot decision where generic
screenshot narration reported three visual defects and Terra immediately
finished. Across four counterbalanced samples, the baseline repeated `done`
4/4 while the task-aware corrective treatment chose the same focused
`read_file styles.css` investigation 4/4. Because a one-turn replay cannot
execute that read and observe a later repair, the strict edit expectation
correctly reported no lift. The replay evidence independently audited cleanly.

A subsequent 2+2 full-task Terra screen compared generic narration with a
task-aware visible-contract review. Both arms passed strictly 2/2. The
task-aware arm used 33 versus 32 turns, 40 versus 38 requests, and 342.786
versus 339.965 task seconds. One task-aware run produced a real screenshot-led
repair: after the reviewer reported that required Night/Dawn controls were not
visible, Terra relocated them, reran tests, and obtained a clear interactive
preview. The other task-aware run was correctly reported clear and required no
revision.

This establishes review engagement and one concrete rendered repair, but not
correctness lift. `BANTAM_CODEX_PREVIEW_TASK_REVIEW=1` therefore remains
experimental and requires `BANTAM_CODEX_PREVIEW_VISION=1`.

#### Direct classifier calibration

A six-case deterministic Chromium corpus now tests the reviewer independently
of agent implementation variance: missing required controls, a clipped exact
headline, an occluded exact CTA, an unreadable required caption, intentional
whitespace that must remain clear, and a source-only `aria-pressed` contract
that pixels must not pretend to prove.

Terra medium and Sol high each scored 6/6 in the pilot and repeated 6/6 in the
final self-contained run: 24/24 total judgments, 16 true positives, 8 true
negatives, zero false positives, zero false negatives, and zero invalid
outputs. The final evidence archives and hashes its manifest, reconstructs
every task-aware prompt hash, verifies screenshot bytes, recomputes verdicts
and scores, rejects incomplete matrices, and independently audits cleanly.

```bash
node bin/preview-review-calibration.js
node bin/preview-review-calibration.js --audit \
  .bantam/preview-review-calibrations/<run>/evidence.json
```

#### Planted full-agent occlusion study

The calibrated reviewer earned a six-run Terra experiment on controls that
remained present in DOM text and geometry but were covered by a stacking layer.
The grader was calibrated in both directions: the untouched fixture fails
because the center of `Night` resolves to `MAIN.hero`; direct removal of the
planted layer passes.

| Arm | Strict | Turns | Requests | Task time |
| --- | ---: | ---: | ---: | ---: |
| DOM preview | 1/2 | 10 | 10 | 53.961 s |
| Generic screenshot | 2/2 | 15 | 18 | 96.497 s |
| Task-aware screenshot | 2/2 | 11 | 13 | 71.063 s |

The DOM failure raised only the child control's z-index, which could not escape
its parent's lower stacking context. DOM preview reported green and the hidden
hit-test grader caught the still-obscured control. In one generic-vision run,
the first screenshot showed an empty top-right pill; Terra then raised the
parent header and the next screenshot showed Night/Dawn. This is a concrete
screenshot-caused repair.

Both task-aware trajectories selected a correct source repair before their
first preview, which returned `RESULT: CLEAR`. Their 2/2 result and lower cost
than generic narration are useful non-regression evidence, but not causal
evidence for the task-aware prompt. Rendered vision therefore remains
experimental.

#### Review-first Terra/Sol intervention

The missing causal test now runs the same calibrated occlusion under an
explicit review-first contract: the agent must preview before reading or
editing source. The fixture uses `repoBase` composition so its repository bytes
remain shared with the original planted defect. This exposed and fixed a CLI
inconsistency where fixture execution supported composed repositories but both
experiment launchers rejected them during preflight.

The task-aware protocol is now bound into trusted preview proof. An exact
leading `RESULT: REPAIR` becomes `visual-fail`; `RESULT: CLEAR` becomes pass;
malformed prose remains uncertain and non-blocking. This linkage only activates
inside the existing screenshot-vision opt-in.

| Model and arm | Strict | Turns | Requests | Input tokens | Task time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Terra DOM | 0/2 | 8 | 8 | 116,916 | 43.229 s |
| Terra generic vision | 2/2 | 21 | 27 | 664,309 | 204.572 s |
| Terra task-aware vision | 2/2 | 16 | 22 | 396,507 | 101.044 s |
| Sol DOM | 0/2 | 8 | 8 | 128,728 | 60.497 s |
| Sol generic vision | 2/2 | 22 | 29 | 756,049 | 256.116 s |
| Sol task-aware vision | 2/2 | 17 | 23 | 481,412 | 155.209 s |

All four DOM-only runs previewed the covered controls as present and finished
without an edit; all failed the hidden pointer hit-test. Every task-aware run
received an initial trusted `visual-fail`, repaired only after that screenshot,
then received CLEAR on both repaired load and interactive previews. Generic
vision also repaired 4/4, but task-aware review saved five turns for each model,
five Terra requests, six Sol requests, 267,802/274,637 input tokens, and roughly
101/101 seconds of task time versus generic narration. All twelve complete-run
audits passed.

One generic Terra run hit an interaction timeout after its correct visual
repair and authored unnecessary arrow-key behavior before a clean retry. The
run still passed, but the detour is retained as regression evidence rather than
credited to vision.

#### Clear-page non-target cost screen

The paired negative control starts from the same campaign with the overlay
already below the controls. DOM-only and task-aware arms both passed 4/4 across
Terra and Sol. All eight task-aware reviews returned CLEAR and none of the four
task-aware trajectories edited source.

The capability was not free. Across two runs per model, task-aware review added
three requests, 29,610 input tokens, and 22.289 seconds for Terra; it added
three requests, 34,860 input tokens, and 17.475 seconds for Sol. Therefore
screenshot vision remains globally default-off. Within the explicit
`BANTAM_CODEX_PREVIEW_VISION=1` opt-in, the structured task-aware protocol is
now preferred because it is more actionable and substantially cheaper than
generic narration on the causal target. Set
`BANTAM_CODEX_PREVIEW_TASK_REVIEW=0` to restore generic narration.

#### Deterministic pointer hit-testing: promoted

Chromium now measures pointer reachability for a bounded set of visible
buttons, links, and form controls. For each control center it calls
`elementFromPoint`; if another rendered element owns that point, the preview
returns `pointer-obstruction` with the control, blocker, and coordinates. The
proof persists into the done gate. Disabled controls and off-viewport centers
are not judged, and a label that activates its associated control is accepted.

A matched Terra/Sol study ran the review-first occlusion and already-clear
control with screenshot vision disabled in every arm:

| Arm | Overall strict | Occluded | Clear | Turns | Requests | Task time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Terra detector off | 2/4 | 0/2 | 2/2 | 16 | 16 | 91.888 s |
| Terra detector on | 4/4 | 2/2 | 2/2 | 24 | 24 | 126.598 s |
| Sol detector off | 2/4 | 0/2 | 2/2 | 12 | 12 | 118.238 s |
| Sol detector on | 4/4 | 2/2 | 2/2 | 27 | 27 | 200.801 s |

Every rollback target trajectory saw a false-green preview, made no repair,
and failed the hidden browser hit-test. Every enabled target trajectory
received exact blocker evidence, repaired, and passed. One Sol trajectory
first raised only the child control's z-index; the next deterministic preview
remained red and caused the missing parent stacking repair. The four clear
treatments had zero findings, zero edits, and passed 4/4. All sixteen complete
run audits passed.

Compared with the prior task-aware screenshot target, deterministic hit-testing
saved Terra six requests, 67,336 input tokens, and 18.658 seconds; it saved Sol
five requests, 40,894 input tokens, and 40.591 seconds. It required no
`preview_vision` requests. The detector is therefore default-on with
`BANTAM_PREVIEW_POINTER_HIT_TEST=0` as an explicit rollback.

### Pause-advertisement false trigger: promoted fix

The same screen exposed a separate causal regression. The interactive smoke
treated the campaign heading “A pause above the city.” as proof that the page
advertised a P-key pause control. Terra was blocked at completion, authored an
irrelevant pause overlay, then spent additional turns discovering and removing
that invented behavior.

The smoke now requires either an explicit P-to-pause instruction or a visible
pause/resume control. A Chromium negative control proves ordinary prose does
not fire; a positive control proves “Press P to pause” still detects a missing
overlay. The full regression is 1,172/1,172 passing.

### Preview timeout phase separation: promoted fix

The review-first evidence retained another false attribution: Terra completed
the full click and keyboard smoke with no interaction issues, but the separate
second Chromium process used only to capture an optional screenshot timed out.
BANTAM collapsed both process deadlines into `browserTimedOut`, classified the
working page as `interaction-timeout`, and told the agent to treat the last
control as a likely non-terminating handler.

The runner now records `interactionTimedOut` and
`screenshotCaptureTimedOut` independently. A screenshot-only timeout preserves
the completed DOM interaction evidence, remains a preview pass, and says only
that optional visual review should be retried if required. A real interaction
timeout remains blocking; legacy artifacts without phase fields retain their
old conservative classification. The completion objection also treats one
interaction timeout as inconclusive and asks for one exact retry before source
edits.

A deterministic browser double reproduces the two-process boundary: its DOM
pass returns a complete interaction report and its screenshot pass hangs. The
before classifier returned `interaction-timeout`; the repaired runner returns
`pass`, retains visible text and completed actions, and records the auxiliary
timeout in trusted proof. Explicit interaction-timeout, runner-level DOM
timeout, and legacy-report negative controls remain red. The canonical suite
passes 1,189/1,189.

The preceding screenshot-cache proposal was rejected before implementation.
Repeated load and interactive screenshot captures of the unchanged clear
fixture had different byte lengths and SHA-256 hashes, so source/task identity
was not safe evidence of pixel identity. No cache ships.

### Full-corpus replay mining: promoted scale fix

The documented `replay-mine .bantam --untreated --uncontrasted` command stopped
working after the evidence tree grew beyond 5,000 JSON files. The ceiling
treated copied package manifests, fixture task files, and workspace state as
if they were replay evidence, so the model-free discovery loop could not inspect
its own accumulated corpus.

The miner now uses independent ceilings: 100,000 traversed JSON files and 5,000
recognized `bantam-run`/replay evidence files. Symlinks remain skipped,
oversized files remain excluded, malformed JSON remains counted, and the
evidence cap still fails closed. A deterministic corpus test proves that eight
irrelevant JSON files do not consume a two-evidence-file allowance, a third run
artifact does, and the JSON scan ceiling remains enforced.

The real before command failed at 5,000. The same command now completes in
about 2.4 seconds, scanning 7,596 JSON files while bounding 523 evidence
artifacts. It recovers two untreated, uncontrasted cohorts with 46 candidate
turns, without a model call. The canonical suite passes 1,190/1,190.

The word “untreated” still had an important boundary: it meant no exact replay
study was found, not that the current harness lacked a deterministic safeguard.
The remaining range-parser failure demonstrated the difference. Its historical
model found the bug but terminated with `respond`; the current autonomous
implementation response guard already rejects that exit and has a deterministic
repair-continuation regression.

Replay mining now accepts an explicit coverage registry pinned to the failing
artifact SHA-256. Each entry names the current mechanism and evidence paths;
`--coverage FILE --uncovered` excludes matching failures from navigation while
leaving ordinary output unchanged. The filter declares coverage rather than
inferring causality, and its report says so. The range-parser artifact is
covered by autonomous implementation response rejection. The keyed-task-pool
artifact is covered by the default keyed-Promise lifecycle audit, whose
task selector, focused-probe lifecycle tests, and Terra/Sol 4/4 strict discovery
study directly match the historical contract gap. On the live corpus the
coverage-aware filter reduces the untreated, uncontrasted queue from two
failures and 46 turns to zero. This is a navigation result, not a claim that no
future failures exist. Both launchers remain model-free and the focused miner
suite passes 10/10.

### Terminal-only landing grace: rejected after native A/B

A mined run that exhausted its turn budget immediately after a green landing
verification suggested reserving one extra, `done`-only model call. The
prototype was deliberately unable to read, edit, or execute commands, and red
or unverified trees received no extension.

A counterbalanced two-round Terra/Sol study forced identical two-turn
read-then-repair traces in every arm. All four controls and all four treatments
produced the same correct source, passed the configured verifier, passed the
hidden contract, and passed complete run-artifact audit. The treatment fired
4/4 times and changed `reachedDone` from 0/4 to 4/4, but strict correctness
remained 4/4 versus 4/4 because BANTAM already accepts the verified green tree
at the boundary.

The treatment added one Codex request per run. Across two Terra runs it added
30,764 input tokens and 3.331 seconds of task time; across two Sol runs it added
32,310 input tokens and 3.825 seconds. With no correctness or evidence lift,
the implementation was removed. The immutable negative study remains at
`.bantam/experiments/2026-07-30T01-30-16-613Z-terminal-landing-grace-terra-sol`.

### Compound baseline verifier recognition: promoted fix

Fresh Terra/Sol hard-task discovery found a false regression-guard warning in
a strict-passing Sol run. The model ran a focused lifecycle probe and the exact
baseline `npm test` in one compound shell action. BANTAM compared the whole
shell string with `npm test`, declared the test counts incomparable, and told
Sol to rerun the unchanged baseline. Sol complied.

The guard now recognizes the baseline only when it is one simple command and
appears as a complete shell segment with the same token sequence. Substrings,
added arguments, and compound baseline commands remain incomparable. Run
artifacts expose both `scopeMismatchNotices` and
`embeddedBaselineRecognitions`; `BANTAM_EMBEDDED_BASELINE_SCOPE=0` restores the
old conservative behavior.

An exact-turn Sol replay improved the expected verified `done` decision from
1/3 to 3/3, while also cutting output and reasoning tokens. That result is
recorded as partial lift because the two baseline misses chose additional
probes that could have been useful; it was not sufficient for promotion by
itself.

The promotion proof is a counterbalanced two-round full-task Sol A/B. Both
controls and both treatments passed the configured verifier, all four hidden
contract checks, completion audit, state audit, prompt-integrity audit, and
complete run-artifact audit. Each control naturally hit the false warning and
finished in 14 turns. Each treatment recognized the embedded verifier and
finished in 8 turns. Treatment therefore removed 12 requests, 724,663 input
tokens, 6,850 output tokens, 3,439 reasoning tokens, and 154.544 seconds of
task time in aggregate, with no correctness or audit-count delta. The
canonical regression passes 1,196/1,196.

A separate two-round adapter-migration replication tested a broader twelve-file
lexical contract. All four runs again passed the verifier, four hidden contract
checks, completion and lexical audits, prompt integrity, and complete artifact
audit. Three trajectories kept the baseline and focused probe separate; the
recognizer stayed silent. One treatment naturally embedded `npm test` in its
contract probe and recorded one recognition without a mismatch. Neither
control produced the compound shape, so the aggregate one-request treatment
difference is not attributable to this mechanism and is not counted as lift.
This study is cross-fixture safety and engagement evidence, not a second causal
efficiency estimate.

## Next improvements worth pursuing

1. Measure why nominally identical Chromium captures differ before considering
   any exact-input vision deduplication; do not cache across differing pixels.
2. Run the seven-fixture suite for multiple rounds before promoting hard routing
   claims. The current result is strong functional evidence, not a population
   estimate of model quality.

## Evidence

- [Promotion ledger](promotion-ledger.json)
- Usage attribution summary
- Image review packet summary
- Tool outcome protocol summary
- Complete-run audit smoke summary
- Causal tool-usage linkage summary
- Pixel facts target summary
- Pixel facts non-target summary
- Valid preview-vision summary
- Invalid preview-vision pilot
- Main v2 summary
- Main v2 showcase
- Main v2 manifest
- Offline code regression summary
- Offline code regression showcase
