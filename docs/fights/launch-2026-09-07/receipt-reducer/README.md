# Receipt reducer · six-system comparison

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Build an event-receipt reducer: deterministic state from recorded job events,
with validation and a usable CLI. Every contender received the same work order,
starter and independent acceptance checks. All six completed accepted work.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 112.487 s |
| DeepSeek Harness · same 27B | PASS | 5/5 | 442.738 s |
| Hermes · same 27B | PASS | 5/5 | 577.573 s |
| Codex · native Astra | PASS | 5/5 | 114.133 s |
| Codex · native Sol | PASS | 5/5 | 166.661 s |
| Codex · native Terra | PASS | 5/5 | 107.185 s |

BANTAM was the fastest local contender: 74.6% less wall time than DeepSeek
Harness and 80.5% less than Hermes. Terra was fastest overall; BANTAM finished
5.3 seconds later. These are single observations, not statistically established
rankings or evidence that the models have identical general capability.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 22 requests | 277,539 | 8,942 | 251,257 | 26,282 |
| DeepSeek Harness · all 18 requests | 527,511 | 29,270 | 497,530 | 29,981 |
| Hermes · measured subset, 13/14 requests | 227,979 | 36,313 | 205,912 | 22,067 |
| Hermes · separate idle-bounded server window | 250,630 | 36,313 | 227,920 | 22,710 |
| Astra · native aggregate, 5 responses | 74,320 | 2,907 | 65,664 | 8,656 |
| Sol · native aggregate, 6 responses | 88,711 | 4,477 | 62,720 | 25,991 |
| Terra · native aggregate, 7 responses | 108,074 | 4,531 | 90,368 | 17,706 |

BANTAM used 47.4% fewer input tokens and 69.4% fewer output tokens than
DeepSeek Harness. Its prefix reuse was 90.5%. Native frontier systems used
fewer input and output tokens than BANTAM on this attempt. Input already
includes cached input: do not add those columns together.

Hermes has one request without a wire usage receipt. Its complete wire totals
remain unknown; the subset and independent server-window totals are retained
separately. Server attribution assumes no other inference client used the
endpoint during the window. BANTAM and DeepSeek also retain their slightly
different server counters in the replay. Overlapping meters must not be added
or forced to agree. Native aggregates are not per-request wire recordings.

## Conditions and provenance

Frozen factory source `bb31e5fb680ce3503aae5ea94e3521a576d94ca4`.
All local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. DeepSeek and
Hermes had a 32,768-token per-request output allowance. Native Codex selected
`gpt-6-astra`, `gpt-5.6-sol` and `gpt-5.6-terra`, all at medium effort.
All selected runtimes passed offline checks before scoring. Local inference
was serial; a serial native Codex queue ran alongside it. No manual repairs,
teacher requests or post-result changes to the candidates were made.

This is a previously used development task, not a held-out evaluation or a
pure context ablation. Native prompts, tools, sampling and output policies
differ. All six planned contenders remain in this one-card derivative, even
where a frontier contender is faster or uses fewer tokens. Raw transcripts,
source and machine details remain private. Public packages contain allowlisted
measurements and replay counters. Hash manifests exclude this README and do
not establish authorship or authorize executing imported evidence.
