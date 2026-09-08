# Context packet · native Claude reference

[Replay](share/index.html) · [Share image](share/share-card.png) ·
[Detailed measurements](index.html) · [Portable JSON](share/fight-card.json)

Build a deterministic, bounded project context packet. Both native Claude
attempts completed cleanly and passed all five independent groups.

| System | Outcome | Time | Input | Output | Cached input | Fresh input |
|---|---|---:|---:|---:|---:|---:|
| Claude Sonnet | PASS 5/5 | 62.237s | 439,451 | 5,700 | 398,100 | 41,351 |
| Claude Opus | PASS 5/5 | 67.268s | 139,205 | 5,794 | 112,339 | 26,866 |

Complete native aggregates: Sonnet reported 13 turns and Opus six. Cache-creation
input was 41,327 and 26,854 respectively, already included in fresh/input totals.
These are not per-request wire measurements.

Read the [shared source, model and isolation conditions](../README.md).
The [earlier BANTAM comparison](../../launch-2026-09-07/context-packet/README.md)
is a separate cohort, not a rerun or a row silently inserted into this card.
