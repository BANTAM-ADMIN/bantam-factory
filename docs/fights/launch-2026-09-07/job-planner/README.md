# Job planner · six-system comparison

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Repair a job planner: order dependent work deterministically and propagate
failure without losing the plan. Every contender received the same work order,
starter and independent acceptance checks. Five of six completed accepted
work; Hermes reached its time limit with two of five groups passing.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM FACTORY · local 27B | PASS | 5/5 | 193.2 s |
| DeepSeek Harness · same 27B | PASS | 5/5 | 483.5 s |
| Hermes · same 27B | TIMEOUT | 2/5 | 600.0 s |
| Codex · native Astra | PASS | 5/5 | 118.4 s |
| Codex · native Sol | PASS | 5/5 | 240.9 s |
| Codex · native Terra | PASS | 5/5 | 119.3 s |

BANTAM FACTORY was the only local contender to finish under four minutes: 60.0% less
wall time than DeepSeek Harness on the same weights, while Hermes did not
finish within the 600 s limit. Astra was fastest overall; BANTAM FACTORY finished
74.8 seconds later, and ahead of Sol. A timeout is not a completion time.
These are single observations, not statistically established rankings or
evidence that the models have identical general capability.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · all 20 requests | 321,420 | 16,718 | 286,516 | 34,904 |
| DeepSeek Harness · all 16 requests | 497,535 | 32,153 | 483,833 | 13,702 |
| Hermes · measured subset, 12/13 requests | 206,244 | 34,848 | 182,167 | 24,077 |
| Hermes · separate idle-bounded server window | 230,800 | 35,190 | 206,200 | 24,600 |
| Astra · native aggregate | 75,897 | 3,169 | 52,992 | 22,905 |
| Sol · native aggregate | 143,400 | 6,641 | 119,296 | 24,104 |
| Terra · native aggregate | 110,847 | 4,997 | 69,376 | 41,471 |

BANTAM FACTORY used 35.4% fewer input tokens and 48.0% fewer output tokens than
DeepSeek Harness. Its prefix reuse was 89.1%. Native frontier systems used
fewer input and output tokens than BANTAM FACTORY on this attempt. Input already
includes cached input: do not add those columns together.

Hermes has one request without a wire usage receipt, so its complete wire
totals remain unknown; the measured subset and the independent server-window
totals are retained separately. Server attribution assumes no other inference
client used the endpoint during the window. BANTAM FACTORY and DeepSeek also retain
their slightly different server counters in the replay. Overlapping meters
must not be added or forced to agree. Native aggregates are not per-request
wire recordings.

## Conditions and provenance

Frozen factory source `f67925e4c9bc76e92927ec64e457c57a3ca98b19`.
All local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. DeepSeek and
Hermes had a 32,768-token per-request output allowance. Native Codex selected
`gpt-6-astra`, `gpt-5.6-sol` and `gpt-5.6-terra`, all at medium effort.
All selected runtimes passed offline checks before scoring. Local inference
was serial; a serial native Codex queue ran alongside it. A separate native
Claude Code reference series was recording on the same machine during the
local lanes, so CPU and I/O contention remained possible. No manual repairs,
teacher requests or post-result changes to the candidates were made.

This is a previously used development task, not a held-out evaluation or a
pure context ablation. Native prompts, tools, sampling and output policies
differ. All six planned contenders remain in this one-card derivative,
including the timeout and the frontier contenders that were faster. Raw
transcripts, source and machine details remain private. Public packages
contain allowlisted measurements and replay counters. Hash manifests exclude
this README and do not establish authorship or authorize executing imported
evidence.

</details>
