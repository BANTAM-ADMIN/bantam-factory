# Patch transaction · native Claude reference

[Replay](share/index.html) · [Share image](share/share-card.png) ·
[Detailed measurements](index.html) · [Portable JSON](share/fight-card.json)

Extend an atomic edit engine to validate preimages and apply a transaction.
Both native Claude attempts completed cleanly and passed all five independent
groups. Sonnet was faster on this attempt.

| System | Outcome | Time | Input | Output | Cached input | Fresh input |
|---|---|---:|---:|---:|---:|---:|
| Claude Sonnet | PASS 5/5 | 31.360s | 241,947 | 3,192 | 228,852 | 13,095 |
| Claude Opus | PASS 5/5 | 129.342s | 434,039 | 11,310 | 413,651 | 20,388 |

Complete native aggregates: Sonnet reported nine turns and Opus 15.
Cache-creation input was 13,081 and 20,358 respectively, already included in
fresh/input totals. These are not per-request wire measurements.

Read the [shared source, model and isolation conditions](../README.md).
The [earlier BANTAM FACTORY comparison](../../launch-2026-09-07/patch-transaction/README.md)
is a separate cohort. Sonnet finished this task faster than that BANTAM FACTORY attempt;
the original measurements and all other contenders remain available.
