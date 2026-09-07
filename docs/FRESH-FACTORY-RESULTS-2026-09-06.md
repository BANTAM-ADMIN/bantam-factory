# Fresh factory fight results — September 6, 2026

> Referenced historical fight-card packages are privately archived outside this repository.
> Their links now lead to the archive policy, not the old evidence.

The revised main series completed all 18 planned attempts; the separately
requested native Sol/Terra follow-up completed all six. BANTAM with the local
27B and DeepSeek Harness with the same weights both finished 3/3 correctly.
BANTAM was faster on each of these three local cards. Native Astra, Sol, Terra,
and BANTAM-wrapped Astra also finished 3/3. These are encouraging observations
on three bounded tools, not a general capability ranking.

Importantly, **every one of the 24 candidates passed all five held-out groups**.
That does not make every attempt a completed, accepted delivery: two timed-out
attempts left accepted artifacts, and one left a failing added test suite.
The distinction is part of what a factory should measure.

See the [fixed protocol](FRESH-FACTORY-FIGHTS-2026-09-06.md) and the
[context/overhead audit](FRESH-FACTORY-CONTEXT-AUDIT-2026-09-06.md). No candidate
was repaired for this report, no inference was requested, and no scores or
frozen runtime files were changed.

## Outcomes, completion and elapsed time

Each card had a 600-second contender ceiling. Times below are contender startup
through exit/cleanup, excluding independent grading. `PASS` means the project
passed both inspections, protected files remained intact, and the harness
completed cleanly. `OUTPUT_ONLY` means the project passed but the harness did
not complete. `TIMEOUT` here means a timed-out run whose complete project did
not pass both inspections. A held-out group count alone does not establish
project acceptance.

| Tested system | Receipt reducer | Snapshot drift | Job planner | Clean completions | Accepted projects | PASS | Total seconds |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| BANTAM / local 27B | PASS, 163.005s | PASS, 181.835s | PASS, 381.886s | 3/3 | 3/3 | 3/3 | 726.726 |
| DeepSeek Harness / same 27B | PASS, 410.563s | PASS, 469.088s | PASS, 481.679s | 3/3 | 3/3 | 3/3 | 1,361.330 |
| OpenCode / same 27B | PASS, 422.666s | OUTPUT_ONLY, 600.006s | PASS, 422.784s | 2/3 | 3/3 | 2/3 | 1,445.456 |
| Hermes / same 27B | PASS, 418.842s | OUTPUT_ONLY, 600.006s | TIMEOUT, 600.006s | 1/3 | 2/3 | 1/3 | 1,618.854 |
| Native Codex / Astra | PASS, 111.205s | PASS, 122.932s | PASS, 173.808s | 3/3 | 3/3 | 3/3 | 407.945 |
| BANTAM / Codex Astra | PASS, 146.032s | PASS, 156.413s | PASS, 246.882s | 3/3 | 3/3 | 3/3 | 549.327 |
| Native Codex / Sol, follow-up | PASS, 109.553s | PASS, 182.078s | PASS, 134.309s | 3/3 | 3/3 | 3/3 | 425.940 |
| Native Codex / Terra, follow-up | PASS, 123.398s | PASS, 79.666s | PASS, 113.322s | 3/3 | 3/3 | 3/3 | 316.386 |

Overall: 21 clean completions, 23 accepted projects, 21 `PASS`, two
`OUTPUT_ONLY`, one `TIMEOUT`. All 24 have 5/5 held-out groups and zero protected
file changes. The three non-completions all reached the wall deadline.
All independent inspections themselves finished without timeout.

The main local queue was serial; the main frontier queue overlapped it.
Sol/Terra were a later, serial six-bout sidecar that also overlapped the local
queue. Consequently, summed contender times are not the elapsed duration of
the experiment, and CPU/IO contention and time-of-run effects are uncontrolled.
Independent grading added 4.465s / 7.418s / 4.219s / 4.787s for the four local
systems and 6.998s / 4.629s / 4.150s / 3.921s for native Astra, wrapped Astra,
Sol and Terra respectively.

### Why Hermes job-planner is not OUTPUT_ONLY

The saved record is internally consistent:

- Held-out judge: exit 0, 5/5 groups, `pass: true`.
- Existing protected tests and package: unchanged; `tampered: []`.
- Public command: `npm test` exits 1, reporting 25 passing and seven failing
  tests. All four supplied public tests pass.
- Contender: timeout at 600.006s, exit 1; no clean completion.

Hermes added `test/job-plan-cli.test.js` and
`test/job-plan-contract.test.js`. They are automatically discovered by the
unchanged `node --test` package script. Six failures come from CLI fixtures
trying to create workspace-local `test/.tmp-cli` during the read-only judging
phase; the recorded error is `ENOENT`. Those are environment-sensitive test
fixture failures, not six demonstrated CLI defects. The contract permits
added tests but does not explicitly describe the judge's read-only filesystem;
that is a protocol limitation to clarify in a future version, not silently
change after this run.

The seventh failure is an incorrect added test oracle. For jobs `s1` and `s2`
already succeeded, pending `p1` depending on both, pending `p2` depending on
`p1`, and independent pending `p3`, the contract requires Kahn ordering over
the **entire graph before filtering**. Its full order is
`p3, s1, s2, p1, p2`, so the implementation correctly returns pending order
`p3, p1, p2`. The added test instead expects `p1, p2, p3`. That disagreement
would remain even in a writable test workspace.

Thus `candidatePass` is false because the delivered project fails `npm test`,
not because its protected files were changed or the held-out planner checks
failed. The run also times out, yielding `TIMEOUT`. Hermes snapshot-drift has
both inspection exits 0 and no protected changes, so its otherwise identical
timeout yields `OUTPUT_ONLY`. Neither record is relabeled here. The evidence
supports useful implementation capability and a delivery/verification problem,
not a claim that this 27B cannot implement the planner.

## Token and cache accounting

Input includes reused input; fresh input is input minus reported cached input.
Reuse below is summed cached input divided by summed input, not an average of
rounded per-run percentages. Generation request counts include local auxiliary
work, not only main agent turns. Output includes whatever reasoning the serving
interface counts in that field; it is not just delivered source code.

| System | Requests | Input | Cached input | Fresh input | Output | Reuse | Primary accounting |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| BANTAM / local 27B | 81 | 1,210,844 | 1,077,976 | 132,868 | 50,431 | 89.03% | Complete, 81/81 wire receipts |
| DeepSeek Harness / same 27B | 48 | 1,379,231 | 1,322,118 | 57,113 | 89,400 | 95.86% | Complete, 48/48 wire receipts |
| OpenCode / same 27B | 63 | unknown | unknown | unknown | unknown | unknown | Incomplete, 62/63 wire receipts |
| Hermes / same 27B | 46 | unknown | unknown | unknown | unknown | unknown | Incomplete, 43/46 wire receipts |
| Native Codex / Astra | 16 | 250,217 | 215,808 | 34,409 | 11,508 | 86.25% | Complete native response records |
| BANTAM / Codex Astra | 26 | 552,531 | 464,128 | 88,403 | 12,400 | 84.00% | Saved per-call counters reconciled, 26/26 |
| Native Codex / Sol | 25 | 437,064 | 371,200 | 65,864 | 19,172 | 84.93% | Complete native response records |
| Native Codex / Terra | 24 | 387,609 | 312,576 | 75,033 | 14,880 | 80.64% | Complete native response records |

Wrapped Astra's existing aggregate schema does **not** contain a `complete`
boolean. This audit instead checked all 26 saved model calls: each has status
`ok`, one recorded attempt, the expected Astra model and valid nonnegative
input/cache/output counters. Summing those counters reproduces every aggregate
exactly. That is explicitly a per-call reconciliation, not an invented schema
flag or a claim to observe undisclosed provider activity.

For exact per-card accounting:

| System / card | Requests measured | Input | Cached | Fresh | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| BANTAM 27B / receipt | 21/21 | 215,397 | 178,747 | 36,650 | 11,974 |
| BANTAM 27B / snapshot | 21/21 | 261,945 | 228,976 | 32,969 | 12,744 |
| BANTAM 27B / planner | 39/39 | 733,502 | 670,253 | 63,249 | 25,713 |
| DeepSeek 27B / receipt | 16/16 | 444,842 | 438,859 | 5,983 | 29,357 |
| DeepSeek 27B / snapshot | 12/12 | 332,773 | 298,174 | 34,599 | 29,920 |
| DeepSeek 27B / planner | 20/20 | 601,616 | 585,085 | 16,531 | 30,123 |
| OpenCode 27B / receipt | 14/14 | 241,121 | 176,904 | 64,217 | 27,368 |
| OpenCode 27B / snapshot | 28/29 | unknown | unknown | unknown | unknown |
| OpenCode 27B / planner | 20/20 | 391,901 | 341,057 | 50,844 | 26,522 |
| Hermes 27B / receipt | 16/17 | unknown | unknown | unknown | unknown |
| Hermes 27B / snapshot | 14/15 | unknown | unknown | unknown | unknown |
| Hermes 27B / planner | 13/14 | unknown | unknown | unknown | unknown |
| Native Astra / receipt | 5/5 | 75,202 | 66,432 | 8,770 | 3,100 |
| Native Astra / snapshot | 5/5 | 78,061 | 67,968 | 10,093 | 3,435 |
| Native Astra / planner | 6/6 | 96,954 | 81,408 | 15,546 | 4,973 |
| Wrapped Astra / receipt | 8/8 | 163,360 | 135,808 | 27,552 | 3,626 |
| Wrapped Astra / snapshot | 8/8 | 161,623 | 133,760 | 27,863 | 3,706 |
| Wrapped Astra / planner | 10/10 | 227,548 | 194,560 | 32,988 | 5,068 |
| Native Sol / receipt | 7/7 | 107,288 | 92,160 | 15,128 | 4,826 |
| Native Sol / snapshot | 10/10 | 189,556 | 156,544 | 33,012 | 7,957 |
| Native Sol / planner | 8/8 | 140,220 | 122,496 | 17,724 | 6,389 |
| Native Terra / receipt | 8/8 | 129,348 | 109,568 | 19,780 | 5,952 |
| Native Terra / snapshot | 8/8 | 125,894 | 90,368 | 35,526 | 3,481 |
| Native Terra / planner | 8/8 | 132,367 | 112,640 | 19,727 | 5,447 |

### Incomplete receipts and supplementary counters

Unknown is not zero, and a completed artifact does not imply complete metering.
All four incomplete rows have one disconnected generation request without a
final usable usage record. Their **measured-subset** input/output totals are:
OpenCode snapshot 640,216 / 38,725; Hermes receipt 305,497 / 27,443;
Hermes snapshot 272,440 / 38,653; Hermes planner 247,592 / 36,537.
These are not replacement full-run totals, and no complete-arm cache ratio is
calculated for OpenCode or Hermes.

The separate immediate endpoint-window counters provide useful reconciliation:

| Incomplete row | Supplementary input | Cached | Fresh | Generated | Endpoint idle after snapshot? |
| --- | ---: | ---: | ---: | ---: | --- |
| OpenCode / snapshot | 640,210 | 594,880 | 45,330 | 38,725 | Yes |
| Hermes / receipt | 326,170 | 285,230 | 40,940 | 27,443 | No |
| Hermes / snapshot | 298,660 | 272,390 | 26,270 | 38,859 | Yes |
| Hermes / planner | 272,920 | 247,540 | 25,380 | 36,680 | Yes |

These are endpoint-wide counters, with rounding at their current magnitudes and
attribution conditional on no outside inference client. They never replace
the primary wire totals. In particular, Hermes receipt's immediate snapshot
was taken while its post-task background request was still processing. The
next lane's pre-inference idle snapshot supports a separately attributed settled
window of 326,860 input / 285,230 cached / 41,630 fresh / 27,443 generated.
The [context audit](FRESH-FACTORY-CONTEXT-AUDIT-2026-09-06.md#hermes-metering-settled-supplement-not-repaired-primary-totals)
records the exact reconciliation and canceled post-task skill-review request.
That supplement does not recover its missing request receipt.

## What follows — and what does not

BANTAM's useful result is reliable, bounded delivery from the local model:
three accepted projects and clean completions, in 726.726s versus DeepSeek's
1,361.330s across the same cards. Both succeed. DeepSeek has substantially
better recorded prefix reuse and fewer fresh input tokens, while BANTAM emits
fewer output tokens and finishes sooner. This is not a story in which one
harness wins every metric, and high prefix reuse alone is not a throughput
objective.

Native Astra is more economical here than wrapped Astra: both succeed, but the
wrapper uses 2.21 times total input, 2.57 times fresh input and 34.7% more wall
time. The context audit verifies working extension/delta delivery, then locates
action echoes, batching differences and additional completion witnesses. Native
Astra's first call on each card also reports 9,600 cached tokens, whereas the
wrapped first calls report zero. The first-call fresh-input disparity accounts
for 58.3% of the overall extra fresh input. We did not control provider cache
state, so those savings cannot be assigned solely to prompt wording or model
intelligence. Local warm-cache state was not reset either: DeepSeek's first
receipt request already reports 4,993 cached tokens.

Terra has the lowest summed wall time of the tested native frontier runs;
Astra uses the fewest recorded input and output tokens. Sol also passes all
three. Different native model instructions, serving speeds, cache states and
task execution choices remain in play. The later sidecar is explicitly not
a randomized, simultaneous frontier-model trial. No wrapped Sol or Terra was
tested.

The following boundaries matter:

- **Three tasks and one attempt per system/task are insufficient to estimate
  rare failures.** All 24 held-out scores reach the ceiling. This gauges bounded
  factory tools, not long-horizon projects, unfamiliar domains or adversarial
  correctness. The suite distinguishes delivery behavior better than it
  distinguishes implementation capability in this pass.
- **Extra checks are not proved unnecessary by causing no repair on these
  three artifacts.** Factory checks may prevent rare costly failures. Future
  evidence-bound completion or reduced-repetition policies need independent
  review, deliberate fault cases and unfamiliar paired qualification; do not
  remove guards, reasoning or Datalog simply because a successful run was long.
- **This is a system comparison, not a context-only ablation.** Local peers use
  a 32,768-token combined main-response cap and declared 65,536-token context;
  BANTAM separates up-to-4,096-token reasoning from up-to-8,192-token actions.
  Native sampling, tools, output reservation/compaction, runtime versions and
  completion policies differ. Cloud comparisons additionally change weights,
  tokenizer, hardware and provider behavior. Token counts are not comparable
  units of intelligence, cost or energy across these systems.
- **The tested local artifact is the operator's Qwen3.8 27B GGUF**, not a
  stock-weight claim. Its SHA-256 is
  `ba36dc3c2b2ff5e0aa5d71092a8894546996a6a119ae391803dda07cdc08516d`.
  Exact model IDs, launch/configuration hashes and server settings remain in
  the manifests. Codex models are exactly `gpt-6-astra`, `gpt-5.6-sol` and
  `gpt-5.6-terra`, medium effort. Native logs verify the selected model and
  effort; they are not attestations of provider internals.
- **The original 8K diagnostic series is retired, not erased or pooled.**
  DeepSeek/OpenCode consumed the combined cap before implementation, motivating
  the separately sealed full 32K rerun. Its three completed diagnostic rows
  remain, and the operator-interrupted Hermes attempt remains unscored. Higher
  output reservation can change compaction, so this correction is not a pure
  token-budget ablation either.
- **Isolation and gauges have declared limits.** Judges run offline and
  read-only; candidate-added workspace-writing tests expose a compatibility
  edge. Local agent host networking is not enforced egress confinement. The
  behavioral graders are not a proof against malicious in-process grader
  subversion. No publication, evidence upload or repository visibility change
  was performed by this audit.

## Final read-only integrity audit and evidence locator

The settled main manifest contains 18/18 results and the sidecar 6/6. Every
per-run `result.json` equals its manifest row. All task hashes match the
original contracts; material seals match original starters; current final
candidate hashes match saved final-file records; parsed held-out stdout matches
each recorded grade. The main's 404 sealed source entries and sidecar's 405
still match the filesystem. Both share the same unchanged 23-entry kit seal.
All nine native Astra/Sol/Terra sessions independently verify the requested
model and medium effort, and their recomputed response-record usage exactly
matches all nine saved totals. All 12 local wire aggregates were recalculated
from their saved exchange records and match, including incomplete totals.
The sidecar's private source/kit snapshot bytes also match their original seals.

The final Docker read-only inspection found no remaining benchmark containers,
running or stopped, under the BANTAM/Astra/DeepSeek/OpenCode/Hermes names.
Unrelated service containers were left untouched. Source seals, native session
records and local hashes establish local consistency, not trustworthy authorship
or universal semantic completeness.

Raw evidence remains in ignored private local storage. Paths below are relative
to the repository. For retention after a private clone, the six-run sidecar also
has a [private evidence package](fights/README.md), including
its [unchanged manifest](fights/README.md),
[511-member SHA-256 index](fights/README.md) and
[compressed source/session/receipt archive](fights/README.md).
It preserves the sidecar schema rather than merging six follow-up observations
into the 18-run main series. It is private, **not redacted**, and must not be
mistaken for a publication-safe bundle. The original evidence locations are:

- Main: `.bantam/acceptance/2026-09-06/factory-fights-v2-32k/manifest.json`.
- Sidecar: `.bantam/acceptance/2026-09-06/factory-frontier-sol-terra-v1/manifest.json`.
- Each has `repeat-1/CARD/ARM/result.json`, `task.md`, `command.json`, `ws/`,
  contender stdout/stderr and independent public/hidden grader logs.
- Local lanes retain `wire/exchanges.jsonl`, request/response bodies,
  `wire/usage.json`, `server-usage.json` and native/BANTAM records. Wrapped
  Astra's per-call evidence is in `run.json`; native Codex response records and
  model selection are in `native-sessions/**/*.jsonl`.
- The Hermes planner explanation comes directly from
  `repeat-1/job-planner/hermes/public.stdout.log` and its two added test files.
- Retired diagnostic provenance remains under
  `.bantam/acceptance/2026-09-06/factory-fights-v1/`, including
  `INTERRUPTED.md` and `operator-interruption.json`.

The [passive exchange format](FIGHT-CARD-EXCHANGE.md) can package observations
and hashes for review. Imported records remain untrusted observations, not
automatically admitted factory rules. The next useful advance is to make
specific, justified decisions cheaper while preserving the witnesses that make
their correctness auditable.

## Private release-candidate verification

The [completed Arena](fights/README.md) and
[main evidence package](fights/README.md) now preserve all
18 main rows after a private clone. The archive contains 857 allowlisted files;
extraction into a fresh directory reproduced every indexed byte count and
SHA-256. The six-run sidecar archive independently reproduced all 511 members.
Neither package is a privacy-redacted public release.

Release checks completed after presentation and packaging changes:

- Full `npm test`: 3,538 tests, 3,505 passed, zero failed, 33 skipped.
- Explicit Docker/adapter/card qualification: 48/48 passed, no skips, using
  scripted endpoints rather than additional scored inference.
- Replay suite with Chromium enabled: 23/23 passed. Actual completed desktop
  and mobile checks covered recorded clocks/counters, source and context
  inspection, all outcomes, and a byte-identical offline JSON download.
- Packaging/export/documentation focused checks: 21/21 passed. Packaging
  rejects stale embedded evidence/indexes, incomplete series, changed hashes,
  symlink inputs and existing destinations.
- Supplementary credential-pattern scans found no matches in 857 main archive
  attachments, 1,041 embedded replay artifacts, or 511 sidecar members. These
  are pattern checks, not proof of secret absence or a redaction guarantee.

The delivered scope is the benchmark machinery, qualified cards, private
receipts and polished Arena. The shared recorded-run Workbench integration,
public material review and first-time-user onboarding trial remain launch
items; they are not certified by this test pass.
