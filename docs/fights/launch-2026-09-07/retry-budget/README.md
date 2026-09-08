# Retry budget · six-system comparison

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Repair a retry controller: respect backoff, server retry hints and a hard
remaining-time budget without overflow. Every contender received the same work
order, starter and independent acceptance checks. All six completed accepted
work.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 141.7 s |
| DeepSeek Harness · same 27B | PASS | 5/5 | 445.8 s |
| Hermes · same 27B | PASS | 5/5 | 562.0 s |
| Codex · native Astra | PASS | 5/5 | 137.3 s |
| Codex · native Sol | PASS | 5/5 | 231.8 s |
| Codex · native Terra | PASS | 5/5 | 143.2 s |

BANTAM was the fastest local contender: 68.2% less wall time than DeepSeek
Harness and 74.8% less than Hermes on the same weights. Astra was fastest
overall; BANTAM finished 4.4 seconds later, 1.5 seconds ahead of Terra and
well ahead of Sol. These are single observations, not statistically
established rankings or evidence that the models have identical general
capability.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 23 requests | 304,594 | 9,969 | 273,649 | 30,945 |
| DeepSeek Harness · all 15 requests | 397,922 | 27,046 | 384,287 | 13,635 |
| Hermes · measured subset, 25/26 requests | 510,541 | 33,214 | 481,155 | 29,386 |
| Hermes · separate idle-bounded server window | 533,700 | 33,214 | 503,800 | 29,900 |
| Astra · native aggregate | 90,451 | 3,684 | 67,072 | 23,379 |
| Sol · native aggregate | 127,218 | 6,251 | 96,768 | 30,450 |
| Terra · native aggregate | 163,987 | 5,762 | 137,728 | 26,259 |

BANTAM used 23.5% fewer input tokens and 63.1% fewer output tokens than
DeepSeek Harness. Its prefix reuse was 89.8%. Native frontier systems used
fewer input and output tokens than BANTAM on this attempt. Input already
includes cached input: do not add those columns together.

Hermes has one request without a wire usage receipt, so its complete wire
totals remain unknown; the measured subset and the independent server-window
totals are retained separately. Server attribution assumes no other inference
client used the endpoint during the window. BANTAM and DeepSeek also retain
their slightly different server counters in the replay. Overlapping meters
must not be added or forced to agree. Native aggregates are not per-request
wire recordings.

## Conditions and provenance

Frozen factory source `8cbfce01bae65c7725aa60e9470e0fe343d8cd87`.
All local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. DeepSeek and
Hermes had a 32,768-token per-request output allowance. Native Codex selected
`gpt-6-astra`, `gpt-5.6-sol` and `gpt-5.6-terra`, all at medium effort.
All selected runtimes passed offline checks before scoring. Local inference
was serial; a serial native Codex queue ran alongside it. No other comparison
was recording on the machine during this card's local lanes. No manual
repairs, teacher requests or post-result changes to the candidates were made.

This is a previously used development task, not a held-out evaluation or a
pure context ablation. Native prompts, tools, sampling and output policies
differ. All six planned contenders remain in this one-card derivative,
including the frontier contender that was faster. Raw transcripts, source and
machine details remain private. Public packages contain allowlisted
measurements and replay counters. Hash manifests exclude this README and do
not establish authorship or authorize executing imported evidence.
