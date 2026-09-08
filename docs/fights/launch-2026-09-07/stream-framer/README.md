# Stream framer · launch series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Repair a streaming parser across chunk boundaries, field parsing, termination,
invalid input and CLI integration. Same starter and independent grader for each
system; no manual repairs to the submitted candidates.

| System | Independent groups | Outcome | Wall time |
|---|---:|---|---:|
| BANTAM · local 27B | 4/5 | TIMEOUT | 600.019 s |
| OpenCode · same local 27B | 0/5 | TIMEOUT | 600.005 s |
| Codex · native Astra | 5/5 | PASS, clean completion | 160.651 s |

Astra won this attempt. BANTAM passed four groups but rejected a valid CLI
input with `invalid base64 padding`. Neither local run completed within the
limit. Timeout durations are not times to successful completion.

## Accounting, including incomplete requests

| System / measured scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · subset, 69/70 requests | 1,660,877 | 31,617 | 1,462,842 | 198,035 |
| OpenCode · subset, 6/7 requests | 74,091 | 36,392 | 25,307 | 48,784 |
| Astra · native aggregate, 6 responses | 94,116 | 3,998 | 78,976 | 15,140 |

Full request-level totals for both local attempts are unknown. These measured
subsets are not substitutes for complete totals. Cached input is included in
input, not additional to it. An unfinished BANTAM checkpoint contained no final
native metrics; it is not presented as a zero-token run.

The independent server window for BANTAM did not end idle, so it is not a
settled full-run measurement. OpenCode's idle-bounded server counters are
retained separately in the replay. Overlapping meters must not be added.

## Conditions and provenance

Frozen factory checkout `6bf118ba5f5fc0d06127fa1368ee85c5011d7590`;
later history cleanup and presentation changes did not alter these attempts.
Local contenders used the Qwen 27B Q4_K_P control, 72K context and CPU vision
projection, not the recommended DavidAU download. OpenCode had a 32,768-token
per-request output allowance; other systems used their own output policies.
Local inference was serial, with frontier work allowed alongside it.

This previously used development task is not a held-out reliability study.
All three planned contenders are retained, including both timeouts. Public
exports contain allowlisted measurements and replay counters, not private
source, prompts or machine paths. Raw evidence remains private. Package hashes
check generated assets, excluding this README; they do not attest authorship
or authorize execution.
