# Redaction plan · six-system comparison

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Build a redaction planner: remove selected literals deterministically, with an
exact edit receipt and byte accounting. Every contender received the same work
order, starter and independent acceptance checks. Five of six completed
accepted work. Hermes reached its time limit; the artifact it left behind
passed all five groups, but a timeout is not a completion.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM FACTORY · local 27B | PASS | 5/5 | 133.2 s |
| DeepSeek Harness · same 27B | PASS | 5/5 | 391.8 s |
| Hermes · same 27B | TIMEOUT | 5/5 | 600.0 s |
| Codex · native Astra | PASS | 5/5 | 117.0 s |
| Codex · native Sol | PASS | 5/5 | 241.2 s |
| Codex · native Terra | PASS | 5/5 | 134.3 s |

BANTAM FACTORY was the fastest local contender: 66.0% less wall time than DeepSeek
Harness on the same weights, while Hermes did not finish within the 600 s
limit. Astra was fastest overall; BANTAM FACTORY finished 16.2 seconds later and ahead
of Terra and Sol. These are the recorded elapsed times for this work order.

**Inside each contender:** a short explanation, the recorded actions and their results, delivered files with before/after changes, and the acceptance output.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · all 25 requests | 289,442 | 10,210 | 257,976 | 31,466 |
| BANTAM FACTORY · separate idle-bounded server window | 289,470 | 10,210 | 258,000 | 31,470 |
| DeepSeek Harness · all 16 requests | 380,741 | 24,252 | 353,605 | 27,136 |
| DeepSeek Harness · separate idle-bounded server window | 380,730 | 24,252 | 353,600 | 27,130 |
| Hermes · measured subset, 24/25 requests | 486,170 | 34,573 | 423,444 | 62,726 |
| Hermes · separate idle-bounded server window | 512,110 | 34,846 | 449,200 | 62,910 |
| Astra · native aggregate | 74,253 | 3,148 | 65,408 | 8,845 |
| Sol · native aggregate | 125,291 | 6,545 | 87,680 | 37,611 |
| Terra · native aggregate | 178,901 | 5,293 | 152,832 | 26,069 |

BANTAM FACTORY used 24.0% fewer input tokens and 57.9% fewer output tokens than
DeepSeek Harness on the same weights, with 89.1% prefix reuse. Native frontier
systems used fewer input and output tokens than BANTAM FACTORY on this attempt. Input
already includes cached input: do not add those columns together.

Hermes has one request without a wire usage receipt, so its complete wire
totals remain unknown; the measured subset and the independent server-window
totals are retained separately. Server attribution assumes no other inference
client used the endpoint during the window. BANTAM FACTORY and DeepSeek also retain
their slightly different server counters in the replay. Overlapping meters
must not be added or forced to agree. Native aggregates are not per-request
wire recordings.

## Conditions and provenance

The BANTAM FACTORY lane was recorded on frozen factory source
`4ebd12e8debcd5a6ee20be42fff28422584deab2`, which derives the history window
from the served context rather than a fixed constant. Its manifest records a
72,192-token served window and a 173,260-character history budget. The
DeepSeek, Hermes, Astra, Sol and Terra lanes are the recorded attempts from
frozen source `8cbfce01bae65c7725aa60e9470e0fe343d8cd87` on the same frozen
kit, starter bytes and independent grader; they were not re-run, because the
change affects no non-BANTAM FACTORY lane.

All local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. DeepSeek and
Hermes had a 32,768-token per-request output allowance. Native Codex selected
`gpt-6-astra`, `gpt-5.6-sol` and `gpt-5.6-terra`, all at medium effort.
All selected runtimes passed offline checks before scoring. Local inference
was serial. No manual repairs, teacher requests or post-result changes to the
candidates were made.

This is a previously used development task. Native prompts, tools, sampling and output policies
differ. All six planned contenders remain in this one-card derivative,
including the timeout and the frontier contenders that were faster. The work views include recorded actions, acceptance output and delivered files. Asset hashes cover the generated files; this explanatory note is separate.

</details>
