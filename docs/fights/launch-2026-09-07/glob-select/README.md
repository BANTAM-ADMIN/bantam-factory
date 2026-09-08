# Glob select · selection series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Match paths against an ordered list of glob patterns, with the last matching
pattern deciding inclusion, and return a receipt naming the deciding pattern
for every path. The assignment states its own preconditions: the pattern list
must be a dense array of unique nonempty strings, and a single `*` never
crosses a path separator.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 264.1 s |

One system is recorded on this work order so far. BANTAM completed accepted
work and passed every acceptance group, including the hidden group that
exercises the uniqueness precondition the visible tests never touch.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 27 requests | 503,914 | 19,280 | 459,965 | 43,949 |
| BANTAM · separate idle-bounded server window | 503,950 | 19,280 | 460,000 | 43,950 |

Prefix reuse was 91.3% across 27 requests. Input already includes cached
input: do not add those columns together. Server attribution assumes no other
inference client used the endpoint during the window. Overlapping meters must
not be added or forced to agree.

## Conditions and provenance

Recorded on frozen factory source
`7d6d304a419e99da3bfdf347f8fc47a67a147791`, which derives the history window
from the served context, reserves a final action against the wall budget, and
quotes the assignment's own named requirements back into the completion audit.
The manifest records a 72,192-token served window, a 173,260-character history
budget, a 600-second wall deadline and a 48-second closure reserve.

The local contender used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. Local inference
was serial. No manual repairs, teacher requests or post-result changes to the
candidate were made.

One recorded attempt is an observation, not an expected value, and a
single-system card is not a comparison. Public exports contain allowlisted
measurements and replay counters, not private source, prompts or machine
paths. Raw evidence remains private. Package hashes check generated assets,
excluding this README; they do not attest authorship or authorize execution.
