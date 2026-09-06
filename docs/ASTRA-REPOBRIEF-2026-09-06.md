# RepoBrief: GPT-6 Astra and local 27B project cards

This is the original comparison. Subsequent harness changes and reruns are
recorded separately in [Context delivery fixes](CONTEXT-DELIVERY-FIXES-2026-09-06.md).

## Purpose

Build something useful with BANTAM, then compare the same model behind two
different action loops. RepoBrief is a small local Git handoff tool: report the
working tree, save a content snapshot, and distinguish verification results
that still apply from those made stale by later edits.

The three cumulative cards are in
[`examples/fights/repobrief-astra-2026-09-06`](../examples/fights/repobrief-astra-2026-09-06/README.md).
Neither the operator nor the test authors implement candidate application code.

## Integration

- `astra`, `codex-astra`, and `gpt-6-astra` resolve to the exact requested model
  in the model registry and native delegate. Existing defaults and automatic
  model recommendations are unchanged.
- The fight roster adds `codex-astra` and `bantam-codex-astra`, both explicitly
  using medium reasoning. A separate `bantam-local-27b` corner has no cloud teacher.
- The installed Codex CLI is 0.153.4. Its live catalog and real smoke request
  establish account access; documentation alone would not establish that.
  [Official Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
  informed model selection and compatible reasoning settings.
- Astra remains a manually selected option. This small comparison does not
  establish an automatic routing policy.

## Method and boundaries

Each card starts every contender with identical task and project bytes and a
fresh session. Cards 2 and 3 extend the previous passing **BANTAM–Astra** product,
copied to every contender. This is a comparison of feature additions to a shared
codebase, not independent three-stage product trajectories.

The initial request was Astra-only. The local model was held out when the user
asked, then added after the user explicitly authorized it. Its existing health
check identified Qwen3.8-27B-BANTAM-Q4_K_P.gguf at localhost:8085. The first two
Astra runs are retained, not rerun for a more favorable result.

Native Codex's workspace-write sandbox could not operate on this host. A
separate Docker launcher therefore confines native execution to a disposable
workspace. The same clean runtime hosts BANTAM's Codex app-server with the
workspace mounted read-only. It receives only the required runtime and a
read-only authentication mount, not the user's configuration, projects or
Docker socket. The native inner sandbox bypass occurs only inside this outer
container, never directly on the host.

BANTAM performs its own workspace actions and runs shell checks inside its
normal Docker sandbox. Final supplied and held-out tests run in a separate
no-network Docker container, with candidate and grader files read-only and no
account credentials. Protected tests and package configuration are hashed.
All model runs are sequential, limited to eight minutes; BANTAM additionally
has 60 action turns. Time includes runtime startup and the agent's own checks,
but excludes independent final grading. Different tools, reasoning mechanisms
and runtime overhead remain part of the systems being compared.

The first-pair score adapter mistakenly looked for saved `result.done` rather
than the actual `result.reachedDone` field. The original BANTAM candidate passed
the tests and reached accepted completion. Its score was corrected from the
unchanged saved run and grader outputs, independently audited. The original
misgraded evidence remains intact. A regression now checks the serialized
completion schema. No candidate repair or repeated inference was involved.

## Results

All nine runs completed. No candidate changed protected tests or package
configuration. The final manifest reports zero mismatches across 463 sealed
source files and 14 test-kit files. `allPassed: false` and the driver's exit 1
correctly preserve the local model's card-1 failure; they do not mean the
experiment stopped early.

| Contender | 1: Git status | 2: Snapshots | 3: Verification receipts | Total wall time |
| --- | --- | --- | --- | --- |
| BANTAM + Astra, medium | Pass · 104.0 s | Pass · 207.9 s | Pass · 193.7 s | 8m 25.6s |
| Native Codex Astra, medium | Pass · 109.6 s | Pass · 137.3 s | Pass · 436.5 s | 11m 23.4s |
| BANTAM + local 27B | Fail · 311.4 s | Pass · 187.5 s | Pass · 166.2 s | 11m 05.1s |

The supplied meaningful checks are cumulative 2 / 4 / 6; the separate held-out
checks are cumulative 3 / 5 / 8. `npm test` also reports the helper module loading
as an extra passing test, so its displayed totals are 3 / 5 / 7. Local card 1
passes its supplied checks but fails one held-out check: a rename reports its
old pathname instead of the destination. Its accepted BANTAM completion does
not override that independent failure.

Native card 3 deserves a strong timing caveat. Its code edit completed at
86.732 seconds, supplied tests at 87.499 seconds, and extra self-authored checks
at 128.444 seconds. The final answer arrived at 435.016 seconds. The intervening
306.572-second event gap accounts for about 70% of wall time, with no further
recorded tools, edits or errors. The evidence cannot distinguish server delay,
client buffering, model work or another unobserved cause. Do not describe this
as five extra minutes spent implementing the feature, and do not silently
subtract it to manufacture an adjusted winner.

The concrete quality result is stronger than the speed result: **Astra built
the requested utility successfully through either action loop.** BANTAM's
three-stage trajectory delivered the working application without operator
code repair. The local model delivered useful feature additions, but its
status error and the later symlink probe show why a passing public suite is
not sufficient evidence of complete correctness. One sample per corner per
card cannot establish a general model ranking.

### Reported context traffic

| Contender, summed over three cards | Input tokens, including cached | Cached input | Output tokens |
| --- | ---: | ---: | ---: |
| BANTAM + Astra | 1,574,510 | 1,202,816 (76.4%) | 11,481 |
| Native Codex Astra | 293,826 | 234,624 (79.9%) | 10,190 |
| BANTAM + local 27B | 1,994,355 | 1,844,001 (92.5%) | 46,664 |

These are runtime-reported token traffic, not billed costs, unique context
size, or a directly comparable measure of reasoning across different models.
Wrapped Astra's 36 saved per-call usages sum exactly to its run metrics. The
transport resets usage per completion and reads app-server `tokenUsage.last`,
not cumulative `total`; inspection found no thread-total double counting.
Native totals come from its three JSONL `turn.completed` records. Raw
app-server usage notifications were not archived, so provider-internal
retry/compaction accounting cannot be independently reconciled here.

For the same Astra model, BANTAM reports about **5.4 times the input traffic**
in this sample, despite using run-scoped delta transport. That deserves
profiling alongside the false context guards. The local corner's 92.5% cache
reuse confirms substantial prefix reuse in this run, but does not prove
extension equals rebuild in capability or that the retained context is all
useful. Neither default cache mode nor automatic model selection was changed.

## Evidence

Raw evidence remains local and ignored by Git:

- `.bantam/acceptance/2026-09-06/astra-repobrief-first/`: original first pair,
  including the preserved scoring mistake.
- `.bantam/acceptance/2026-09-06/repobrief-three-corners/`: corrected first-pair
  imports, added local model and remaining cards, manifests and replay pages.

Before live work, the full software suite passed 3,312 tests with zero failures
and four skips. Subsequent scoring/roster changes passed the focused regression
tests. These are harness software checks, not local-model benchmark runs.

The final full recheck, including the new completion-schema regression,
passed **3,313 tests, zero failures, four skips** (3,317 total) with concurrency
4 in 114.5 seconds. An earlier final run at concurrency 8 had one missing-
screenshot failure in the unchanged asynchronous preview test; that exact
test passed alone, then the complete suite passed at concurrency 4, without
source edits between attempts. This is an observed intermittent test failure,
not a diagnosed or repaired preview defect. All attempt logs are preserved in
the evidence directory's `verification/` folder, alongside the original clean
pre-run suite. Context, usage and independent candidate audits are in `audit/`;
nonsecret container preflight summaries are in `preflight/`.

The final comparison replay is
`.bantam/acceptance/2026-09-06/repobrief-three-corners/fight-cards.html`.
Raw logs, prompts, run artifacts and independent audit notes stay local; they
are not intended for Git staging. GitHub reported `BANTAM-ADMIN/bantam-factory`
as `PRIVATE` after the run. At the original comparison handoff, the additions
had not yet been committed or uploaded. Subsequent release status is in the
linked fixes report; unrelated work, including `bench/repro/`, remains untouched.

## Application handoff

The completed BANTAM–Astra application is at
`/home/operator/Desktop/PROJECTAI/testcode/repobrief`. Its application, package
and supplied tests are byte-identical to the passing card-3 candidate; the
operator added only its handoff README. It requires Node 20+ and Git, with no
dependencies to install. A read-only status invocation against the real BANTAM
working tree also succeeded.

```sh
cd /home/operator/Desktop/PROJECTAI/testcode/repobrief
node bin/repobrief.js status --repo /path/to/project --json
node bin/repobrief.js snapshot --repo /path/to/project --name handoff
node bin/repobrief.js verify --repo /path/to/project --label tests -- npm test
node bin/repobrief.js receipts --repo /path/to/project --json
```

The useful distinction is between a command that passed and a result that
still applies to the current source bytes. A verifier that itself changes
source is immediately stale. Exact restoration of source can make an ordinary
stable receipt current again. This is a small local utility, not a secure
execution service: `verify` runs the supplied command with the caller's normal
permissions. Concurrent writers, crash-atomic persistence, interactive or
long-running commands, and large outputs were explicitly outside this brief.

## What the context audit actually established

Three concrete harness defects were reproduced from saved evidence. They were
not repaired during the comparison, and findings were not fed back to any
contender. At that point these were follow-up work, not completed fixes; the
linked fixes report records the subsequent implementation and validation.

1. **Context residency must describe delivered bytes.** In local card 1, a
   multi-file inspection clipped helper bodies and instructed the model to
   reread them. Subsequent reads were refused because the guards claimed the
   files were already in `<open_files>`. Seven actual request prompts, checked
   against their recorded hashes, contain neither those helper bodies nor that
   panel. Ordinary extension had compiled but not rendered it. Requested read
   ranges were also counted as delivered despite clipping. This is a real
   unavailable-context/recovery trap. It does **not** prove that missing helper
   bodies caused the final rename error: relevant expected rows were visible,
   other search routes remained, and no controlled intervention isolated that
   causal claim. See `src/agent.js`, `src/prompt.js`, and `src/repetition.js`.
2. **Execution evidence must not include assignment prose.** Local card 1 had
   a structured passing `npm test` receipt with exit 0. Appended guidance
   repeated the requirement that a non-repository invocation must “exit 1.”
   The done guard parsed that prose as a failed test command. Deterministic
   replay reproduces the false failure; removing only the guidance makes it
   disappear. Structured execution provenance must survive the evidence
   pipeline instead of being flattened into annotated text. See
   `src/logic/evidence-guard.js`, `runlog.js`, and `deliverable-signals.js`.
   The same defect repeats in local card 3: turn 22's exit-0 receipt is
   contradicted by turn 23's exit-1 objection; removing only appended guidance
   clears the deterministic replay failure there too.
3. **Runtime contracts are not build-time file obligations.** Wrapped Astra
   card 2 was twice refused completion because literal
   `.repobrief/snapshots/NAME.json` did not exist in its workspace. The brief
   required the resulting program to create parameterized snapshots when
   invoked in a target repository. The program already did that and passed
   checks; no application repair was needed. The bounded guard eventually
   allowed completion. The fix needs an explicit obligation distinction, not
   merely a special case for uppercase filenames. See
   `src/logic/missing-outputs.js` and `src/done-gates.js`.

There is also a positive poka-yoke example: wrapped Astra card 3 attempted a
partial replacement with an unclosed brace. The syntax gate rejected the edit
before application, supplied accurate changed-region context, and the next
turn produced a valid replacement. This supports keeping grounded guards; it
does not show that ordinary tests could not also have caught the mistake.

My interpretation: context correctness includes **availability, provenance,
and scope**, not just prompt length. A cache hit can faithfully preserve wrong
feedback. Prefer exact execution receipts and provably delivered source spans
over increasingly clever inference from prose. The next focused patch should
add deterministic regressions for these three saved failures, repair those
boundaries, and only then run a separately labelled before/after experiment.
This comparison does not itself compare extension against rebuild or establish
that every application bug is a context bug.

## Independent checks beyond the sealed score

Post-completion probes were kept separate from the original grader and never
used to improve a candidate's scored run. Local card 1 additionally rewrites
Git's index after an mtime-only source change and mishandles a repository root
ending in a space. Both Astra status candidates pass those probes.

Local card 2 passes the original five held-out checks but follows a symbolic
link when a tracked file's **parent directory** has been replaced by that
link. This violates the stated skip-directory-symlinks rule and identifies a
coverage gap in the frozen grader. Both Astra card-2 candidates pass that
probe. The original score is preserved rather than silently revised. Since
card 2 inherits BANTAM–Astra's status implementation, its improved local status
behavior is not evidence that the local model repaired its own first card.

All three final card-3 candidates pass six additional probes, including
signal-terminated verification recorded durably as failed/current. This does
not erase earlier-stage defects: each final candidate inherited the passing
BANTAM–Astra card-2 implementation. The delivered BANTAM app was also regraded
from its handoff directory: six supplied and eight held-out checks passed in
the read-only, no-network grading container.
