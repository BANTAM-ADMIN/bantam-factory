# Context delivery fixes: September 6, 2026

Follow-up to [the original Astra/RepoBrief comparison](ASTRA-REPOBRIEF-2026-09-06.md)
and [the preserved context diagnosis](CONTEXT-DIAGNOSIS-2026-09-06.md).
The original results and candidate artifacts are not replaced by this work.

## Implemented changes

- Codex run/delta sends the suffix since the **previous successfully completed
  canonical prompt**, instead of repeatedly appending the suffix since the first
  prompt. V2 artifacts identify this explicitly; historical V1 remains auditable.
  Rewritten history and lost/interrupted sessions require a fresh full prompt.
  Concurrent completions cannot race the delivery cursor, and a retired process
  cannot clear a replacement process's state.
- Read residency must describe source bytes actually supplied to the model.
  Extension WS0 does not render a working-set panel, so a compiled-but-absent
  panel cannot justify refusing a requested read. Clipped read headers are not
  receipts for the entire requested range.
- Peer-source excerpts must come from current safely resolved workspace bytes,
  not pre-edit index snapshots presented as another implementation.
- The existing completion audit is bounded and preserved through clipping,
  without claiming that an absent source panel is available. Passing public
  tests is not evidence that an untested requirement was satisfied.
- Completion evidence uses execution-bound receipts before transcript prose.
  An assignment's description of an expected `exit 1` is not a failed `npm test`.
  Legacy text fallback stops before harness annotations.
- A runtime storage contract is distinguished from a file explicitly requested
  for the handoff. This does not exempt explicit source, sample or result files.

The [official Codex app-server documentation](https://developers.openai.com/codex/app-server)
informed the retained-thread interpretation. This is not a model-routing change.
Extension/cache-fast remains the default; other context modes stay optional.
Read deduplication is intentionally conservative when residency is unproven:
serving a requested source range again is preferable to claiming absent bytes
are already visible. This can permit additional reads; it is not a claim that
every trajectory now uses the fewest possible tokens.

## Offline transport result

Replaying the exact original 36 Astra prompts through V2 produced three initial
full deliveries and 33 incremental deliveries: no fallback or forced rebase.
All reconstructed canonical prompts match the originals exactly.

| Card | Original serialized characters | V2 serialized characters |
| --- | ---: | ---: |
| 1 | 64,167 | 35,889 |
| 2 | 338,504 | 63,569 |
| 3 | 271,247 | 64,915 |
| Total | 673,918 | 164,373 |

This is **75.6% less serialized delivery**, not a forecast of provider token
usage, cost, cache hits or model quality. The 40-turn regression also checks
linear wire growth and exact incremental reconstruction.

## Validation design

`scripts/repobrief-context-validation.mjs` copies the original sealed starter
bytes and task for each requested corner/card, with the unchanged grader and
public tests. The original comparison used shared BANTAM-Astra starters for
later cards; these reruns preserve that design, rather than claiming independent
three-stage trajectories. Native Astra need not be rerun to test harness changes.

The driver records source/task/starter hashes, exact commands, raw runs, usage,
grades and completion acceptance in a new ignored evidence directory. Source
and grader hashes must remain unchanged during a validation invocation. It
refuses to overwrite existing evidence and stops at the first failure by default.
Model limits remain 60 actions and eight minutes per corner/card.

No Git-specific answer, hidden-test feedback, manual candidate repair or grader
change is supplied to either model. Any unsuccessful new sample remains part
of the record. A higher score in one sample would not establish universal
correctness or isolate every individual patch's causal effect.

## Sealed live validation: all six reruns passed

Evidence: `.bantam/acceptance/2026-09-06/repobrief-context-fixed-v1/`.
The completed manifest reports zero source/kit mismatches, unchanged exact
task/starter hashes and no protected-file changes. Both models reached accepted
completion on every card. The final card passed six meaningful public checks
plus eight held-out checks; Node also counts the imported helper module.

| Across three cards | Local 27B original | Local 27B fixed | Wrapped Astra original | Wrapped Astra fixed |
| --- | ---: | ---: | ---: | ---: |
| Cards passed | 2/3 | 3/3 | 3/3 | 3/3 |
| Requests | 130 | 102 | 36 | 35 |
| Input tokens, including cached | 1,994,355 | 1,448,666 | 1,574,510 | 751,642 |
| Cached input | 1,844,001 | 1,319,423 | 1,202,816 | 657,280 |
| Input not reported cached | 150,354 | 129,243 | 371,694 | 94,362 |
| Output tokens | 46,664 | 31,126 | 11,481 | 10,581 |
| Wall seconds | 665.1 | 458.8 | 505.6 | 496.8 |

Local input fell 27.4%, actual prefill fell 14.0%, and elapsed time fell 31.0%.
Weighted prefix reuse remained 91.1% (originally 92.5%). Wrapped Astra input
fell 52.3%, with uncached input down 74.6%; weighted cache reuse increased from
76.4% to 87.4%. These are observed token counts, not bills or reliability
estimates. The final regression-suite recheck overlapped Astra cards 1/2, so
wall-time comparisons are not isolated performance measurements. It did not
overlap local-model runs.

Astra card 1 took eight calls rather than six: total input increased 25.3%
despite uncached input decreasing 17.5%. Cards 2/3 supply the aggregate saving.
On card 2 the first completion was accepted immediately, eliminating the old
three-call false literal-snapshot-file loop, while a genuine intermediate test
failure was still detected and followed by a verified repair.

This does **not** establish that wrapped Astra now uses fewer tokens than native
Astra. The preserved native baseline used 293,826 input tokens, of which 59,202
were uncached—still below this fixed wrapped run. The demonstrated win is a
large reduction of the wrapper's own avoidable amplification while preserving
quality, not universal superiority over a native agent.

Strict offline audits of the new artifacts verify all 35 Astra canonical
requests exactly: three full deliveries plus 32 V2 deltas, one retained native
thread per card and zero rebases. Live serialized delivery totaled 158,907
characters versus 673,918 originally, a 76.4% reduction. Every request retained
the pinned Astra/medium settings.

### Local card 1: the originally failing case

The first post-fix sample passed the original public and held-out checks, with
accepted completion and no protected-file changes. It took 31 actions / 43
requests, versus 38 / 56 in the original failed run. Input was 599,693 tokens
(558,938 cached), versus 794,270 (736,894 cached). Wall time was 186.2 seconds
versus 311.4 seconds; neither single sample is a general speed guarantee.

All 43 request hashes verify. The rename requirement is present in every
request, and no working-set panel is rendered (WS0 remains unchanged). The
previously missing helper bodies now arrive after a focused read. The complete
480-character post-green reanchor is visible in calls 20–42, whereas the original
reanchor was clipped away. Some generic completion-audit guidance did survive
in the old run; this was not a total absence of audit advice.

Using zero-based saved turn indices, the new run observes an incorrect quoted
rename destination at turn 18, repairs the parser at turn 19, and independently
obtains the correct single `final dest.txt` rename result at turn 21. This is
actual observation, repair and recheck—not simply a completion claim that a
rename branch exists. It supports the context diagnosis, but does not isolate
one patch's effect from the other changes or from sampling variability.

## Post-comparison hardening and release checks

Trace review found one remaining peer-label edge case: a single replacement
could introduce a helper and revise another function, but only its first
function was excluded from same-file peer suggestions. The excerpt already
contained current bytes, yet could misleadingly describe edited code as
"elsewhere". After the six-arm comparison completed, a narrow change in
`src/edit-context.js` excluded all functions touched by that replacement span.
Two new regressions cover helper-plus-parser replacements and spans beginning
inside one function and crossing another, while preserving untouched peers.

This final hardening was **not** included in the six live runs. Those measured
scores refer to the sealed v1 source; its original peer module is preserved in
the ignored verification folder. The final code receives deterministic tests
and a full-suite release recheck instead of attributing unmeasured model
performance to the follow-up change.

The pre-hardening full suite passed 3,342 tests, with zero failures and four
skips. An earlier run had three paging fixtures that counted panel-skipped
operations as executed reads; their scenarios now exercise actual reads, with
a new regression proving skipped reads cannot fabricate paging activity.
Two other assertions needed the corrected range-specific dedup wording.
All attempts are retained in the evidence directory's `verification/` folder.

The final release recheck, including the post-comparison peer-span correction,
passed **3,344 tests, zero failures and four skips** (3,348 total) at concurrency
four in 116.4 seconds. `git diff --check` and the scoped staging audit are clean.

Raw prompts, candidate workspaces, grades and account material are excluded
from Git staging. The changes preserve the existing private repository,
manual-only Astra selection, local-model defaults and extension/cache-fast
default. The existing `bantamfactory` entry points directly at this checkout;
no reinstall or public package publication is involved.
