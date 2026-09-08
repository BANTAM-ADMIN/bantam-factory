# Stream framer · launch series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Repair a streaming parser across chunk boundaries, field parsing, termination,
invalid input and CLI integration. Same starter and independent grader for each
system; no manual repairs to the submitted candidates.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 432.7 s |
| OpenCode · same local 27B | TIMEOUT | 0/5 | 600.0 s |
| Codex · native Astra | PASS | 5/5 | 160.7 s |

BANTAM and Astra both completed accepted work and passed every acceptance
group. Astra was 2.7× quicker on this attempt. OpenCode, running the same
local weights as BANTAM, reached its time limit with no group passing; a
timeout is not a time to successful completion.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 40 requests | 945,746 | 29,812 | 887,131 | 58,615 |
| BANTAM · separate idle-bounded server window | 945,710 | 29,812 | 887,100 | 58,610 |
| OpenCode · measured subset, 6/7 requests | 74,091 | 36,392 | 25,307 | 48,784 |
| OpenCode · separate idle-bounded server window | 85,643 | 36,396 | 35,860 | 49,783 |
| Astra · native aggregate | 94,116 | 3,998 | 78,976 | 15,140 |

BANTAM's prefix reuse was 93.8%, its highest on any published card, and it
produced 18.1% fewer output tokens than OpenCode while OpenCode left the
starter unimplemented. Input already includes cached input: do not add those
columns together.

OpenCode has one request without a wire usage receipt, so its complete wire
totals remain unknown; the measured subset and the independent server-window
totals are retained separately. Server attribution assumes no other inference
client used the endpoint during the window. Overlapping meters must not be
added or forced to agree. Native aggregates are not per-request wire
recordings.

## Conditions and provenance

The BANTAM lane was recorded on frozen factory source
`06dc7a2042b36030e7399d3101a5421dd2df0efa`, which derives the history window
from the served context and reserves a final action against the wall budget.
Its manifest records a 72,192-token served window and a 173,260-character
history budget. The OpenCode and Astra lanes are the recorded attempts from
frozen source `6bf118ba5f5fc0d06127fa1368ee85c5011d7590` on the same frozen
kit, starter bytes and independent grader; they were not re-run, because
neither change affects a non-BANTAM lane.

Local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. OpenCode had a
32,768-token per-request output allowance; other systems used their own output
policies. Local inference was serial. No manual repairs, teacher requests or
post-result changes to the candidates were made.

This previously used development task is not a held-out reliability study.
BANTAM's recorded attempts on this work order have ranged widely in turn count,
so one attempt is an observation rather than an expected value. All three
planned contenders are retained, including the timeout. Public exports contain
allowlisted measurements and replay counters, not private source, prompts or
machine paths. Raw evidence remains private. Package hashes check generated
assets, excluding this README; they do not attest authorship or authorize
execution.
