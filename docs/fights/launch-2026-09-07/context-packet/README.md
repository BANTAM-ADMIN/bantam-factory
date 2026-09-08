# Context packet · launch series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Build a deterministic, byte-budgeted context packer with strict validation and
a command-line interface. Same starter and independent grader for each system;
one recorded attempt each. No manual candidate repairs.

| System | Independent groups | Outcome | Wall time |
|---|---:|---|---:|
| BANTAM FACTORY · local 27B | 5/5 | PASS, accepted completion | 58.072 s |
| OpenCode · same local 27B | 5/5 | OUTPUT_ONLY, time limit | 600.004 s |
| Codex · native Astra | 5/5 | PASS, clean completion | 110.560 s |

BANTAM FACTORY completed this attempt in 47.5% less elapsed time than native Astra.
That is a different-model system comparison, not a same-model harness result.
OpenCode's artifact passed, but its process did not finish within ten minutes;
600 seconds is a timeout boundary, not its time to successful completion.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Token receipts

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · complete, 14/14 requests | 109,586 | 4,206 | 93,590 | 15,996 |
| OpenCode · measured subset, 27/28 requests | 623,297 | 38,632 | 532,798 | 90,499 |
| Astra · native aggregate | 75,196 | 2,835 | 62,336 | 12,860 |

BANTAM FACTORY used more input and output tokens than Astra despite finishing sooner.
Input already includes cached input; these columns must not be added together.
Astra reports aggregate usage, not full request-by-request coverage.

OpenCode's last request was interrupted. Its full request-level totals remain
unknown. Its separate, idle-bounded local-server counter window reports
642,213 input, 39,039 output, 551,570 cached input and 90,643 fresh input tokens.
Those endpoint counters are a separate overlapping scope, not additional tokens
or a replacement for the missing request receipt. The server was reserved for
serial local contenders during the measurement.

## Conditions and provenance

Frozen factory checkout `6bf118ba5f5fc0d06127fa1368ee85c5011d7590`, before the
final history-only credential cleanup. This benchmark clone and raw evidence
remain private. The subsequent public-presentation changes did not change
the factory runtime used in these attempts.

Local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection—not the recommended DavidAU download. OpenCode was
configured for a 32,768-token per-request output allowance. Native tool policies,
sampling and cache state were not equalized. Local inference was serial; the
native Astra queue overlapped it, so host CPU/I/O contention is possible.

This is a previously used development work order, not a held-out reliability
study. This directory is a one-card derivative of the broader launch series;
all three planned contenders for this card are included, including the timeout.
Other launch-series work orders are published separately as their runs finish
and their exports are reviewed.

Only allowlisted public labels, measurements and replay counters are included.
Raw prompts, source code, machine paths and execution transcripts are omitted.
The package manifests hash the generated assets; they do not attest authorship
or authorize execution. The explanatory README is outside those asset hashes.

</details>
